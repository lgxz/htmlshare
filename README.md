# htmlshare

Private one-off HTML sharing through a single HTTPS relay.

## Shape

- Server: Docker Compose on a VPS, exposed on `443`.
- Client: native macOS Swift app.
- Sharing ends when the app window is closed or `Stop` is clicked.

## Server

Point a domain such as `share.example.com` to the VPS, then create `.env`:

```bash
cp .env.example .env
cp users.example.json users.json
chmod 600 users.json
```

Edit `.env`:

```bash
SHARE_DOMAIN=share.example.com
ADMIN_TOKEN=change-this-different-long-random-token
HTMLSHARE_USERS_FILE=/config/users.json
HTMLSHARE_USERS_RELOAD_SECONDS=5
HTMLSHARE_MAX_FILE_BYTES=10485760
HTMLSHARE_EVENT_LOG=/data/events.jsonl
HTMLSHARE_LOG_UNMATCHED=0
HTMLSHARE_LOG_DISCONNECTED=0
HTMLSHARE_MAX_PENDING_REQUESTS=100
HTMLSHARE_MAX_PENDING_PER_SHARE=10
HTMLSHARE_CACHE_MAX_TOTAL_BYTES=536870912
```

Edit `users.json`:

```json
{
  "users": [
    {
      "name": "lgx",
      "token": "change-this-long-random-token",
      "enabled": true,
      "cache": {
        "enabled": true,
        "ttlSeconds": 1800,
        "maxFileBytes": 1048576,
        "maxShareBytes": 52428800
      },
      "limits": {
        "maxActiveShares": 5,
        "maxPendingPerShare": 10
      }
    }
  ]
}
```

`users.json` is hot-reloaded. New shares use the latest file within `HTMLSHARE_USERS_RELOAD_SECONDS`; existing connected shares keep the user policy snapshot from registration.

Start the relay:

```bash
docker compose up -d --build
```

Check it:

```bash
curl https://share.example.com/healthz
```

Events are appended as JSONL. In Docker Compose the default path is `/data/events.jsonl`; local development defaults to `data/events.jsonl`.

```bash
docker compose exec htmlshare tail -f /data/events.jsonl
```

The event recorder is isolated behind `record(event)` in `src/index.js`, so the JSONL storage can be replaced by SQLite later without changing request/session handling.

Users are configured in `users.json`. Each token has its own active-share, per-share pending-request, and cache limits.

Cache policy is a permission upper bound. Clients still choose whether a specific share requests cache and for how long. The server uses the stricter result and returns the effective cache policy when the share is registered.

The cache is in memory only. It stores successful `GET /s/<session-id>/<path>` responses, can serve cached files after the client disconnects until TTL expiry, and is cleared when the server process restarts. `HEAD` can read an existing cached `GET` response but does not create cache entries.

Unmatched scanner traffic such as `/wp-login.php` or `/.env` is not logged by default. Set `HTMLSHARE_LOG_UNMATCHED=1` to include those 404s for diagnostics.

Requests for disconnected or random `/s/<session-id>/...` URLs are not logged by default. Set `HTMLSHARE_LOG_DISCONNECTED=1` to include those 410s for diagnostics.

The relay limits in-flight browser requests before forwarding them to a sharing client:

- `HTMLSHARE_MAX_PENDING_REQUESTS`: global in-flight request limit.
- `limits.maxPendingPerShare`: per-user per-share in-flight request limit.

The relay also limits cache memory:

- `HTMLSHARE_CACHE_MAX_TOTAL_BYTES`: global in-memory cache limit.
- `cache.maxFileBytes`: per-token single cached file limit.
- `cache.maxShareBytes`: per-token per-share cache limit.

Admin status:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://share.example.com/admin/status
```

Admin page:

```text
https://share.example.com/admin
```

The browser uses Basic Auth. Enter any username, and use `ADMIN_TOKEN` as the password.

The first admin page is intentionally small:

- View uptime, active shares, configured users, request totals, and cache stats.
- Clear all in-memory cache.
- Clear one cached session.
- Reload `users.json`.

The status response includes uptime, active shares, client IPs, per-share counters, pending request count, and startup totals:

```json
{
  "activeShareCount": 1,
  "pendingRequestCount": 0,
  "cache": {
    "entryCount": 2,
    "totalBytes": 20480,
    "maxTotalBytes": 536870912,
    "hits": 3,
    "misses": 1
  },
  "activeShares": [
    {
      "sessionId": "XMKjEa6GLXk",
      "user": "lgx",
      "cache": {
        "enabled": false,
        "ttlSeconds": 0,
        "maxFileBytes": 0,
        "maxShareBytes": 0
      },
      "limits": {
        "maxActiveShares": 5,
        "maxPendingPerShare": 10
      },
      "connectedAt": "2026-07-06T00:00:00.000Z",
      "clientIp": "203.0.113.10",
      "requestCount": 3,
      "lastPath": "/s/XMKjEa6GLXk/travel-guide.html",
      "bytesSent": 12345
    }
  ]
}
```

## macOS App

Create the local client config:

```bash
mkdir -p ~/.htmlshare
cp client.env.example ~/.htmlshare/client.env
```

Edit `~/.htmlshare/client.env`:

```bash
HTMLSHARE_SERVER=wss://share.example.com/tunnel
PUBLIC_BASE_URL=https://share.example.com
SHARE_TOKEN=change-this-long-random-token
```

`SHARE_TOKEN` is the token for one user in `users.json`. `HtmlShareSwift.app` reads this file at runtime. Changing the server URL or token only requires editing `~/.htmlshare/client.env` and restarting the app; rebuilding is not required.

Build the app:

```bash
scripts/build-swift-app.sh
```

The app is generated at:

```bash
dist/HtmlShareSwift.app
```

Package it:

```bash
cd dist
ditto -c -k --sequesterRsrc --keepParent HtmlShareSwift.app HtmlShareSwift-macos-arm64.zip
```

## Go CLI

The Go CLI uses the same `~/.htmlshare/client.env` config as the macOS app and prints each visit with IP, browser, OS, status, bytes, and path.

Run from source:

```bash
go run ./cmd/htmlshare-go --file /path/to/file.html --cache-ttl 10m
```

Build a local binary:

```bash
go build -o dist/htmlshare-go ./cmd/htmlshare-go
```

Cross-compile examples:

```bash
GOOS=windows GOARCH=amd64 go build -o dist/htmlshare-go-windows-amd64.exe ./cmd/htmlshare-go
GOOS=linux GOARCH=amd64 go build -o dist/htmlshare-go-linux-amd64 ./cmd/htmlshare-go
GOOS=darwin GOARCH=arm64 go build -o dist/htmlshare-go-macos-arm64 ./cmd/htmlshare-go
```

## Use

1. Open `HtmlShareSwift.app`.
2. Optional: choose `Cache 5 min`, `Cache 10 min`, or `Cache 30 min`.
3. Click `Choose File`.
4. Select an `.html` or `.htm` file.
5. The share URL is displayed and copied to the clipboard.
6. Click `Stop` or close the window to end sharing.

## Local Smoke Test

Server:

```bash
npm install
HTMLSHARE_USERS_FILE=users.example.json npm run server
```

Client:

```bash
PUBLIC_BASE_URL=http://localhost:8080 npm run client -- --server ws://localhost:8080/tunnel --file /path/to/file.html
```

Go client:

```bash
HTMLSHARE_SERVER=ws://localhost:8080/tunnel PUBLIC_BASE_URL=http://localhost:8080 SHARE_TOKEN=change-this-long-random-token go run ./cmd/htmlshare-go --file /path/to/file.html --cache-ttl 10m
```

Open the printed URL.

## Notes

- Only the selected HTML file's directory is shared.
- Paths cannot escape that directory.
- Default max single-file response is 10MB. Override with `HTMLSHARE_MAX_FILE_BYTES`.
- The app prefers `~/.htmlshare/client.env` at runtime. A bundled `client.env` is only a fallback.
- The native macOS app and Go CLI show visitor records, including IP, browser, and OS.
- Server authentication uses `users.json`; client config still uses `SHARE_TOKEN` for the selected user's token.
- Cache defaults to off per share. Swift and Go clients can request a TTL, capped by `users.json`.
- To implement another platform client, see `docs/client-protocol.md`.
- Server events are written to `HTMLSHARE_EVENT_LOG` as JSONL by default.
- Non-share-path scanner traffic is ignored unless `HTMLSHARE_LOG_UNMATCHED=1`.
