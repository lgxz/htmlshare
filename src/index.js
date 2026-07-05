#!/usr/bin/env node

import { createServer } from "node:http";
import { mkdirSync, createWriteStream } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";

const MAX_FILE_BYTES = Number(process.env.HTMLSHARE_MAX_FILE_BYTES || 10 * 1024 * 1024);
const DEFAULT_PORT = Number(process.env.PORT || 8080);
const DEFAULT_EVENT_LOG = process.env.HTMLSHARE_EVENT_LOG || path.resolve("data/events.jsonl");
const LOG_UNMATCHED = process.env.HTMLSHARE_LOG_UNMATCHED === "1";
const LOG_DISCONNECTED = process.env.HTMLSHARE_LOG_DISCONNECTED === "1";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const MAX_PENDING_REQUESTS = positiveInt(process.env.HTMLSHARE_MAX_PENDING_REQUESTS, 100);
const MAX_PENDING_PER_SHARE = positiveInt(process.env.HTMLSHARE_MAX_PENDING_PER_SHARE, 10);

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

const command = process.argv[2];

if (command === "server") {
  runServer();
} else if (command === "client") {
  runClient();
} else {
  usage();
  process.exit(command ? 64 : 0);
}

function usage() {
  console.log(`Usage:
  htmlshare server [--port 8080]
  htmlshare client --server ws://localhost:8080/tunnel --file /path/to/file.html

Environment:
  SHARE_TOKEN              Required token for server mode and authenticated clients
  PUBLIC_BASE_URL          Public base URL printed by the client, e.g. https://share.example.com
  HTMLSHARE_MAX_FILE_BYTES Max single file size, default 10MB
  HTMLSHARE_EVENT_LOG      Server JSONL event log path
  HTMLSHARE_LOG_UNMATCHED  Set to 1 to log non-share-path scanner traffic
  HTMLSHARE_LOG_DISCONNECTED Set to 1 to log requests for disconnected /s/... URLs
  HTMLSHARE_MAX_PENDING_REQUESTS Global in-flight browser request limit, default 100
  HTMLSHARE_MAX_PENDING_PER_SHARE Per-share in-flight browser request limit, default 10
  ADMIN_TOKEN              Optional bearer token for /admin/status`);
}

function runServer() {
  const port = readOption("--port") ? Number(readOption("--port")) : DEFAULT_PORT;
  const shareToken = process.env.SHARE_TOKEN || "";
  if (!shareToken) {
    console.error("SHARE_TOKEN is required in server mode.");
    process.exit(78);
  }

  const events = createEventRecorder(DEFAULT_EVENT_LOG);
  const sessions = new Map();
  const pending = new Map();
  const stats = createStats(pending);

  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    let eventWritten = false;
    const recordRequest = (sessionId, parsed, status, bytes = 0, error = "") => {
      if (eventWritten) return;
      eventWritten = true;
      stats.recordRequest(sessionId, {
        path: parsed.pathname,
        status,
        bytes,
        durationMs: Date.now() - startedAt
      });
      events.record({
        type: "request",
        sessionId,
        method: req.method,
        path: parsed.pathname,
        query: parsed.search || "",
        status,
        bytes,
        durationMs: Date.now() - startedAt,
        ip: clientIp(req),
        userAgent: req.headers["user-agent"] || "",
        referer: req.headers.referer || "",
        error
      });
    };

    try {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("ok\n");
        return;
      }

      const parsed = new URL(req.url || "/", "http://localhost");
      if (parsed.pathname === "/admin/status") {
        if (!isAdminAuthorized(req)) {
          res.writeHead(401, {
            "content-type": "text/plain; charset=utf-8",
            "www-authenticate": "Bearer"
          });
          res.end("Unauthorized\n");
          return;
        }

        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(`${JSON.stringify(stats.snapshot(), null, 2)}\n`);
        return;
      }

      const match = /^\/s\/([^/]+)(?:\/(.*))?$/.exec(parsed.pathname);
      if (!match) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found\n");
        if (LOG_UNMATCHED) {
          events.record({
            type: "request_unmatched",
            method: req.method,
            path: parsed.pathname,
            status: 404,
            durationMs: Date.now() - startedAt,
            ip: clientIp(req),
            userAgent: req.headers["user-agent"] || ""
          });
        }
        return;
      }

      const [, sessionId, rawPath = ""] = match;
      const session = sessions.get(sessionId);
      if (!session || session.ws.readyState !== WebSocket.OPEN) {
        res.writeHead(410, { "content-type": "text/plain; charset=utf-8" });
        res.end("This share is not connected.\n");
        if (LOG_DISCONNECTED) recordRequest(sessionId, parsed, 410, 0, "share_not_connected");
        return;
      }

      if (!["GET", "HEAD"].includes(req.method || "")) {
        res.writeHead(405, { allow: "GET, HEAD" });
        res.end();
        recordRequest(sessionId, parsed, 405, 0, "method_not_allowed");
        return;
      }

      if (pending.size >= MAX_PENDING_REQUESTS || pendingCountForSession(pending, sessionId) >= MAX_PENDING_PER_SHARE) {
        res.writeHead(429, { "content-type": "text/plain; charset=utf-8", "retry-after": "5" });
        res.end("Too many in-flight requests.\n");
        recordRequest(sessionId, parsed, 429, 0, "too_many_pending_requests");
        return;
      }

      const id = randomId(12);
      const response = waitForResponse(pending, id, sessionId, 15000);
      session.ws.send(JSON.stringify({
        type: "request",
        id,
        method: req.method,
        path: `/${rawPath}${parsed.search}`
      }));

      const message = await response;
      if (message.status >= 400) {
        res.writeHead(message.status, { "content-type": "text/plain; charset=utf-8" });
        const body = message.error || "Request failed\n";
        res.end(body);
        recordRequest(sessionId, parsed, message.status, Buffer.byteLength(body), body.trim());
        return;
      }

      const headers = {
        "content-type": message.contentType || "application/octet-stream",
        "cache-control": "no-store"
      };
      const body = req.method === "HEAD" ? null : decodeResponseBody(message);
      if (body) headers["content-length"] = String(body.length);
      else if (typeof message.size === "number" && message.size <= MAX_FILE_BYTES) headers["content-length"] = String(message.size);
      res.writeHead(message.status || 200, headers);
      if (req.method === "HEAD") {
        res.end();
        recordRequest(sessionId, parsed, message.status || 200, 0);
      } else {
        res.end(body);
        recordRequest(sessionId, parsed, message.status || 200, body.length);
      }
    } catch (error) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`${error.message}\n`);
      const parsed = new URL(req.url || "/", "http://localhost");
      const sessionId = /^\/s\/([^/]+)/.exec(parsed.pathname)?.[1] || "";
      if (sessionId) recordRequest(sessionId, parsed, 502, 0, error.message);
    }
  });

  const wss = new WebSocketServer({ server, path: "/tunnel" });
  wss.on("connection", (ws, req) => {
    let registeredSession = "";
    const connectedAt = new Date().toISOString();
    const connectionIp = clientIp(req);
    const userAgent = req.headers["user-agent"] || "";

    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        events.record({ type: "client_invalid_message", reason: "invalid_json" });
        ws.close(1003, "Invalid JSON");
        return;
      }

      if (message.type === "register") {
        if (message.token !== shareToken) {
          stats.totals.shareRejections += 1;
          events.record({ type: "share_rejected", reason: "bad_token", ip: connectionIp, userAgent });
          ws.close(1008, "Bad token");
          return;
        }
        registeredSession = message.sessionId || randomId(8);
        if (sessions.has(registeredSession)) {
          stats.totals.shareRejections += 1;
          events.record({
            type: "share_rejected",
            reason: "duplicate_session",
            sessionId: registeredSession,
            ip: connectionIp,
            userAgent
          });
          ws.close(1008, "Duplicate session");
          return;
        }

        const share = stats.addShare({
          sessionId: registeredSession,
          connectedAt,
          clientIp: connectionIp,
          userAgent
        });
        sessions.set(registeredSession, { ws, share });
        ws.send(JSON.stringify({ type: "registered", sessionId: registeredSession }));
        console.log(`share connected: ${registeredSession}`);
        events.record({
          type: "share_connected",
          sessionId: registeredSession,
          connectedAt,
          ip: connectionIp,
          userAgent
        });
        return;
      }

      if (message.type === "response" && pending.has(message.id)) {
        const entry = pending.get(message.id);
        entry.resolve(message);
        pending.delete(message.id);
      }
    });

    ws.on("close", () => {
      const session = sessions.get(registeredSession);
      if (registeredSession && session?.ws === ws) {
        sessions.delete(registeredSession);
        stats.removeShare(registeredSession);
        console.log(`share disconnected: ${registeredSession}`);
        events.record({
          type: "share_disconnected",
          sessionId: registeredSession
        });
      }
    });
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`htmlshare server listening on :${port}`);
    events.record({ type: "server_started", port, eventLog: DEFAULT_EVENT_LOG });
  });
}

function decodeResponseBody(message) {
  const encoded = message.body || "";
  if (typeof encoded !== "string") {
    throw new Error("Shared client returned an invalid response body");
  }

  if (typeof message.size === "number" && message.size > MAX_FILE_BYTES) {
    throw new Error("Shared client response is too large");
  }

  const maxBase64Length = Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4;
  if (encoded.length > maxBase64Length) {
    throw new Error("Shared client response is too large");
  }

  const body = Buffer.from(encoded, "base64");
  if (body.length > MAX_FILE_BYTES) {
    throw new Error("Shared client response is too large");
  }

  if (typeof message.size === "number" && body.length !== message.size) {
    throw new Error("Shared client response size mismatch");
  }

  return body;
}

async function runClient() {
  const serverUrl = readOption("--server") || process.env.HTMLSHARE_SERVER;
  const fileArg = readOption("--file") || process.argv[3];
  const shareToken = process.env.SHARE_TOKEN || "";

  if (!serverUrl || !fileArg) {
    usage();
    process.exit(64);
  }

  const htmlFile = await realpath(fileArg);
  const fileInfo = await lstat(htmlFile);
  if (!fileInfo.isFile()) {
    throw new Error(`Not a file: ${htmlFile}`);
  }

  const rootDir = await realpath(path.dirname(htmlFile));
  const entryName = path.basename(htmlFile);
  const sessionId = randomId(8);
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || serverUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/tunnel$/, "");
  const shareUrl = `${publicBaseUrl.replace(/\/$/, "")}/s/${sessionId}/${encodeURIComponent(entryName)}`;

  const ws = new WebSocket(serverUrl);
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "register", sessionId, token: shareToken }));
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
      console.log("Keep this process running while sharing. Press Ctrl+C to stop.");
      return;
    }

    if (message.type === "request") {
      const response = await handleFileRequest(rootDir, message.path || "/");
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
}

async function handleFileRequest(rootDir, requestPath) {
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
    if (info.size > MAX_FILE_BYTES) {
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

function waitForResponse(pending, id, sessionId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Shared client did not respond in time"));
    }, timeoutMs);

    pending.set(id, {
      sessionId,
      resolve(message) {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
}

function pendingCountForSession(pending, sessionId) {
  let count = 0;
  for (const entry of pending.values()) {
    if (entry.sessionId === sessionId) count += 1;
  }
  return count;
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createEventRecorder(filePath) {
  if (!filePath) {
    return { record() {} };
  }

  mkdirSync(path.dirname(filePath), { recursive: true });
  const stream = createWriteStream(filePath, { flags: "a" });
  stream.on("error", (error) => {
    console.error(`event log error: ${error.message}`);
  });

  return {
    record(event) {
      const payload = {
        ts: new Date().toISOString(),
        ...event
      };
      stream.write(`${JSON.stringify(payload)}\n`);
    }
  };
}

function createStats(pending) {
  const startedAt = new Date().toISOString();
  const activeShares = new Map();
  const totals = {
    sharesStarted: 0,
    sharesEnded: 0,
    shareRejections: 0,
    requests: 0,
    successes: 0,
    clientErrors: 0,
    serverErrors: 0,
    bytesSent: 0
  };

  return {
    totals,

    addShare({ sessionId, connectedAt, clientIp, userAgent }) {
      totals.sharesStarted += 1;
      const share = {
        sessionId,
        connectedAt,
        clientIp,
        userAgent,
        requestCount: 0,
        successCount: 0,
        clientErrorCount: 0,
        serverErrorCount: 0,
        bytesSent: 0,
        lastRequestAt: "",
        lastPath: "",
        lastStatus: 0,
        lastDurationMs: 0
      };
      activeShares.set(sessionId, share);
      return share;
    },

    removeShare(sessionId) {
      if (activeShares.delete(sessionId)) {
        totals.sharesEnded += 1;
      }
    },

    recordRequest(sessionId, { path: requestPath, status, bytes, durationMs }) {
      totals.requests += 1;
      totals.bytesSent += bytes || 0;
      if (status >= 200 && status < 400) totals.successes += 1;
      else if (status >= 400 && status < 500) totals.clientErrors += 1;
      else if (status >= 500) totals.serverErrors += 1;

      const share = activeShares.get(sessionId);
      if (!share) return;
      share.requestCount += 1;
      share.bytesSent += bytes || 0;
      share.lastRequestAt = new Date().toISOString();
      share.lastPath = requestPath || "";
      share.lastStatus = status;
      share.lastDurationMs = durationMs || 0;
      if (status >= 200 && status < 400) share.successCount += 1;
      else if (status >= 400 && status < 500) share.clientErrorCount += 1;
      else if (status >= 500) share.serverErrorCount += 1;
    },

    snapshot() {
      return {
        startedAt,
        uptimeSeconds: Math.floor((Date.now() - Date.parse(startedAt)) / 1000),
        activeShareCount: activeShares.size,
        pendingRequestCount: pending.size,
        activeShares: [...activeShares.values()],
        totals: { ...totals }
      };
    }
  };
}

function isAdminAuthorized(req) {
  if (!ADMIN_TOKEN) return false;
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${ADMIN_TOKEN}`) return true;
  return req.headers["x-admin-token"] === ADMIN_TOKEN;
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "";
}

function randomId(bytes) {
  return randomBytes(bytes).toString("base64url");
}

function contentType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

function copyToClipboard(text) {
  if (process.platform !== "darwin") return;
  try {
    const proc = spawn("pbcopy");
    proc.stdin.end(text);
  } catch {
    // Clipboard is a convenience only.
  }
}
