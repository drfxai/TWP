const url=process.argv[2];
const token=process.env.TELEGRAM_BOT_TOKEN;
const secret=process.env.TELEGRAM_WEBHOOK_SECRET;
if(!url||!/^https:\/\/[^\s]+\/telegram$/.test(url)||!token||!secret){
  console.error('Usage: TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET environment variables + HTTPS /telegram URL are required.');
  process.exit(1);
}
const r=await fetch(`https://api.telegram.org/bot${token}/setWebhook`,{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({url,secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:true}),
});
const response=await r.json();
if(!r.ok||!response.ok){console.error('Telegram rejected the webhook registration.');process.exit(1);}
console.log('Webhook registered for:',new URL(url).origin,'(secret not printed)');
