# Quick start & troubleshooting (English)

[Home](../README.md) · [فارسی](QUICKSTART.fa.md)

## Prerequisites

- A Cloudflare account with Workers enabled.
- Node.js 20+ and Git.
- A Telegram client with functioning `tg://webproxy` support. Confirm this before relying on any connection link.

## Install in five steps

1. Download: `git clone https://github.com/drfxai/TWP.git && cd TWP`
2. Install dependencies: `npm install`
3. Authenticate: `npx wrangler login`
4. Generate two independent random values using the commands in the [README](../README.md#quick-start). Run `npx wrangler secret put PROXY_SECRET` (32 hex chars) and `npx wrangler secret put ADMIN_TOKEN` (64 hex chars), entering the corresponding values when prompted.
5. Deploy: `npm run deploy`. Open the displayed Worker URL, enter your admin token and use **Generate connection links**.

## Verify the deployment

1. **Worker health:** `curl -i https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/api/health`. This confirms only HTTP availability and configuration, not Telegram connectivity.
2. **Dashboard:** open the Worker URL. Ensure the admin token is required to reveal the link.
3. **Client compatibility:** open the generated `tg://webproxy` link with the intended Telegram build. If the app does not recognize it, the WEB proxy protocol may not be supported by that build.
4. **End-to-end:** confirm an authenticated HTTPS bridge, successful WebSocket upgrade, upstream Telegram DC TCP connectivity and sustained bidirectional message traffic. Review Cloudflare Worker logs as needed.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `Invalid Worker configuration` | Verify `PROXY_SECRET` is 32 hex characters (or supported padded format), `ADMIN_TOKEN` is present, and optional `BASE_PATH` matches allowed syntax. |
| Dashboard loads, no links | Re-enter the secret admin token; check request to `/api/admin/link` is authorized. |
| Telegram ignores the link | WEB proxy support in the actual client build; supported URI scheme, hostname, secret length and optional path. |
| WSS fails | Worker route, runtime compatibility date, network intermediaries, authorization and valid Telegram bridge request. |
| Connected but no traffic | Telegram DC egress, MTProto handshake, stream flow control and downstream data. |
| Intermittent disconnects | Network filtering, Cloudflare TCP/socket quotas, session expiry and client reconnection behavior. |

Use `npm run check` and `npm run build` before redeploying. **Do not log or post secrets when reporting a problem.**

## Operating recommendations

- Rotate both tokens after suspected exposure.
- Limit the number of simultaneous streams in `wrangler.toml` if necessary.
- For critical deployments, consider a verified custom domain rather than relying on `workers.dev` availability.
- Treat speed claims as testable measurements, not guarantees.
