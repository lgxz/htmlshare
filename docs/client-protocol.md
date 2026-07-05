# HtmlShare Client Protocol

This document describes how to implement a HtmlShare client in any language or platform.

The existing macOS app is only one client implementation. A Windows, Linux, iOS, Android, CLI, or browser-extension companion can use the same relay protocol.

## Overview

The client shares one local HTML file's containing directory through the relay.

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

## Configuration

A client needs:

```env
HTMLSHARE_SERVER=wss://share.example.com/tunnel
PUBLIC_BASE_URL=https://share.example.com
SHARE_TOKEN=shared-secret-token
```

`HTMLSHARE_SERVER` is the WebSocket endpoint.

`PUBLIC_BASE_URL` is used by the client to print or display the browser URL.

`SHARE_TOKEN` is sent when registering. If the relay has `SHARE_TOKEN` configured, clients with the wrong token are rejected.

## Session ID

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

## WebSocket Registration

Connect to:

```text
wss://share.example.com/tunnel
```

Immediately send:

```json
{
  "type": "register",
  "sessionId": "XMKjEa6GLXk",
  "token": "shared-secret-token"
}
```

The relay replies:

```json
{
  "type": "registered",
  "sessionId": "XMKjEa6GLXk"
}
```

After this, the public share URL can be copied to the clipboard or shown in the UI.

## Request Message

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

## Response Message

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
- `size`: byte length of the decoded body.
- `body`: base64-encoded file bytes.
- `error`: plain-text error body for non-2xx responses.

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
  -> close WebSocket; URL returns 410 from relay
```

Stop sharing when:

- The user clicks `Stop`.
- The app window closes.
- The app exits.
- The WebSocket disconnects.

## Minimal Pseudocode

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
  token: config.SHARE_TOKEN
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

## Current Limitations

- Responses are buffered into JSON, so large files are inefficient.
- There is no request body support.
- There is no range request support.
- One session id maps to one connected client.
- If the client disconnects, the relay returns `410 This share is not connected.`

Future protocol versions could add binary frames, streaming, range requests, and client-advertised capabilities.
