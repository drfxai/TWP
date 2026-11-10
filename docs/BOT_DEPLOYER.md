# MAXIMUS Deployer Bot — operator guide

[Repository](../README.md) · Bot: [@drfxtwp_bot](https://t.me/drfxtwp_bot) · Channel: [@drfxai](https://t.me/drfxai)

The deployer is a Cloudflare Worker that runs the Telegram bot. From inside Telegram it installs, on **each user's own Cloudflare account**:

| Section | What gets deployed | Delivered to the user |
| --- | --- | --- |
| ⚡ Section 1 — TWP | `worker.js` (MAXIMUS TWP Core v2.2) with a random Worker name and random `PROXY_SECRET` | `tg://webproxy` link, `t.me/webproxy` link, dashboard with QR code |
| 🌐 Section 2 — VLESS | `vless/worker.js` with a new KV namespace, random `UUID` and `ADMIN_PASSWORD` | VLESS config link, subscription link, worker details, panel URL and password |

Persian is the default language; users can switch to English from the menu.

## User flow

1. `/start` → if the user is not a member of `REQUIRED_CHANNEL` (default `@drfxai`), the bot shows **«عضویت در کانال رسمی الزامی است!»** with a join button and **«✅ عضو شدم»**.
2. Main menu → **⚡ بخش اول (TWP)**, **🌐 بخش دوم (VLESS)**, **📖 راهنمای دریافت توکن**, **🚀 افزایش پایداری و سرعت**, language.
3. A section shows what it installs and a **«🔑 دریافت API Token کلادفلر»** button that opens Cloudflare's *Create Token* page with exactly the permissions it needs preselected:
   - TWP: `Workers Scripts: Edit`, `Account Settings: Read`
   - VLESS: `Workers Scripts: Edit`, `Workers KV Storage: Edit`, `Account Settings: Read`
4. The user taps **Continue to summary → Create Token**, copies the token and sends it to the bot.
5. The bot **deletes the token message immediately**, finds the account and its `workers.dev` subdomain (creating one if the account has none), and shows a live progress bar (`⚡ [████████░░] 85%`).
6. The result message is delivered with copy buttons and links. A token sent before choosing a section is kept only **AES-GCM encrypted** in KV for at most 5 minutes until the user picks TWP or VLESS, then deleted.

## Deploy the bot

```bash
npm install
npm run check
npx wrangler login
npx wrangler kv namespace create STATE --config deployer/wrangler.toml   # put the id in deployer/wrangler.toml
npx wrangler secret put TELEGRAM_BOT_TOKEN --config deployer/wrangler.toml
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --config deployer/wrangler.toml
npx wrangler secret put SETUP_SIGNING_KEY --config deployer/wrangler.toml
npm run deploy:deployer
node scripts/register-telegram-webhook.mjs https://maximus-twp-deployer.YOUR-SUBDOMAIN.workers.dev/telegram
```

| Setting | Type | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | secret | Token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_WEBHOOK_SECRET` | secret | 32+ random characters (`A-Z a-z 0-9 _ -`) |
| `SETUP_SIGNING_KEY` | secret | 32+ random characters; derives the token-encryption key |
| `STATE` | KV binding | Short-lived section choice / encrypted token |
| `REQUIRED_CHANNEL` | var | Forced-join channel, default `@drfxai`; `-` disables the gate |
| `TUTORIAL_URL` | var, optional | Channel post for the "stability & speed" button; built-in tips are shown otherwise |
| `BOT_OWNER_IDS` | var, optional | Comma-separated Telegram IDs to make the bot private; empty = public |
| `PUBLIC_BOT_WEBHOOK_URL`, `BOOTSTRAP_WEBHOOK` | optional | Scheduled self-registration of profile, commands and webhook |

**Important:** add the bot as an **administrator of `@drfxai`**. Telegram only lets a bot read channel memberships when it is an admin; otherwise every user sees the join gate.

## Security notes

- Cloudflare tokens are used once per deployment, never logged and never echoed; Cloudflare error bodies are not shown to users because they can contain submitted data.
- Telegram delivers the token message to the bot before it is deleted, so advise users to revoke the token after installation (`dash.cloudflare.com/profile/api-tokens`).
- If a user sends a Telegram bot token by mistake, it is deleted and the user is told to revoke it in BotFather.
- The bot ignores groups and channels and answers only in private chats.
- Only the bundled MAXIMUS TWP and MAXIMUS VLESS workers can be deployed; no remote code is downloaded.
- A deployment that succeeds at the API level does not prove that a given network or Telegram client can connect; test the links.

## Live deployment — DrFXAi

The bot runs at `https://maximus-twp-deployer.drfxai.workers.dev` with its webhook at `/telegram`. After merging this version, create the `STATE` KV namespace, put its id in `deployer/wrangler.toml`, redeploy with `npm run deploy:deployer`, and make the bot an admin of `@drfxai`.
