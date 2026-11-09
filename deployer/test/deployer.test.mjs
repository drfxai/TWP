import test from 'node:test';
import assert from 'node:assert/strict';
import {deployWorker,validateTarget} from '../src/deploy.js';
import {escapeHtml,setupPage,resultPage} from '../src/ui.js';

const params={accountId:'0123456789abcdef0123456789abcdef',subdomain:'myteam',workerName:'maximus-twp-test',apiToken:'a'.repeat(40)};

test('validates explicit limited target identifiers',()=>{
  assert.doesNotThrow(()=>validateTarget(params));
  assert.throws(()=>validateTarget({...params,accountId:'oops'}));
  assert.throws(()=>validateTarget({...params,workerName:'other-app'}));
  assert.throws(()=>validateTarget({...params,subdomain:'wrong.example.com'}));
});

test('escapes potentially hostile UI fields',()=>{
  assert.equal(escapeHtml('<script>alert(1)</script>'),'&lt;script&gt;alert(1)&lt;/script&gt;');
  const html=setupPage({lang:'en',ticket:'test',sig:'sig'});
  assert.match(html,/Deploy your private Telegram WEB proxy/);
  assert.doesNotMatch(html,/external-deployer-brand/i);
});

test('Persian setup and result pages render',()=>{
  assert.match(setupPage({lang:'fa',ticket:'a',sig:'b'}),/lang="fa"/);
  assert.match(resultPage({lang:'fa',result:{adminToken:'redacted',dashboard:'https://example.workers.dev',deepLink:'tg://webproxy',webLink:'https://t.me/webproxy'}}),/کلید مدیریت/);
});

test('uploads a module worker with random secrets, enables only the selected workers.dev script',async()=>{
  const requests=[];
  const fetcher=async(url,opts)=>{requests.push({url,opts});return {ok:true,status:200,json:async()=>({success:true,result:{}})};};
  const out=await deployWorker({...params,coreSource:'export default {fetch() {return new Response("ok")}}; // '.repeat(10),fetcher});
  assert.equal(requests.length,2);
  assert.match(requests[0].url,/workers\/scripts\/maximus-twp-test$/);
  assert.equal(requests[0].opts.method,'PUT');
  const metadata=JSON.parse(requests[0].opts.body.get('metadata'));
  assert.equal(metadata.main_module,'maximus-core.mjs');
  assert.equal(metadata.bindings.find(b=>b.name==='PROXY_SECRET').text.length,32);
  assert.equal(metadata.bindings.find(b=>b.name==='ADMIN_TOKEN').text.length,64);
  assert.equal(metadata.bindings.filter(b=>b.type==='secret_text').length,2);
  assert.match(requests[1].url,/subdomain$/);
  assert.equal(requests[1].opts.method,'POST');
  assert.match(out.deepLink,/tg:\/\/webproxy/);
  assert.equal(out.host,'maximus-twp-test.myteam.workers.dev');
});

test('never returns raw provider errors with token in response',async()=>{
  const fetcher=async()=>({ok:false,status:403,json:async()=>({success:false,errors:[{message:params.apiToken}]})});
  await assert.rejects(deployWorker({...params,coreSource:'export default {fetch() {return new Response("ok")}}; // '.repeat(10),fetcher}),e=>!e.message.includes(params.apiToken));
});
