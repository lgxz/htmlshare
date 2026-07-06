import { WebSocket, WebSocketServer } from "ws";
import { clientIp, nonNegativeInt, positiveInt, randomId } from "./utils.js";

export function createTunnelHandlers({
  server,
  users,
  sessions,
  pending,
  responseCache,
  stats,
  events,
  maxFileBytes,
  maxPendingRequests,
  defaultCacheMaxEntries,
  defaultCacheMaxBytes,
  cacheMaxTotalBytes,
  logDisconnected
}) {
  function recordRequest({ req, startedAt, sessionId, parsed, status, bytes = 0, error = "", details = {} }) {
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
  }

  installWebSocketServer({
    server,
    users,
    sessions,
    pending,
    responseCache,
    stats,
    events,
    defaultCacheMaxEntries,
    defaultCacheMaxBytes,
    cacheMaxTotalBytes
  });

  return {
    async handleShareRequest({ req, res, parsed, startedAt, match }) {
      const [, sessionId, rawPath = ""] = match;
      let eventWritten = false;
      const writeEvent = (status, bytes = 0, error = "", details = {}) => {
        if (eventWritten) return;
        eventWritten = true;
        recordRequest({ req, startedAt, sessionId, parsed, status, bytes, error, details });
      };

      try {
        if (!["GET", "HEAD"].includes(req.method || "")) {
          res.writeHead(405, { allow: "GET, HEAD" });
          res.end();
          writeEvent(405, 0, "method_not_allowed");
          return;
        }

        const requestPath = `/${rawPath}${parsed.search}`;
        const cached = responseCache.get(sessionId, requestPath);
        if (cached) {
          const headers = { ...cached.headers, "x-htmlshare-cache": "hit" };
          if (req.method === "HEAD") {
            res.writeHead(cached.status, headers);
            res.end();
            writeEvent(cached.status, 0, "", { user: cached.user, cache: "hit" });
          } else {
            res.writeHead(cached.status, headers);
            res.end(cached.body);
            writeEvent(cached.status, cached.bytes, "", { user: cached.user, cache: "hit" });
          }
          return;
        }

        const session = sessions.get(sessionId);
        if (!session || session.ws.readyState !== WebSocket.OPEN) {
          res.writeHead(410, { "content-type": "text/plain; charset=utf-8" });
          res.end("This share is not connected.\n");
          if (logDisconnected) writeEvent(410, 0, "share_not_connected");
          return;
        }

        const maxPendingForShare = session.user.limits.maxPendingPerShare;
        if (pending.size >= maxPendingRequests || pendingCountForSession(pending, sessionId) >= maxPendingForShare) {
          res.writeHead(429, { "content-type": "text/plain; charset=utf-8", "retry-after": "5" });
          res.end("Too many in-flight requests.\n");
          writeEvent(429, 0, "too_many_pending_requests");
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
          writeEvent(message.status, Buffer.byteLength(body), body.trim());
          return;
        }

        const headers = {
          "content-type": message.contentType || "application/octet-stream",
          "cache-control": "no-store"
        };
        const body = req.method === "HEAD" ? null : decodeResponseBody(message, maxFileBytes);
        if (body) headers["content-length"] = String(body.length);
        else if (typeof message.size === "number" && message.size <= maxFileBytes) headers["content-length"] = String(message.size);
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
          writeEvent(message.status || 200, 0);
        } else {
          res.end(body);
          writeEvent(message.status || 200, body.length);
        }
      } catch (error) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`${error.message}\n`);
        writeEvent(502, 0, error.message);
      }
    }
  };
}

function installWebSocketServer({
  server,
  users,
  sessions,
  pending,
  responseCache,
  stats,
  events,
  defaultCacheMaxEntries,
  defaultCacheMaxBytes,
  cacheMaxTotalBytes
}) {
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

        const cachePolicy = effectiveCachePolicy({
          userCache: user.cache,
          clientCache: message.cache || {},
          defaultCacheMaxEntries,
          defaultCacheMaxBytes,
          cacheMaxTotalBytes
        });
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

      if (message.type === "stop" && registeredSession) {
        const session = sessions.get(registeredSession);
        const cleared = message.purgeCache === true
          ? responseCache.clearSession(registeredSession)
          : { entriesCleared: 0, bytesCleared: 0 };
        events.record({
          type: "share_stopped",
          sessionId: registeredSession,
          user: session?.user?.name || "",
          purgeCache: message.purgeCache === true,
          ...cleared
        });
        ws.close(1000, "Stopped");
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
}

function decodeResponseBody(message, maxFileBytes) {
  const encoded = message.body || "";
  if (typeof encoded !== "string") {
    throw new Error("Shared client returned an invalid response body");
  }

  if (typeof message.size === "number" && message.size > maxFileBytes) {
    throw new Error("Shared client response is too large");
  }

  const maxBase64Length = Math.ceil(maxFileBytes / 3) * 4 + 4;
  if (encoded.length > maxBase64Length) {
    throw new Error("Shared client response is too large");
  }

  const body = Buffer.from(encoded, "base64");
  if (body.length > maxFileBytes) {
    throw new Error("Shared client response is too large");
  }

  if (typeof message.size === "number" && body.length !== message.size) {
    throw new Error("Shared client response size mismatch");
  }

  return body;
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

function effectiveCachePolicy({
  userCache,
  clientCache,
  defaultCacheMaxEntries,
  defaultCacheMaxBytes,
  cacheMaxTotalBytes
}) {
  const clientEnabled = clientCache.enabled === true;
  const clientTtl = nonNegativeInt(clientCache.ttlSeconds, 0);
  const userTtl = nonNegativeInt(userCache.ttlSeconds, 0);
  const userCacheEnabled = userCache.enabled === true;
  const maxEntries = userCacheEnabled ? positiveInt(userCache.maxEntries, defaultCacheMaxEntries) : 0;
  const maxBytes = userCacheEnabled ? positiveInt(userCache.maxBytes, defaultCacheMaxBytes) : 0;
  const ttlSeconds = Math.min(userTtl, clientTtl);
  const enabled = userCacheEnabled &&
    clientEnabled &&
    ttlSeconds > 0 &&
    maxEntries > 0 &&
    maxBytes > 0 &&
    cacheMaxTotalBytes > 0;

  return {
    enabled,
    ttlSeconds: enabled ? ttlSeconds : 0,
    maxEntries,
    maxBytes
  };
}
