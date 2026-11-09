import {decodeSecret,b64url,join} from './security.js';
export const DC_IPS={
  1:['149.154.175.50','149.154.175.51'],
  2:['149.154.167.50','149.154.167.51'],
  3:['149.154.175.100','149.154.175.101'],
  4:['149.154.167.91','149.154.167.92'],
  5:['149.154.171.5','149.154.171.6']
};
export function setting(env){
  const path=String(env.BASE_PATH||'').replace(/^\/+|\/+$/g,'');
  if(path && !/^[a-zA-Z0-9_-]{4,64}$/.test(path))throw new Error('Invalid BASE_PATH');
  return {
    secret:env.PROXY_SECRET?decodeSecret(env.PROXY_SECRET):null,
    admin:String(env.ADMIN_TOKEN||''),
    path,
    route:path?'/'+path:'',
    maxStreams:Math.max(1,Math.min(40,Number(env.MAX_STREAMS)||24)),
  };
}
export function linkOf(host,cfg){
  if(!cfg.secret)throw new Error('Not configured');
  const server=host+(cfg.path?'/'+cfg.path:'');
  const secret=cfg.path?b64url(join(Uint8Array.of(0x70),cfg.secret.linkSecret)):
    Array.from(cfg.secret.linkSecret,b=>b.toString(16).padStart(2,'0')).join('');
  const query='server='+encodeURIComponent(server)+'&secret='+encodeURIComponent(secret);
  return {deepLink:'tg://webproxy?'+query,webLink:'https://t.me/webproxy?'+query,server};
}
