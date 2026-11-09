# Security model

## Trust boundaries

1. **Proxy Worker:** holds a per-deployment `PROXY_SECRET` (transport credential) and a separate `ADMIN_TOKEN` (operator UI). Authentication uses short-lived stateless tokens; no per-user D1 or KV is required.
2. **Deployer Bot:** holds the **Telegram Bot API token**, a **Telegram webhook secret**, and a **setup-link signing key** as Cloudflare secrets. These are not the same values as a user's proxy credentials.
3. **User Cloudflare account:** receives a one-time HTTPS API call from the deployer. The user-entered Cloudflare API token is handled in the request only, without database persistence, Telegram echo or analytics. It can still be present in memory during the request and in upstream provider systems. The operator of the deployer must be trusted.

## Safe provisioning

- Use a Cloudflare API token restricted to the **specific account** and **Workers Scripts: Edit**. Do not request All Accounts, KV or Global API Keys unless a documented feature truly requires them.
- Enter the Cloudflare token in the setup HTTPS form, not in Telegram chat.
- Use a dedicated token with a short expiration and revoke it after provisioning, especially if a third-party deployer is involved.
- The setup link is time-limited and HMAC-signed but is **not** an OAuth authorization grant. Never forward it.
- Deployments create unique random proxy/admin tokens; admin values are displayed only on the post-deployment web page. Store them in a password manager, not a GitHub issue.
- Keep the bot private by defining `BOT_OWNER_IDS`, unless a public deployer has been security-reviewed and appropriately rate-limited. Public operation is **not** enabled by default.

## Threats & limitations

- A compromised bot token enables bot impersonation. Rotate through BotFather and Cloudflare secrets.
- A compromised Cloudflare API token permits editing Workers within its scope. Limit and expire the scope.
- Workers' serverless runtime and Telegram's WEB proxy client contract may change. Unit tests alone cannot validate real-world confidentiality or availability.
- A proxy link includes a bearer credential. Rotation invalidates previous links.
- A privacy-friendly design does not imply anonymity, censorship immunity, zero logging by third-party infrastructure, or guaranteed connection speed.

Report vulnerabilities privately to the maintainers; **never** include active secrets in a public issue or screenshot.
