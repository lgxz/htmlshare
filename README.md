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
```

Edit `.env`:

```bash
SHARE_DOMAIN=share.example.com
SHARE_TOKEN=change-this-long-random-token
ADMIN_TOKEN=change-this-different-long-random-token
HTMLSHARE_MAX_FILE_BYTES=10485760
HTMLSHARE_EVENT_LOG=/data/events.jsonl
HTMLSHARE_LOG_UNMATCHED=0
```

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

Unmatched scanner traffic such as `/wp-login.php` or `/.env` is not logged by default. Set `HTMLSHARE_LOG_UNMATCHED=1` to include those 404s for diagnostics.

Admin status:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://share.example.com/admin/status
```

The status response includes uptime, active shares, client IPs, per-share counters, pending request count, and startup totals:

```json
{
  "activeShareCount": 1,
  "pendingRequestCount": 0,
  "activeShares": [
    {
      "sessionId": "XMKjEa6GLXk",
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

`HtmlShareSwift.app` reads this file at runtime. Changing the server URL or token only requires editing `~/.htmlshare/client.env` and restarting the app; rebuilding is not required.

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

## Use

1. Open `HtmlShareSwift.app`.
2. Click `Choose File`.
3. Select an `.html` or `.htm` file.
4. The share URL is displayed and copied to the clipboard.
5. Click `Stop` or close the window to end sharing.

## Local Smoke Test

Server:

```bash
npm install
npm run server
```

Client:

```bash
PUBLIC_BASE_URL=http://localhost:8080 npm run client -- --server ws://localhost:8080/tunnel --file /path/to/file.html
```

Open the printed URL.

## Notes

- Only the selected HTML file's directory is shared.
- Paths cannot escape that directory.
- Default max single-file response is 10MB. Override with `HTMLSHARE_MAX_FILE_BYTES`.
- The app prefers `~/.htmlshare/client.env` at runtime. A bundled `client.env` is only a fallback.
- To implement another platform client, see `docs/client-protocol.md`.
- Server events are written to `HTMLSHARE_EVENT_LOG` as JSONL by default.
- Non-share-path scanner traffic is ignored unless `HTMLSHARE_LOG_UNMATCHED=1`.
