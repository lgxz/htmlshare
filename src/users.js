import { readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { parseDurationSeconds, positiveInt, nonNegativeInt } from "./utils.js";

export function createUserStore(filePath, events, defaults) {
  let usersByToken = new Map();
  let usersByName = new Map();
  let lastMtimeMs = 0;

  return {
    load() {
      const result = loadUsersFile(filePath, defaults);
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
          const result = loadUsersFile(filePath, defaults);
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

function loadUsersFile(filePath, defaults) {
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
    const user = normalizeUser(rawUser, index, defaults);
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

function normalizeUser(rawUser, index, defaults) {
  if (!rawUser || typeof rawUser !== "object") {
    throw new Error(`Invalid users file: user at index ${index} must be an object.`);
  }

  const name = String(rawUser.name || "").trim();
  const token = String(rawUser.token || "").trim();
  if (!name) throw new Error(`Invalid users file: user at index ${index} is missing name.`);
  if (!token) throw new Error(`Invalid users file: user "${name}" is missing token.`);
  if (rawUser.enabled === false) {
    return nullUser(name, token, defaults);
  }

  const limits = rawUser.limits || {};
  const cache = rawUser.cache || {};
  const publish = rawUser.publish || {};
  const cacheEnabled = cache.enabled === true;
  const ttlSeconds = parseCacheTtlSeconds(cache);
  const publishEnabled = publish.enabled === true;
  return {
    name,
    token,
    enabled: true,
    cache: {
      enabled: cacheEnabled,
      ttlSeconds,
      maxEntries: cacheEnabled ? positiveInt(cache.maxEntries, defaults.cacheMaxEntries) : 0,
      maxBytes: cacheEnabled ? positiveInt(cache.maxBytes ?? cache.maxShareBytes, defaults.cacheMaxBytes) : 0
    },
    limits: {
      maxActiveShares: positiveInt(limits.maxActiveShares, 1),
      maxPendingPerShare: positiveInt(limits.maxPendingPerShare, defaults.maxPendingPerShare)
    },
    publish: {
      enabled: publishEnabled,
      allowedSlugs: publishEnabled ? stringList(publish.allowedSlugs) : [],
      maxFiles: publishEnabled ? positiveInt(publish.maxFiles, defaults.publishMaxFiles) : 0,
      maxBytes: publishEnabled ? positiveInt(publish.maxBytes, defaults.publishMaxBytes) : 0,
      maxFileBytes: publishEnabled ? positiveInt(publish.maxFileBytes, defaults.publishMaxFileBytes) : 0
    }
  };
}

function parseCacheTtlSeconds(cache) {
  if (cache.ttl !== undefined) return parseDurationSeconds(cache.ttl);
  return nonNegativeInt(cache.ttlSeconds, 0);
}

function nullUser(name, token, defaults) {
  return {
    name,
    token,
    enabled: false,
    cache: {
      enabled: false,
      ttlSeconds: 0,
      maxEntries: 0,
      maxBytes: 0
    },
    limits: {
      maxActiveShares: 0,
      maxPendingPerShare: defaults.maxPendingPerShare
    },
    publish: {
      enabled: false,
      allowedSlugs: [],
      maxFiles: 0,
      maxBytes: 0,
      maxFileBytes: 0
    }
  };
}

function publicUser(user) {
  return {
    name: user.name,
    enabled: user.enabled,
    cache: { ...user.cache },
    limits: { ...user.limits },
    publish: { ...user.publish }
  };
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}
