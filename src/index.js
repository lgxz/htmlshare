#!/usr/bin/env node

import { createServer } from "node:http";
import path from "node:path";
import { handleAdminRequest } from "./admin.js";
import { runPublishClient, runShareClient } from "./client.js";
import { createResponseCache } from "./cache.js";
import { createEventRecorder } from "./events.js";
import { createPublishHandlers } from "./publish.js";
import { createStats } from "./stats.js";
import { createTunnelHandlers } from "./tunnel.js";
import { createUserStore } from "./users.js";
import {
  clientIp,
  nonNegativeInt,
  positiveInt,
  readOption
} from "./utils.js";

const MAX_FILE_BYTES = Number(process.env.HTMLSHARE_MAX_FILE_BYTES || 10 * 1024 * 1024);
const DEFAULT_PORT = Number(process.env.PORT || 8080);
const DEFAULT_EVENT_LOG = process.env.HTMLSHARE_EVENT_LOG || path.resolve("data/events.jsonl");
const LOG_UNMATCHED = process.env.HTMLSHARE_LOG_UNMATCHED === "1";
const LOG_DISCONNECTED = process.env.HTMLSHARE_LOG_DISCONNECTED === "1";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const MAX_PENDING_REQUESTS = positiveInt(process.env.HTMLSHARE_MAX_PENDING_REQUESTS, 100);
const MAX_PENDING_PER_SHARE = positiveInt(process.env.HTMLSHARE_MAX_PENDING_PER_SHARE, 10);
const CACHE_MAX_TOTAL_BYTES = nonNegativeInt(process.env.HTMLSHARE_CACHE_MAX_TOTAL_BYTES, 512 * 1024 * 1024);
const DEFAULT_CACHE_MAX_ENTRIES = positiveInt(process.env.HTMLSHARE_CACHE_MAX_ENTRIES, 100);
const DEFAULT_CACHE_MAX_BYTES = positiveInt(process.env.HTMLSHARE_CACHE_MAX_BYTES, 100 * 1024 * 1024);
const DEFAULT_PUBLISH_MAX_FILES = positiveInt(process.env.HTMLSHARE_PUBLISH_MAX_FILES, 200);
const DEFAULT_PUBLISH_MAX_BYTES = positiveInt(process.env.HTMLSHARE_PUBLISH_MAX_BYTES, 100 * 1024 * 1024);
const DEFAULT_PUBLISH_MAX_FILE_BYTES = positiveInt(process.env.HTMLSHARE_PUBLISH_MAX_FILE_BYTES, MAX_FILE_BYTES);
const PUBLISHED_DIR = process.env.HTMLSHARE_PUBLISHED_DIR || path.resolve("data/published");
const DEFAULT_SERVER_URL = "wss://share.xxyy.eu.org/tunnel";
const DEFAULT_PUBLIC_BASE_URL = "https://share.xxyy.eu.org";
const DEFAULT_SHARE_TOKEN = "69a00c76d73257a4369f868d71ffdccaeb6391fcb6cc074b";

const command = process.argv[2];

if (command === "server") {
  runServer();
} else if (command === "client") {
  runShareClient({
    defaultServerUrl: DEFAULT_SERVER_URL,
    defaultPublicBaseUrl: DEFAULT_PUBLIC_BASE_URL,
    defaultShareToken: DEFAULT_SHARE_TOKEN,
    maxFileBytes: MAX_FILE_BYTES
  }).then((ok) => {
    if (!ok) {
      usage();
      process.exit(64);
    }
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
} else if (command === "publish") {
  runPublishClient({
    defaultServerUrl: DEFAULT_SERVER_URL,
    defaultShareToken: DEFAULT_SHARE_TOKEN
  }).then((ok) => {
    if (!ok) {
      usage();
      process.exit(64);
    }
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
} else {
  usage();
  process.exit(command ? 64 : 0);
}

function usage() {
  console.log(`Usage:
  htmlshare server [--port 8080]
  htmlshare client --file /path/to/file.html [--server ws://localhost:8080/tunnel] [--cache-ttl 10m]
  htmlshare publish --file /path/to/index.html --slug demo
  htmlshare publish --dir /path/to/site --entry index.html --slug demo

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
  HTMLSHARE_CACHE_MAX_ENTRIES Default per-share cached file count for cache-enabled users, default 100
  HTMLSHARE_CACHE_MAX_BYTES   Default per-share cache size for cache-enabled users, default 100MB
  HTMLSHARE_PUBLISHED_DIR     Persistent publish directory, default data/published
  HTMLSHARE_PUBLISH_MAX_FILES Default publish file-count limit, default 200
  HTMLSHARE_PUBLISH_MAX_BYTES Default publish total byte limit, default 100MB
  HTMLSHARE_PUBLISH_MAX_FILE_BYTES Default publish single-file limit, default HTMLSHARE_MAX_FILE_BYTES
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
  const users = createUserStore(usersFile, events, {
    maxPendingPerShare: MAX_PENDING_PER_SHARE,
    cacheMaxEntries: DEFAULT_CACHE_MAX_ENTRIES,
    cacheMaxBytes: DEFAULT_CACHE_MAX_BYTES,
    publishMaxFiles: DEFAULT_PUBLISH_MAX_FILES,
    publishMaxBytes: DEFAULT_PUBLISH_MAX_BYTES,
    publishMaxFileBytes: DEFAULT_PUBLISH_MAX_FILE_BYTES
  });
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
  const publishHandlers = createPublishHandlers({
    users,
    events,
    publishedDir: PUBLISHED_DIR
  });
  const stats = createStats(pending, sessions, responseCache);
  let tunnelHandlers;

  const server = createServer(async (req, res) => {
    const startedAt = Date.now();

    try {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("ok\n");
        return;
      }

      const parsed = new URL(req.url || "/", "http://localhost");
      if (parsed.pathname === "/api/publish") {
        await publishHandlers.handlePublishRequest({ req, res, parsed });
        return;
      }

      if (await publishHandlers.handlePublishedRequest({ req, res, parsed })) {
        return;
      }

      if (parsed.pathname === "/admin" || parsed.pathname.startsWith("/admin/")) {
        await handleAdminRequest({
          req,
          res,
          parsed,
          users,
          responseCache,
          stats,
          events,
          adminToken: ADMIN_TOKEN
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

      await tunnelHandlers.handleShareRequest({ req, res, parsed, startedAt, match });
    } catch (error) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`${error.message}\n`);
    }
  });

  tunnelHandlers = createTunnelHandlers({
    server,
    users,
    sessions,
    pending,
    responseCache,
    stats,
    events,
    maxFileBytes: MAX_FILE_BYTES,
    maxPendingRequests: MAX_PENDING_REQUESTS,
    defaultCacheMaxEntries: DEFAULT_CACHE_MAX_ENTRIES,
    defaultCacheMaxBytes: DEFAULT_CACHE_MAX_BYTES,
    cacheMaxTotalBytes: CACHE_MAX_TOTAL_BYTES,
    logDisconnected: LOG_DISCONNECTED
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`htmlshare server listening on :${port}`);
    events.record({ type: "server_started", port, eventLog: DEFAULT_EVENT_LOG, usersFile });
  });
}
