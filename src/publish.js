import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_PUBLISHED_DIR = path.resolve("data/published");
const JSON_OVERHEAD_BYTES = 1024 * 1024;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
  [".pdf", "application/pdf"]
]);

export function createPublishHandlers({ users, events, publishedDir = DEFAULT_PUBLISHED_DIR }) {
  const rootDir = path.resolve(publishedDir);

  return {
    async handlePublishRequest({ req, res }) {
      if (req.method !== "POST") {
        sendJson(res, { ok: false, error: "Method not allowed" }, 405, { allow: "POST" });
        return true;
      }

      const user = users.findByToken(bearerToken(req));
      if (!user) {
        sendJson(res, { ok: false, error: "Unauthorized" }, 401);
        return true;
      }
      if (!user.publish?.enabled) {
        sendJson(res, { ok: false, error: "Publish is not enabled for this user" }, 403);
        return true;
      }

      let payload;
      try {
        const bodyLimit = Math.max(
          user.publish.maxBytes * 2 + user.publish.maxFiles * 1024 + JSON_OVERHEAD_BYTES,
          JSON_OVERHEAD_BYTES
        );
        payload = await readJsonBody(req, bodyLimit);
      } catch (error) {
        sendJson(res, { ok: false, error: error.message }, statusForPublishError(error));
        return true;
      }

      try {
        const result = await publishSnapshot({
          rootDir,
          user,
          payload,
          events
        });
        sendJson(res, {
          ok: true,
          slug: result.slug,
          entry: result.entry,
          files: result.files,
          bytes: result.bytes,
          url: `/p/${result.slug}/`
        });
      } catch (error) {
        sendJson(res, { ok: false, error: error.message }, statusForPublishError(error));
      }
      return true;
    },

    async handlePublishedRequest({ req, res, parsed }) {
      const match = /^\/p\/([^/]+)(?:\/(.*))?$/.exec(parsed.pathname);
      if (!match) return false;

      const [, rawSlug, rawPath = ""] = match;
      if (!["GET", "HEAD"].includes(req.method || "")) {
        res.writeHead(405, { allow: "GET, HEAD" });
        res.end();
        return true;
      }

      try {
        const slug = validateSlug(rawSlug);
        const slugRoot = path.join(rootDir, slug);
        const manifest = JSON.parse(await readFile(path.join(slugRoot, "manifest.json"), "utf8"));
        const requestPath = rawPath ? decodeURIComponent(rawPath) : manifest.entry;
        const relativePath = normalizeRelativePath(requestPath || manifest.entry);
        const filePath = safeJoin(path.join(slugRoot, "current"), relativePath);
        const info = await stat(filePath);
        if (!info.isFile()) throw httpError("Not found", 404);

        const headers = {
          "content-type": contentType(filePath),
          "content-length": String(info.size),
          "cache-control": cacheControlFor(filePath)
        };
        res.writeHead(200, headers);
        if (req.method === "HEAD") {
          res.end();
        } else {
          createReadStream(filePath).pipe(res);
        }
      } catch (error) {
        const status = Number.isInteger(error.status) ? error.status : 404;
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
        res.end(`${status === 404 ? "Not found" : error.message}\n`);
      }
      return true;
    }
  };
}

async function publishSnapshot({ rootDir, user, payload, events }) {
  if (!payload || typeof payload !== "object") throw httpError("Invalid publish payload", 400);
  const slug = validateSlug(payload.slug);
  const entry = normalizeRelativePath(payload.entry || "");
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (!files.length) throw httpError("files must not be empty", 400);
  if (files.length > user.publish.maxFiles) throw httpError("Too many files", 413);
  if (!isSlugAllowed(user.publish.allowedSlugs, slug)) throw httpError("Slug is not allowed for this user", 403);

  const uploadId = `${Date.now()}-${randomBytes(6).toString("hex")}`;
  const tmpDir = path.join(rootDir, ".tmp", uploadId);
  const slugRoot = path.join(rootDir, slug);
  const currentDir = path.join(slugRoot, "current");
  const oldDir = path.join(slugRoot, `.old-${uploadId}`);
  let totalBytes = 0;
  let sawEntry = false;
  const manifestFiles = [];

  await mkdir(tmpDir, { recursive: true });

  try {
    for (const file of files) {
      const relativePath = normalizeRelativePath(file?.path || "");
      if (relativePath === entry) sawEntry = true;
      const body = decodeBody(file?.body);
      const size = nonNegativeInt(file?.size, body.length);
      if (size !== body.length) throw httpError(`Size mismatch for ${relativePath}`, 400);
      if (body.length > user.publish.maxFileBytes) throw httpError(`File too large: ${relativePath}`, 413);
      totalBytes += body.length;
      if (totalBytes > user.publish.maxBytes) throw httpError("Publish is too large", 413);

      const sha256 = sha256Hex(body);
      if (file?.sha256 && file.sha256 !== sha256) throw httpError(`sha256 mismatch for ${relativePath}`, 400);

      const destination = safeJoin(tmpDir, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, body, { mode: 0o644 });
      manifestFiles.push({
        path: relativePath,
        size: body.length,
        sha256,
        contentType: file?.contentType || contentType(relativePath)
      });
    }

    if (!sawEntry) throw httpError("entry must reference one uploaded file", 400);

    const manifest = {
      slug,
      entry,
      user: user.name,
      publishedAt: new Date().toISOString(),
      fileCount: manifestFiles.length,
      bytes: totalBytes,
      files: manifestFiles
    };
    await writeFile(path.join(tmpDir, ".manifest.pending.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    await mkdir(slugRoot, { recursive: true });
    await rm(oldDir, { recursive: true, force: true });
    let movedCurrent = false;
    try {
      await rename(currentDir, oldDir);
      movedCurrent = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(tmpDir, currentDir);
      await rename(path.join(currentDir, ".manifest.pending.json"), path.join(slugRoot, "manifest.json"));
      await rm(oldDir, { recursive: true, force: true });
    } catch (error) {
      if (movedCurrent) {
        await rm(currentDir, { recursive: true, force: true });
        await rename(oldDir, currentDir).catch(() => {});
      }
      throw error;
    }

    events.record({
      type: "publish_completed",
      slug,
      user: user.name,
      files: manifestFiles.length,
      bytes: totalBytes
    });
    return { slug, entry, files: manifestFiles.length, bytes: totalBytes };
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true });
    events.record({
      type: "publish_failed",
      slug: payload?.slug || "",
      user: user.name,
      error: error.message
    });
    throw error;
  }
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(httpError("Request body is too large", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(httpError(`Invalid JSON: ${error.message}`, 400));
      }
    });
    req.on("error", reject);
  });
}

function validateSlug(value) {
  const slug = String(value || "").trim();
  if (!SLUG_PATTERN.test(slug)) {
    throw httpError("Invalid slug: use lowercase letters, numbers, and hyphens", 400);
  }
  return slug;
}

function normalizeRelativePath(value) {
  const raw = String(value || "").replaceAll("\\", "/");
  if (!raw || raw.includes("\0") || raw.startsWith("/")) {
    throw httpError("Invalid file path", 400);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw httpError("Invalid file path", 400);
  }
  return normalized;
}

function safeJoin(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw httpError("Invalid file path", 400);
  }
  return resolved;
}

function decodeBody(value) {
  if (typeof value !== "string") throw httpError("file body must be base64", 400);
  return Buffer.from(value, "base64");
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function isSlugAllowed(allowedSlugs, slug) {
  return allowedSlugs.length === 0 || allowedSlugs.includes(slug);
}

function contentType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

function cacheControlFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return [".html", ".htm"].includes(ext)
    ? "no-cache"
    : "public, max-age=31536000, immutable";
}

function sendJson(res, payload, status = 200, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function statusForPublishError(error) {
  return Number.isInteger(error.status) ? error.status : 500;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
