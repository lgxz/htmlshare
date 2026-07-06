import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import {
  contentType,
  copyToClipboard,
  formatDuration,
  parseDurationSeconds,
  publicBaseFromServer,
  randomId,
  readOption
} from "./utils.js";

export async function runShareClient({ defaultServerUrl, defaultPublicBaseUrl, defaultShareToken, maxFileBytes }) {
  const serverUrl = readOption("--server") || process.env.HTMLSHARE_SERVER || defaultServerUrl;
  const fileArg = readOption("--file") || process.argv[3];
  const shareToken = process.env.SHARE_TOKEN || defaultShareToken;
  const cacheTtlSeconds = parseDurationSeconds(readOption("--cache-ttl") || process.env.HTMLSHARE_CACHE_TTL || "0");

  if (!serverUrl || !fileArg) {
    return false;
  }

  const htmlFile = await realpath(fileArg);
  const fileInfo = await lstat(htmlFile);
  if (!fileInfo.isFile()) {
    throw new Error(`Not a file: ${htmlFile}`);
  }

  const rootDir = await realpath(path.dirname(htmlFile));
  const entryName = path.basename(htmlFile);
  const sessionId = randomId(8);
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ||
    (serverUrl === defaultServerUrl ? defaultPublicBaseUrl : publicBaseFromServer(serverUrl, defaultServerUrl));
  const shareUrl = `${publicBaseUrl.replace(/\/$/, "")}/s/${sessionId}/${encodeURIComponent(entryName)}`;

  const ws = new WebSocket(serverUrl);
  ws.on("open", () => {
    ws.send(JSON.stringify({
      type: "register",
      sessionId,
      token: shareToken,
      cache: {
        enabled: cacheTtlSeconds > 0,
        ttlSeconds: cacheTtlSeconds
      }
    }));
  });

  ws.on("message", async (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }

    if (message.type === "registered") {
      console.log("Share URL:");
      console.log(shareUrl);
      copyToClipboard(shareUrl);
      if (message.cache?.enabled) {
        console.log(`Cache: ${formatDuration(message.cache.ttlSeconds)}`);
      } else {
        console.log("Cache: off");
      }
      console.log("Keep this process running while sharing. Press Ctrl+C to stop.");
      return;
    }

    if (message.type === "request") {
      const response = await handleFileRequest(rootDir, message.path || "/", maxFileBytes);
      ws.send(JSON.stringify({ type: "response", id: message.id, ...response }));
    }
  });

  ws.on("close", (code, reason) => {
    console.error(`Disconnected from server (${code}) ${reason}`);
    process.exit(code === 1000 ? 0 : 1);
  });

  ws.on("error", (error) => {
    console.error(error.message);
  });

  return true;
}

export async function runPublishClient({ defaultServerUrl, defaultShareToken }) {
  const slug = readOption("--slug");
  const fileArg = readOption("--file");
  const dirArg = readOption("--dir");
  const entryArg = readOption("--entry");
  const shareToken = process.env.SHARE_TOKEN || defaultShareToken;
  const publicBaseUrl = readOption("--public-base-url") ||
    process.env.PUBLIC_BASE_URL ||
    publicBaseFromServer(readOption("--server") || process.env.HTMLSHARE_SERVER || defaultServerUrl, defaultServerUrl);

  if (!slug || (!fileArg && !dirArg)) {
    return false;
  }

  const rootDir = fileArg
    ? await realpath(path.dirname(fileArg))
    : await realpath(dirArg);
  const entry = fileArg
    ? path.basename(fileArg)
    : (entryArg || "index.html");

  const files = await collectPublishFiles(rootDir);
  if (!files.some((file) => file.path === entry)) {
    throw new Error(`entry file is missing from publish directory: ${entry}`);
  }

  const endpoint = `${publicBaseUrl.replace(/\/$/, "")}/api/publish`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${shareToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ slug, entry, files })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Publish failed with HTTP ${response.status}`);
  }

  const publishedUrl = `${publicBaseUrl.replace(/\/$/, "")}${payload.url || `/p/${slug}/`}`;
  console.log("Published URL:");
  console.log(publishedUrl);
  console.log(`Files: ${payload.files}`);
  console.log(`Bytes: ${payload.bytes}`);
  copyToClipboard(publishedUrl);
  return true;
}

async function collectPublishFiles(rootDir) {
  const files = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".DS_Store") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const resolved = await realpath(fullPath);
      if (resolved !== rootDir && !resolved.startsWith(`${rootDir}${path.sep}`)) {
        throw new Error(`Refusing to publish file outside directory: ${fullPath}`);
      }

      const body = await readFile(resolved);
      const relativePath = path.relative(rootDir, resolved).split(path.sep).join("/");
      files.push({
        path: relativePath,
        contentType: contentType(resolved),
        size: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
        body: body.toString("base64")
      });
    }
  }

  await walk(rootDir);
  return files;
}

async function handleFileRequest(rootDir, requestPath, maxFileBytes) {
  try {
    const parsed = new URL(requestPath, "http://localhost");
    const pathname = decodeURIComponent(parsed.pathname);
    const normalized = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const relativePath = normalized === "/" ? "" : normalized.replace(/^[/\\]+/, "");
    const candidate = await realpath(path.join(rootDir, relativePath));

    if (!candidate.startsWith(`${rootDir}${path.sep}`) && candidate !== rootDir) {
      return { status: 403, error: "Forbidden\n" };
    }

    const info = await stat(candidate);
    if (!info.isFile()) {
      return { status: 404, error: "Not found\n" };
    }
    if (info.size > maxFileBytes) {
      return { status: 413, error: "File is too large for this share.\n" };
    }

    const body = await readFile(candidate);
    return {
      status: 200,
      contentType: contentType(candidate),
      size: body.length,
      body: body.toString("base64")
    };
  } catch {
    return { status: 404, error: "Not found\n" };
  }
}
