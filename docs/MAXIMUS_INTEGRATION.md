# Integration with MAXIMUS VPN

The service has its own deployable Worker and its own GitHub repository. A Telegram WEB proxy transports **Telegram application traffic only**. It should appear as a separate entry in MAXIMUS' Nodes / Telegram Tools collection, not masquerade as an Xray, sing-box or WARP VPN engine.

## Suggested profile data contract

```json
{
  "id": "generated-locally",
  "type": "telegram_web_proxy",
  "displayName": "MAXIMUS TWP",
  "serverHost": "example.workers.dev",
  "basePath": "",
  "secret": "REPLACE_WITH_SECRET_OR_SECURE_REFERENCE",
  "mode": "telegram_only",
  "status": "untested"
}
```

Never put the secret into analytics, crash logs, diagnostic attachments or exported screenshots. Keep it inside the Android encrypted credential store. Do not include the operator's `ADMIN_TOKEN` in mobile profile data.

## Expected Android UI actions

1. **Import / add profile:** accept a `tg://webproxy` URI, validate the hostname and secret locally, store encrypted.
2. **Open in Telegram:** launch Android `ACTION_VIEW` with the URI. Telegram support varies by version; show a user-visible unsupported-client error if there is no handler.
3. **Validate endpoint:** perform an unauthenticated GET `/api/health` to test whether the Worker exists; **not** a guarantee of Telegram data-plane connectivity.
4. **Connection testing:** only mark `Connected` after an actual Telegram client establishes the carrier and transfers data; admin health response is insufficient.
5. **Settings:** distinguish Telegram-only status from the device-wide VPN connection state.

## Deployment options

Cloudflare Workers can host multiple independent TWP deployments under custom domains or workers.dev subdomains. Keep each Worker secret unique. A MAXIMUS Smart Manager integration can provision workers through an explicit Cloudflare account authorization; do not ask users to paste their account-wide Cloudflare API token into Telegram or store it in the Worker.

No code in the main MAXIMUS-VPN repository is modified by this standalone service. Integrating APK screens and native Telegram client behavior is a separate engineering task.
