// Self-contained bilingual UI: no external fonts, scripts, analytics or images.
const S = {
  en: {
    title:'Deploy your private Telegram WEB proxy', intro:'Install MAXIMUS TWP to your own Cloudflare account. Your Cloudflare API token is used only during this HTTPS request and is never sent to Telegram.',
    account:'Cloudflare account ID', accountHelp:'32-character Account ID from the Cloudflare dashboard.',
    subdomain:'workers.dev subdomain', subdomainHelp:'The account subdomain without .workers.dev; e.g. myteam.',
    worker:'Worker name', token:'Scoped Cloudflare API token', tokenHelp:'Workers Scripts: Edit, scoped to this account only. Prefer an expiring token.',
    submit:'Deploy MAXIMUS TWP', caution:'Never submit a Global API Key or paste a token into Telegram chat. Do not deploy to an account you do not own.',
    result:'Deployment API completed', next:'Copy these one-time credentials into a password manager. Rotate or revoke the Cloudflare API token after setup.',
    admin:'Operator admin token — save now', dashboard:'Open dashboard', connect:'Open Telegram WEB proxy link', web:'Shareable Telegram link',
    note:'Worker deployment does not prove Telegram client support or end-to-end connectivity. Test the connection before relying on it.',
    expired:'This setup link has expired or is invalid. Return to the bot and request a new one.',
  },
  fa: {
    title:'نصب وب‌پروکسی اختصاصی تلگرام', intro:'MAXIMUS TWP را روی حساب Cloudflare خودتان نصب کنید. توکن API فقط برای همین درخواست HTTPS استفاده می‌شود و به تلگرام ارسال نمی‌شود.',
    account:'شناسه حساب Cloudflare', accountHelp:'شناسه ۳۲ کاراکتری Account ID در داشبورد کلادفلر.',
    subdomain:'زیردامنه workers.dev', subdomainHelp:'زیردامنه حساب بدون پسوند .workers.dev؛ مثل myteam.',
    worker:'نام Worker', token:'توکن API محدود کلادفلر', tokenHelp:'دسترسی Workers Scripts: Edit فقط برای همین حساب، ترجیحاً با تاریخ انقضا.',
    submit:'نصب MAXIMUS TWP', caution:'Global API Key را وارد نکنید و توکن را در چت تلگرام نفرستید. فقط حسابی را نصب کنید که متعلق به خودتان است.',
    result:'درخواست انتشار در Cloudflare انجام شد', next:'اطلاعات مدیریت را یک‌بار در نرم‌افزار مدیریت رمز ذخیره کنید. پس از نصب توکن Cloudflare را باطل کنید.',
    admin:'کلید مدیریت — همین حالا ذخیره کنید', dashboard:'باز کردن داشبورد', connect:'باز کردن لینک وب‌پروکسی تلگرام', web:'لینک قابل اشتراک',
    note:'انتشار Worker تضمین نمی‌کند نسخه تلگرام شما از WEB Proxy پشتیبانی کند یا اتصال واقعی موفق باشد. ابتدا تست کنید.',
    expired:'این لینک نصب منقضی شده یا معتبر نیست. به ربات برگردید و لینک جدید بگیرید.',
  }
};
export function escapeHtml(v) { return String(v).replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])); }
const base = (title, lang, inside) => `<!DOCTYPE html><html lang="${lang}" dir="${lang==='fa'?'rtl':'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} — MAXIMUS TWP</title><style>
:root{color-scheme:dark;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 10% 0%,#153e65 0,transparent 48%),linear-gradient(135deg,#070d19,#0b162b);color:#eef8ff;min-height:100vh}main{max-width:700px;margin:0 auto;padding:58px 24px}header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:54px}.brand{font-size:19px;letter-spacing:.13em;font-weight:900}.brand span{color:#00c8ff}.lang{color:#a1c7d9;text-decoration:none;border:1px solid #315071;padding:8px 14px;border-radius:12px}article{border:1px solid #255171;background:linear-gradient(155deg,#122943e8,#09172bf5);padding:clamp(22px,5vw,42px);border-radius:24px;box-shadow:0 18px 80px #0008}h1{font-size:clamp(26px,5vw,40px);line-height:1.18;margin:0 0 18px}p{color:#b4c6d7;line-height:1.75}label{display:block;margin-top:22px;margin-bottom:8px;color:#e6f4ff;font-weight:650}input{width:100%;background:#071422;border:1px solid #395571;border-radius:12px;padding:14px 16px;color:#f5fdff;font:inherit;direction:ltr;text-align:left}input:focus{outline:2px solid #17cfff;outline-offset:2px}.help{font-size:13px;margin:6px 0 0}button,.action{display:inline-block;border:0;border-radius:12px;background:linear-gradient(100deg,#06abff,#1bf2f1);color:#041426;padding:14px 20px;font:inherit;font-weight:800;text-decoration:none;cursor:pointer;margin-top:22px}.action{margin-inline-end:10px}code{display:block;overflow-wrap:anywhere;direction:ltr;text-align:left;padding:15px;border-radius:12px;border:1px solid #2c5272;background:#081523;color:#cbeaff}aside{margin-top:25px;border-inline-start:3px solid #f4b452;padding:8px 18px;color:#f3d59b;background:#bd6c1411}footer{padding:30px 0;color:#64829a;text-align:center;font-size:12px}a{color:#76dbff}</style></head><body><main><header><div class="brand">MAXIMUS <span>TWP</span></div><span>DrFXAi</span></header>${inside}<footer>© 2026 DrFXAi · Secure setup · No analytics</footer></main></body></html>`;
export function setupPage({lang='en',ticket='',sig='',error=''}) {
  lang=lang==='fa'?'fa':'en'; const t=S[lang];
  const field=(key,title,placeholder,desc='',type='text',value='',pattern='')=>`<label for="${key}">${title}</label><input id="${key}" name="${key}" type="${type}" placeholder="${placeholder}" value="${escapeHtml(value)}" ${pattern?`pattern="${pattern}"`:''} required maxlength="512" autocomplete="off">${desc?`<p class="help">${desc}</p>`:''}`;
  const target=lang==='fa'?'en':'fa'; const link=`/setup?ticket=${encodeURIComponent(ticket)}&sig=${encodeURIComponent(sig)}&lang=${target}`;
  return base(t.title,lang,`<article><div style="display:flex;justify-content:flex-end"><a class="lang" href="${escapeHtml(link)}">${target==='fa'?'فارسی':'English'}</a></div><h1>${t.title}</h1><p>${t.intro}</p>${error?`<aside role="alert">${escapeHtml(error)}</aside>`:''}<form method="POST" action="/setup"><input type="hidden" name="ticket" value="${escapeHtml(ticket)}"><input type="hidden" name="sig" value="${escapeHtml(sig)}"><input type="hidden" name="lang" value="${lang}">${field('accountId',t.account,'0123456789abcdef0123456789abcdef',t.accountHelp)}${field('subdomain',t.subdomain,'myaccount',t.subdomainHelp)}${field('workerName',t.worker,'maximus-twp-private')}${field('apiToken',t.token,'••••••••••••••',''+t.tokenHelp,'password')}<button type="submit">${t.submit}</button></form><aside>${t.caution}</aside></article>`);
}
export function resultPage({lang='en',result}) {
  const t=S[lang==='fa'?'fa':'en'];
  return base(t.result,lang,`<article><h1>${t.result}</h1><p>${t.next}</p><label>${t.admin}</label><code>${escapeHtml(result.adminToken)}</code><p><a class="action" href="${escapeHtml(result.dashboard)}" target="_blank" rel="noreferrer">${t.dashboard}</a></p><p><a class="action" href="${escapeHtml(result.deepLink)}">${t.connect}</a></p><label>${t.web}</label><code>${escapeHtml(result.webLink)}</code><aside>${t.note}</aside></article>`);
}
export function expiredPage(lang='en') { return base('Setup expired',lang,`<article><h1>MAXIMUS TWP</h1><p>${S[lang==='fa'?'fa':'en'].expired}</p></article>`); }
