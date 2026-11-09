import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const origin='https://maximus-twp-deployer.drfxai.workers.dev';
const env={TELEGRAM_BOT_TOKEN:'test:fake',TELEGRAM_WEBHOOK_SECRET:'test-webhook-secret',SETUP_SIGNING_KEY:'test-key-material-for-hmac-that-is-long',BOT_OWNER_USERNAME:'drfxgod'};
const api=(ok,status=200)=>new Response(JSON.stringify({ok,result:ok}),{status,headers:{'content-type':'application/json'}});
const originalFetch=globalThis.fetch;
const webhook=update=>new Request(origin+'/telegram',{method:'POST',headers:{'x-telegram-bot-api-secret-token':env.TELEGRAM_WEBHOOK_SECRET,'content-type':'application/json'},body:JSON.stringify(update)});

test('Deploy TWP callback survives expired callback ID and Telegram keyboard rejection',async()=>{
  const calls=[];
  globalThis.fetch=async(url,opts)=>{
    const method=String(url).split('/').pop(),body=JSON.parse(opts.body);calls.push({method,body});
    if(method==='answerCallbackQuery'||(method==='sendMessage'&&body.reply_markup))return api(false,400);
    return api(true);
  };
  try{
    const update={callback_query:{id:'expired',from:{id:12345678,username:'DrFXGOD'},message:{chat:{id:12345678,type:'private'}},data:'deploy:en'}};
    const reply=await worker.fetch(webhook(update),env);
    assert.equal(reply.status,200);
    assert.deepEqual(calls.map(c=>c.method),['answerCallbackQuery','sendMessage','sendMessage']);
    assert.equal(calls[2].body.reply_markup,undefined);
    const link=calls[2].body.text.match(/https:\/\/\S+\/setup\?ticket=\S+&sig=\S+/)?.[0];
    assert.ok(link);
    const form=await worker.fetch(new Request(link),env);
    assert.equal(form.status,200);
    assert.match(await form.text(),/Deploy your private Telegram WEB proxy/);
  }finally{globalThis.fetch=originalFetch;}
});

test('/deploy text command sends a signed HTTPS form link',async()=>{
  const sent=[];globalThis.fetch=async(url,opts)=>{sent.push(JSON.parse(opts.body));return api(true);};
  try{
    const update={message:{message_id:30,from:{id:12345678,username:'DrFXGOD'},chat:{id:12345678,type:'private'},text:'/deploy'}};
    assert.equal((await worker.fetch(webhook(update),env)).status,200);
    assert.equal(sent.length,1);
    assert.match(sent[0].text,/\/setup\?ticket=/);
  }finally{globalThis.fetch=originalFetch;}
});

test('non-owner cannot obtain deployment link',async()=>{
  const sent=[];globalThis.fetch=async(url,opts)=>{sent.push(JSON.parse(opts.body));return api(true);};
  try{
    const update={message:{from:{id:777,username:'unknown'},chat:{id:777,type:'private'},text:'/deploy'}};
    assert.equal((await worker.fetch(webhook(update),env)).status,200);
    assert.match(sent[0].text,/private/);
    assert.doesNotMatch(sent[0].text,/\/setup\?ticket=/);
  }finally{globalThis.fetch=originalFetch;}
});