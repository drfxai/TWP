import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const origin='https://maximus-deployer.drfxai.workers.dev';
function memoryKv(){const m=new Map();return {m,get:async k=>m.get(k)??null,put:async(k,v)=>{m.set(k,v);},delete:async k=>{m.delete(k);}};}
const baseEnv=()=>({TELEGRAM_BOT_TOKEN:'test:fake',TELEGRAM_WEBHOOK_SECRET:'test-webhook-secret',SETUP_SIGNING_KEY:'test-key-material-for-hmac-that-is-long',REQUIRED_CHANNEL:'@DrFXi',STATE:memoryKv()});
const webhook=(env,update)=>new Request(origin+'/telegram',{method:'POST',headers:{'x-telegram-bot-api-secret-token':env.TELEGRAM_WEBHOOK_SECRET,'content-type':'application/json'},body:JSON.stringify(update)});
const originalFetch=globalThis.fetch;
const user={id:12345678,first_name:'Dr',language_code:'fa'};
const chat={id:12345678,type:'private'};
const token='B'.repeat(40);

function telegram(memberStatus='member'){
  const calls=[];
  globalThis.fetch=async(url,opts)=>{
    const u=String(url);
    if(u.startsWith('https://api.telegram.org/')){
      const method=u.split('/').pop(),body=JSON.parse(opts.body);calls.push({method,body});
      if(method==='getChatMember')return new Response(JSON.stringify({ok:true,result:{status:memberStatus}}));
      return new Response(JSON.stringify({ok:true,result:{message_id:99}}));
    }
    throw new Error('unexpected network call '+u);
  };
  return calls;
}
const ctx=()=>{const jobs=[];return {jobs,waitUntil:p=>jobs.push(p)};};

test('non-members see the forced-join gate for @DrFXi',async()=>{
  const env=baseEnv();const calls=telegram('left');
  try{
    const r=await worker.fetch(webhook(env,{message:{message_id:1,from:user,chat,text:'/start'}}),env,ctx());
    assert.equal(r.status,200);
    const gate=calls.find(c=>c.method==='sendMessage');
    assert.match(gate.body.text,/عضویت در کانال رسمی الزامی است/);
    assert.match(gate.body.text,/@DrFXi/);
    assert.equal(gate.body.reply_markup.inline_keyboard[0][0].url,'https://t.me/drfxai');
    assert.equal(gate.body.reply_markup.inline_keyboard[1][0].callback_data,'check:main:fa');
  }finally{globalThis.fetch=originalFetch;}
});

test('members get the main menu with both sections',async()=>{
  const env=baseEnv();const calls=telegram('member');
  try{
    await worker.fetch(webhook(env,{message:{message_id:1,from:user,chat,text:'/start'}}),env,ctx());
    const menu=calls.find(c=>c.method==='sendMessage');
    const data=menu.body.reply_markup.inline_keyboard.flat().map(b=>b.callback_data);
    assert.ok(data.includes('sec:twp:fa'));
    assert.ok(data.includes('sec:vless:fa'));
  }finally{globalThis.fetch=originalFetch;}
});

test('token after choosing a section is deleted from chat and starts that deployment',async()=>{
  const env=baseEnv();const calls=telegram('member');
  try{
    await worker.fetch(webhook(env,{callback_query:{id:'q',from:user,message:{message_id:5,chat},data:'sec:vless:fa'}}),env,ctx());
    assert.ok(env.STATE.m.has('pending:12345678'));
    const c=ctx();
    await worker.fetch(webhook(env,{message:{message_id:7,from:user,chat,text:token}}),env,c);
    assert.ok(calls.some(x=>x.method==='deleteMessage'&&x.body.message_id===7));
    assert.equal(c.jobs.length,1);
    assert.ok(!env.STATE.m.has('pending:12345678'));
    assert.ok(calls.every(x=>!JSON.stringify(x.body).includes(token)));
  }finally{globalThis.fetch=originalFetch;}
});

test('token sent first is kept only encrypted and the user picks a section',async()=>{
  const env=baseEnv();const calls=telegram('member');
  try{
    await worker.fetch(webhook(env,{message:{message_id:8,from:user,chat,text:token}}),env,ctx());
    const stored=env.STATE.m.get('token:12345678');
    assert.ok(stored&&!stored.includes(token));
    const choose=calls.filter(c=>c.method==='sendMessage').pop();
    assert.equal(choose.body.reply_markup.inline_keyboard[0][0].callback_data,'run:twp:fa');
    const c=ctx();
    await worker.fetch(webhook(env,{callback_query:{id:'q2',from:user,message:{message_id:9,chat},data:'run:twp:fa'}}),env,c);
    assert.equal(c.jobs.length,1);
    assert.ok(!env.STATE.m.has('token:12345678'));
  }finally{globalThis.fetch=originalFetch;}
});

test('Telegram bot tokens are deleted with a revoke warning',async()=>{
  const env=baseEnv();const calls=telegram('member');
  try{
    await worker.fetch(webhook(env,{message:{message_id:10,from:user,chat,text:'123456789:'+'x'.repeat(35)}}),env,ctx());
    assert.ok(calls.some(c=>c.method==='deleteMessage'));
    assert.match(calls.filter(c=>c.method==='sendMessage').pop().body.text,/BotFather/);
  }finally{globalThis.fetch=originalFetch;}
});

test('group chats are ignored and bad webhook secrets are refused',async()=>{
  const env=baseEnv();const calls=telegram('member');
  try{
    await worker.fetch(webhook(env,{message:{message_id:1,from:user,chat:{id:-100,type:'supergroup'},text:'/start'}}),env,ctx());
    assert.equal(calls.length,0);
    const bad=new Request(origin+'/telegram',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'nope'},body:'{}'});
    assert.equal((await worker.fetch(bad,env,ctx())).status,401);
  }finally{globalThis.fetch=originalFetch;}
});
