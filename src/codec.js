/** MAXIMUS TWP | WEB proxy v1 binary frame codec. */
export const Frame = Object.freeze({ OPEN:1, DATA:2, CLOSE:3, WINDOW:4, PING:5, PONG:6, HELLO:16, WELCOME:17, BYE:31 });
export const MAX_FRAME_BYTES = 1_048_576;
export const MAX_PACKET_BYTES = 4_194_304;

export function frame(type, id=0, body=new Uint8Array()) {
  if (!Number.isSafeInteger(id) || id < 0 || id > 0xffffff) throw new RangeError('stream id');
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  if (bytes.length > MAX_FRAME_BYTES) throw new RangeError('frame too large');
  const out = new Uint8Array(8 + bytes.length);
  out[0]=type;
  out[1]=(id>>>16)&255; out[2]=(id>>>8)&255; out[3]=id&255;
  new DataView(out.buffer).setUint32(4,bytes.length,false);
  out.set(bytes,8);
  return out;
}
export function parseFrames(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!data.length || data.length > MAX_PACKET_BYTES) throw new RangeError('invalid packet size');
  const frames=[];
  for (let pos=0; pos<data.length;) {
    if (data.length-pos<8 || frames.length>=4096) throw new Error('incomplete frame header');
    const size=new DataView(data.buffer,data.byteOffset+pos+4,4).getUint32(0,false);
    if (size>MAX_FRAME_BYTES || size>data.length-pos-8) throw new Error('invalid frame length');
    const id=(data[pos+1]<<16)|(data[pos+2]<<8)|data[pos+3];
    frames.push({type:data[pos],id,payload:data.subarray(pos+8,pos+8+size)});
    pos+=8+size;
  }
  return frames;
}
export function validateIncoming(x) {
  const {type,id,payload}=x;
  const empty = payload.length===0;
  if (type===Frame.OPEN || type===Frame.CLOSE) return id!==0 && empty;
  if (type===Frame.DATA) return id!==0 && payload.length>0;
  if (type===Frame.WINDOW) return id!==0 && payload.length===4 && new DataView(payload.buffer,payload.byteOffset,4).getUint32(0,false)>0;
  if (type===Frame.PONG) return id===0 && payload.length<=64;
  if (type===Frame.BYE) return id===0 && payload.length<=128;
  return false;
}
export function windowFrame(id,n) {
  if (!Number.isInteger(n)||n<1||n>0x7fffffff) throw new RangeError('window credit');
  const buf=new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0,n,false);
  return frame(Frame.WINDOW,id,buf);
}
