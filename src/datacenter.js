import {CtrCipher,sha256,join,reverse,random} from './security.js';
import {DC_IPS} from './config.js';
/** Select a fixed Telegram datacenter from an encrypted MTProto Obfuscated2 header. */
export async function decodeClientGreeting(secretInfo, raw){
  if(raw.length!==64)throw new Error('obfuscated header length');
  const secret=secretInfo.coreSecret;
  const upKey=await sha256(join(raw.slice(8,40),secret));
  const reverseSeed=reverse(raw.slice(8,56));
  const downKey=await sha256(join(reverseSeed.slice(0,32),secret));
  const downIv=reverseSeed.slice(32,48);
  const upCipher=new CtrCipher(upKey,raw.slice(40,56));
  const plain=await upCipher.crypt(raw,0);
  const view=new DataView(plain.buffer,plain.byteOffset,plain.byteLength);
  const mode=view.getUint32(56,true);
  const destination=view.getInt16(60,true);
  let number=Math.abs(destination);
  if(number>10000)number%=10000;
  if(!DC_IPS[number] || ![0xefefefef,0xeeeeeeee,0xdddddddd].includes(mode))throw new Error('unsupported MTProto transport or DC');
  if(secretInfo.padded && mode!==0xdddddddd)throw new Error('padding mode mismatch');
  return {upCipher,downKey,downIv,mode,destination,dc:number};
}
export async function dcGreeting(client){
  const payload=random(64);
  // The reverse-direction seed is chosen to make Telegram's existing downlink cipher reusable.
  payload.set(reverse(join(client.downKey,client.downIv)),8);
  const view=new DataView(payload.buffer);
  view.setUint32(56,client.mode,true);
  view.setInt16(60,client.destination,true);
  // The first 8 bytes must not resemble a known transport/HTTP/TLS greeting.
  if(payload[0]===0xef||payload[0]===0x16||payload[0]===0x47||payload[0]===0x50)payload[0]=0xa5;
  const cipher=new CtrCipher(payload.slice(8,40),payload.slice(40,56));
  const enc=await cipher.crypt(payload,0);
  payload.set(enc.slice(56,64),56);
  return {payload,cipher};
}
export async function openDc(dc,connectFn){
  const hosts=DC_IPS[dc];if(!hosts)throw new Error('DC denied');
  let failure;
  for(const host of hosts){
    try{return await connectFn({hostname:host,port:443},{secureTransport:'off',allowHalfOpen:false});}
    catch(err){failure=err;}
  }
  throw failure||new Error('DC unreachable');
}
