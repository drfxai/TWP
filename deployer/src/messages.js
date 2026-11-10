// MAXIMUS Deployer — bilingual texts (Persian default). Copyright (c) 2026 DrFXAi — MIT License

const PERMS = {
  twp: [
    {key: 'workers_scripts', type: 'edit'},
    {key: 'account_settings', type: 'read'},
  ],
  vless: [
    {key: 'workers_scripts', type: 'edit'},
    {key: 'workers_kv_storage', type: 'edit'},
    {key: 'account_settings', type: 'read'},
  ],
};

/** Prefilled Cloudflare "Create Token" page with exactly the permissions a section needs. */
export function tokenLink(section = 'vless') {
  const perms = PERMS[section] || PERMS.vless;
  const name = `maximus-${section}-${Math.random().toString(36).slice(2, 7)}`;
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify(perms))}&name=${encodeURIComponent(name)}&accountId=*&zoneId=all`;
}

export function bar(pct) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const full = Math.round(p / 10);
  return `⚡ [${'█'.repeat(full)}${'░'.repeat(10 - full)}] ${p}%`;
}

const LINE = '━━━━━━━━━━━━━━';

export const M = {
  fa: {
    welcome: name => `🛡 <b>MAXIMUS Deployer</b> • DrFXAi\n${LINE}\n👋 سلام ${name} عزیز؛\n\nبا این ربات در کمتر از یک دقیقه و بدون VPS، روی اکانت کلادفلر خودتان بسازید:\n\n⚡ <b>بخش اول:</b> وب‌پروکسی رسمی تلگرام (TWP)\n🌐 <b>بخش دوم:</b> سرور و پنل اختصاصی VLESS\n\n👇 بخش مورد نظر را انتخاب کنید:`,
    gate: (name, channel) => `🔒 <b>عضویت در کانال رسمی الزامی است!</b>\n${LINE}\n👋 سلام ${name} عزیز؛\n\nبرای استفاده از خدمات رایگان ربات (ساخت وب‌پروکسی تلگرام و سرور VLESS)، ابتدا در کانال رسمی ما عضو شوید و سپس روی دکمه «✅ عضو شدم» بزنید:\n\n📢 آیدی کانال: ${channel}`,
    notYet: '⛔️ هنوز عضویت شما در کانال تأیید نشد. ابتدا عضو شوید و دوباره «✅ عضو شدم» را بزنید.',
    sectionTwp: `⚡ <b>بخش اول: ساخت وب‌پروکسی رسمی تلگرام (MAXIMUS TWP v2.2)</b>\n${LINE}\nدر این بخش، موتور رسمی وب‌پروکسی تلگرام روی اکانت کلادفلر شما نصب می‌شود:\n\n✅ انتخاب نام کاملاً تصادفی برای ورکر\n✅ ساخت متغیر امنیتی PROXY_SECRET به صورت رندوم\n✅ تحویل لینک مستقیم tg://webproxy و داشبورد QR Code\n\n📌 <b>روش راه‌اندازی:</b>\n۱. روی دکمه «🔑 دریافت API Token کلادفلر» در زیر بزنید.\n۲. در صفحه کلادفلر روی <b>Continue to summary</b> و سپس <b>Create Token</b> کلیک کنید.\n۳. کد توکن را کپی کرده و <b>در همینجا ارسال کنید</b> تا پروکسی شما ساخته شود 👇`,
    sectionVless: `🌐 <b>بخش دوم: ساخت سرور و پنل اختصاصی VLESS</b>\n${LINE}\nدر این بخش، سرور VLESS به همراه پنل مدیریت روی اکانت کلادفلر شما نصب می‌شود:\n\n✅ انتخاب نام کاملاً تصادفی برای ورکر\n✅ ساخت دیتابیس KV و UUID اختصاصی\n✅ تحویل لینک کانفیگ VLESS، لینک اشتراک و رمز پنل\n\n📌 <b>روش راه‌اندازی:</b>\n۱. روی دکمه «🔑 دریافت API Token کلادفلر» در زیر بزنید.\n۲. در صفحه کلادفلر روی <b>Continue to summary</b> و سپس <b>Create Token</b> کلیک کنید.\n۳. کد توکن را کپی کرده و <b>در همینجا ارسال کنید</b> تا سرور شما ساخته شود 👇`,
    guide: `📚 <b>راهنمای گام‌به‌گام دریافت API Token از کلادفلر</b>\n${LINE}\nبرای اینکه ربات بتواند ورکر را روی اکانت شما نصب کند، به یک توکن دسترسی نیاز دارد:\n\n1️⃣ ابتدا در مرورگر خود وارد سایت dash.cloudflare.com شوید (ثبت‌نام رایگان است).\n2️⃣ روی دکمه «🔑 صفحه ساخت خودکار API Token» در پایین کلیک کنید.\n3️⃣ در صفحه‌ای که باز می‌شود، تمام دسترسی‌های لازم (Workers Scripts و Workers KV) از قبل توسط لینک انتخاب شده‌اند.\n4️⃣ به پایین صفحه بروید و روی دکمه آبی <b>Continue to summary</b> بزنید.\n5️⃣ در صفحه بعد روی <b>Create Token</b> بزنید.\n6️⃣ کد توکن نمایش داده شده را <b>Copy</b> کنید و در چت ربات بفرستید!\n\n🔐 <i>توکن شما هیچ‌جا ذخیره نمی‌شود و بلافاصله پس از دریافت از تاریخچه چت پاک می‌گردد.</i>`,
    tips: `🚀 <b>آموزش افزایش پایداری و سرعت</b>\n${LINE}\n1️⃣ در پنل VLESS، یک <b>آی‌پی یا دامنه‌ی تمیز کلادفلر</b> در فیلد «آدرس» بگذارید و ذخیره کنید. اگر آی‌پی تمیز ندارید آن را خالی بگذارید.\n2️⃣ در کلاینت (v2rayNG، Hiddify، NekoBox) فیلد <b>Fingerprint</b> را روی chrome یا randomized بگذارید.\n3️⃣ اگر اتصال قطع‌ووصل می‌شود، <b>Fragment</b> را فعال کنید: packets = tlshello، length = 10-30، interval = 10-20.\n4️⃣ اگر سایت‌هایی که پشت کلادفلر هستند باز نمی‌شوند، در پنل مقدار <b>PROXYIP</b> را تنظیم کنید.\n5️⃣ برای وب‌پروکسی تلگرام، از نسخه‌ی رسمی و به‌روز تلگرام (اندروید ۱۲.۱۰ به بعد، دسکتاپ ۷.۱ به بعد) استفاده کنید.\n6️⃣ پس از هر تغییر در کلاینت، علامت ✓ یا ذخیره را بزنید و یک‌بار اتصال را قطع و وصل کنید 🙏`,
    tokenReceived: '🔑 توکن کلادفلر شما دریافت شد!\n🛡 (پیام حاوی توکن جهت امنیت از چت پاک شد)',
    tokenReceivedChoose: '🔑 توکن کلادفلر شما دریافت شد!\n🛡 (پیام حاوی توکن جهت امنیت از چت پاک شد)\n\n👇 لطفاً بخش مورد نظر خود را برای نصب انتخاب کنید:',
    tokenExpired: '⌛️ توکن قبلی منقضی شد. لطفاً دوباره توکن را در همینجا ارسال کنید 👇',
    chooseFirst: '👇 ابتدا بخش مورد نظر (TWP یا VLESS) را انتخاب کنید و سپس توکن را دوباره بفرستید. پیام قبلی شما پاک شد.',
    badToken: '❌ این متن شبیه توکن API کلادفلر نیست. از دکمه «🔑 دریافت API Token کلادفلر» استفاده کنید.',
    botTokenWarning: '⚠️ شما توکن یک ربات تلگرام فرستادید! پیام پاک شد. فوراً آن توکن را در @BotFather باطل (Revoke) کنید. اینجا فقط توکن API کلادفلر لازم است.',
    starting: '🚀 در حال آماده‌سازی نصب…',
    stage: {
      start: '🚀 در حال اتصال به کلادفلر…',
      account: '🔎 در حال بررسی توکن و شناسایی اکانت کلادفلر…',
      kv: '🗄 در حال ساخت دیتابیس KV…',
      secret: '🚀 در حال ساخت ورکر تصادفی و تنظیم متغیرهای امنیتی…',
      publish: '🌐 در حال انتشار ورکر روی workers.dev…',
      done: '✅ نصب با موفقیت انجام شد!',
    },
    twpResult: r => `⚡ <b>وب‌پروکسی رسمی تلگرام شما با موفقیت ساخته شد!</b> 🎉\n${LINE}\n🔗 <b>لینک اتصال مستقیم (ضربه بزنید تا کپی شود):</b>\n<pre>${r.deep}</pre>\n🌍 <b>لینک قابل اشتراک:</b>\n<pre>${r.web}</pre>\n📋 <b>مشخصات فنی ورکر شما:</b>\n<blockquote>🏷 نام ورکر: ${r.name}\n🌐 آدرس سرور: ${r.host}\n🎛 داشبورد و QR: ${r.dash}</blockquote>\n⚠️ تلگرام اندروید ۱۲.۱۰+ یا دسکتاپ ۷.۱+ لازم است.`,
    vlessResult: r => `🌐 <b>سرور و پنل اختصاصی VLESS شما با موفقیت ساخته شد!</b> 🎉\n${LINE}\n🔗 <b>لینک کانفیگ VLESS پنل (ضربه بزنید تا کپی شود):</b>\n<pre>${r.link}</pre>\n📥 <b>لینک اشتراک:</b>\n<pre>${r.sub}</pre>\n📋 <b>مشخصات فنی ورکر شما:</b>\n<blockquote>🏷 نام ورکر: ${r.name}\n🗄 متغیر دیتابیس: KV (${r.kv})\n🔐 پسورد پنل (ADMIN): ${r.password}\n🌐 آدرس پنل: ${r.panel}</blockquote>`,
    failCf: (step, status) => `نصب انجام نشد. کلادفلر درخواست «${step}» را رد کرد (HTTP ${status}). مطمئن شوید توکن را با دکمه‌ی ربات و با همه‌ی دسترسی‌ها ساخته‌اید و دوباره تلاش کنید.`,
    failAccount: 'نصب انجام نشد. این توکن به هیچ اکانت کلادفلری دسترسی ندارد. توکن را از دکمه‌ی ربات بسازید.',
    failBundle: 'نصب انجام نشد. بسته‌ی هسته روی ربات کامل نیست؛ لطفاً به مدیر ربات اطلاع دهید.',
    failGeneric: 'نصب انجام نشد. لطفاً چند دقیقه‌ی دیگر دوباره تلاش کنید.',
    yourId: id => `🆔 آیدی عددی تلگرام شما: ${id}`,
    blocked: id => `⛔️ این ربات فعلاً خصوصی است.\n🆔 آیدی شما: ${id}`,
    btnTwp: '⚡ بخش اول: نصب وب‌پروکسی تلگرام (TWP)',
    btnVless: '🌐 بخش دوم: نصب سرور و پنل VLESS',
    btnInstallTwp: '⚡ بخش اول: نصب وب‌پروکسی تلگرام (TWP)',
    btnInstallVless: '🌐 بخش دوم: نصب سرور و پنل VLESS',
    btnGuide: '📖 راهنمای گام‌به‌گام دریافت توکن',
    btnTips: '🚀 افزایش پایداری و سرعت',
    btnTipsPost: '🚀 پست آموزش افزایش پایداری و سرعت',
    btnLang: '🌐 English',
    btnJoin: '📢 ۱. عضویت در کانال رسمی',
    btnJoined: '✅ ۲. عضو شدم (بررسی و ورود به ربات)',
    btnToken: '🔑 ۱. دریافت API Token کلادفلر',
    btnTokenAuto: '🔑 صفحه ساخت خودکار API Token',
    btnBackMain: '⬅️ بازگشت به منوی اصلی',
    btnBackSection: '⬅️ بازگشت به بخش قبلی',
    btnCancel: '⬅️ انصراف و بازگشت به منوی اصلی',
    btnConnect: '🔌 اتصال مستقیم به تلگرام',
    btnDashboard: '🎛 داشبورد و QR Code',
    btnCopyLink: '📋 کپی لینک tg://webproxy',
    btnPanel: '🎛 ورود به پنل مدیریت',
    btnPassword: p => `🔑 پسورد پنل: ${p} (کپی)`,
    btnHome: '🏠 بازگشت به منوی اصلی',
  },
  en: {
    welcome: name => `🛡 <b>MAXIMUS Deployer</b> • DrFXAi\n${LINE}\n👋 Hi ${name},\n\nDeploy on your own Cloudflare account in under a minute, no VPS needed:\n\n⚡ <b>Section 1:</b> Official Telegram WEB proxy (TWP)\n🌐 <b>Section 2:</b> Private VLESS server & panel\n\n👇 Choose a section:`,
    gate: (name, channel) => `🔒 <b>Joining our official channel is required!</b>\n${LINE}\n👋 Hi ${name},\n\nTo use the bot's free services (Telegram WEB proxy and VLESS server), join our official channel first, then tap «✅ I joined»:\n\n📢 Channel: ${channel}`,
    notYet: '⛔️ Your membership is not confirmed yet. Join the channel, then tap «✅ I joined» again.',
    sectionTwp: `⚡ <b>Section 1: Official Telegram WEB proxy (MAXIMUS TWP v2.2)</b>\n${LINE}\nThis installs the Telegram WEB proxy engine on your Cloudflare account:\n\n✅ Fully random Worker name\n✅ Random PROXY_SECRET\n✅ Direct tg://webproxy link and QR dashboard\n\n📌 <b>How to:</b>\n1. Tap «🔑 Get Cloudflare API Token» below.\n2. On Cloudflare, tap <b>Continue to summary</b>, then <b>Create Token</b>.\n3. Copy the token and <b>send it here</b> 👇`,
    sectionVless: `🌐 <b>Section 2: Private VLESS server & panel</b>\n${LINE}\nThis installs a VLESS server with an admin panel on your Cloudflare account:\n\n✅ Fully random Worker name\n✅ Dedicated KV database and UUID\n✅ VLESS config link, subscription link and panel password\n\n📌 <b>How to:</b>\n1. Tap «🔑 Get Cloudflare API Token» below.\n2. On Cloudflare, tap <b>Continue to summary</b>, then <b>Create Token</b>.\n3. Copy the token and <b>send it here</b> 👇`,
    guide: `📚 <b>Step-by-step: get a Cloudflare API Token</b>\n${LINE}\n1️⃣ Sign in at dash.cloudflare.com (free).\n2️⃣ Tap «🔑 Auto API Token page» below.\n3️⃣ All required permissions (Workers Scripts, Workers KV) are preselected.\n4️⃣ Scroll down and tap <b>Continue to summary</b>.\n5️⃣ Tap <b>Create Token</b>.\n6️⃣ <b>Copy</b> the token and send it to the bot!\n\n🔐 <i>Your token is never stored and is deleted from the chat right away.</i>`,
    tips: `🚀 <b>Improve stability and speed</b>\n${LINE}\n1️⃣ In the VLESS panel, set a <b>clean Cloudflare IP or domain</b> as the address. Leave it empty if you have none.\n2️⃣ In your client (v2rayNG, Hiddify, NekoBox) set <b>Fingerprint</b> to chrome or randomized.\n3️⃣ If the connection drops, enable <b>Fragment</b>: packets = tlshello, length = 10-30, interval = 10-20.\n4️⃣ If Cloudflare-hosted sites don't open, set <b>PROXYIP</b> in the panel.\n5️⃣ For the Telegram WEB proxy use an up-to-date official Telegram (Android 12.10+, Desktop 7.1+).\n6️⃣ Save after each change and reconnect once 🙏`,
    tokenReceived: '🔑 Your Cloudflare token was received!\n🛡 (The message containing it was deleted for safety)',
    tokenReceivedChoose: '🔑 Your Cloudflare token was received!\n🛡 (The message containing it was deleted for safety)\n\n👇 Choose what to install:',
    tokenExpired: '⌛️ The previous token expired. Please send the token here again 👇',
    chooseFirst: '👇 Choose a section (TWP or VLESS) first, then send the token again. Your message was deleted.',
    badToken: "❌ That doesn't look like a Cloudflare API token. Use «🔑 Get Cloudflare API Token».",
    botTokenWarning: '⚠️ You sent a Telegram bot token! It was deleted. Revoke it in @BotFather now. Only a Cloudflare API token is needed here.',
    starting: '🚀 Preparing the installation…',
    stage: {
      start: '🚀 Connecting to Cloudflare…',
      account: '🔎 Checking the token and finding your Cloudflare account…',
      kv: '🗄 Creating the KV database…',
      secret: '🚀 Creating a random Worker and setting security variables…',
      publish: '🌐 Publishing the Worker on workers.dev…',
      done: '✅ Installation complete!',
    },
    twpResult: r => `⚡ <b>Your official Telegram WEB proxy is ready!</b> 🎉\n${LINE}\n🔗 <b>Direct link (tap to copy):</b>\n<pre>${r.deep}</pre>\n🌍 <b>Shareable link:</b>\n<pre>${r.web}</pre>\n📋 <b>Worker details:</b>\n<blockquote>🏷 Worker: ${r.name}\n🌐 Server: ${r.host}\n🎛 Dashboard & QR: ${r.dash}</blockquote>\n⚠️ Requires Telegram Android 12.10+ or Desktop 7.1+.`,
    vlessResult: r => `🌐 <b>Your private VLESS server & panel are ready!</b> 🎉\n${LINE}\n🔗 <b>VLESS config link (tap to copy):</b>\n<pre>${r.link}</pre>\n📥 <b>Subscription link:</b>\n<pre>${r.sub}</pre>\n📋 <b>Worker details:</b>\n<blockquote>🏷 Worker: ${r.name}\n🗄 Database: KV (${r.kv})\n🔐 Panel password (ADMIN): ${r.password}\n🌐 Panel: ${r.panel}</blockquote>`,
    failCf: (step, status) => `Installation failed. Cloudflare refused "${step}" (HTTP ${status}). Make sure the token was created with the bot's button and all permissions, then try again.`,
    failAccount: 'Installation failed. This token cannot access any Cloudflare account. Create it with the bot button.',
    failBundle: 'Installation failed. The bot core bundle is incomplete; please tell the bot administrator.',
    failGeneric: 'Installation failed. Please try again in a few minutes.',
    yourId: id => `🆔 Your Telegram user ID: ${id}`,
    blocked: id => `⛔️ This bot is private for now.\n🆔 Your ID: ${id}`,
    btnTwp: '⚡ Section 1: Install Telegram WEB proxy (TWP)',
    btnVless: '🌐 Section 2: Install VLESS server & panel',
    btnInstallTwp: '⚡ Section 1: Install Telegram WEB proxy (TWP)',
    btnInstallVless: '🌐 Section 2: Install VLESS server & panel',
    btnGuide: '📖 Step-by-step token guide',
    btnTips: '🚀 Improve stability & speed',
    btnTipsPost: '🚀 Stability & speed tutorial',
    btnLang: '🌐 فارسی',
    btnJoin: '📢 1. Join the official channel',
    btnJoined: '✅ 2. I joined (check & enter)',
    btnToken: '🔑 1. Get Cloudflare API Token',
    btnTokenAuto: '🔑 Auto API Token page',
    btnBackMain: '⬅️ Back to main menu',
    btnBackSection: '⬅️ Back',
    btnCancel: '⬅️ Cancel and go back',
    btnConnect: '🔌 Connect in Telegram',
    btnDashboard: '🎛 Dashboard & QR Code',
    btnCopyLink: '📋 Copy tg://webproxy link',
    btnPanel: '🎛 Open admin panel',
    btnPassword: p => `🔑 Panel password: ${p} (copy)`,
    btnHome: '🏠 Back to main menu',
  },
};
