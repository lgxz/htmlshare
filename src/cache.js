export function createResponseCache({ maxTotalBytes, events }) {
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

  function countShareEntries(sessionId) {
    let count = 0;
    for (const entry of entries.values()) {
      if (entry.sessionId === sessionId) count += 1;
    }
    return count;
  }

  function evictShareToFit(sessionId, neededBytes, policy) {
    while (
      (shareBytes.get(sessionId) || 0) + neededBytes > policy.maxBytes ||
      countShareEntries(sessionId) >= policy.maxEntries
    ) {
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
      if (bytes <= 0 || bytes > policy.maxBytes || bytes > maxTotalBytes) {
        return false;
      }

      pruneExpired();
      const key = keyFor(sessionId, requestPath);
      deleteEntry(key, "");
      evictShareToFit(sessionId, bytes, policy);
      evictGlobalToFit(bytes);
      if (
        (shareBytes.get(sessionId) || 0) + bytes > policy.maxBytes ||
        countShareEntries(sessionId) >= policy.maxEntries ||
        totalBytes + bytes > maxTotalBytes
      ) {
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
