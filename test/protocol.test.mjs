import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {Frame,frame,parseFrames,validateIncoming,windowFrame} from '../src/codec.js';
import {unhex,hex,b64url,unb64url,bridgeCapability,decodeSecret,tokenCreate,tokenCheck,CtrCipher,random,join} from '../src/security.js';
import {setting,linkOf} from '../src/config.js';
import {bridgePage} from '../src/bridge.js';
import {Script} from 'node:vm';


test('canonical frame encoding and bounded decoding',()=>{
  const pkt=join(frame(Frame.OPEN,0x123456),frame(Frame.DATA,0x123456,Uint8Array.of(5,6,7)));
  const out=parseFrames(pkt);
  assert.equal(out.length,2);assert.equal(out[0].id,0x123456);assert.equal(out[1].payload[2],7);
  assert.ok(out.every(validateIncoming));
  assert.throws(()=>parseFrames(pkt.slice(0,-1)),/invalid frame length/);
  assert.throws(()=>frame(Frame.OPEN,0x1000000),/stream id/);
});

test('window deltas must be positive',()=>{
  assert.equal(validateIncoming(parseFrames(windowFrame(3,4))[0]),true);
  assert.throws(()=>windowFrame(4,0),/credit/);
  assert.equal(validateIncoming({type:Frame.DATA,id:0,payload:Uint8Array.of(1)}),false);
});

test('strict secret handling and binary codecs',()=>{
  const secret=decodeSecret('00112233445566778899aabbccddeeff');
  assert.equal(secret.coreSecret.length,16);
  assert.equal(hex(unb64url(b64url(secret.linkSecret))),hex(secret.linkSecret));
  assert.throws(()=>decodeSecret('0000'),/PROXY_SECRET/);
  assert.equal(decodeSecret('dd00112233445566778899aabbccddeeff').padded,true);
});

test('HMAC bridge vectors are compatible with public protocol',async()=>{
  const secret=unhex('000102030405060708090a0b0c0d0e0f');
  assert.equal(await bridgeCapability(secret,'proxy.example.com'),'MHLEY5PmW1GWqJkSrlmJpvJUiLhBH_QKy6yKg8a0JPk');
  assert.equal(await bridgeCapability(unhex('dd000102030405060708090a0b0c0d0e0f'),'proxy.example.com'),'IpJrt3e7sKtzPyoXy6w-Zj6GGEvsvclN66JzQEfPYLA');
});

test('signed tokens bind role, host and path',async()=>{
  const secret=random(16);const t=await tokenCreate(secret,'boot','proxy.example.com','',120);
  assert.equal(await tokenCheck(secret,t,'boot','proxy.example.com',''),true);
  assert.equal(await tokenCheck(secret,t,'session','proxy.example.com',''),false);
  assert.equal(await tokenCheck(secret,t,'boot','other.example.com',''),false);
  assert.equal(await tokenCheck(secret,t+'x','boot','proxy.example.com',''),false);
});

test('AES-CTR segmented encryption equals contiguous encryption',async()=>{
  const key=random(32),iv=random(16),buffer=random(259);
  const cipher=new CtrCipher(key,iv);
  const combined=await cipher.crypt(buffer,64);
  const pieces=join(await cipher.crypt(buffer.slice(0,21),64),await cipher.crypt(buffer.slice(21,117),85),await cipher.crypt(buffer.slice(117),181));
  assert.equal(hex(combined),hex(pieces));
  assert.equal(hex(await cipher.crypt(combined,64)),hex(buffer));
});

test('base path link encoding and secure defaults',()=>{
  const cfg=setting({PROXY_SECRET:'00112233445566778899aabbccddeeff',BASE_PATH:'private-bridge'});
  const links=linkOf('proxy.workers.dev',cfg);
  assert.match(links.deepLink,/server=proxy.workers.dev%2Fprivate-bridge/);
  assert.match(links.deepLink,/secret=c/);
  assert.equal(setting({}).secret,null);
  assert.throws(()=>setting({BASE_PATH:'../unsafe'}),/Invalid BASE_PATH/);
});

test('rendered bridge JavaScript parses without syntax errors or external resources',()=>{
  const response=bridgePage('safeToken','');
  assert.equal(response.status,200);
  return response.text().then(html=>{
    const script=html.match(/<script[^>]*>([\s\S]+?)<\/script>/)[1];
    assert.doesNotThrow(()=>new Script(script));
    assert.doesNotMatch(html,/https:\/\/fonts\./);
  });
});
