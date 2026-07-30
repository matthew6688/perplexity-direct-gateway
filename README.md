# Perplexity Direct Gateway

OpenAI-compatible HTTP API backed by Perplexity's web backend. No browser automation per request — session cookie is extracted once from Chrome, then all requests go direct HTTP.

## Architecture

```
Client → :8788/v1/chat/completions
       → Node.js HTTP fetch → perplexity.ai/rest/sse/perplexity_ask
       → streamed answer + citations
```

Cookie extraction (one-time, auto-refreshed):
```
Node → CDP proxy /cookies → Chrome httpOnly cookie
```

Compare with the old browser-based approach:
```
Old: Node → CDP eval → Chrome fetch → Runtime.evaluate 30s timeout
New: Node → cookie → direct HTTP fetch → no timeout
```

## Features

- OpenAI-compatible `/v1/chat/completions` (streaming + non-streaming)
- `/v1/models` model catalog
- `/health` status check
- 8 models across 6 providers (plan-dependent)
- File upload: PDF, DOCX, XLSX, PPTX, images, code, CSV, JSON, Markdown, 90+ formats
- Serial FIFO request queue with human-like delays (2-7s between requests)
- Cookie lifecycle: auto-refresh every 2 hours or 30min before expiry
- 403 auto-recovery: refresh cookie and retry
- Retry with exponential backoff + model fallback chain

## Supported Models

| Alias | Model | Provider |
|---|---|---|
| `best` (default) | Perplexity Best | PERPLEXITY |
| `sonar` | Sonar 2 | PERPLEXITY |
| `gemini` / `gemini-thinking` | Gemini 3.1 Pro | GOOGLE |
| `sonnet` | Claude Sonnet 5 | ANTHROPIC |
| `sonnet-thinking` | Claude Sonnet 5 Thinking | ANTHROPIC |
| `kimi` | Kimi K3 | MOONSHOT_AI |
| `glm` | GLM-5.2 | ZAI |
| `grok` | Grok 4.5 | XAI |
| `grok-thinking` | Grok 4.5 Thinking | XAI |
| `nemotron` | Nemotron 3 Ultra | NVIDIA |

## Supported File Types

Documents: `pdf`, `doc`, `docx`, `pptx`, `xlsx`
Images: `png`, `jpg`, `jpeg`, `gif`, `bmp`, `tiff`, `svg`, `webp`, `ico`, `avif`, `heic`, `heif`
Audio: `mp3`, `wav`, `ogg`, `aiff`, `flac`
Video: `mp4`, `mpeg`, `mov`, `avi`, `webm`, `wmv`, `3gp`
Code: `py`, `js`, `ts`, `go`, `rs`, `java`, `c`, `cpp`, `rb`, `php`, `swift`, `kt`, `scala`, `lua`, `dart`, `sql`, `r`, `sh`, `bash`, `zsh`, `css`, `less`, `html`, `xml`, `yaml`, `toml`, `json`, `csv`, `md`, `tex`, `ipynb`, and more.

Full list: see `src/perplexity.mjs` → `MIME_MAP`.

## Prerequisites

- Node.js 22+
- Chrome with Perplexity logged in
- CDP proxy running on `localhost:3456` (included with Hermes/openclaw)

## Quick Start

```bash
npm start
# or
node src/server.mjs
```

Server listens on `http://127.0.0.1:8788`.

### Authentication (optional)

```bash
PERPLEXITY_PROXY_KEY=your-secret node src/server.mjs
```

Then pass `Authorization: Bearer your-secret` with requests.

## Usage

### Chat Completion

```bash
curl http://localhost:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "messages": [{"role": "user", "content": "Explain quantum computing in one sentence."}],
    "stream": false
  }'
```

### Streaming

```bash
curl http://localhost:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini",
    "messages": [{"role": "user", "content": "Write a haiku about programming."}],
    "stream": true
  }'
```

### With File Upload

```bash
curl http://localhost:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "best",
    "messages": [{"role": "user", "content": "Summarize this document."}],
    "attachments": ["./report.pdf"],
    "stream": false
  }'
```

### Health Check

```bash
curl http://localhost:8788/health
# {"status":"ok","provider":"perplexity-direct","queueDepth":0,"sessionAlive":true}
```

### List Models

```bash
curl http://localhost:8788/v1/models
```

## Cookie Extraction Tool

The `extract-session.mjs` script can extract the httpOnly session cookie directly from Chrome via CDP WebSocket:

```bash
node extract-session.mjs
# Outputs: __Secure-next-auth.session-token=eyJhbG...
```

This is used internally by the gateway but can also be used standalone.

## How It Works

1. **Startup**: Gateway connects to CDP proxy, finds a Perplexity tab, extracts the `__Secure-next-auth.session-token` httpOnly cookie via `Network.getCookies`.

2. **Requests**: All API calls go direct from Node to `perplexity.ai/rest/sse/perplexity_ask` with the cookie in HTTP headers. No CDP eval, no browser tab per request.

3. **Cookie Refresh**: Cookie is auto-refreshed every 2 hours (or 30 minutes before expiry) by re-extracting from Chrome. On HTTP 403, cookie is refreshed immediately and the request is retried.

4. **Serial Queue**: Requests are queued and processed one at a time with 2-7 second random delays between them to simulate human behavior and protect the account.

5. **File Upload**: Files are uploaded via Perplexity's S3 presigned URL flow — first get an upload URL from `/rest/uploads/create_upload_url`, then upload directly to S3. The S3 URL is passed as an attachment to the ask request.

## Configuration

| Env Var | Default | Description |
|---|---|---|
| `PORT` | `8788` | Server listen port |
| `HOST` | `127.0.0.1` | Server listen host |
| `CDP_PROXY` | `http://localhost:3456` | CDP proxy URL (bootstrap only) |
| `PERPLEXITY_PROXY_KEY` | (none) | API key for request auth |
| `PERPLEXITY_SESSION_FILE` | `~/.perplexity-session.txt` | Cookie file path |

## Ops & Maintenance

Operational tooling lives in [`perplexity-ops`](https://github.com/matthew6688/perplexity-ops)
(same pattern as [`aurora-ops`](https://github.com/matthew6688/aurora-ops)):

| Tool | Location | Purpose |
|---|---|---|
| `refresh-cookie.py` | `~/perplexity-ops/` | HTTP-refresh cookie via `/api/auth/session` |
| `perplexity-direct.30s.sh` | `~/swiftbar-plugins/` | SwiftBar menu-bar status + start/stop/restart |
| `ai.perplexity-direct.cookie-refresh.plist` | `~/Library/LaunchAgents/` | launchd auto-refresh every 12h |
| `pplx-direct` | `~/.local/bin/` | One-line terminal CLI |

```bash
# Gateway lifecycle
cd ~/perplexity-direct-gateway
nohup node src/server.mjs >> ~/Library/Logs/perplexity-direct/server.log 2>&1 &
# Or use the PPLX-D SwiftBar icon in the menu bar

# Manual cookie refresh
python3 ~/perplexity-ops/refresh-cookie.py
# Or via SwiftBar: click PPLX-D → "Refresh cookie now"

# Health + cookie age
curl http://127.0.0.1:8788/health

# One-line queries
pplx-direct -m sonnet "question"
pplx-direct --stream "question"
```

### Cookie lifecycle

1. **Bootstrap** (once): cookie extracted from Chrome → `~/.perplexity-session.txt`
2. **Gateway start**: reads from file, zero CDP
3. **Every 12h (launchd)**: `refresh-cookie.py` calls `/api/auth/session` → `Set-Cookie` → writes file → `POST /refresh`
4. **Gateway internal**: also refreshes every 24h via setInterval
5. **CDP fallback**: only when cookie expires (~30 days) and HTTP refresh fails

## License

MIT
