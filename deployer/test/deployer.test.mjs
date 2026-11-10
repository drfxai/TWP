import test from 'node:test';
import assert from 'node:assert/strict';
import {deployTwp,deployVless,resolveAccount,validateToken,randomName} from '../src/deploy.js';
import {tokenLink,bar,M} from '../src/messages.js';

const token='A'.repeat(40);
const ACC='0123456789abcdef0123456789abcdef';
const bundle='export default {fetch() {return new Response("ok")}}; // '.repeat(10);
const okJson=result=>({ok:true,status:200,json:async()=>({success:true,result})});

function fakeCloudflare({subdomain='myteam'}={}){
  const calls=[];
  const fetcher=async(url,opts={})=>{
    calls.push({url,method:opts.method||'GET',opts});
    if(url.endsWith('/accounts?per_page=5'))return okJson([{id:ACC,name:'Me'}]);
    if(url.endsWith('/workers/subdomain')&&(opts.method||'GET')==='GET')return subdomain?okJson({subdomain}):{ok:false,status:404,json:async()=>({success:false})};
    if(url.endsWith('/workers/subdomain')&&opts.method==='PUT')return okJson({subdomain:JSON.parse(opts.body).subdomain});
    if(url.endsWith('/storage/kv/namespaces'))return okJson({id:'f'.repeat(32),title:JSON.parse(opts.body).title});
    return okJson({});
  };
  return {calls,fetcher};
}

test('validates Cloudflare API token shape',()=>{
  assert.doesNotThrow(()=>validateToken(token));
  assert.throws(()=>validateToken('short'));
  assert.throws(()=>validateToken('123456789:'+'a'.repeat(35)));
});

test('random worker names are lowercase and start with a letter',()=>{
  for(let i=0;i<50;i++)assert.match(randomName(10),/^[a-z][a-z0-9]{9}$/);
});

test('resolves account and creates a workers.dev subdomain when missing',async()=>{
  const {calls,fetcher}=fakeCloudflare({subdomain:''});
  const r=await resolveAccount({apiToken:token,fetcher});
  assert.equal(r.accountId,ACC);
  assert.match(r.subdomain,/^mx-[a-z0-9]+$/);
  assert.ok(calls.some(c=>c.method==='PUT'&&c.url.endsWith('/workers/subdomain')));
});

test('TWP deploy uploads a random worker with a random PROXY_SECRET and reports progress',async()=>{
  const {calls,fetcher}=fakeCloudflare();
  const steps=[];
  const r=await deployTwp({apiToken:token,coreSource:bundle,fetcher,onProgress:async p=>steps.push(p)});
  const upload=calls.find(c=>c.method==='PUT'&&/workers\/scripts\/[a-z0-9]+$/.test(c.url));
  const meta=JSON.parse(upload.opts.body.get('metadata'));
  assert.equal(meta.bindings.find(b=>b.name==='PROXY_SECRET').text.length,32);
  assert.deepEqual(meta.compatibility_flags,['nodejs_compat','no_websocket_standard_binary_type']);
  assert.match(r.deepLink,/^tg:\/\/webproxy\?server=[a-z0-9]+\.myteam\.workers\.dev&secret=[0-9a-f]{32}$/);
  assert.match(r.webLink,/^https:\/\/t\.me\/webproxy\?/);
  assert.deepEqual(steps,[15,45,85]);
});

test('VLESS deploy creates KV, binds UUID and ADMIN_PASSWORD, returns panel and config',async()=>{
  const {calls,fetcher}=fakeCloudflare();
  const r=await deployVless({apiToken:token,vlessSource:bundle,fetcher});
  assert.ok(calls.some(c=>c.url.endsWith('/storage/kv/namespaces')));
  const upload=calls.find(c=>c.method==='PUT'&&/workers\/scripts\/[a-z0-9]+$/.test(c.url));
  const meta=JSON.parse(upload.opts.body.get('metadata'));
  assert.equal(meta.bindings.find(b=>b.type==='kv_namespace').name,'KV');
  assert.equal(meta.bindings.find(b=>b.name==='UUID').text,r.uuid);
  assert.equal(meta.bindings.find(b=>b.name==='ADMIN_PASSWORD').text,r.password);
  assert.match(r.vlessLink,/^vless:\/\/[0-9a-f-]{36}@[a-z0-9]+\.myteam\.workers\.dev:443\?encryption=none&security=tls/);
  assert.match(r.panel,/\/admin$/);
});

test('never returns raw provider errors that may contain the token',async()=>{
  const fetcher=async()=>({ok:false,status:403,json:async()=>({success:false,errors:[{message:token}]})});
  await assert.rejects(deployTwp({apiToken:token,coreSource:bundle,fetcher}),e=>!e.message.includes(token));
});

test('prefilled token link carries only the needed permissions',()=>{
  const twp=decodeURIComponent(tokenLink('twp'));
  assert.match(twp,/workers_scripts/);
  assert.doesNotMatch(twp,/workers_kv_storage/);
  assert.match(decodeURIComponent(tokenLink('vless')),/workers_kv_storage/);
  assert.equal(bar(85),'⚡ [█████████░] 85%');
  assert.ok(M.fa.sectionTwp.includes('PROXY_SECRET'));
});
