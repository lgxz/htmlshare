export function createStats(pending, sessions, responseCache) {
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
