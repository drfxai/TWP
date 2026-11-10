import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {internals} from '../vless/worker.js';

const UUID='4dd18689-f994-46fb-a5ee-5fbf61da1cf4';
const env=()=>{const m=new Map();return {UUID,ADMIN_PASSWORD:'tL6aAjfXzRAc',KV:{get:async k=>m.get(k)??null,put:async(k,v)=>{m.set(k,v);}}};};

function header({cmd=1,port=443,host='example.com'}={}){
  const u=internals.uuidBytes(UUID),h=new TextEncoder().encode(host);
  return Uint8Array.from([0,...u,0,cmd,port>>8,port&255,2,h.length,...h,1,2,3]);
}

test('parses VLESS TCP header with a domain target and keeps the payload',()=>{
  const r=internals.parseVlessHeader(header(),internals.uuidBytes(UUID));
  assert.equal(r.address,'example.com');
  assert.equal(r.port,443);
  assert.equal(r.isUdp,false);
  assert.deepEqual([...r.payload],[1,2,3]);
});

test('rejects a wrong UUID',()=>{
  assert.throws(()=>internals.parseVlessHeader(header(),internals.uuidBytes('00000000-0000-0000-0000-000000000000')),/unauthorized/);
});

test('builds a VLESS link with clean IP, ws path and fingerprint',()=>{
  const link=internals.buildLink({uuid:UUID,address:'104.16.1.1',port:443,path:'/?ed=2560',fingerprint:'randomized',name:'MAXIMUS'},'abc.mx.workers.dev');
  assert.match(link,/^vless:\/\/4dd18689-f994-46fb-a5ee-5fbf61da1cf4@104\.16\.1\.1:443\?/);
  assert.match(link,/sni=abc\.mx\.workers\.dev/);
  assert.match(link,/path=%2F%3Fed%3D2560/);
});

test('admin panel requires the password and saves settings to KV',async()=>{
  const e=env();
  const base='https://abc.mx.workers.dev';
  assert.match(await (await worker.fetch(new Request(base+'/admin'),e)).text(),/ورود به پنل مدیریت/);
  const bad=await worker.fetch(new Request(base+'/admin/login',{method:'POST',body:'password=wrong'}),e);
  assert.equal(bad.status,403);
  const good=await worker.fetch(new Request(base+'/admin/login',{method:'POST',body:'password=tL6aAjfXzRAc'}),e);
  assert.equal(good.status,303);
  const cookie=good.headers.get('set-cookie').split(';')[0];
  const panel=await (await worker.fetch(new Request(base+'/admin',{headers:{cookie}}),e)).text();
  assert.match(panel,/vless:\/\//);
  const saved=await worker.fetch(new Request(base+'/admin/save',{method:'POST',headers:{cookie},body:'address=104.16.1.1&port=8443&path=%2F%3Fed%3D2560&fingerprint=chrome&name=MAXIMUS&proxyIp='}),e);
  assert.equal(saved.status,303);
  const sub=await (await worker.fetch(new Request(base+'/sub/'+UUID),e)).text();
  assert.match(atob(sub),/@104\.16\.1\.1:8443\?.*fp=chrome/);
});

test('unknown paths are hidden and root is a neutral page',async()=>{
  const e=env();
  assert.equal((await worker.fetch(new Request('https://abc.mx.workers.dev/x'),e)).status,404);
  assert.equal((await worker.fetch(new Request('https://abc.mx.workers.dev/'),e)).status,200);
});
