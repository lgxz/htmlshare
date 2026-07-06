# HtmlShare Client Protocol

This document describes how to implement a HtmlShare client in any language or platform.

The existing macOS app is only one client implementation. A Windows, Linux, iOS, Android, CLI, or browser-extension companion can use the same protocols.

## Overview

HtmlShare supports two client modes.

Temporary sharing keeps a client connected through the relay:

```text
local client
  -> opens WebSocket to relay /tunnel
  -> registers a random session id
  -> receives file requests from the relay
  -> responds with file bytes as base64 JSON

browser
  -> GET https://share.example.com/s/<session-id>/<path>
  -> relay forwards request to the connected client
  -> relay returns the client's response
```

The relay only listens on normal HTTPS/WSS. The client initiates the outbound connection, so it does not need a public IP or inbound port.

Permanent publishing uploads a static snapshot to server disk:

```text
local client
  -> scans a directory
  -> POSTs manifest + base64 file bytes to /api/publish
  -> receives a fixed public URL

browser
  -> GET https://share.example.com/p/<slug>/<path>
  -> relay serves the file directly from disk
```

## Configuration

A client needs:

```env
HTMLSHARE_SERVER=wss://share.example.com/tunnel
PUBLIC_BASE_URL=https://share.example.com
SHARE_TOKEN=shared-secret-token
```

`HTMLSHARE_SERVER` is the WebSocket endpoint.

`PUBLIC_BASE_URL` is used by the client to print or display the browser URL.

`SHARE_TOKEN` is sent when registering. The relay matches it against a user token in `users.json`; clients with unknown or disabled tokens are rejected.

For publishing, the same `SHARE_TOKEN` is sent as an HTTP bearer token. The relay accepts it only when the matching user has publish permission.

The first-party macOS app, Go CLI, and Node client include built-in defaults for `https://share.xxyy.eu.org` using the no-cache `public` user token. A third-party client can do the same only if that token is present in the target relay's `users.json`. Local config and environment variables should override built-in defaults.

## Temporary Share URLs

### Session ID

Generate a random URL-safe session id for every share.

Recommended:

- At least 64 bits of randomness.
- URL-safe base64 without padding, or hex.
- Example: `XMKjEa6GLXk`.

The public share URL is:

```text
<PUBLIC_BASE_URL>/s/<session-id>/<entry-file-name>
```

Example:

```text
https://share.example.com/s/XMKjEa6GLXk/travel-guide.html
```

### WebSocket Registration

Connect to:

```text
wss://share.example.com/tunnel
```

Immediately send:

```json
{
  "type": "register",
  "sessionId": "XMKjEa6GLXk",
  "token": "shared-secret-token",
  "cache": {
    "enabled": true,
    "ttlSeconds": 600
  }
}
```

The relay replies:

```json
{
  "type": "registered",
  "sessionId": "XMKjEa6GLXk",
  "cache": {
    "enabled": true,
    "ttlSeconds": 600,
    "maxEntries": 100,
    "maxBytes": 104857600
  }
}
```

After this, the public share URL can be copied to the clipboard or shown in the UI.

The `cache` field on registration is optional. If omitted, caching is off for that share. The relay treats the user token's cache policy as an upper bound and the client request as the per-share preference. The effective policy returned in `registered.cache` is what the relay will actually use.

If the user's token does not permit cache, the relay returns:

```json
{
  "enabled": false,
  "ttlSeconds": 0,
  "maxEntries": 0,
  "maxBytes": 0
}
```

User configuration may express cache TTL as a duration string, such as `"ttl": "1d"`, `"ttl": "3d"`, or `"ttl": "1w"`. WebSocket protocol messages continue to use `ttlSeconds` so clients receive one normalized value.

To explicitly stop a share and ask the relay to clear any cached files for that session, send:

```json
{
  "type": "stop",
  "sessionId": "XMKjEa6GLXk",
  "purgeCache": true
}
```

The relay closes the WebSocket after processing the stop message. If the client simply disconnects or exits without sending `stop`, cached files can continue to be served until their TTL expires.

### Request Message

When a browser requests a shared file, the relay sends this message to the connected client:

```json
{
  "type": "request",
  "id": "request-id",
  "method": "GET",
  "path": "/travel-guide.html",
  "visitor": {
    "ip": "203.0.113.10",
    "userAgent": "Mozilla/5.0 ...",
    "referer": "https://example.com/",
    "at": "2026-07-06T10:20:30.000Z"
  }
}
```

Fields:

- `id`: unique request id. Echo this in the response.
- `method`: currently `GET` or `HEAD`.
- `path`: URL path and optional query string, rooted at the shared directory.
- `visitor`: best-effort browser visitor metadata supplied by the relay.
- `visitor.ip`: browser client IP after trusted reverse-proxy headers.
- `visitor.userAgent`: browser `User-Agent` header, or an empty string.
- `visitor.referer`: browser `Referer` header, or an empty string.
- `visitor.at`: relay receive time in ISO 8601 format.

### Response Message

For success:

```json
{
  "type": "response",
  "id": "request-id",
  "status": 200,
  "contentType": "text/html; charset=utf-8",
  "size": 12345,
  "body": "PGh0bWw+Li4uPC9odG1sPg=="
}
```

For errors:

```json
{
  "type": "response",
  "id": "request-id",
  "status": 404,
  "error": "Not found\n"
}
```

Fields:

- `type`: always `response`.
- `id`: copied from the request.
- `status`: HTTP status code returned by the relay to the browser.
- `contentType`: MIME type for successful responses.
- `size`: byte length of the decoded body. For `HEAD`, this can be sent without `body` so the relay can set `Content-Length`.
- `body`: base64-encoded file bytes. Required for successful `GET` responses; optional for `HEAD`.
- `error`: plain-text error body for responses with `status >= 400`.

For browser `HEAD` requests, the relay forwards a `HEAD` request message to the client and does not send a response body to the browser. A client may either send `size` only or reuse its normal `GET` response shape; the relay ignores the body for `HEAD`.

## Permanent Publish

Publishing creates or replaces a fixed URL:

```text
<PUBLIC_BASE_URL>/p/<slug>/
```

Example:

```text
https://share.example.com/p/demo/
```

`slug` is the permanent URL name. `entry` is the default file returned when a browser requests `/p/<slug>/`.

### Publish Request

Send:

```http
POST /api/publish
Authorization: Bearer shared-secret-token
Content-Type: application/json
```

Request body:

```json
{
  "slug": "demo",
  "entry": "index.html",
  "files": [
    {
      "path": "index.html",
      "contentType": "text/html; charset=utf-8",
      "sha256": "7a38...",
      "size": 12345,
      "body": "PGh0bWw+Li4uPC9odG1sPg=="
    },
    {
      "path": "assets/app.css",
      "contentType": "text/css; charset=utf-8",
      "sha256": "95d0...",
      "size": 456,
      "body": "aDF7Y29sb3I6IzI0NX0="
    }
  ]
}
```

Fields:

- `slug`: fixed public name. Current server accepts lowercase letters, numbers, and hyphens, beginning with a lowercase letter or number.
- `entry`: relative path to the default file for `/p/<slug>/`; it must be present in `files`.
- `files`: uploaded static snapshot.
- `files[].path`: slash-separated relative path inside the published site.
- `files[].contentType`: MIME type returned when serving this file.
- `files[].sha256`: lowercase hex SHA-256 of decoded file bytes.
- `files[].size`: decoded byte length.
- `files[].body`: base64-encoded file bytes.

The server validates token permissions, allowed slugs, file count, total bytes, per-file bytes, path safety, `entry`, `size`, and `sha256`.

### Publish Response

For success:

```json
{
  "ok": true,
  "slug": "demo",
  "entry": "index.html",
  "files": 2,
  "bytes": 12801,
  "url": "/p/demo/"
}
```

For errors:

```json
{
  "ok": false,
  "error": "Slug is not allowed for this user"
}
```

Clients should treat non-2xx HTTP status codes or `"ok": false` as failure.

### Published File Serving

Browsers can request:

```text
GET  /p/<slug>/
HEAD /p/<slug>/
GET  /p/<slug>/<path>
HEAD /p/<slug>/<path>
```

When `<path>` is omitted, the server serves the published `entry`. Published HTML uses `Cache-Control: no-cache`; other static assets use a long immutable cache header.

## File Resolution Rules

A safe client should:

1. Share the selected HTML file's containing directory, not the whole disk.
2. Percent-decode the requested path.
3. Normalize the path.
4. Resolve symlinks if the platform supports it.
5. Reject any path that escapes the shared directory.
6. Return `404` for missing files or directories.
7. Return `413` for files larger than the client limit.

The current implementations use a 10MB single-file limit by default.

A safe publish client should:

1. Publish the selected entry file's containing directory or an explicitly selected directory.
2. Use slash-separated relative paths in `files[].path`.
3. Reject absolute paths, empty paths, `..` paths, and NUL bytes.
4. Resolve symlinks if the platform supports it.
5. Reject any symlink or file path that escapes the published directory.
6. Include only regular files.
7. Compute `sha256` and `size` from the exact decoded bytes in `body`.

## MIME Types

At minimum, support:

```text
.html .htm -> text/html; charset=utf-8
.css       -> text/css; charset=utf-8
.js .mjs   -> text/javascript; charset=utf-8
.json      -> application/json; charset=utf-8
.png       -> image/png
.jpg .jpeg -> image/jpeg
.gif       -> image/gif
.svg       -> image/svg+xml
.webp      -> image/webp
.ico       -> image/x-icon
.txt       -> text/plain; charset=utf-8
.pdf       -> application/pdf
```

Unknown files can use:

```text
application/octet-stream
```

## Client Lifecycle

Recommended UI lifecycle:

```text
Idle
  -> choose file
Starting
  -> WebSocket connected and registered
Sharing
  -> show/copy public URL
Stopped
  -> send stop with purgeCache=true; relay clears cached files and closes WebSocket
Closed
  -> close WebSocket; cached files may remain available until TTL expiry
```

Stop sharing when:

- The user clicks `Stop`.
- The WebSocket disconnects.

Disconnect without purging when:

- The app window closes.
- The app exits.

## Minimal Temporary Share Pseudocode

```text
config = read_config()
file = choose_html_file()
root = dirname(file)
session_id = random_urlsafe_id()
share_url = config.PUBLIC_BASE_URL + "/s/" + session_id + "/" + urlencode(basename(file))

ws = websocket_connect(config.HTMLSHARE_SERVER)
ws.send_json({
  type: "register",
  sessionId: session_id,
  token: config.SHARE_TOKEN,
  cache: {
    enabled: cache_ttl_seconds > 0,
    ttlSeconds: cache_ttl_seconds
  }
})

while message = ws.receive_json():
  if message.type == "registered":
    copy_to_clipboard(share_url)
    show(share_url)

  if message.type == "request":
    local_path = safe_resolve(root, message.path)
    if local_path is invalid:
      ws.send_json({ type: "response", id: message.id, status: 404, error: "Not found\n" })
    else:
      bytes = read_file(local_path)
      ws.send_json({
        type: "response",
        id: message.id,
        status: 200,
        contentType: mime_type(local_path),
        size: len(bytes),
        body: base64(bytes)
      })
```

## Minimal Publish Pseudocode

```text
config = read_config()
root = choose_site_directory()
slug = choose_slug()
entry = choose_entry_file_or_default("index.html")
files = []

for file in walk(root):
  if file is not a regular file:
    continue
  resolved = resolve_symlinks(file)
  if resolved escapes root:
    fail()
  bytes = read_file(resolved)
  files.append({
    path: relative_slash_path(root, resolved),
    contentType: mime_type(resolved),
    sha256: hex_sha256(bytes),
    size: len(bytes),
    body: base64(bytes)
  })

response = http_post_json(config.PUBLIC_BASE_URL + "/api/publish", {
  slug: slug,
  entry: entry,
  files: files
}, headers = {
  Authorization: "Bearer " + config.SHARE_TOKEN
})

if response.ok:
  show(config.PUBLIC_BASE_URL + response.url)
else:
  show_error(response.error)
```

## Current Limitations

- Responses are buffered into JSON, so large files are inefficient.
- There is no request body support.
- There is no range request support.
- One session id maps to one connected client.
- If the client disconnects, cached `GET` responses can remain available until TTL expiry. Uncached paths return `410 This share is not connected.`
- Publish uploads are single JSON requests, so large sites are inefficient.

Future protocol versions could add binary frames, streaming, range requests, client-advertised capabilities, and resumable multi-step publishing.
