# MAXIMUS TWP — engineering notes

## Purpose

A narrowly scoped, independently authored Cloudflare Workers WEB proxy service for Telegram. It is **not** an HTTP CONNECT/SOCKS5 proxy or system-wide Android VPN engine. The design targets Telegram clients that implement the WEB proxy v1 transport contract. Production interoperability is unverified until exercised against a compatible Telegram build.

## Data path

```
Telegram native networking
  -> native WEB adapter (authenticated WebView IPC)
  -> HTTPS capability bridge / short-lived bootstrap
  -> WSS carrier, binary frame multiplexing
  -> fixed Telegram DC IP allowlist, TCP :443 via Cloudflare sockets
  -> MTProto Obfuscated2 header translation
  -> Telegram datacenter
```

All stream IDs are managed within one WebSocket upgrade. Each socket request receives an isolated in-memory session and its own active-stream map. There is no D1, KV, R2, durable object or session database. The proxy does not log content or track end-users. Cloudflare platform-level logs and network policy remain under the account operator's control.

## Protocol compatibility

- Bridge query is HMAC-SHA256 over `tdesktop-web-proxy-bridge-v1\n<host>` (v2 binds a base path).
- Binary frame header is `type:u8 | streamId:u24 | length:u32be`, followed by up to 1 MiB of data.
- `HELLO`/`WELCOME` is exchanged using POST `/api/v1/session`, followed by a same-origin `tproxy-v1.<token>` WebSocket upgrade.
- The WebView bridge dispatches one complete frame at a time to the native boundary. A parent MessagePort on `http://127.0.0.1:<port>` is an explicit fallback.
- OPEN allocates one logical stream; WINDOW tracks per-stream credit; CLOSE releases resources. The TCP destination is never supplied by the user.
- A 64-byte Obfuscated2 handshake is decoded using the shared secret. The decrypted transport tag and DC ID are validated; uplink is translated to a direct DC handshake and downlink stays on the client's expected keystream.

Reference wire contract: https://github.com/telegramdesktop/tproxy-server/blob/master/PROTOCOL.md

## Threat model & constraints

- Never ship a preset `PROXY_SECRET` or expose it in public HTML; this repository deliberately fails closed without it.
- The bridge capability is hostname-bound and only accessible to a party already holding the shared secret.
- Stateless session tokens are short-lived and HMAC-authenticated; bootstrap tokens are **not single-use** and signed session tokens are **replayable within their validity window**. Session revocation requires rotating the relay secret or deploying a stateful alternative.
- The public dashboard requires separate `ADMIN_TOKEN` bearer authentication before issuing links. It does not persist the token to storage.
- A Cloudflare Worker cannot guarantee immunity to filtering or reliable TCP connectivity to every datacenter on every ISP. Deployments require live testing.
- Limits: 24 concurrent streams by default (configurable to 40), 40 dials per WS carrier, 4 MiB flow window per stream, 1 MiB per frame, 4 MiB per inbound WS message, 2 MiB browser buffered soft limit.
- The implementation supports one multiplexed WebSocket carrier. HTTPS polling and lane isolation are **not implemented**.
- No auto-install into the MAXIMUS Android APK is included; this is a separate serverless service and a configuration handoff.

## Deployment security checklist

1. Use a cryptographically random per-deployment `PROXY_SECRET` and a distinct strong `ADMIN_TOKEN`.
2. Set both using `wrangler secret put`, never in `[vars]` or source control.
3. Restrict Cloudflare access permissions and configure budget/abuse alerts.
4. Keep Worker logging of headers, request paths and WebSocket frames disabled.
5. Verify that the target Telegram client supports `tg://webproxy`, not merely MTProxy or SOCKS5.
6. Check Cloudflare socket availability / error metrics and update allowlisted DC endpoints as needed.
7. Run tests and dry-run build before deployment; use a staging worker first.

## Known gaps for a hardened release

- Real Telegram v1 interoperability matrix (Android/Desktop/iOS), real Cloudflare socket tests and long-duration soak testing.
- Exhaustive abuse, race-condition and crypto known-answer tests, plus reliable backpressure timeouts.
- Durable Object single-use bootstrap / session revocation (if the product requires strong replay prevention).
- Optional per-stream isolated WS lanes, adaptive region scheduling and failover after stream closure.
