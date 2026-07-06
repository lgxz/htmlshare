export async function handleAdminRequest({ req, res, parsed, users, responseCache, stats, events, adminToken }) {
  if (!isAdminAuthorized(req, adminToken)) {
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
    const fmtDuration = (seconds) => {
      if (!seconds) return "off";
      if (seconds % 604800 === 0) return (seconds / 604800) + "w";
      if (seconds % 86400 === 0) return (seconds / 86400) + "d";
      if (seconds % 3600 === 0) return (seconds / 3600) + "h";
      if (seconds % 60 === 0) return (seconds / 60) + "m";
      return seconds + "s";
    };
    const fmtTime = (value) => value ? new Date(value).toLocaleString() : "-";
    const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    const text = (value) => value === undefined || value === null || value === "" ? "-" : esc(value);

    async function api(path, options) {
      const headers = options && options.method === "POST" ? { "x-admin-action": "1" } : {};
      const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...options, headers: { ...headers, ...(options?.headers || {}) } });
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
        '<td>' + ((share.cache && share.cache.enabled) ? '<span class="pill ok">' + fmtDuration(share.cache.ttlSeconds) + '</span>' : '<span class="pill">off</span>') + '</td>' +
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
          '<td>' + (user.cache?.enabled ? '<span class="pill ok">' + fmtDuration(user.cache.ttlSeconds) + '</span>' : '<span class="pill">off</span>') + '</td>' +
          '<td>' + (user.cache?.maxEntries || 0) + '</td>' +
          '<td>' + fmtBytes(user.cache?.maxBytes || 0) + '</td>' +
          '<td>' + (user.publish?.enabled ? '<span class="pill ok">' + (user.publish.allowedSlugs?.length ? text(user.publish.allowedSlugs.join(", ")) : "any") + '</span>' : '<span class="pill">off</span>') + '</td>' +
        '</tr>';
      });
      table("#users", ["User", "Status", "Active", "Max shares", "Pending/share", "Cache", "Max entries", "Max bytes", "Publish"], rows);
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

function isAdminAuthorized(req, adminToken) {
  if (!adminToken) return false;
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${adminToken}`) return true;
  if (!auth.startsWith("Basic ")) return req.headers["x-admin-token"] === adminToken;
  const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
  const password = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded;
  return password === adminToken || req.headers["x-admin-token"] === adminToken;
}
