import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {handle} from '../src/worker.js';
import {bridgeCapability,unhex} from '../src/security.js';
import {Frame,frame} from '../src/codec.js';
const host='https://proxy.example.com';
const env={PROXY_SECRET:'00112233445566778899aabbccddeeff',ADMIN_TOKEN:'very-secret-operator-token'};
const req=(path,opts={})=>new Request(host+path,opts);

test('health is safe without private settings',async()=>{
  const r=await handle(req('/api/health'),{});
  assert.equal(r.status,200);assert.equal((await r.json()).configured,false);
});

test('public UI never contains secret or operator token',async()=>{
  const page=await handle(req('/'),env);
  assert.equal(page.status,200);
  const markup=await page.text();
  assert.match(markup,/MAXIMUS TWP/);
  assert.doesNotMatch(markup,/00112233445566778899aabbccddeeff|very-secret-operator-token/);
});

test('operator link requires authentication',async()=>{
  assert.equal((await handle(req('/api/admin/link',{method:'POST'}),env)).status,403);
  const r=await handle(req('/api/admin/link',{method:'POST',headers:{Authorization:'Bearer very-secret-operator-token'}}),env);
  assert.equal(r.status,200);
  assert.match((await r.json()).deepLink,/tg:\/\/webproxy/);
});

test('bridge rejects unauthenticated capabilities',async()=>{
  assert.equal((await handle(req('/?bridge=0000000000000000000000000000000000000000000'),env)).status,404);
  const cap=await bridgeCapability(unhex(env.PROXY_SECRET),'proxy.example.com');
  const page=await handle(req('/?bridge='+cap),env);
  assert.equal(page.status,200);
  assert.match(await page.text(),/TelegramWebProxy/);
});

test('session accepts HELLO only with signed bootstrap bearer',async()=>{
  const cap=await bridgeCapability(unhex(env.PROXY_SECRET),'proxy.example.com');
  const bridge=await handle(req('/?bridge='+cap),env);
  const html=await bridge.text();
  const token=/const token="([^"]+)"/.exec(html)[1];
  const good=()=>req('/api/v1/session',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream'},body:frame(Frame.HELLO,0,Uint8Array.of(1))});
  assert.equal((await handle(good(),env)).status,200);
  assert.equal((await handle(req('/api/v1/session',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:frame(Frame.HELLO,0,Uint8Array.of(1))}),env)).status,404);
  const bad=await handle(req('/api/v1/session',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream'},body:frame(Frame.OPEN,1)}),env);
  assert.equal(bad.status,404);
});
