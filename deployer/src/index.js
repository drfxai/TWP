import {CORE_BUNDLE} from '../generated/core.js';
import {deployWorker} from './deploy.js';
import {escapeHtml,setupPage,resultPage,expiredPage} from './ui.js';

const NO_STORE={'cache-control':'no-store, private','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY'};
const HTML={...NO_STORE,'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"};
const errorResponse=(msg,status=400)=>new Response(msg,{status,headers:NO_STORE});
const encode = value => btoa(String.fromCharCode(...new TextEncoder().encode(value))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const decode = str => new TextDecoder().decode(Uint8Array.from(atob(str.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-str.length%4)%4)),c=>c.charCodeAt(0)));
const tss=(s)=>new TextEncoder().encode(s);
const same=(a,b)=>{if(!a||!b||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;};

export async function signTicket(payload,key){
  const raw=encode(JSON.stringify(payload));
  const k=await crypto.subtle.importKey('raw',tss(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const mac=await crypto.subtle.sign('HMAC',k,tss(raw));
  return {ticket:raw,sig:btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')};
}
export async function verifyTicket(ticket,sig,key){
  if(!/^[A-Za-z0-9_-]{30,200}$/.test(ticket||'')||!/^[A-Za-z0-9_-]{43}$/.test(sig||''))return null;
  const k=await crypto.subtle.importKey('raw',tss(key),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const mac=Uint8Array.from(atob(sig.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-sig.length%4)%4)),c=>c.charCodeAt(0));
  if(!await crypto.subtle.verify('HMAC',k,mac,tss(ticket)))return null;
  let data;try{data=JSON.parse(decode(ticket));}catch{return null;}
  if(!data||!Number.isSafeInteger(data.chatId)||!Number.isSafeInteger(data.exp)||data.exp<Date.now()/1000||data.exp>Date.now()/1000+605||!['en','fa'].includes(data.lang))return null;
  return data;
}

const M={
 en:{welcome:'MAXIMUS TWP · DrFXAi\n\nDeploy your own private Telegram WEB Proxy on Cloudflare Workers, with no VPS. English is the default language.\n\nSelect an option below. WEB proxy client support must be verified independently.',deploy:'⚡ Deploy TWP',help:'📘 Installation guide',language:'🌐 Language / زبان',security:'🔐 Security',guide:'Fast setup:\n1. Create a Cloudflare account.\n2. Open Deploy TWP.\n3. Create an API token scoped to Workers Scripts: Edit for your account.\n4. Enter account ID, subdomain and token in the HTTPS form (NOT in chat).\n5. Keep your one-time admin token, then test the Telegram link.\n\nhttps://github.com/drfxai/TWP',sec:'Never send tokens in Telegram messages. Use only the HTTPS deployment form; choose a limited, short-lived Cloudflare API token and revoke it afterwards. Do not forward setup links.',link:'Open secure deployment form',blocked:'This deployer is private. Please contact the administrator.'},
 fa:{welcome:'MAXIMUS TWP · DrFXAi\n\nساخت وب‌پروکسی خصوصی تلگرام روی Cloudflare Workers و بدون VPS. زبان ربات قابل تغییر است.\n\nابتدا گزینه مورد نظر را انتخاب کنید. پشتیبانی نسخه تلگرام از WEB Proxy باید جداگانه بررسی شود.',deploy:'⚡ نصب TWP',help:'📘 راهنمای نصب',language:'🌐 Language / زبان',security:'🔐 امنیت',guide:'نصب ساده:\n۱. حساب Cloudflare بسازید.\n۲. گزینه نصب TWP را بزنید.\n۳. توکن API محدود به Workers Scripts: Edit و حساب خود بسازید.\n۴. شناسه حساب، زیردامنه و توکن را فقط در فرم HTTPS وارد کنید، نه چت.\n۵. کلید مدیریت را ذخیره و اتصال تلگرام را آزمایش کنید.\n\nhttps://github.com/drfxai/TWP',sec:'توکن را در پیام تلگرام نفرستید. فقط فرم HTTPS؛ توکن Cloudflare محدود و موقت باشد و پس از نصب باطل شود. لینک نصب را برای دیگران نفرستید.',link:'باز کردن فرم امن نصب',blocked:'این ربات فعلاً خصوصی است و فقط ادمین دسترسی دارد.'}
};
function menu(lang='en'){const t=M[lang];return {inline_keyboard:[[{text:t.deploy,callback_data:`deploy:${lang}`}],[{text:t.help,callback_data:`help:${lang}`},{text:t.security,callback_data:`security:${lang}`}],[{text:t.language,callback_data:lang==='en'?'lang:fa':'lang:en'}]]};}
async function telegramApi(env,method,body){
  const res=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)
  });
  const data=await res.json().catch(()=>null);
  if(!res.ok||!data?.ok)throw new Error(`Telegram API ${method} rejected request (HTTP ${res.status})`);
  return data.result;
}
// Keep the secure link usable when Telegram rejects an inline keyboard.
async function sendWithFallback(env,message){
  try { return await telegramApi(env,'sendMessage',message); }
  catch(error){
    if(!message.reply_markup)throw error;
    const {reply_markup:unused,...plain}=message;
    return telegramApi(env,'sendMessage',plain);
  }
}
const owner=(from,env)=>{
  const ids=String(env.BOT_OWNER_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(ids.length)return ids.includes(String(from.id));
  const username=String(env.BOT_OWNER_USERNAME||'').replace(/^@/,'').toLowerCase();
  // Username enrollment is temporary: replace with a numeric ID allowlist as soon as possible.
  return !!username && String(from.username||'').toLowerCase()===username;
};

async function telegramWebhook(req,env){
  if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_WEBHOOK_SECRET||!env.SETUP_SIGNING_KEY)return errorResponse('Not configured',503);
  if(!same(req.headers.get('x-telegram-bot-api-secret-token')||'',env.TELEGRAM_WEBHOOK_SECRET))return errorResponse('Unauthorized',401);
  if(Number(req.headers.get('content-length')||0)>65536)return errorResponse('Payload too large',413);
  let update;try{update=await req.json();}catch{return errorResponse('Bad update');}
  const callback=update.callback_query;
  const from=callback?.from||update.message?.from;
  const chatId=callback?.message?.chat?.id||update.message?.chat?.id;
  if(!from||!Number.isSafeInteger(chatId))return new Response('ok',{headers:NO_STORE});
  // Deployment is an account operation; never expose setup links in group chats.
  const chatType=callback?.message?.chat?.type||update.message?.chat?.type;
  if(chatType!=='private')return new Response('ok',{headers:NO_STORE});
  if(callback?.id){
    try{await telegramApi(env,'answerCallbackQuery',{callback_query_id:callback.id});}
    catch{/* Expired query acknowledgement should not block the action. */}
  }
  const messageText=String(update.message?.text||'').trim();
  // /id works before owner enrollment, so the operator can retrieve their Telegram user ID.
  if(/^\/id(?:@drfxtwp_bot)?$/i.test(messageText)){
    await telegramApi(env,'sendMessage',{chat_id:chatId,text:`Your Telegram user ID: ${from.id}\nConfigure BOT_OWNER_IDS with this number in the deployer Worker.`});
    return new Response('ok',{headers:NO_STORE});
  }
  // Delete probable credential messages immediately, without copying or echoing the value.
  // Bot message deletion may fail if the message is already too old or lacks permission.
  if(!callback && /^(?:[0-9]{7,12}:[A-Za-z0-9_-]{30,}|[A-Za-z0-9_-]{40,})$/.test(messageText)){
    try{await telegramApi(env,'deleteMessage',{chat_id:chatId,message_id:update.message.message_id});}catch{}
    await telegramApi(env,'sendMessage',{chat_id:chatId,text:'For your security, never send Telegram or Cloudflare tokens in chat. Revoke and rotate any exposed token; use only the HTTPS setup form.'});
    return new Response('ok',{headers:NO_STORE});
  }
  let action='menu',lang='en';
  if(callback?.data){const [a,l]=callback.data.split(':');if(['deploy','help','security','lang','menu'].includes(a)&&['en','fa'].includes(l)){action=a;lang=l;}}
  // /start intentionally always starts in English; language choice is explicit.
  if(/^\/deploy(?:@drfxtwp_bot)?$/i.test(messageText))action='deploy';
  if(/^\/help(?:@drfxtwp_bot)?$/i.test(messageText))action='help';
  if(/^\/security(?:@drfxtwp_bot)?$/i.test(messageText))action='security';
  if(/^\/language(?:@drfxtwp_bot)?$/i.test(messageText))action='lang';
  if(!owner(from,env)){
    await sendWithFallback(env,{chat_id:chatId,text:M[lang].blocked+'\nYour Telegram ID: '+from.id+'\nUse /id to enroll an authorized operator.'});
    return new Response('ok',{headers:NO_STORE});
  }
  const t=M[lang];
  if(action==='lang'||action==='menu'){
    await sendWithFallback(env,{chat_id:chatId,text:t.welcome+'\n\nSend /deploy if the inline button does not respond.',reply_markup:menu(lang)});
  }else if(action==='help'||action==='security'){
    await sendWithFallback(env,{chat_id:chatId,text:action==='help'?t.guide:t.sec,reply_markup:menu(lang)});
  }else if(action==='deploy'){
    const data=await signTicket({chatId,lang,exp:Math.floor(Date.now()/1000)+600},env.SETUP_SIGNING_KEY);
    const link=new URL('/setup',new URL(req.url).origin);link.searchParams.set('ticket',data.ticket);link.searchParams.set('sig',data.sig);
    // The URL remains available even if Telegram rejects its inline button.
    await sendWithFallback(env,{chat_id:chatId,text:t.link+'\n'+link.href+'\n\n'+t.sec,
      link_preview_options:{is_disabled:true},
      reply_markup:{inline_keyboard:[[{text:t.link,url:link.href}],[{text:t.language,callback_data:lang==='en'?'lang:fa':'lang:en'}]]}});
  }else{
    await sendWithFallback(env,{chat_id:chatId,text:t.welcome+'\n\nSend /deploy if the inline button does not respond.',reply_markup:menu(lang)});
  }
  return new Response('ok',{headers:NO_STORE});
}

async function setup(req,url,env){
  if(!env.SETUP_SIGNING_KEY)return errorResponse('Not configured',503);
  if(req.method==='GET'){
    const ticket=url.searchParams.get('ticket'),sig=url.searchParams.get('sig');
    const v=await verifyTicket(ticket,sig,env.SETUP_SIGNING_KEY);
    const lang=(url.searchParams.get('lang')==='fa'||url.searchParams.get('lang')==='en')?url.searchParams.get('lang'):v?.lang;
    return new Response(v?setupPage({lang,ticket,sig}):expiredPage(),{status:v?200:403,headers:HTML});
  }
  if(req.method!=='POST')return errorResponse('Method not allowed',405);
  if(!(req.headers.get('content-type')||'').startsWith('application/x-www-form-urlencoded'))return errorResponse('Expected form data',415);
  if(Number(req.headers.get('content-length')||0)>16000)return errorResponse('Form too large',413);
  if(req.headers.get('origin')&&req.headers.get('origin')!==url.origin)return errorResponse('Cross-origin submit refused',403);
  const raw=await req.text();if(raw.length>16000)return errorResponse('Form too large',413);
  const d=new URLSearchParams(raw),ticket=d.get('ticket'),sig=d.get('sig');
  const v=await verifyTicket(ticket,sig,env.SETUP_SIGNING_KEY);
  if(!v)return new Response(expiredPage(),{status:403,headers:HTML});
  const lang=['en','fa'].includes(d.get('lang'))?d.get('lang'):v.lang;
  const fields={accountId:d.get('accountId')||'',subdomain:d.get('subdomain')||'',workerName:d.get('workerName')||'',apiToken:d.get('apiToken')||''};
  try{
    const result=await deployWorker({...fields,coreSource:CORE_BUNDLE});
    return new Response(resultPage({lang,result}),{headers:HTML});
  }catch(err){
    // Some failures happen after uploading the Worker but before enabling workers.dev.
    // Do not echo tokens or upstream bodies in the response or logs.
    const message=err instanceof Error?err.message:'Deployment could not be completed.';
    return new Response(setupPage({lang,ticket,sig,error:message}),{status:422,headers:HTML});
  }
}

// Scheduled registration avoids distributing bot credentials to external setup scripts.
// Remove the temporary cron trigger after Telegram reports a healthy webhook.
async function configureTelegram(env){
  if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_WEBHOOK_SECRET)return;
  const url=String(env.PUBLIC_BOT_WEBHOOK_URL||'');
  if(!/^https:\/\/[a-z0-9.-]+\.workers\.dev\/telegram$/.test(url))throw new Error('Invalid public Telegram webhook URL');
  const invoke=async(method,body)=>{
    const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const data=await r.json().catch(()=>({}));
    if(!r.ok||!data.ok)throw new Error('Telegram setup '+method+' failed ('+r.status+')');
    return data.result;
  };
  await invoke('setMyName',{name:'MAXIMUS TWP Deployer'});
  await invoke('setMyDescription',{description:'Deploy a private Telegram WEB Proxy on Cloudflare Workers. Secure setup, no VPS. Powered by DrFXAi.'});
  await invoke('setMyShortDescription',{short_description:'Private Telegram WEB Proxy deployment by DrFXAi.'});
  await invoke('setMyCommands',{commands:[
    {command:'start',description:'Open the MAXIMUS TWP menu'},
    {command:'id',description:'Display your Telegram user ID'},
    {command:'help',description:'Cloudflare installation guide'},
    {command:'deploy',description:'Get a secure deployment link'},
    {command:'language',description:'English / فارسی'},
    {command:'security',description:'Token security guidance'}
  ]});
  await invoke('setWebhook',{url,secret_token:env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:['message','callback_query'],drop_pending_updates:true});
  const info=await invoke('getWebhookInfo',{});
  if(info.url!==url)throw new Error('Telegram webhook URL confirmation mismatch');
  console.log('MAXIMUS TWP bot configuration confirmed; URL matched:',info.url);
}

export default {
  async scheduled(_event,env,ctx){
    if(env.BOOTSTRAP_WEBHOOK!=='1')return;
    ctx.waitUntil(configureTelegram(env));
  },
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/health'&&request.method==='GET')return new Response(JSON.stringify({service:'MAXIMUS TWP Deployer',configured:!!(env.TELEGRAM_BOT_TOKEN&&env.TELEGRAM_WEBHOOK_SECRET&&env.SETUP_SIGNING_KEY)}),{headers:{...NO_STORE,'content-type':'application/json'}});
    if(url.pathname==='/telegram'&&request.method==='POST')return telegramWebhook(request,env);
    if(url.pathname==='/setup')return setup(request,url,env);
    return errorResponse('Not found',404);
  }
};
