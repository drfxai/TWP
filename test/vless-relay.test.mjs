import test from 'node:test';
import assert from 'node:assert/strict';

class MockWs extends EventTarget {
  constructor(){super();this.readyState=1;this.peer=null;}
  accept(){}
  send(data){const p=this.peer;if(p&&p.readyState===1)queueMicrotask(()=>p.dispatchEvent(Object.assign(new Event('message'),{data})));}
  close(){if(this.readyState===3)return;this.readyState=3;if(this.peer&&this.peer.readyState!==3){this.peer.readyState=3;this.peer.dispatchEvent(new Event('close'));}}
}
globalThis.WebSocketPair=function(){const c=new MockWs(),s=new MockWs();c.peer=s;s.peer=c;return {0:c,1:s};};
const Original=globalThis.Response;
globalThis.Response=class extends Original{constructor(b,i){if(i&&i.status===101){super(null,{...i,status:200});Object.defineProperty(this,'status',{value:101});this.webSocket=i.webSocket;}else super(b,i);}};

const {default:worker,internals}=await import('../vless/worker.js');
const UUID='4dd18689-f994-46fb-a5ee-5fbf61da1cf4';

test('E2E: VLESS TCP relay sends response header then remote bytes, forwards uplink',async()=>{
  const written=[];let remote;
  globalThis.__mockConnect=(address)=>{
    assert.equal(address.hostname,'example.com');assert.equal(address.port,80);
    return {writable:new WritableStream({write(c){written.push(...c);}}),readable:new ReadableStream({start(c){remote=c;}}),close(){}};
  };
  const res=await worker.fetch(new Request('https://abc.mx.workers.dev/?ed=2560',{headers:{upgrade:'websocket'}}),{UUID});
  assert.equal(res.status,101);
  const client=res.webSocket;const got=[];
  client.addEventListener('message',e=>got.push(...new Uint8Array(e.data)));
  const u=internals.uuidBytes(UUID),h=new TextEncoder().encode('example.com');
  client.send(Uint8Array.from([0,...u,0,1,0,80,2,h.length,...h,71,69,84]));
  await new Promise(r=>setTimeout(r,20));
  assert.deepEqual(written,[71,69,84]);
  remote.enqueue(Uint8Array.of(9,8,7));
  await new Promise(r=>setTimeout(r,20));
  assert.deepEqual(got,[0,0,9,8,7]);
  client.send(Uint8Array.of(1,1));
  await new Promise(r=>setTimeout(r,20));
  assert.deepEqual(written,[71,69,84,1,1]);
  globalThis.__mockConnect=null;
});

test('E2E: wrong UUID closes the socket without dialing',async()=>{
  let dialed=false;globalThis.__mockConnect=()=>{dialed=true;};
  const res=await worker.fetch(new Request('https://abc.mx.workers.dev/',{headers:{upgrade:'websocket'}}),{UUID});
  const client=res.webSocket;
  client.send(Uint8Array.from([0,...new Uint8Array(16),0,1,0,80,1,1,1,1,1]));
  await new Promise(r=>setTimeout(r,20));
  assert.equal(dialed,false);assert.equal(client.readyState,3);
  globalThis.__mockConnect=null;
});
