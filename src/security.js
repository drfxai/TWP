/** Independent cryptographic primitives for MAXIMUS TWP. */
const encoder=new TextEncoder();
export const utf8=s=>encoder.encode(s);
export function hex(bytes){return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
export function unhex(s){if(typeof s!=='string'||!/^([0-9a-f]{2})+$/i.test(s))throw new Error('invalid hexadecimal');return Uint8Array.from(s.match(/../g),h=>parseInt(h,16));}
export function b64url(bytes){let raw='';for(const b of bytes)raw+=String.fromCharCode(b);return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export function unb64url(s){if(typeof s!=='string'||!/^[\w-]+$/.test(s))throw new Error('invalid base64url');const raw=atob(s.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0));}
export function equal(a,b){if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;}
export function join(...parts){const output=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let i=0;for(const p of parts){output.set(p,i);i+=p.length;}return output;}
export function reverse(bytes){return Uint8Array.from(bytes).reverse();}
export async function sha256(bytes){return new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));}
export async function sign(key,data){const imported=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);return new Uint8Array(await crypto.subtle.sign('HMAC',imported,data));}
export function random(n){const out=new Uint8Array(n);crypto.getRandomValues(out);return out;}
export function decodeSecret(value) {
  const input=unhex(value);
  if(input.length===16)return {linkSecret:input,coreSecret:input,padded:false};
  if(input.length===17&&input[0]===0xdd)return {linkSecret:input,coreSecret:input.slice(1),padded:true};
  throw new Error('PROXY_SECRET must be 16 bytes hex or dd + 16 bytes hex');
}
/** AES-CTR at an absolute byte position (arbitrary, including non-block aligned). */
export class CtrCipher {
  constructor(key,counter){this.keyBytes=key;this.iv=counter;this.imported=null;}
  async crypt(data,offset=0){
    if (!this.imported)this.imported=await crypto.subtle.importKey('raw',this.keyBytes,{name:'AES-CTR'},false,['encrypt']);
    const src=data instanceof Uint8Array?data:new Uint8Array(data);
    if(!src.length)return new Uint8Array();
    const ctr=this.iv.slice();let blocks=Math.floor(offset/16);
    for(let p=15;p>=0 && blocks>0;p--){const sum=ctr[p]+(blocks%256);ctr[p]=sum%256;blocks=Math.floor(blocks/256)+Math.floor(sum/256);}
    const skip=offset%16, payload=new Uint8Array(skip+src.length);payload.set(src,skip);
    const res=await crypto.subtle.encrypt({name:'AES-CTR',counter:ctr,length:128},this.imported,payload);
    return new Uint8Array(res).slice(skip);
  }
}
export function bridgeContext(host,path=''){
  return utf8(path?`tdesktop-web-proxy-bridge-v2\n${host}\n${path}`:`tdesktop-web-proxy-bridge-v1\n${host}`);
}
export async function bridgeCapability(secret,host,path=''){return b64url(await sign(secret,bridgeContext(host,path)));}
const tokenDomain=utf8('maximus-twp-token-2026\n');
export async function tokenCreate(secret,kind,host,path,ttl){
  const payload={k:kind,h:host,p:path,e:Math.floor(Date.now()/1000)+ttl,n:b64url(random(16))};
  const payloadText=b64url(utf8(JSON.stringify(payload)));
  const signature=b64url(await sign(secret,join(tokenDomain,utf8(payloadText))));
  return payloadText+'.'+signature;
}
export async function tokenCheck(secret,value,kind,host,path){
  if(typeof value!=='string'||value.length>500)return false;
  const parts=value.split('.');if(parts.length!==2||!parts[1])return false;
  let obj;
  try{obj=JSON.parse(new TextDecoder().decode(unb64url(parts[0])));}catch{return false;}
  if(obj.k!==kind||obj.h!==host||obj.p!==path||!Number.isInteger(obj.e)||obj.e<Math.floor(Date.now()/1000)||obj.e>Math.floor(Date.now()/1000)+650||typeof obj.n!=='string')return false;
  const actual=await sign(secret,join(tokenDomain,utf8(parts[0])));
  let received;try{received=unb64url(parts[1]);}catch{return false;}
  return equal(actual,received);
}
