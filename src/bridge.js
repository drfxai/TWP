/** Authenticated, self-contained WebView bridge. No off-origin requests. */
export function bridgePage(token,route){
  const nonce=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/=+$/,'');
  const code=`(()=>{
  'use strict';
  const token=${JSON.stringify(token)}, base=${JSON.stringify(route)};
  const native=window.TelegramWebProxy;
  const marker=new URLSearchParams(location.hash.slice(1)).get('android');
  let port=null,channel=null,connecting=false,closed=false,active=false;
  const pending=[];
  history.replaceState(null,'',base+'/' );
  function sendApp(value){try{if(native&&typeof native.postMessage==='function')native.postMessage(value);else if(port)port.postMessage(value);}catch{halt();}}
  function status(state){sendApp({t:'status',state});}
  function halt(){if(closed)return;closed=true;active=false;pending.length=0;try{channel?.close();}catch{}status('closed');}
  function bytes(value){
    if(value instanceof ArrayBuffer)return new Uint8Array(value);
    if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
    return null;
  }
  function split(input){
    const result=[];
    for(let p=0;p<input.length;){
      if(p+8>input.length)throw Error('short header');
      const length=new DataView(input.buffer,input.byteOffset+p+4,4).getUint32(0,false);
      if(length>1048576||p+8+length>input.length)throw Error('bad frame');
      result.push(input.slice(p,p+8+length));p+=8+length;
    }
    return result;
  }
  function deliver(buffer){for(const f of split(new Uint8Array(buffer)))sendApp(f.buffer);}
  function sendRemote(data){if(channel&&active&&channel.readyState===1){
      if(channel.bufferedAmount>33554432){halt();return;}
      channel.send(data);
    }else if(pending.length<1024)pending.push(data);else halt();}
  async function connectWithHello(hello){
    if(connecting||closed)return;
    connecting=true;
    try{
      const response=await fetch(base+'/api/v1/session',{
        method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/octet-stream'},
        body:hello,mode:'same-origin',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'
      });
      if(!response.ok)throw Error('session rejected');
      const credential=response.headers.get('X-Session-Token');
      if(!credential)throw Error('missing session');
      const frame=await response.arrayBuffer();
      const scheme=location.protocol==='https:'?'wss:':'ws:';
      channel=new WebSocket(scheme+'//'+location.host+base+'/api/v1/ws',['tproxy-v1.'+credential]);
      channel.binaryType='arraybuffer';
      channel.onopen=()=>{if(closed)return;active=true;deliver(frame);status('connected');while(pending.length)sendRemote(pending.shift());};
      channel.onmessage=e=>{try{if(!(e.data instanceof ArrayBuffer))throw Error('not binary');deliver(e.data);}catch{halt();}};
      channel.onerror=()=>halt();channel.onclose=()=>halt();
    }catch{halt();}
  }
  function receive(value){
    if(closed)return;
    const item=value&&typeof value==='object'&&'data'in value?value.data:value;
    if(item&&typeof item==='object'&&item.t==='close'){halt();return;}
    const buffer=bytes(item);if(!buffer||!buffer.length)return;
    let packets;try{packets=split(buffer);}catch{halt();return;}
    for(const f of packets){
      if(!connecting){
        if(f[0]!==16||f[1]!==0||f[2]!==0||f[3]!==0||f.length!==9||f[8]!==1){halt();return;}
        connectWithHello(f);
      }else sendRemote(f);
    }
  }
  if(native&&typeof native.postMessage==='function'&&typeof marker==='string'&&/^[\\w-]{43}$/.test(marker)){
    native.onmessage=receive;
    sendApp({t:'tproxy-android-init',v:1,nonce:marker});
  }else{
    window.addEventListener('message',event=>{
      if(port||event.source!==window.parent||!/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(event.origin))return;
      if(!event.data||event.data.t!=='tproxy-init'||event.data.v!==1||event.ports.length!==1)return;
      port=event.ports[0];port.onmessage=receive;port.start();status('ready');
    });
  }
})();`;
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAXIMUS Bridge</title></head><body><script nonce="${nonce}">${code}</script></body></html>`;
  return new Response(html,{status:200,headers:{
    'content-type':'text/html; charset=utf-8','cache-control':'no-store, private',
    'referrer-policy':'no-referrer','x-content-type-options':'nosniff',
    'content-security-policy':`default-src 'none'; connect-src 'self' wss:; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
    'permissions-policy':'camera=(), microphone=(), geolocation=()'
  }});
}
