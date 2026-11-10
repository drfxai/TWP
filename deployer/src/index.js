// MAXIMUS Deployer Bot — @drfxtwp_bot — Copyright (c) 2026 DrFXAi — MIT License
// Deploys MAXIMUS TWP (Telegram WEB proxy) and MAXIMUS VLESS (server + panel)
// to the user's own Cloudflare account from inside Telegram.
import {CORE_BUNDLE, VLESS_BUNDLE} from '../generated/core.js';
import {deployTwp, deployVless, validateToken, CloudflareError} from './deploy.js';
import {M, tokenLink, bar} from './messages.js';

const NO_STORE = {'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer'};
const ok = () => new Response('ok', {headers: NO_STORE});
const errorResponse = (msg, status = 400) => new Response(msg, {status, headers: NO_STORE});
const enc = new TextEncoder();
const dec = new TextDecoder();
const PENDING_TTL = 600;   // seconds a chosen section stays armed
const TOKEN_TTL = 300;     // seconds an encrypted token may wait for a section choice

const same = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const escapeHtml = v => String(v).replace(/[&<>"]/g, x => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[x]));

// ---------------------------------------------------------------- Telegram API

async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    const err = new Error(`Telegram API ${method} rejected request (HTTP ${res.status})`);
    err.description = data?.description || '';
    throw err;
  }
  return data.result;
}

// Keep the content deliverable when Telegram rejects a keyboard (e.g. an old client without copy_text).
async function send(env, message) {
  try { return await tg(env, 'sendMessage', message); }
  catch (error) {
    if (!message.reply_markup) throw error;
    const {reply_markup: _unused, ...plain} = message;
    return tg(env, 'sendMessage', plain);
  }
}

async function edit(env, chatId, messageId, text, extra = {}) {
  try { return await tg(env, 'editMessageText', {chat_id: chatId, message_id: messageId, text, ...extra}); }
  catch { return null; }
}

// ---------------------------------------------------------------- access

const ownerIds = env => String(env.BOT_OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const allowed = (from, env) => { const ids = ownerIds(env); return !ids.length || ids.includes(String(from.id)); };
export const requiredChannel = env => {
  const raw = String(env.REQUIRED_CHANNEL ?? '@DrFXi').trim();
  if (!raw || raw === '-') return '';
  return raw.startsWith('@') || /^-100\d+$/.test(raw) ? raw : '@' + raw;
};
const channelUrl = ch => ch.startsWith('@') ? `https://t.me/${ch.slice(1)}` : 'https://t.me/';

async function isMember(env, userId) {
  const channel = requiredChannel(env);
  if (!channel) return true;
  try {
    const member = await tg(env, 'getChatMember', {chat_id: channel, user_id: userId});
    return ['creator', 'administrator', 'member'].includes(member.status) || (member.status === 'restricted' && member.is_member);
  } catch (error) {
    // The bot must be an administrator of the channel to read memberships.
    console.log('Membership check failed for', channel, error.description || error.message);
    return false;
  }
}

// ---------------------------------------------------------------- short-lived state (KV)

async function stateKey(env) {
  const material = await crypto.subtle.digest('SHA-256', enc.encode('maximus-token-v1:' + String(env.SETUP_SIGNING_KEY || '')));
  return crypto.subtle.importKey('raw', material, {name: 'AES-GCM'}, false, ['encrypt', 'decrypt']);
}

async function sealToken(env, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await stateKey(env), enc.encode(token)));
  return b64(iv) + '.' + b64(ct);
}

async function openToken(env, sealed) {
  try {
    const [iv, ct] = String(sealed).split('.');
    return dec.decode(await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(iv)}, await stateKey(env), unb64(ct)));
  } catch { return ''; }
}

const kvGet = async (env, key) => { try { return env.STATE ? JSON.parse(await env.STATE.get(key) || 'null') : null; } catch { return null; } };
const kvPut = (env, key, value, ttl) => env.STATE ? env.STATE.put(key, JSON.stringify(value), {expirationTtl: Math.max(60, ttl)}) : null;
const kvDel = (env, key) => env.STATE ? env.STATE.delete(key) : null;

// ---------------------------------------------------------------- keyboards

const L = lang => (lang === 'en' ? 'en' : 'fa');
function mainMenu(env, lang) {
  const t = M[lang];
  const rows = [
    [{text: t.btnTwp, callback_data: `sec:twp:${lang}`}],
    [{text: t.btnVless, callback_data: `sec:vless:${lang}`}],
    [{text: t.btnGuide, callback_data: `guide:main:${lang}`}],
    [env.TUTORIAL_URL ? {text: t.btnTips, url: String(env.TUTORIAL_URL)} : {text: t.btnTips, callback_data: `tips:main:${lang}`}],
    [{text: t.btnLang, callback_data: `lang:${lang === 'fa' ? 'en' : 'fa'}:${lang}`}],
  ];
  return {inline_keyboard: rows};
}
function gateMenu(env, lang) {
  const t = M[lang];
  return {inline_keyboard: [[{text: t.btnJoin, url: channelUrl(requiredChannel(env))}], [{text: t.btnJoined, callback_data: `check:main:${lang}`}]]};
}
function sectionMenu(env, section, lang) {
  const t = M[lang];
  return {inline_keyboard: [
    [{text: t.btnToken, url: tokenLink(section)}],
    [{text: t.btnGuide, callback_data: `guide:${section}:${lang}`}],
    [{text: t.btnBackMain, callback_data: `menu:main:${lang}`}],
  ]};
}
function guideMenu(env, section, lang) {
  const t = M[lang];
  const tips = env.TUTORIAL_URL ? {text: t.btnTipsPost, url: String(env.TUTORIAL_URL)} : {text: t.btnTipsPost, callback_data: `tips:${section}:${lang}`};
  return {inline_keyboard: [
    [{text: t.btnTokenAuto, url: tokenLink(section === 'main' ? 'vless' : section)}],
    [tips],
    [section === 'main' ? {text: t.btnBackMain, callback_data: `menu:main:${lang}`} : {text: t.btnBackSection, callback_data: `sec:${section}:${lang}`}],
  ]};
}
function chooseMenu(lang) {
  const t = M[lang];
  return {inline_keyboard: [
    [{text: t.btnInstallTwp, callback_data: `run:twp:${lang}`}],
    [{text: t.btnInstallVless, callback_data: `run:vless:${lang}`}],
    [{text: t.btnCancel, callback_data: `cancel:main:${lang}`}],
  ]};
}

// ---------------------------------------------------------------- deployment

function failureText(t, error) {
  if (error instanceof CloudflareError) return t.failCf(error.step, error.status);
  const code = error?.message;
  if (code === 'NO_ACCOUNT') return t.failAccount;
  if (code === 'INVALID_TOKEN') return t.badToken;
  if (code === 'BUNDLE_MISSING') return t.failBundle;
  return t.failGeneric;
}

export async function runDeployment(env, {chatId, section, lang, token}) {
  const t = M[lang];
  const progress = await send(env, {chat_id: chatId, text: bar(5) + '\n' + t.stage.start});
  const onProgress = async (pct, stage) => { if (progress?.message_id) await edit(env, chatId, progress.message_id, bar(pct) + '\n' + (t.stage[stage] || t.stage.start)); };
  try {
    if (section === 'twp') {
      const r = await deployTwp({apiToken: token, coreSource: CORE_BUNDLE, onProgress});
      if (progress?.message_id) await edit(env, chatId, progress.message_id, bar(100) + '\n' + t.stage.done);
      await send(env, {
        chat_id: chatId, parse_mode: 'HTML', link_preview_options: {is_disabled: true},
        text: t.twpResult({name: escapeHtml(r.workerName), host: escapeHtml(r.host), deep: escapeHtml(r.deepLink), web: escapeHtml(r.webLink), dash: escapeHtml(r.dashboard)}),
        reply_markup: {inline_keyboard: [
          [{text: t.btnConnect, url: r.webLink}],
          [{text: t.btnDashboard, url: r.dashboard}],
          [{text: t.btnCopyLink, copy_text: {text: r.deepLink.slice(0, 256)}}],
          [{text: t.btnHome, callback_data: `menu:main:${lang}`}],
        ]},
      });
    } else {
      const r = await deployVless({apiToken: token, vlessSource: VLESS_BUNDLE, onProgress});
      if (progress?.message_id) await edit(env, chatId, progress.message_id, bar(100) + '\n' + t.stage.done);
      const tips = env.TUTORIAL_URL ? {text: t.btnTips, url: String(env.TUTORIAL_URL)} : {text: t.btnTips, callback_data: `tips:main:${lang}`};
      await send(env, {
        chat_id: chatId, parse_mode: 'HTML', link_preview_options: {is_disabled: true},
        text: t.vlessResult({link: escapeHtml(r.vlessLink), name: escapeHtml(r.workerName), kv: escapeHtml(r.kvTitle), password: escapeHtml(r.password), panel: escapeHtml(r.panel), sub: escapeHtml(r.subscription)}),
        reply_markup: {inline_keyboard: [
          [{text: t.btnPanel, url: r.panel}],
          [{text: t.btnPassword(r.password), copy_text: {text: r.password}}],
          [tips],
          [{text: t.btnHome, callback_data: `menu:main:${lang}`}],
        ]},
      });
    }
  } catch (error) {
    if (progress?.message_id) await edit(env, chatId, progress.message_id, '❌ ' + failureText(t, error));
    else await send(env, {chat_id: chatId, text: '❌ ' + failureText(t, error)});
  }
}

// ---------------------------------------------------------------- webhook

const TOKEN_RE = /^[A-Za-z0-9_-]{35,60}$/;
const BOT_TOKEN_RE = /^[0-9]{7,12}:[A-Za-z0-9_-]{30,}$/;

async function showMenu(env, chatId, lang, from, messageId) {
  const t = M[lang];
  const text = t.welcome(escapeHtml(from.first_name || ''));
  const extra = {parse_mode: 'HTML', reply_markup: mainMenu(env, lang)};
  if (messageId && await edit(env, chatId, messageId, text, extra)) return;
  await send(env, {chat_id: chatId, text, ...extra});
}

async function showPanel(env, chatId, messageId, text, reply_markup) {
  const extra = {parse_mode: 'HTML', reply_markup, link_preview_options: {is_disabled: true}};
  if (messageId && await edit(env, chatId, messageId, text, extra)) return;
  await send(env, {chat_id: chatId, text, ...extra});
}

async function telegramWebhook(req, env, ctx) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || !env.SETUP_SIGNING_KEY) return errorResponse('Not configured', 503);
  if (!same(req.headers.get('x-telegram-bot-api-secret-token') || '', env.TELEGRAM_WEBHOOK_SECRET)) return errorResponse('Unauthorized', 401);
  if (Number(req.headers.get('content-length') || 0) > 65536) return errorResponse('Payload too large', 413);
  let update;
  try { update = await req.json(); } catch { return errorResponse('Bad update'); }

  const callback = update.callback_query;
  const message = update.message;
  const from = callback?.from || message?.from;
  const chat = callback?.message?.chat || message?.chat;
  if (!from || !Number.isSafeInteger(chat?.id)) return ok();
  // Deployments are account operations: never in groups or channels.
  if (chat.type !== 'private') return ok();
  const chatId = chat.id;
  const messageId = callback?.message?.message_id;
  if (callback?.id) { try { await tg(env, 'answerCallbackQuery', {callback_query_id: callback.id}); } catch { /* expired */ } }

  let [action, arg, lang] = ['menu', 'main', from.language_code === 'en' ? 'en' : 'fa'];
  if (callback?.data) {
    const parts = String(callback.data).split(':');
    if (parts.length === 3 && ['menu', 'sec', 'guide', 'tips', 'lang', 'check', 'run', 'cancel'].includes(parts[0])) [action, arg, lang] = [parts[0], parts[1], L(parts[2])];
  }
  if (action === 'lang') { lang = L(arg); action = 'menu'; }
  const t = M[lang];
  const text = String(message?.text || '').trim();

  if (/^\/id(?:@\w+)?$/i.test(text)) {
    await send(env, {chat_id: chatId, text: t.yourId(from.id)});
    return ok();
  }
  if (!allowed(from, env)) {
    await send(env, {chat_id: chatId, text: t.blocked(from.id)});
    return ok();
  }

  // Credential-looking messages are deleted at once and never echoed.
  if (message && (TOKEN_RE.test(text) || BOT_TOKEN_RE.test(text))) {
    try { await tg(env, 'deleteMessage', {chat_id: chatId, message_id: message.message_id}); } catch { /* too old or no permission */ }
    if (BOT_TOKEN_RE.test(text)) { await send(env, {chat_id: chatId, text: t.botTokenWarning}); return ok(); }
    if (!(await isMember(env, from.id))) { await send(env, {chat_id: chatId, parse_mode: 'HTML', text: t.gate(escapeHtml(from.first_name || ''), escapeHtml(requiredChannel(env))), reply_markup: gateMenu(env, lang)}); return ok(); }
    try { validateToken(text); } catch { await send(env, {chat_id: chatId, text: t.badToken}); return ok(); }
    const pending = await kvGet(env, `pending:${chatId}`);
    if (pending?.section) {
      await kvDel(env, `pending:${chatId}`);
      await send(env, {chat_id: chatId, text: t.tokenReceived});
      ctx.waitUntil(runDeployment(env, {chatId, section: pending.section, lang: L(pending.lang || lang), token: text}));
      return ok();
    }
    if (!env.STATE) { await send(env, {chat_id: chatId, text: t.chooseFirst, reply_markup: mainMenu(env, lang)}); return ok(); }
    await kvPut(env, `token:${chatId}`, {sealed: await sealToken(env, text)}, TOKEN_TTL);
    await send(env, {chat_id: chatId, text: t.tokenReceivedChoose, reply_markup: chooseMenu(lang)});
    return ok();
  }

  // Every other interaction requires the channel membership first.
  if (!(await isMember(env, from.id))) {
    const gateText = t.gate(escapeHtml(from.first_name || ''), escapeHtml(requiredChannel(env)));
    if (action === 'check') await send(env, {chat_id: chatId, text: t.notYet});
    await showPanel(env, chatId, action === 'check' ? null : messageId, gateText, gateMenu(env, lang));
    return ok();
  }

  if (action === 'run' && (arg === 'twp' || arg === 'vless')) {
    const stored = await kvGet(env, `token:${chatId}`);
    await kvDel(env, `token:${chatId}`);
    const token = stored?.sealed ? await openToken(env, stored.sealed) : '';
    if (!token) { await showPanel(env, chatId, messageId, t.tokenExpired, sectionMenu(env, arg, lang)); await kvPut(env, `pending:${chatId}`, {section: arg, lang}, PENDING_TTL); return ok(); }
    if (messageId) await edit(env, chatId, messageId, t.starting);
    ctx.waitUntil(runDeployment(env, {chatId, section: arg, lang, token}));
    return ok();
  }
  if (action === 'cancel') { await kvDel(env, `token:${chatId}`); await kvDel(env, `pending:${chatId}`); await showMenu(env, chatId, lang, from, messageId); return ok(); }
  if (action === 'sec' && (arg === 'twp' || arg === 'vless')) {
    await kvPut(env, `pending:${chatId}`, {section: arg, lang}, PENDING_TTL);
    await showPanel(env, chatId, messageId, arg === 'twp' ? t.sectionTwp : t.sectionVless, sectionMenu(env, arg, lang));
    return ok();
  }
  if (action === 'guide') { await showPanel(env, chatId, messageId, t.guide, guideMenu(env, ['twp', 'vless'].includes(arg) ? arg : 'main', lang)); return ok(); }
  if (action === 'tips') {
    const back = ['twp', 'vless'].includes(arg) ? {text: t.btnBackSection, callback_data: `sec:${arg}:${lang}`} : {text: t.btnBackMain, callback_data: `menu:main:${lang}`};
    await showPanel(env, chatId, messageId, t.tips, {inline_keyboard: [[back]]});
    return ok();
  }
  if (/^\/(?:twp|proxy)(?:@\w+)?$/i.test(text)) { await kvPut(env, `pending:${chatId}`, {section: 'twp', lang}, PENDING_TTL); await showPanel(env, chatId, null, t.sectionTwp, sectionMenu(env, 'twp', lang)); return ok(); }
  if (/^\/vless(?:@\w+)?$/i.test(text)) { await kvPut(env, `pending:${chatId}`, {section: 'vless', lang}, PENDING_TTL); await showPanel(env, chatId, null, t.sectionVless, sectionMenu(env, 'vless', lang)); return ok(); }
  if (/^\/(?:help|guide)(?:@\w+)?$/i.test(text)) { await showPanel(env, chatId, null, t.guide, guideMenu(env, 'main', lang)); return ok(); }
  if (/^\/language(?:@\w+)?$/i.test(text)) { await showMenu(env, chatId, lang === 'fa' ? 'en' : 'fa', from, null); return ok(); }
  await showMenu(env, chatId, lang, from, action === 'check' ? null : messageId);
  return ok();
}

// ---------------------------------------------------------------- bot profile & webhook bootstrap

async function configureTelegram(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return;
  const url = String(env.PUBLIC_BOT_WEBHOOK_URL || '');
  if (!/^https:\/\/[a-z0-9.-]+\.workers\.dev\/telegram$/.test(url)) throw new Error('Invalid public Telegram webhook URL');
  await tg(env, 'setMyName', {name: 'MAXIMUS Deployer'});
  await tg(env, 'setMyDescription', {description: 'ساخت رایگان وب‌پروکسی رسمی تلگرام (TWP) و سرور VLESS روی Cloudflare Workers، بدون VPS. DrFXAi'});
  await tg(env, 'setMyShortDescription', {short_description: 'MAXIMUS TWP & VLESS Deployer by DrFXAi'});
  await tg(env, 'setMyCommands', {commands: [
    {command: 'start', description: 'منوی اصلی MAXIMUS'},
    {command: 'twp', description: 'نصب وب‌پروکسی تلگرام (TWP)'},
    {command: 'vless', description: 'نصب سرور و پنل VLESS'},
    {command: 'help', description: 'راهنمای دریافت توکن کلادفلر'},
    {command: 'language', description: 'English / فارسی'},
    {command: 'id', description: 'نمایش آیدی عددی شما'},
  ]});
  await tg(env, 'setWebhook', {url, secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true});
  const info = await tg(env, 'getWebhookInfo', {});
  if (info.url !== url) throw new Error('Telegram webhook URL confirmation mismatch');
  console.log('MAXIMUS Deployer webhook confirmed:', info.url);
}

export default {
  async scheduled(_event, env, ctx) {
    if (env.BOOTSTRAP_WEBHOOK !== '1') return;
    ctx.waitUntil(configureTelegram(env));
  },
  async fetch(request, env, ctx) {
    try { return await route(request, env, ctx); }
    catch (error) { console.log('MAXIMUS Deployer error:', error && error.stack || error); return errorResponse('Internal error: ' + (error && error.message || 'unknown'), 500); }
  },
};

async function route(request, env, ctx) {
    const url = new URL(request.url);
    const context = ctx || {waitUntil: p => p};
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({service: 'MAXIMUS Deployer', configured: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET && env.SETUP_SIGNING_KEY), state: !!env.STATE, channel: requiredChannel(env) || null}), {headers: {...NO_STORE, 'content-type': 'application/json'}});
    }
    if (url.pathname === '/telegram' && request.method === 'POST') return telegramWebhook(request, env, context);
    return errorResponse('Not found', 404);
}
