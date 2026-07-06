#!/usr/bin/env node

import { createServer } from "node:http";
import { mkdirSync, createWriteStream, readFileSync, statSync } from "node:fs";
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
const CACHE_MAX_TOTAL_BYTES = nonNegativeInt(process.env.HTMLSHARE_CACHE_MAX_TOTAL_BYTES, 512 * 1024 * 1024);

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
  htmlshare client --server ws://localhost:8080/tunnel --file /path/to/file.html [--cache-ttl 10m]

Environment:
  HTMLSHARE_USERS_FILE     Required users.json path for server mode
  HTMLSHARE_USERS_RELOAD_SECONDS Users file hot reload interval, default 5
  PUBLIC_BASE_URL          Public base URL printed by the client, e.g. https://share.example.com
  HTMLSHARE_MAX_FILE_BYTES Max single file size, default 10MB
  HTMLSHARE_EVENT_LOG      Server JSONL event log path
  HTMLSHARE_LOG_UNMATCHED  Set to 1 to log non-share-path scanner traffic
  HTMLSHARE_LOG_DISCONNECTED Set to 1 to log requests for disconnected /s/... URLs
  HTMLSHARE_MAX_PENDING_REQUESTS Global in-flight browser request limit, default 100
  HTMLSHARE_MAX_PENDING_PER_SHARE Default per-share limit for users.json, default 10
  HTMLSHARE_CACHE_MAX_TOTAL_BYTES Global in-memory cache limit, default 512MB
  ADMIN_TOKEN              Optional bearer token for /admin/status`);
}

function runServer() {
  const port = readOption("--port") ? Number(readOption("--port")) : DEFAULT_PORT;
  const usersFile = process.env.HTMLSHARE_USERS_FILE || "";
  if (!usersFile) {
    console.error("HTMLSHARE_USERS_FILE is required in server mode.");
    process.exit(78);
  }

  const events = createEventRecorder(DEFAULT_EVENT_LOG);
  const users = createUserStore(usersFile, events);
  try {
    users.load();
  } catch (error) {
    console.error(error.message);
    process.exit(78);
  }
  users.startReloadTimer(positiveInt(process.env.HTMLSHARE_USERS_RELOAD_SECONDS, 5));

  const sessions = new Map();
  const pending = new Map();
  const responseCache = createResponseCache({
    maxTotalBytes: CACHE_MAX_TOTAL_BYTES,
    events
  });
  const stats = createStats(pending, sessions, responseCache);

  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    let eventWritten = false;
    const recordRequest = (sessionId, parsed, status, bytes = 0, error = "", details = {}) => {
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
        user: details.user || sessions.get(sessionId)?.user?.name || "",
        method: req.method,
        path: parsed.pathname,
        query: parsed.search || "",
        status,
        bytes,
        durationMs: Date.now() - startedAt,
        cache: details.cache || "",
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
      if (parsed.pathname === "/admin" || parsed.pathname.startsWith("/admin/")) {
        await handleAdminRequest({
          req,
          res,
          parsed,
          users,
          responseCache,
          stats,
          events
        });
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
      if (!["GET", "HEAD"].includes(req.method || "")) {
        res.writeHead(405, { allow: "GET, HEAD" });
        res.end();
        recordRequest(sessionId, parsed, 405, 0, "method_not_allowed");
        return;
      }

      const requestPath = `/${rawPath}${parsed.search}`;
      const cached = responseCache.get(sessionId, requestPath);
      if (cached) {
        const headers = { ...cached.headers, "x-htmlshare-cache": "hit" };
        if (req.method === "HEAD") {
          res.writeHead(cached.status, headers);
          res.end();
          recordRequest(sessionId, parsed, cached.status, 0, "", { user: cached.user, cache: "hit" });
        } else {
          res.writeHead(cached.status, headers);
          res.end(cached.body);
          recordRequest(sessionId, parsed, cached.status, cached.bytes, "", { user: cached.user, cache: "hit" });
        }
        return;
      }

      const session = sessions.get(sessionId);
      if (!session || session.ws.readyState !== WebSocket.OPEN) {
        res.writeHead(410, { "content-type": "text/plain; charset=utf-8" });
        res.end("This share is not connected.\n");
        if (LOG_DISCONNECTED) recordRequest(sessionId, parsed, 410, 0, "share_not_connected");
        return;
      }

      const maxPendingForShare = session.user.limits.maxPendingPerShare;
      if (pending.size >= MAX_PENDING_REQUESTS || pendingCountForSession(pending, sessionId) >= maxPendingForShare) {
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
        path: requestPath,
        visitor: {
          ip: clientIp(req),
          userAgent: req.headers["user-agent"] || "",
          referer: req.headers.referer || "",
          at: new Date().toISOString()
        }
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
      if (req.method === "GET" && (message.status || 200) === 200 && body) {
        responseCache.set({
          sessionId,
          user: session.user.name,
          requestPath,
          status: message.status || 200,
          headers,
          body,
          policy: session.cachePolicy
        });
      }
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
        if (registeredSession) {
          stats.totals.shareRejections += 1;
          events.record({
            type: "share_rejected",
            reason: "already_registered",
            sessionId: registeredSession,
            ip: connectionIp,
            userAgent
          });
          ws.close(1008, "Already registered");
          return;
        }
        const user = users.findByToken(message.token || "");
        if (!user) {
          stats.totals.shareRejections += 1;
          events.record({ type: "share_rejected", reason: "bad_token", ip: connectionIp, userAgent });
          ws.close(1008, "Bad token");
          return;
        }
        if (activeShareCountForUser(sessions, user.name) >= user.limits.maxActiveShares) {
          stats.totals.shareRejections += 1;
          events.record({
            type: "share_rejected",
            reason: "too_many_active_shares",
            user: user.name,
            ip: connectionIp,
            userAgent
          });
          ws.close(1008, "Too many active shares");
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

        const cachePolicy = effectiveCachePolicy(user.cache, message.cache || {});
        const share = stats.addShare({
          sessionId: registeredSession,
          userName: user.name,
          cache: cachePolicy,
          limits: user.limits,
          connectedAt,
          clientIp: connectionIp,
          userAgent
        });
        sessions.set(registeredSession, { ws, share, user, cachePolicy });
        ws.send(JSON.stringify({ type: "registered", sessionId: registeredSession, cache: cachePolicy }));
        console.log(`share connected: ${registeredSession} user=${user.name}`);
        events.record({
          type: "share_connected",
          sessionId: registeredSession,
          user: user.name,
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
          sessionId: registeredSession,
          user: session.user?.name || ""
        });
      }
    });
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`htmlshare server listening on :${port}`);
    events.record({ type: "server_started", port, eventLog: DEFAULT_EVENT_LOG, usersFile });
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

async function handleAdminRequest({ req, res, parsed, users, responseCache, stats, events }) {
  if (!isAdminAuthorized(req)) {
    res.writeHead(401, {
      "content-type": "text/plain; charset=utf-8",
      "www-authenticate": 'Basic realm="HtmlShare Admin"'
    });
    res.end("Unauthorized\n");
    return;
  }

  if (req.method === "GET" && parsed.pathname === "/admin") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(adminPageHtml());
    return;
  }

  if (req.method === "GET" && (parsed.pathname === "/admin/status" || parsed.pathname === "/admin/api/status")) {
    sendAdminJson(res, adminStatus(stats, users));
    return;
  }

  if (req.method === "POST" && req.headers["x-admin-action"] !== "1") {
    sendAdminJson(res, { ok: false, error: "x-admin-action header is required" }, 400);
    return;
  }

  if (req.method === "POST" && parsed.pathname === "/admin/api/cache/clear") {
    const result = responseCache.clearAll();
    events.record({ type: "admin_cache_clear", ...result });
    sendAdminJson(res, { ok: true, cache: responseCache.snapshot(), cleared: result });
    return;
  }

  if (req.method === "POST" && parsed.pathname === "/admin/api/cache/clear-session") {
    const sessionId = parsed.searchParams.get("sessionId") || "";
    if (!sessionId) {
      sendAdminJson(res, { ok: false, error: "sessionId is required" }, 400);
      return;
    }
    const result = responseCache.clearSession(sessionId);
    events.record({ type: "admin_cache_clear_session", sessionId, ...result });
    sendAdminJson(res, { ok: true, cache: responseCache.snapshot(), cleared: result });
    return;
  }

  if (req.method === "POST" && parsed.pathname === "/admin/api/users/reload") {
    try {
      const result = users.reloadNow();
      events.record({ type: "admin_users_reload", userCount: result.userCount });
      sendAdminJson(res, { ok: true, users: users.snapshot(), result });
    } catch (error) {
      events.record({ type: "admin_users_reload_failed", error: error.message });
      sendAdminJson(res, { ok: false, error: error.message }, 400);
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found\n");
}

function sendAdminJson(res, payload, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function adminStatus(stats, users) {
  return {
    ...stats.snapshot(),
    configuredUsers: users.snapshot()
  };
}

function adminPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HtmlShare Admin</title>
  <style>
    :root { color-scheme: light dark; --border: color-mix(in srgb, CanvasText 18%, transparent); --muted: color-mix(in srgb, CanvasText 62%, transparent); --panel: color-mix(in srgb, Canvas 92%, CanvasText 3%); }
    * { box-sizing: border-box; }
    body { margin: 0; font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: Canvas; color: CanvasText; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 18px 24px; border-bottom: 1px solid var(--border); }
    h1 { margin: 0; font-size: 18px; font-weight: 650; }
    main { padding: 18px 24px 28px; max-width: 1240px; margin: 0 auto; }
    h2 { margin: 0 0 10px; font-size: 14px; font-weight: 650; }
    section { margin-top: 20px; }
    button { font: inherit; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: ButtonFace; color: ButtonText; cursor: pointer; }
    button:hover { filter: brightness(0.98); }
    .actions { display: flex; gap: 8px; align-items: center; }
    .muted { color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(5, minmax(130px, 1fr)); gap: 10px; }
    .metric { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; background: var(--panel); min-height: 64px; }
    .metric .label { color: var(--muted); font-size: 12px; }
    .metric .value { margin-top: 3px; font-size: 19px; font-weight: 680; }
    table { width: 100%; border-collapse: collapse; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    th, td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; white-space: nowrap; }
    th { color: var(--muted); font-size: 12px; font-weight: 600; background: var(--panel); }
    td.path, td.ua { white-space: normal; word-break: break-word; }
    tr:last-child td { border-bottom: 0; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .pill { display: inline-block; padding: 2px 7px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); }
    .ok { color: #1f8f4d; }
    .bad { color: #c43c32; }
    #error { color: #c43c32; min-height: 18px; }
    @media (max-width: 900px) { .grid { grid-template-columns: repeat(2, minmax(130px, 1fr)); } main, header { padding-left: 14px; padding-right: 14px; } .table-wrap { overflow-x: auto; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>HtmlShare Admin</h1>
      <div class="muted" id="updated">Loading</div>
    </div>
    <div class="actions">
      <button id="reloadUsers">Reload Users</button>
      <button id="clearCache">Clear Cache</button>
      <button id="refresh">Refresh</button>
    </div>
  </header>
  <main>
    <div id="error"></div>
    <section>
      <h2>Summary</h2>
      <div class="grid" id="summary"></div>
    </section>
    <section>
      <h2>Shares</h2>
      <div class="table-wrap"><table id="shares"></table></div>
    </section>
    <section>
      <h2>Cache</h2>
      <div class="table-wrap"><table id="cachedShares"></table></div>
    </section>
    <section>
      <h2>Users</h2>
      <div class="table-wrap"><table id="users"></table></div>
    </section>
  </main>
  <script>
    const fmtBytes = (bytes) => {
      if (!bytes) return "0 B";
      const units = ["B", "KB", "MB", "GB"];
      let value = bytes;
      let index = 0;
      while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
      return (index === 0 ? value : value.toFixed(1)) + " " + units[index];
    };
    const fmtTime = (value) => value ? new Date(value).toLocaleString() : "-";
    const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    const text = (value) => value === undefined || value === null || value === "" ? "-" : esc(value);

    async function api(path, options) {
      const headers = options && options.method === "POST" ? { "x-admin-action": "1" } : {};
      const response = await fetch(path, { cache: "no-store", ...options, headers: { ...headers, ...(options?.headers || {}) } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) throw new Error(payload.error || response.statusText);
      return payload;
    }

    function renderMetrics(status) {
      const cache = status.cache || {};
      const totals = status.totals || {};
      const items = [
        ["Uptime", Math.floor((status.uptimeSeconds || 0) / 60) + " min"],
        ["Active shares", status.activeShareCount || 0],
        ["Pending", status.pendingRequestCount || 0],
        ["Requests", totals.requests || 0],
        ["Bytes sent", fmtBytes(totals.bytesSent || 0)],
        ["Cache entries", cache.entryCount || 0],
        ["Cache bytes", fmtBytes(cache.totalBytes || 0)],
        ["Cache hits", cache.hits || 0],
        ["Cache misses", cache.misses || 0],
        ["Cache max", fmtBytes(cache.maxTotalBytes || 0)]
      ];
      document.querySelector("#summary").innerHTML = items.map(([label, value]) => '<div class="metric"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>').join("");
    }

    function table(selector, headers, rows) {
      document.querySelector(selector).innerHTML = '<thead><tr>' + headers.map((h) => '<th>' + h + '</th>').join("") + '</tr></thead><tbody>' +
        (rows.length ? rows.join("") : '<tr><td colspan="' + headers.length + '" class="muted">None</td></tr>') + '</tbody>';
    }

    function renderShares(status) {
      const rows = (status.activeShares || []).map((share) => '<tr>' +
        '<td><code>' + text(share.sessionId) + '</code></td>' +
        '<td>' + text(share.user) + '</td>' +
        '<td>' + text(share.clientIp) + '</td>' +
        '<td>' + fmtTime(share.connectedAt) + '</td>' +
        '<td>' + (share.requestCount || 0) + '</td>' +
        '<td>' + fmtBytes(share.bytesSent || 0) + '</td>' +
        '<td>' + ((share.cache && share.cache.enabled) ? '<span class="pill ok">' + share.cache.ttlSeconds + 's</span>' : '<span class="pill">off</span>') + '</td>' +
        '<td>' + (share.cache?.entries || 0) + ' / ' + fmtBytes(share.cache?.bytes || 0) + '</td>' +
        '<td class="path">' + text(share.lastPath) + '</td>' +
        '</tr>');
      table("#shares", ["Session", "User", "Client IP", "Connected", "Requests", "Bytes", "Cache", "Cache use", "Last path"], rows);
    }

    function renderCache(status) {
      const rows = (status.cache?.cachedShares || []).map((share) => '<tr>' +
        '<td><code>' + text(share.sessionId) + '</code></td>' +
        '<td>' + text(share.user) + '</td>' +
        '<td>' + (share.entries || 0) + '</td>' +
        '<td>' + fmtBytes(share.bytes || 0) + '</td>' +
        '<td>' + (share.hits || 0) + '</td>' +
        '<td>' + fmtTime(share.expiresAt) + '</td>' +
        '<td><button data-clear-session="' + text(share.sessionId) + '">Clear</button></td>' +
        '</tr>');
      table("#cachedShares", ["Session", "User", "Entries", "Bytes", "Hits", "Expires", ""], rows);
      document.querySelectorAll("[data-clear-session]").forEach((button) => {
        button.onclick = async () => {
          await api("/admin/api/cache/clear-session?sessionId=" + encodeURIComponent(button.dataset.clearSession), { method: "POST" });
          await refresh();
        };
      });
    }

    function renderUsers(status) {
      const active = new Map((status.users || []).map((user) => [user.name, user]));
      const rows = (status.configuredUsers || []).map((user) => {
        const stats = active.get(user.name) || {};
        return '<tr>' +
          '<td>' + text(user.name) + '</td>' +
          '<td>' + (user.enabled ? '<span class="ok">enabled</span>' : '<span class="bad">disabled</span>') + '</td>' +
          '<td>' + (stats.activeShareCount || 0) + '</td>' +
          '<td>' + (user.limits?.maxActiveShares || 0) + '</td>' +
          '<td>' + (user.limits?.maxPendingPerShare || 0) + '</td>' +
          '<td>' + (user.cache?.enabled ? '<span class="pill ok">' + user.cache.ttlSeconds + 's</span>' : '<span class="pill">off</span>') + '</td>' +
          '<td>' + fmtBytes(user.cache?.maxFileBytes || 0) + '</td>' +
          '<td>' + fmtBytes(user.cache?.maxShareBytes || 0) + '</td>' +
        '</tr>';
      });
      table("#users", ["User", "Status", "Active", "Max shares", "Pending/share", "Cache", "Max file", "Max share"], rows);
    }

    async function refresh() {
      document.querySelector("#error").textContent = "";
      const status = await api("/admin/api/status");
      renderMetrics(status);
      renderShares(status);
      renderCache(status);
      renderUsers(status);
      document.querySelector("#updated").textContent = "Updated " + new Date().toLocaleTimeString();
    }

    document.querySelector("#refresh").onclick = refresh;
    document.querySelector("#clearCache").onclick = async () => { await api("/admin/api/cache/clear", { method: "POST" }); await refresh(); };
    document.querySelector("#reloadUsers").onclick = async () => { await api("/admin/api/users/reload", { method: "POST" }); await refresh(); };
    refresh().catch((error) => { document.querySelector("#error").textContent = error.message; });
    setInterval(() => refresh().catch(() => {}), 5000);
  </script>
</body>
</html>`;
}

async function runClient() {
  const serverUrl = readOption("--server") || process.env.HTMLSHARE_SERVER;
  const fileArg = readOption("--file") || process.argv[3];
  const shareToken = process.env.SHARE_TOKEN || "";
  const cacheTtlSeconds = parseDurationSeconds(readOption("--cache-ttl") || process.env.HTMLSHARE_CACHE_TTL || "0");

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

function activeShareCountForUser(sessions, userName) {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.user?.name === userName) count += 1;
  }
  return count;
}

function effectiveCachePolicy(userCache, clientCache) {
  const clientEnabled = clientCache.enabled === true;
  const clientTtl = nonNegativeInt(clientCache.ttlSeconds, 0);
  const userTtl = nonNegativeInt(userCache.ttlSeconds, 0);
  const maxFileBytes = nonNegativeInt(userCache.maxFileBytes, 0);
  const maxShareBytes = nonNegativeInt(userCache.maxShareBytes, 0);
  const ttlSeconds = Math.min(userTtl, clientTtl);
  const enabled = userCache.enabled === true &&
    clientEnabled &&
    ttlSeconds > 0 &&
    maxFileBytes > 0 &&
    maxShareBytes > 0 &&
    CACHE_MAX_TOTAL_BYTES > 0;

  return {
    enabled,
    ttlSeconds: enabled ? ttlSeconds : 0,
    maxFileBytes,
    maxShareBytes
  };
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function parseDurationSeconds(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "off" || raw === "false" || raw === "0") return 0;
  const match = /^(\d+)(s|m|h)?$/.exec(raw);
  if (!match) return 0;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] || "s";
  if (unit === "h") return amount * 3600;
  if (unit === "m") return amount * 60;
  return amount;
}

function formatDuration(seconds) {
  if (!seconds) return "off";
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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

function createUserStore(filePath, events) {
  let usersByToken = new Map();
  let usersByName = new Map();
  let lastMtimeMs = 0;

  return {
    load() {
      const result = loadUsersFile(filePath);
      usersByToken = result.usersByToken;
      usersByName = result.usersByName;
      lastMtimeMs = result.mtimeMs;
      events.record({ type: "users_loaded", usersFile: filePath, userCount: usersByName.size });
      console.log(`loaded ${usersByName.size} htmlshare user(s)`);
      return { userCount: usersByName.size, usersFile: filePath };
    },

    startReloadTimer(intervalSeconds) {
      const intervalMs = Math.max(intervalSeconds, 1) * 1000;
      const timer = setInterval(() => {
        stat(filePath).then((info) => {
          if (info.mtimeMs <= lastMtimeMs) return;
          const result = loadUsersFile(filePath);
          usersByToken = result.usersByToken;
          usersByName = result.usersByName;
          lastMtimeMs = result.mtimeMs;
          events.record({ type: "users_reloaded", usersFile: filePath, userCount: usersByName.size });
          console.log(`reloaded ${usersByName.size} htmlshare user(s)`);
        }).catch((error) => {
          events.record({ type: "users_reload_failed", usersFile: filePath, error: error.message });
          console.error(`users reload failed: ${error.message}`);
        });
      }, intervalMs);
      timer.unref?.();
    },

    findByToken(token) {
      const user = usersByToken.get(token);
      if (!user?.enabled) return null;
      return user;
    },

    reloadNow() {
      return this.load();
    },

    snapshot() {
      return [...usersByName.values()].map(publicUser);
    }
  };
}

function createResponseCache({ maxTotalBytes, events }) {
  const entries = new Map();
  const shareBytes = new Map();
  const totals = {
    hits: 0,
    misses: 0,
    stores: 0,
    evictions: 0,
    expired: 0
  };
  let totalBytes = 0;

  const keyFor = (sessionId, requestPath) => `${sessionId}\0${requestPath}`;

  function deleteEntry(key, reason) {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    totalBytes -= entry.bytes;
    const nextShareBytes = (shareBytes.get(entry.sessionId) || 0) - entry.bytes;
    if (nextShareBytes > 0) shareBytes.set(entry.sessionId, nextShareBytes);
    else shareBytes.delete(entry.sessionId);
    if (reason) {
      totals.evictions += 1;
      if (reason === "ttl") totals.expired += 1;
    }
    return true;
  }

  function pruneExpired() {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) {
        deleteEntry(key, "ttl");
      }
    }
  }

  function evictShareToFit(sessionId, neededBytes, maxShareBytes) {
    while ((shareBytes.get(sessionId) || 0) + neededBytes > maxShareBytes) {
      let removed = false;
      for (const [key, entry] of entries) {
        if (entry.sessionId === sessionId) {
          deleteEntry(key, "share_limit");
          removed = true;
          break;
        }
      }
      if (!removed) break;
    }
  }

  function evictGlobalToFit(neededBytes) {
    while (totalBytes + neededBytes > maxTotalBytes) {
      const oldestKey = entries.keys().next().value;
      if (!oldestKey) break;
      deleteEntry(oldestKey, "global_limit");
    }
  }

  return {
    get(sessionId, requestPath) {
      const key = keyFor(sessionId, requestPath);
      const entry = entries.get(key);
      if (!entry) {
        totals.misses += 1;
        return null;
      }
      if (entry.expiresAt <= Date.now()) {
        deleteEntry(key, "ttl");
        totals.misses += 1;
        return null;
      }
      entries.delete(key);
      entry.hits += 1;
      entry.lastAccessedAt = Date.now();
      entries.set(key, entry);
      totals.hits += 1;
      return entry;
    },

    set({ sessionId, user, requestPath, status, headers, body, policy }) {
      if (!policy?.enabled || status !== 200 || !Buffer.isBuffer(body)) return false;
      const bytes = body.length;
      if (bytes <= 0 || bytes > policy.maxFileBytes || bytes > policy.maxShareBytes || bytes > maxTotalBytes) {
        return false;
      }

      pruneExpired();
      const key = keyFor(sessionId, requestPath);
      deleteEntry(key, "");
      evictShareToFit(sessionId, bytes, policy.maxShareBytes);
      evictGlobalToFit(bytes);
      if ((shareBytes.get(sessionId) || 0) + bytes > policy.maxShareBytes || totalBytes + bytes > maxTotalBytes) {
        return false;
      }

      const expiresAt = Date.now() + policy.ttlSeconds * 1000;
      const entry = {
        key,
        sessionId,
        user,
        requestPath,
        status,
        headers: {
          "content-type": headers["content-type"] || "application/octet-stream",
          "content-length": String(bytes),
          "cache-control": `private, max-age=${policy.ttlSeconds}`
        },
        body,
        bytes,
        createdAt: Date.now(),
        expiresAt,
        lastAccessedAt: Date.now(),
        hits: 0
      };
      entries.set(key, entry);
      shareBytes.set(sessionId, (shareBytes.get(sessionId) || 0) + bytes);
      totalBytes += bytes;
      totals.stores += 1;
      events.record({
        type: "cache_store",
        sessionId,
        user,
        path: requestPath,
        bytes,
        ttlSeconds: policy.ttlSeconds
      });
      return true;
    },

    shareStats(sessionId) {
      let entryCount = 0;
      let hits = 0;
      let expiresAt = 0;
      for (const entry of entries.values()) {
        if (entry.sessionId !== sessionId) continue;
        entryCount += 1;
        hits += entry.hits;
        expiresAt = Math.max(expiresAt, entry.expiresAt);
      }
      return {
        entries: entryCount,
        bytes: shareBytes.get(sessionId) || 0,
        hits,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : ""
      };
    },

    clearAll() {
      const entriesCleared = entries.size;
      const bytesCleared = totalBytes;
      entries.clear();
      shareBytes.clear();
      totalBytes = 0;
      totals.evictions += entriesCleared;
      return { entriesCleared, bytesCleared };
    },

    clearSession(sessionId) {
      let entriesCleared = 0;
      let bytesCleared = 0;
      for (const [key, entry] of [...entries]) {
        if (entry.sessionId !== sessionId) continue;
        entriesCleared += 1;
        bytesCleared += entry.bytes;
        deleteEntry(key, "admin");
      }
      return { entriesCleared, bytesCleared };
    },

    snapshot() {
      pruneExpired();
      const cachedShares = new Map();
      for (const entry of entries.values()) {
        if (!cachedShares.has(entry.sessionId)) {
          cachedShares.set(entry.sessionId, {
            sessionId: entry.sessionId,
            user: entry.user,
            entries: 0,
            bytes: 0,
            hits: 0,
            expiresAt: ""
          });
        }
        const share = cachedShares.get(entry.sessionId);
        share.entries += 1;
        share.bytes += entry.bytes;
        share.hits += entry.hits;
        const currentExpiresAt = share.expiresAt ? Date.parse(share.expiresAt) : 0;
        if (entry.expiresAt > currentExpiresAt) {
          share.expiresAt = new Date(entry.expiresAt).toISOString();
        }
      }
      return {
        enabled: maxTotalBytes > 0,
        entryCount: entries.size,
        totalBytes,
        maxTotalBytes,
        hits: totals.hits,
        misses: totals.misses,
        stores: totals.stores,
        evictions: totals.evictions,
        expired: totals.expired,
        cachedShares: [...cachedShares.values()]
      };
    }
  };
}

function loadUsersFile(filePath) {
  const info = statSync(filePath);
  const text = readFileSync(filePath, "utf8");
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid users file JSON: ${error.message}`);
  }

  if (!document || !Array.isArray(document.users) || document.users.length === 0) {
    throw new Error("Invalid users file: expected a non-empty users array.");
  }

  const usersByToken = new Map();
  const usersByName = new Map();
  for (const [index, rawUser] of document.users.entries()) {
    const user = normalizeUser(rawUser, index);
    if (usersByName.has(user.name)) {
      throw new Error(`Invalid users file: duplicate user name "${user.name}".`);
    }
    if (usersByToken.has(user.token)) {
      throw new Error(`Invalid users file: duplicate token for user "${user.name}".`);
    }
    usersByName.set(user.name, user);
    usersByToken.set(user.token, user);
  }

  return { usersByToken, usersByName, mtimeMs: info.mtimeMs };
}

function normalizeUser(rawUser, index) {
  if (!rawUser || typeof rawUser !== "object") {
    throw new Error(`Invalid users file: user at index ${index} must be an object.`);
  }

  const name = String(rawUser.name || "").trim();
  const token = String(rawUser.token || "").trim();
  if (!name) throw new Error(`Invalid users file: user at index ${index} is missing name.`);
  if (!token) throw new Error(`Invalid users file: user "${name}" is missing token.`);
  if (rawUser.enabled === false) {
    return nullUser(name, token);
  }

  const limits = rawUser.limits || {};
  const cache = rawUser.cache || {};
  return {
    name,
    token,
    enabled: true,
    cache: {
      enabled: cache.enabled === true,
      ttlSeconds: nonNegativeInt(cache.ttlSeconds, 0),
      maxFileBytes: nonNegativeInt(cache.maxFileBytes, 0),
      maxShareBytes: nonNegativeInt(cache.maxShareBytes, 0)
    },
    limits: {
      maxActiveShares: positiveInt(limits.maxActiveShares, 1),
      maxPendingPerShare: positiveInt(limits.maxPendingPerShare, MAX_PENDING_PER_SHARE)
    }
  };
}

function nullUser(name, token) {
  return {
    name,
    token,
    enabled: false,
    cache: {
      enabled: false,
      ttlSeconds: 0,
      maxFileBytes: 0,
      maxShareBytes: 0
    },
    limits: {
      maxActiveShares: 0,
      maxPendingPerShare: MAX_PENDING_PER_SHARE
    }
  };
}

function publicUser(user) {
  return {
    name: user.name,
    enabled: user.enabled,
    cache: { ...user.cache },
    limits: { ...user.limits }
  };
}

function createStats(pending, sessions, responseCache) {
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

    addShare({ sessionId, userName, cache, limits, connectedAt, clientIp, userAgent }) {
      totals.sharesStarted += 1;
      const share = {
        sessionId,
        user: userName,
        cache: { ...cache },
        limits: { ...limits },
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
        cache: responseCache.snapshot(),
        users: userStats(sessions),
        activeShares: [...activeShares.values()].map((share) => ({
          ...share,
          cache: {
            ...share.cache,
            ...responseCache.shareStats(share.sessionId)
          }
        })),
        totals: { ...totals }
      };
    }
  };
}

function userStats(sessions) {
  const users = new Map();
  for (const session of sessions.values()) {
    const userName = session.user?.name || "";
    if (!userName) continue;
    if (!users.has(userName)) {
      users.set(userName, {
        name: userName,
        activeShareCount: 0,
        requestCount: 0,
        bytesSent: 0
      });
    }
    const entry = users.get(userName);
    entry.activeShareCount += 1;
    entry.requestCount += session.share?.requestCount || 0;
    entry.bytesSent += session.share?.bytesSent || 0;
  }
  return [...users.values()];
}

function isAdminAuthorized(req) {
  if (!ADMIN_TOKEN) return false;
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${ADMIN_TOKEN}`) return true;
  if (auth.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const password = separator === -1 ? "" : decoded.slice(separator + 1);
    if (password === ADMIN_TOKEN) return true;
  }
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
