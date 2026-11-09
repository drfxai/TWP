# نصب آسان MAXIMUS TWP — راهنمای فارسی

[بازگشت](../README.fa.md) · [English](QUICKSTART.md)

## روش اول: نصب مستقیم با Wrangler

1. در [Cloudflare](https://dash.cloudflare.com/) حساب بسازید و Node.js 20 یا جدیدتر را نصب کنید.
2. ترمینال یا PowerShell را باز کنید:

   ```bash
   git clone https://github.com/drfxai/TWP.git
   cd TWP
   npm install
   npx wrangler login
   ```

3. این دستور را اجرا کنید و خروجی ۳۲ کاراکتری را **فقط برای کلید پروکسی** نگه دارید:

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(16).toString('hex'))"
   ```

4. دستور بعدی را اجرا کرده و خروجی ۶۴ کاراکتری را **برای رمز مدیریت** استفاده کنید:

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

5. دستورات زیر را به ترتیب اجرا کنید و پس از هر `secret put` مقدار مربوط را در ترمینال وارد کنید:

   ```bash
   npx wrangler secret put PROXY_SECRET
   npx wrangler secret put ADMIN_TOKEN
   npm run deploy
   ```

6. آدرس نمایش‌داده‌شده در پایان استقرار را باز کنید و با `ADMIN_TOKEN` لینک اتصال تلگرام تولید کنید.

**PowerShell:** دستورات بالا در PowerShell نیز قابل اجرا هستند؛ کلیدها را در کد یا GitHub ذخیره نکنید.

## روش دوم: نصب با ربات تلگرام

پس از راه‌اندازی ربات اختصاصی (هنوز بدون توکن فعال نیست)، `/start` را بزنید و `Deploy TWP` را انتخاب کنید. صفحه HTTPS راه‌اندازی باز می‌شود؛ شناسه حساب Cloudflare، نام Worker و توکن API با دسترسی محدود را همان‌جا وارد کنید. **توکن Cloudflare را برای ربات به‌صورت پیام نفرستید.**

جزئیات راه‌اندازی ربات: [BOT_DEPLOYER.md](BOT_DEPLOYER.md).

## تست اتصال

- `https://...workers.dev/api/health` باید پاسخ سلامت بدهد (فقط تست HTTP).
- لینک تولیدشده باید توسط کلاینت تلگرام پشتیبان WEB Proxy شناسایی شود.
- برای تأیید نهایی باید تبادل واقعی ترافیک تا دیتاسنتر تلگرام صورت گیرد.

اگر لینک باز می‌شود اما متصل نیست، به [جدول اشکالات](QUICKSTART.md#troubleshooting) مراجعه کنید. این پروژه **VPN کامل نیست** و سرعت یا عبور از محدودسازی شبکه را تضمین نمی‌کند.
