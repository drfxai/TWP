/**
 * ⚡ MAXIMUS VLESS Server & Panel for Cloudflare Workers
 * Copyright (c) 2026 DrFXAi — MIT License — https://github.com/drfxai/TWP
 *
 * - VLESS over WebSocket (TLS by Cloudflare), TCP relay through cloudflare:sockets
 * - UDP limited to DNS (port 53), resolved over DNS-over-HTTPS
 * - WebSocket early data (?ed=2560) via Sec-WebSocket-Protocol
 * - Password-protected admin panel (/admin) with settings stored in Workers KV
 * - Subscription endpoint (/sub/<uuid>) for v2rayNG, Hiddify, NekoBox, Streisand…
 *
 * Bindings: UUID (secret), ADMIN_PASSWORD (secret), KV (KV namespace, optional),
 *           PROXYIP (optional fallback relay host[:port]).
 */

import { connect } from 'cloudflare:sockets';

const enc = new TextEncoder();
const dec = new TextDecoder();
const DEFAULTS = {
  address: '',            // clean IP / domain; empty = worker host
  port: 443,
  path: '/?ed=2560',
  fingerprint: 'randomized',
  name: 'MAXIMUS',
  proxyIp: '',
  dohUrl: 'https://1.1.1.1/dns-query',
};
const SESSION_TTL = 12 * 3600;
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

// ------------------------------------------------------------------ helpers

function uuidBytes(uuid) {
  const hex = String(uuid || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function equalText(a, b) {
  return equalBytes(enc.encode(String(a)), enc.encode(String(b)));
}

function b64urlToBytes(str) {
  if (!str) return null;
  try {
    const s = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  } catch { return null; }
}

function bytesToB64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, x => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[x]));
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

// ------------------------------------------------------------------ settings

async function loadSettings(env) {
  let saved = {};
  if (env.KV) {
    try { saved = JSON.parse((await env.KV.get('settings')) || '{}') || {}; } catch { saved = {}; }
  }
  const s = {...DEFAULTS, ...saved};
  if (env.PROXYIP && !s.proxyIp) s.proxyIp = String(env.PROXYIP);
  s.uuid = saved.uuid && uuidBytes(saved.uuid) ? saved.uuid : String(env.UUID || '');
  return s;
}

function sanitizeSettings(input, current) {
  const out = {...current};
  const host = v => /^[A-Za-z0-9.:\[\]-]{0,253}$/.test(v);
  if (typeof input.address === 'string' && host(input.address.trim())) out.address = input.address.trim();
  const port = Number(input.port);
  if (Number.isInteger(port) && port > 0 && port < 65536) out.port = port;
  if (typeof input.path === 'string' && /^\/[A-Za-z0-9/?=&._%-]{0,120}$/.test(input.path.trim())) out.path = input.path.trim();
  if (['randomized', 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq', 'random'].includes(input.fingerprint)) out.fingerprint = input.fingerprint;
  if (typeof input.name === 'string' && /^[\p{L}\p{N} _.-]{1,40}$/u.test(input.name.trim())) out.name = input.name.trim();
  if (typeof input.proxyIp === 'string' && host(input.proxyIp.trim())) out.proxyIp = input.proxyIp.trim();
  if (input.rotateUuid === 'on') out.uuid = crypto.randomUUID();
  return out;
}

function buildLink(s, host) {
  const address = s.address || host;
  const q = new URLSearchParams({
    encryption: 'none', security: 'tls', sni: host, fp: s.fingerprint,
    type: 'ws', host, path: s.path,
  });
  return `vless://${s.uuid}@${address.includes(':') && !address.startsWith('[') ? `[${address}]` : address}:${s.port}?${q.toString()}#${encodeURIComponent(s.name)}`;
}

// ------------------------------------------------------------------ admin session

async function issueSession(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const mac = bytesToB64url(await hmac(String(env.ADMIN_PASSWORD), 'session:' + exp));
  return `${exp}.${mac}`;
}

async function checkSession(request, env) {
  const cookie = request.headers.get('cookie') || '';
  const m = /(?:^|;\s*)mx_session=([0-9]+)\.([A-Za-z0-9_-]{43})/.exec(cookie);
  if (!m || !env.ADMIN_PASSWORD) return false;
  if (Number(m[1]) < Date.now() / 1000) return false;
  const expected = bytesToB64url(await hmac(String(env.ADMIN_PASSWORD), 'session:' + m[1]));
  return equalText(expected, m[2]);
}

// ------------------------------------------------------------------ pages

const STYLE = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#000 radial-gradient(#ffffff14 1px,transparent 1px) 0 0/18px 18px;color:#f2f2f2;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
main{max-width:720px;margin:auto;padding:28px 18px 60px}.brand{display:flex;justify-content:space-between;align-items:center;font-size:12px;letter-spacing:.3em}.brand b{color:#d71921}.dot{width:8px;height:8px;border-radius:50%;background:#d71921;display:inline-block;margin-inline-end:8px;box-shadow:0 0 12px #d71921}
.card{background:#111;border:1px solid #2a2a2a;border-radius:24px;padding:22px;margin-top:18px}h1{font-size:22px;margin:0 0 6px}p{color:#9a9a9a;font-size:13px;line-height:1.7}
label{display:block;font-size:11px;letter-spacing:.12em;color:#bdbdbd;margin:14px 0 6px}input,select{width:100%;background:#000;border:1px solid #333;color:#fff;border-radius:14px;padding:12px;font:inherit}
button,.btn{display:inline-flex;justify-content:center;align-items:center;gap:8px;border:0;border-radius:999px;background:#d71921;color:#fff;padding:12px 18px;font:700 13px inherit;cursor:pointer;text-decoration:none;margin-top:14px}.ghost{background:#1c1c1c;border:1px solid #333}
code{display:block;background:#000;border:1px solid #2a2a2a;border-radius:14px;padding:12px;font-size:11px;line-height:1.7;word-break:break-all;color:#e8e8e8}.row{display:flex;gap:10px;flex-wrap:wrap}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.k{font-size:11px;color:#8a8a8a}.v{font-size:13px;margin-top:4px;word-break:break-all}
.msg{color:#ff6b6b;font-size:12px;margin-top:10px}.ok{color:#6bffb3}footer{margin-top:26px;text-align:center;color:#666;font-size:11px}footer a{color:#aaa}@media(max-width:560px){.grid{grid-template-columns:1fr}}`;

function page(title, body) {
  return `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} — MAXIMUS</title><style>${STYLE}</style></head><body><main><div class="brand"><span><span class="dot"></span>MAXIMUS <b>VLESS</b></span><span>DrFXAi</span></div>${body}<footer>MAXIMUS VLESS • by DrFXAi • <a href="https://github.com/drfxai/TWP" target="_blank" rel="noopener">GitHub</a></footer></main></body></html>`;
}

function html(body, status = 200, extra = {}) {
  return new Response(body, {status, headers: {...HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", ...extra}});
}

function loginPage(error = '') {
  return page('ورود به پنل', `<div class="card"><h1>🔐 ورود به پنل مدیریت</h1><p>رمز پنل در پیام ربات MAXIMUS Deployer به شما تحویل داده شده است.</p>
<form method="POST" action="/admin/login"><label>رمز پنل (ADMIN)</label><input name="password" type="password" autocomplete="current-password" required maxlength="128"><button type="submit">ورود</button></form>
${error ? `<div class="msg">${escapeHtml(error)}</div>` : ''}</div>`);
}

function panelPage(s, host, notice = '') {
  const link = buildLink(s, host);
  const sub = `https://${host}/sub/${s.uuid}`;
  const opt = v => `<option value="${v}"${s.fingerprint === v ? ' selected' : ''}>${v}</option>`;
  return page('پنل VLESS', `<div class="card"><h1>🌐 سرور و پنل اختصاصی VLESS</h1><p>کانفیگ را کپی کنید یا لینک اشتراک را در v2rayNG، Hiddify یا NekoBox وارد کنید.</p>
<label>🔗 لینک کانفیگ VLESS</label><code id="cfg">${escapeHtml(link)}</code><div class="row"><button type="button" onclick="cp('cfg',this)">COPY CODE</button></div>
<label>📥 لینک اشتراک (Subscription)</label><code id="sub">${escapeHtml(sub)}</code><div class="row"><button type="button" class="ghost" onclick="cp('sub',this)">کپی لینک اشتراک</button></div>
${notice ? `<div class="msg ok">${escapeHtml(notice)}</div>` : ''}</div>
<div class="card"><h1>📋 مشخصات ورکر</h1><div class="grid"><div><div class="k">آدرس سرور</div><div class="v">${escapeHtml(host)}</div></div><div><div class="k">UUID</div><div class="v">${escapeHtml(s.uuid)}</div></div><div><div class="k">مسیر WebSocket</div><div class="v">${escapeHtml(s.path)}</div></div><div><div class="k">Fingerprint</div><div class="v">${escapeHtml(s.fingerprint)}</div></div></div></div>
<div class="card"><h1>⚙️ تنظیمات</h1><p>برای پایداری و سرعت بیشتر، یک آی‌پی یا دامنه‌ی تمیز کلادفلر در فیلد آدرس بگذارید. اگر ندارید خالی بگذارید.</p>
<form method="POST" action="/admin/save"><label>آدرس (آی‌پی تمیز / دامنه)</label><input name="address" value="${escapeHtml(s.address)}" placeholder="${escapeHtml(host)}">
<div class="grid"><div><label>پورت</label><input name="port" type="number" min="1" max="65535" value="${s.port}"></div><div><label>Fingerprint</label><select name="fingerprint">${['randomized', 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random'].map(opt).join('')}</select></div></div>
<label>مسیر WebSocket</label><input name="path" value="${escapeHtml(s.path)}"><label>نام کانفیگ</label><input name="name" value="${escapeHtml(s.name)}">
<label>PROXYIP (اختیاری، برای سایت‌های پشت کلادفلر)</label><input name="proxyIp" value="${escapeHtml(s.proxyIp)}" placeholder="proxy.example.com:443">
<label><input type="checkbox" name="rotateUuid" style="width:auto"> ساخت UUID جدید (کانفیگ‌های قبلی از کار می‌افتند)</label>
<button type="submit">ذخیره تغییرات</button></form><form method="POST" action="/admin/logout"><button class="ghost" type="submit">خروج</button></form></div>
<script>function cp(id,b){const t=document.getElementById(id).innerText;const done=()=>{const o=b.innerText;b.innerText='کپی شد!';setTimeout(()=>b.innerText=o,1800)};if(navigator.clipboard)navigator.clipboard.writeText(t).then(done).catch(()=>fb(t,done));else fb(t,done)}function fb(t,done){const a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();try{document.execCommand('copy');done()}catch(e){}a.remove()}</script>`);
}

function camouflage() {
  return page('MAXIMUS', `<div class="card"><h1>⚡ MAXIMUS Edge</h1><p>This service is running on Cloudflare Workers.</p></div>`);
}

// ------------------------------------------------------------------ VLESS protocol

/**
 * Parses a VLESS request header.
 * version(1) | uuid(16) | addonsLen(1) | addons | cmd(1) | port(2) | atyp(1) | address | payload
 */
export function parseVlessHeader(buf, expectedUuid) {
  if (buf.length < 24) throw new Error('short header');
  const version = buf[0];
  if (!equalBytes(buf.subarray(1, 17), expectedUuid)) throw new Error('unauthorized');
  const addonsLen = buf[17];
  let i = 18 + addonsLen;
  const cmd = buf[i++];
  if (cmd !== 1 && cmd !== 2) throw new Error('unsupported command');
  const port = (buf[i] << 8) | buf[i + 1];
  i += 2;
  const atyp = buf[i++];
  let address = '';
  if (atyp === 1) {
    address = Array.from(buf.subarray(i, i + 4)).join('.');
    i += 4;
  } else if (atyp === 2) {
    const len = buf[i++];
    address = dec.decode(buf.subarray(i, i + len));
    i += len;
  } else if (atyp === 3) {
    const parts = [];
    for (let j = 0; j < 8; j++) parts.push(((buf[i + j * 2] << 8) | buf[i + j * 2 + 1]).toString(16));
    address = parts.join(':');
    i += 16;
  } else {
    throw new Error('bad address type');
  }
  if (!address || i > buf.length) throw new Error('bad address');
  return {version, isUdp: cmd === 2, port, address, payload: buf.subarray(i)};
}

function splitHostPort(value, fallbackPort) {
  const v = String(value || '').trim();
  if (!v) return null;
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(v) || /^([^:]+)(?::(\d+))?$/.exec(v);
  if (!m) return null;
  return {hostname: m[1], port: Number(m[2]) || fallbackPort};
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return enc.encode(String(data));
}

function safeClose(ws) {
  try { if (ws.readyState === 1 || ws.readyState === 2) ws.close(); } catch { /* ignore */ }
}

async function handleVless(request, settings) {
  const expected = uuidBytes(settings.uuid);
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const early = b64urlToBytes(request.headers.get('sec-websocket-protocol') || '');
  let header = null;
  let socket = null;
  let writer = null;
  let responseHeader = null;
  let dnsBuffer = new Uint8Array(0);
  const queue = [];
  let busy = false;

  const sendToClient = (bytes) => {
    if (server.readyState !== 1) return;
    if (responseHeader) {
      const merged = new Uint8Array(responseHeader.length + bytes.length);
      merged.set(responseHeader);
      merged.set(bytes, responseHeader.length);
      responseHeader = null;
      server.send(merged);
    } else {
      server.send(bytes);
    }
  };

  const pipeRemote = async (sock, onEmpty) => {
    let received = false;
    try {
      const reader = sock.readable.getReader();
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        if (value && value.length) { received = true; sendToClient(value); }
      }
    } catch { /* remote closed */ }
    if (!received && onEmpty) return onEmpty();
    safeClose(server);
  };

  const openTcp = async (target, firstChunk, allowRetry) => {
    socket = connect({hostname: target.hostname, port: target.port});
    writer = socket.writable.getWriter();
    if (firstChunk.length) await writer.write(firstChunk);
    const retry = allowRetry && settings.proxyIp ? async () => {
      const fallback = splitHostPort(settings.proxyIp, header.port);
      try { writer.releaseLock(); socket.close(); } catch { /* ignore */ }
      if (!fallback) return safeClose(server);
      return openTcp(fallback, firstChunk, false);
    } : null;
    pipeRemote(socket, retry);
  };

  const dnsQuery = async (packet) => {
    const res = await fetch(settings.dohUrl || DEFAULTS.dohUrl, {method: 'POST', headers: {'content-type': 'application/dns-message'}, body: packet});
    const answer = new Uint8Array(await res.arrayBuffer());
    const framed = new Uint8Array(answer.length + 2);
    framed[0] = answer.length >> 8;
    framed[1] = answer.length & 0xff;
    framed.set(answer, 2);
    sendToClient(framed);
  };

  const handleUdp = async (chunk) => {
    const merged = new Uint8Array(dnsBuffer.length + chunk.length);
    merged.set(dnsBuffer);
    merged.set(chunk, dnsBuffer.length);
    let i = 0;
    while (i + 2 <= merged.length) {
      const len = (merged[i] << 8) | merged[i + 1];
      if (i + 2 + len > merged.length) break;
      await dnsQuery(merged.slice(i + 2, i + 2 + len));
      i += 2 + len;
    }
    dnsBuffer = merged.slice(i);
  };

  const handleChunk = async (chunk) => {
    if (!header) {
      header = parseVlessHeader(chunk, expected);
      responseHeader = Uint8Array.of(header.version, 0);
      if (header.isUdp) {
        if (header.port !== 53) throw new Error('only DNS over UDP');
        return handleUdp(header.payload);
      }
      return openTcp({hostname: header.address, port: header.port}, header.payload, true);
    }
    if (header.isUdp) return handleUdp(chunk);
    if (writer) await writer.write(chunk);
  };

  const drain = async () => {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) await handleChunk(queue.shift());
    } catch {
      safeClose(server);
      try { socket && socket.close(); } catch { /* ignore */ }
    } finally {
      busy = false;
    }
  };

  if (early && early.length) queue.push(early);
  server.addEventListener('message', (event) => { queue.push(toBytes(event.data)); drain(); });
  server.addEventListener('close', () => { try { socket && socket.close(); } catch { /* ignore */ } safeClose(server); });
  server.addEventListener('error', () => { try { socket && socket.close(); } catch { /* ignore */ } });
  drain();

  const headers = {};
  if (request.headers.get('sec-websocket-protocol')) headers['sec-websocket-protocol'] = request.headers.get('sec-websocket-protocol');
  return new Response(null, {status: 101, webSocket: client, headers});
}

// ------------------------------------------------------------------ router

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const settings = await loadSettings(env);
  if (!uuidBytes(settings.uuid)) return new Response('Not configured', {status: 503, headers: HEADERS});

  if ((request.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
    return handleVless(request, settings);
  }

  if (request.method === 'GET' && url.pathname === `/sub/${settings.uuid}`) {
    const body = btoa(buildLink(settings, host) + '\n');
    return new Response(body, {headers: {...HEADERS, 'content-type': 'text/plain; charset=utf-8', 'profile-title': 'base64:' + btoa(settings.name), 'profile-update-interval': '12'}});
  }

  if (url.pathname === '/admin' && request.method === 'GET') {
    if (!(await checkSession(request, env))) return html(loginPage());
    return html(panelPage(settings, host, url.searchParams.get('saved') ? 'تغییرات ذخیره شد.' : ''));
  }

  if (url.pathname === '/admin/login' && request.method === 'POST') {
    const form = new URLSearchParams(await request.text());
    if (!env.ADMIN_PASSWORD || !equalText(form.get('password') || '', env.ADMIN_PASSWORD)) {
      return html(loginPage('رمز اشتباه است.'), 403);
    }
    const token = await issueSession(env);
    return new Response(null, {status: 303, headers: {...HEADERS, location: '/admin', 'set-cookie': `mx_session=${token}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL}`}});
  }

  if (url.pathname === '/admin/logout' && request.method === 'POST') {
    return new Response(null, {status: 303, headers: {...HEADERS, location: '/admin', 'set-cookie': 'mx_session=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0'}});
  }

  if (url.pathname === '/admin/save' && request.method === 'POST') {
    if (!(await checkSession(request, env))) return html(loginPage(), 403);
    if (!env.KV) return html(panelPage(settings, host, 'KV متصل نیست؛ تنظیمات ذخیره نشد.'), 503);
    const form = Object.fromEntries(new URLSearchParams(await request.text()));
    const next = sanitizeSettings(form, settings);
    const {uuid, ...rest} = next;
    await env.KV.put('settings', JSON.stringify({...rest, uuid}));
    return new Response(null, {status: 303, headers: {...HEADERS, location: '/admin?saved=1'}});
  }

  if (request.method === 'GET' && url.pathname === '/') return html(camouflage());
  return new Response('Not found', {status: 404, headers: HEADERS});
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};

export const internals = {parseVlessHeader, buildLink, sanitizeSettings, uuidBytes};
