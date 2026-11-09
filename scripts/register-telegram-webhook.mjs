// Configure Telegram branding and the deployer webhook without exposing secrets.
// Run from a trusted shell with TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET set.
const url=process.argv[2];
const token=process.env.TELEGRAM_BOT_TOKEN;
const secret=process.env.TELEGRAM_WEBHOOK_SECRET;
if(!url||!/^https:\/\/[^\s/?#]+(?:\/[^?#]*)?\/telegram$/.test(url)||!token||!secret){
  console.error('Usage: TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET environment variables + HTTPS /telegram URL are required.');
  process.exit(1);
}
const api=async(method,body)=>{
  const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error'
  });
  const result=await r.json().catch(()=>({}));
  if(!r.ok||!result.ok){throw new Error(`Telegram ${method} failed (${r.status}); credentials and API errors are not displayed.`);}
};
const commands=[
  {command:'start',description:'Open the MAXIMUS TWP menu'},
  {command:'id',description:'Show your Telegram user ID'},
  {command:'help',description:'Cloudflare installation guide'},
  {command:'language',description:'English / فارسی'},
  {command:'security',description:'Security and token guidance'},
];
try{
  await api('setMyName',{name:'MAXIMUS TWP Deployer'});
  await api('setMyDescription',{description:'Create and manage your private Telegram WEB Proxy on Cloudflare Workers. Secure setup, no VPS. Powered by DrFXAi.'});
  await api('setMyShortDescription',{short_description:'Private Telegram WEB Proxy deployment by DrFXAi.'});
  await api('setMyCommands',{commands});
  await api('setWebhook',{url,secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:true});
  console.log('MAXIMUS TWP bot profile, commands and webhook configured at:',new URL(url).origin);
}catch(err){console.error(err?.message||'Telegram setup failed.');process.exit(1);}
