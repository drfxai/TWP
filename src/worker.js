import {setting,linkOf} from './config.js';
import {bridgeCapability,equal,tokenCreate,tokenCheck,unb64url} from './security.js';
import {parseFrames,Frame,frame} from './codec.js';
import {bridgePage} from './bridge.js';
import {dashboard} from './dashboard.js';
import {runCarrier} from './carrier.js';

const HEADERS={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const hidden=()=>new Response('Not found',{status:404,headers:HEADERS});
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{...HEADERS,'content-type':'application/json; charset=utf-8'}});
const bearer=r=>{const match=/^Bearer (\S+)$/.exec(r.headers.get('authorization')||'');return match?.[1]||'';};
const isAdmin=(request,token)=>{
  const provided=bearer(request);
  if(!token||!provided||provided.length!==token.length)return false;
  let mismatch=0;for(let i=0;i<provided.length;i++)mismatch|=provided.charCodeAt(i)^token.charCodeAt(i);
  return mismatch===0;
};

export async function handle(request,env){
  let cfg;
  try{cfg=setting(env);}catch{return json({error:'Invalid Worker configuration'},503);}
  const url=new URL(request.url),host=url.hostname.toLowerCase(),route=cfg.route;
  const path=url.pathname;
  if(request.method==='GET'&&path==='/api/health')return json({name:'MAXIMUS TWP',status:'ok',configured:!!cfg.secret,protocol:'telegram-web-proxy-v1'});
  if(request.method==='GET'&&path==='/'&&url.search==='')return new Response(dashboard(),{headers:{...HEADERS,'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}});
  if(request.method==='POST'&&path==='/api/admin/link'){
    if(!cfg.secret||!isAdmin(request,cfg.admin))return json({error:'Forbidden'},403);
    return json(linkOf(host,cfg));
  }
  if(!cfg.secret)return hidden();
  const expected=await bridgeCapability(cfg.secret.linkSecret,host,cfg.path);
  const desiredPath=route+'/';
  // A browser can request either a canonical bridge URL or the public landing page.
  if(request.method==='GET'&&path===desiredPath&&url.searchParams.has('bridge')){
    if(url.searchParams.size!==1||!/^\?bridge=[a-zA-Z0-9_-]{43}$/.test(url.search))return hidden();
    const submitted=url.searchParams.get('bridge');
    let supplied;try{supplied=unb64url(submitted);}catch{return hidden();}
    let correct;try{correct=unb64url(expected);}catch{return hidden();}
    if(!equal(supplied,correct))return hidden();
    const token=await tokenCreate(cfg.secret.linkSecret,'boot',host,cfg.path,120);
    return bridgePage(token,route);
  }
  if(request.method==='POST'&&path===route+'/api/v1/session'){
    if(!(await tokenCheck(cfg.secret.linkSecret,bearer(request),'boot',host,cfg.path)))return hidden();
    if(request.headers.get('content-type')!=='application/octet-stream')return hidden();
    const raw=new Uint8Array(await request.arrayBuffer());
    if(raw.length!==9)return hidden();
    let hello;try{hello=parseFrames(raw);}catch{return hidden();}
    if(hello.length!==1||hello[0].type!==Frame.HELLO||hello[0].id!==0||hello[0].payload.length!==1||hello[0].payload[0]!==1)return hidden();
    const session=await tokenCreate(cfg.secret.linkSecret,'session',host,cfg.path,600);
    return new Response(frame(Frame.WELCOME).buffer,{headers:{...HEADERS,'content-type':'application/octet-stream','X-Session-Token':session,'X-Max-Streams':String(cfg.maxStreams)}});
  }
  if(request.method==='GET'&&path===route+'/api/v1/ws'){
    if((request.headers.get('upgrade')||'').toLowerCase()!=='websocket')return hidden();
    const candidate=request.headers.get('sec-websocket-protocol')||'';
    if(!candidate.startsWith('tproxy-v1.'))return hidden();
    const credential=candidate.slice('tproxy-v1.'.length);
    if(!(await tokenCheck(cfg.secret.linkSecret,credential,'session',host,cfg.path)))return hidden();
    const {connect}=await import('cloudflare:sockets');
    const pair=new WebSocketPair();
    const browser=pair[0],server=pair[1];
    server.accept();
    runCarrier(server,cfg.secret,cfg.maxStreams,connect);
    return new Response(null,{status:101,webSocket:browser,headers:{'Sec-WebSocket-Protocol':candidate}});
  }
  return hidden();
}
export default {fetch:handle};
