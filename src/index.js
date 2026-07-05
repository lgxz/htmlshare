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
  SHARE_TOKEN              Optional token required by both server and client
  PUBLIC_BASE_URL          Public base URL printed by the client, e.g. https://share.example.com
  HTMLSHARE_MAX_FILE_BYTES Max single file size, default 10MB
  HTMLSHARE_EVENT_LOG      Server JSONL event log path, default /data/events.jsonl`);
}

function runServer() {
  const port = readOption("--port") ? Number(readOption("--port")) : DEFAULT_PORT;
  const shareToken = process.env.SHARE_TOKEN || "";
  const events = createEventRecorder(DEFAULT_EVENT_LOG);
  const sessions = new Map();
  const pending = new Map();

  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    let eventWritten = false;
    const recordRequest = (sessionId, parsed, status, bytes = 0, error = "") => {
      if (eventWritten) return;
      eventWritten = true;
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
      const match = /^\/s\/([^/]+)(?:\/(.*))?$/.exec(parsed.pathname);
      if (!match) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found\n");
        events.record({
          type: "request_unmatched",
          method: req.method,
          path: parsed.pathname,
          status: 404,
          durationMs: Date.now() - startedAt,
          ip: clientIp(req),
          userAgent: req.headers["user-agent"] || ""
        });
        return;
      }

      const [, sessionId, rawPath = ""] = match;
      const ws = sessions.get(sessionId);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        res.writeHead(410, { "content-type": "text/plain; charset=utf-8" });
        res.end("This share is not connected.\n");
        recordRequest(sessionId, parsed, 410, 0, "share_not_connected");
        return;
      }

      if (!["GET", "HEAD"].includes(req.method || "")) {
        res.writeHead(405, { allow: "GET, HEAD" });
        res.end();
        recordRequest(sessionId, parsed, 405, 0, "method_not_allowed");
        return;
      }

      const id = randomId(12);
      const response = waitForResponse(pending, id, 15000);
      ws.send(JSON.stringify({
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
      if (typeof message.size === "number") headers["content-length"] = String(message.size);
      res.writeHead(message.status || 200, headers);
      if (req.method === "HEAD") {
        res.end();
        recordRequest(sessionId, parsed, message.status || 200, 0);
      } else {
        const body = Buffer.from(message.body || "", "base64");
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
  wss.on("connection", (ws) => {
    let registeredSession = "";
    const connectedAt = new Date().toISOString();

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
        if (shareToken && message.token !== shareToken) {
          events.record({ type: "share_rejected", reason: "bad_token" });
          ws.close(1008, "Bad token");
          return;
        }
        registeredSession = message.sessionId || randomId(8);
        sessions.set(registeredSession, ws);
        ws.send(JSON.stringify({ type: "registered", sessionId: registeredSession }));
        console.log(`share connected: ${registeredSession}`);
        events.record({
          type: "share_connected",
          sessionId: registeredSession,
          connectedAt
        });
        return;
      }

      if (message.type === "response" && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });

    ws.on("close", () => {
      if (registeredSession && sessions.get(registeredSession) === ws) {
        sessions.delete(registeredSession);
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

function waitForResponse(pending, id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Shared client did not respond in time"));
    }, timeoutMs);

    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
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
