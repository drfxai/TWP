/** MAXIMUS TWP — isolated WebSocket/TCP carrier, one instance per upgrade. */
import {Frame,frame,parseFrames,validateIncoming,windowFrame} from './codec.js';
import {decodeClientGreeting,dcGreeting,openDc} from './datacenter.js';

const READ_CHUNK=64*1024;
const FLOW_START=4*1024*1024;
const MAX_BUFFERED=2*1024*1024;
const MAX_DIALS=40;
const SOFT_WAIT_MS=20;

export function runCarrier(ws,secretInfo,limit,connectFn){
  let stopped=false,opened=0;
  const streams=new Map(),seen=new Set();
  let inbound=Promise.resolve();
  ws.binaryType='arraybuffer';

  const emit=bytes=>{if(stopped)return;try{ws.send(bytes);}catch{shutdown(1011);}};
  const drop=(item,notify)=>{
    if(!item || item.dead)return;
    item.dead=true;streams.delete(item.id);
    if(item.wakeup){item.wakeup();item.wakeup=null;}
    try{item.reader?.cancel();}catch{}
    try{item.socket?.close();}catch{}
    try{item.writer?.releaseLock();}catch{}
    if(notify)emit(frame(Frame.CLOSE,item.id));
  };
  const shutdown=code=>{
    if(stopped)return;
    stopped=true;
    for(const entry of streams.values())drop(entry,false);
    try{ws.close(code);}catch{}
  };
  const wake=entry=>{if(entry.wakeup){entry.wakeup();entry.wakeup=null;}};
  const waitForCredit=entry=>new Promise(resolve=>{entry.wakeup=resolve;});

  async function readFromDc(entry){
    try{
      while(!stopped&&!entry.dead){
        while(ws.bufferedAmount>MAX_BUFFERED&&!entry.dead&&!stopped)await new Promise(r=>setTimeout(r,SOFT_WAIT_MS));
        const {done,value}=await entry.reader.read();
        if(done)break;
        for(let p=0;p<value.length&&!entry.dead&&!stopped;){
          while(entry.outbound===0&&!entry.dead&&!stopped)await waitForCredit(entry);
          if(entry.dead||stopped)return;
          const n=Math.min(READ_CHUNK,entry.outbound,value.length-p);
          entry.outbound-=n;
          emit(frame(Frame.DATA,entry.id,value.subarray(p,p+n)));
          p+=n;
        }
      }
    }catch{/* only the impacted stream is closed */}
    drop(entry,true);
  }

  async function upload(entry,data){
    if(stopped||entry.dead)return;
    if(data.length>entry.inbound)throw new Error('upload window exceeded');
    entry.inbound-=data.length;
    let index=0;
    if(!entry.client){
      const count=Math.min(64-entry.headerUsed,data.length);
      entry.header.set(data.subarray(0,count),entry.headerUsed);
      entry.headerUsed+=count;index=count;
      if(entry.headerUsed===64){
        const client=await decodeClientGreeting(secretInfo,entry.header);
        const [hello,socket]=await Promise.all([dcGreeting(client),openDc(client.dc,connectFn)]);
        if(stopped||entry.dead){socket.close();return;}
        entry.socket=socket;
        entry.writer=socket.writable.getWriter();
        entry.reader=socket.readable.getReader();
        entry.client=client.upCipher;
        entry.remote=hello.cipher;
        await entry.writer.write(hello.payload);
        readFromDc(entry);
      }
    }
    if(index<data.length&&entry.client){
      const bytes=data.subarray(index);
      const clear=await entry.client.crypt(bytes,entry.position);
      const encoded=await entry.remote.crypt(clear,entry.position);
      await entry.writer.write(encoded);
      entry.position+=bytes.length;
    }
    if(!entry.dead){
      entry.inbound=Math.min(0x7fffffff,entry.inbound+data.length);
      emit(windowFrame(entry.id,data.length));
    }
  }

  function consume(packet){
    if(packet.id===0){
      if(packet.type===Frame.BYE)shutdown(1000);
      return;
    }
    if(packet.type===Frame.OPEN){
      if(seen.has(packet.id))return shutdown(1002);
      seen.add(packet.id);
      if(opened>=MAX_DIALS||streams.size>=limit){emit(frame(Frame.CLOSE,packet.id));return;}
      opened++;
      streams.set(packet.id,{
        id:packet.id,dead:false,header:new Uint8Array(64),headerUsed:0,
        client:null,remote:null,position:64,inbound:FLOW_START,outbound:FLOW_START,
        writer:null,reader:null,socket:null,wakeup:null,work:Promise.resolve()
      });
      return;
    }
    const entry=streams.get(packet.id);
    if(!entry){if(!seen.has(packet.id))shutdown(1002);return;}
    if(packet.type===Frame.CLOSE){drop(entry,false);return;}
    if(packet.type===Frame.WINDOW){
      const increment=new DataView(packet.payload.buffer,packet.payload.byteOffset,4).getUint32(0,false);
      entry.outbound=Math.min(0x7fffffff,entry.outbound+increment);wake(entry);return;
    }
    if(packet.type===Frame.DATA){
      const copy=packet.payload.slice();
      entry.work=entry.work.then(()=>upload(entry,copy)).catch(()=>drop(entry,true));
    }
  }

  ws.addEventListener('message',event=>{
    inbound=inbound.then(async()=>{
      if(stopped)return;
      const raw=event.data;
      if(typeof raw==='string')throw new Error('text not allowed');
      const bytes=raw instanceof Blob?new Uint8Array(await raw.arrayBuffer()):new Uint8Array(raw);
      const packets=parseFrames(bytes);
      if(!packets.every(validateIncoming))throw new Error('invalid frame');
      for(const item of packets){if(stopped)break;consume(item);}
    }).catch(()=>shutdown(1002));
  });
  ws.addEventListener('close',()=>shutdown(1000));
  ws.addEventListener('error',()=>shutdown(1011));
  return {close:shutdown};
}
