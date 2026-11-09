# MAXIMUS TWP

**DrFXAi · Telegram WEB Proxy transport for Cloudflare Workers**

MAXIMUS TWP is an independently implemented, self-hosted Telegram-only proxy built for the MAXIMUS ecosystem. It provides a dark operator dashboard, private one-click connection links, a HMAC-protected WebView bridge and a multiplexed WebSocket-to-Telegram-datacenter relay. **It is not a device-wide VPN and its compatibility with a real Telegram WEB proxy client must be tested before production use.**

## Features

- Cloudflare Worker deployment with no VPS and no external database.
- Private operator dashboard; links only after `ADMIN_TOKEN` verification.
- `tg://webproxy` deep links; optional `BASE_PATH` support.
- Telegram WEB proxy v1 bridge with HMAC authentication, short-lived bootstrap and session credentials.
- Binary `OPEN`, `DATA`, `WINDOW`, `CLOSE`, `HELLO`, `WELCOME` frames and per-stream flow control.
- Direct Telegram datacenter connectivity using Cloudflare TCP sockets and Obfuscated2 translation.
- Strict backend allowlist, configurable connection limits, no analytics or third-party frontend resources.
- Reusable profile integration contract for MAXIMUS VPN.

## Quick start

Prerequisites: Node.js 20+, a Cloudflare account and a Telegram client that supports the experimental WEB proxy protocol.

```bash
npm install
npm run check
npx wrangler login
npx wrangler secret put PROXY_SECRET
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

`PROXY_SECRET` must be 32 hexadecimal characters (16 random bytes); a 34-character value starting with `dd` selects padded MTProto mode. Generate 16 random bytes locally, for example:

```bash
node -e "console.log(require('node:crypto').randomBytes(16).toString('hex'))"
```

Use a separate, strong random secret for `ADMIN_TOKEN` (at least 32 random bytes encoded as text). Do not commit either key to GitHub. The Worker intentionally does not provide a shared public secret.

On your Worker URL, paste the private operator token and click **Generate connection links**. You can also generate deep links offline:

```bash
PROXY_SECRET=<secret> npm run link -- my-worker.my-subdomain.workers.dev
```

In PowerShell, use `$env:PROXY_SECRET = '...'` followed by `npm run link -- hostname`.

`wrangler.toml` can set `BASE_PATH` to an unguessable URL segment. The Worker automatically generates a path-marked secret for the Telegram link.

## Deployment validation

```bash
npm test
npm run build
curl -s https://your-worker.workers.dev/api/health
```

A healthy dashboard or an HTTP 200 **does not verify a working Telegram proxy**. For real connectivity, use a WEB-capable Telegram client and verify the bridge handshake, a successful WSS carrier, successful Telegram DC TCP dials, and upstream/downstream MTProto traffic.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `src/worker.js` | Worker request routing, authenticated endpoints and WSS upgrade |
| `src/bridge.js` | Origin-restricted WebView carrier |
| `src/carrier.js` | Multiplexed streams, flow control and socket cleanup |
| `src/datacenter.js` | MTProto Obfuscated2 client/DC translation |
| `src/security.js` | HMAC, AES-CTR, stateless tokens, base64 and secrets |
| `src/dashboard.js` | MAXIMUS operator UI |
| `test/` | Automated protocol and service-level tests |
| `docs/` | Architecture and MAXIMUS Android integration notes |

Full security notes: [ARCHITECTURE.md](docs/ARCHITECTURE.md) · Integration: [MAXIMUS_INTEGRATION.md](docs/MAXIMUS_INTEGRATION.md).

## Release status

**v0.1.0 — engineering preview.** Unit validation is included. Production WSS transport, Cloudflare TCP egress and Telegram client compatibility require live integration testing. HTTPS polling, per-stream WebSocket lanes and dynamic multi-region routing are not implemented.

Copyright © 2026 DrFXAi. Licensed under [MIT](LICENSE).
