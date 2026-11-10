/**
 * ⚡ MAXIMUS TWP (Telegram Worker Proxy) Core Engine v2.2
 * High-Performance Serverless Telegram WEB Proxy Relay for Cloudflare Workers
 *
 * Implements the official Telegram WEB Proxy wire contract (tproxy v1):
 * - In-Worker Obfuscated2 Engine (Zero-Copy Downlink, AES-CTR Uplink Re-encryption)
 * - Dynamic Datacenter Selection (DC1 - DC5 over Cloudflare Anycast Sockets)
 * - Multiplexed WebSocket Carrier with Seamless Multi-Lane Rollover
 * - Dual-mode: Direct tg://webproxy bridge & Camouflaged / Interactive Web Dashboard
 *
 * Repository: https://github.com/drfxai/TWP
 * Copyright (c) 2026 DrFXAi
 * License: MIT
 */

import { connect } from 'cloudflare:sockets';

// ==================================================================================
// 1. PROTOCOL CONSTANTS & TELEGRAM DATACENTERS
// ==================================================================================

const BRIDGE_DOMAIN_LABEL  = 'tdesktop-web-proxy-bridge-v1\n';
const TOKEN_LABEL_PREFIX   = 'tgp-token-v1\0';
const TOKEN_KEY_DERIVATION = 'tgp-token-key-v1';

// Frame Types (Telegram WEB Proxy v1 Protocol)
const FRAME_OPEN    = 1;
const FRAME_DATA    = 2;
const FRAME_CLOSE   = 3;
const FRAME_WINDOW  = 4;
const FRAME_PING    = 5;
const FRAME_PONG    = 6;
const FRAME_HELLO   = 0x10;
const FRAME_WELCOME = 0x11;
const FRAME_BYE     = 0x1f;

// Flow Control, Batching & Buffer Boundaries
const CHUNK_SIZE              = 64 * 1024;        // 64 KiB chunks
const MAX_DOWNLINK_BATCH      = 128 * 1024;       // 128 KiB coalesced WebSocket send batch
const WS_HIGH_WATERMARK       = 2 * 1024 * 1024;  // 2 MiB WebSocket backpressure threshold
const INITIAL_STREAM_WIN      = 4 * 1024 * 1024;  // 4 MiB flow credit per stream
const WINDOW_FLUSH_THRESHOLD  = 64 * 1024;        // Immediate window grant threshold
const MAX_FRAME_PAYLOAD       = 1024 * 1024;      // 1 MiB max single frame payload
const MAX_FRAMES_PER_MSG      = 4096;
const MAX_CARRIER_MSG         = 4 * 1024 * 1024;  // 4 MiB max WebSocket message
const MAX_STREAMS_COUNT       = 48;               // Max concurrent logical streams per session
const MAX_RETIRED_IDS         = 4096;
const DEFAULT_DIAL_LIMIT      = 45;               // Streams per lane before warm rollover
const DIAL_TIMEOUT_MS         = 4500;             // TCP connect timeout per endpoint
const CARRIER_PING_MS         = 20000;            // 20s keep-alive & token renewal

const TOKEN_TTL_BOOTSTRAP = 120;                  // 2 minutes
const TOKEN_TTL_SESSION   = 600;                  // 10 minutes
const TOKEN_TTL_RENEWAL   = 3600;                 // 1 hour renewal grace

/**
 * Official Telegram Datacenter IPv4 Endpoints (Standard Port 443).
 * Negative DC IDs represent media endpoints.
 */
const TELEGRAM_DCS = {
  1: ['149.154.175.50', '149.154.175.51', '149.154.175.54'],
  2: ['149.154.167.50', '149.154.167.51', '149.154.167.92'],
  3: ['149.154.175.100', '149.154.175.101'],
  4: ['149.154.167.91', '149.154.167.92'],
  5: ['149.154.171.5', '149.154.171.6'],
};

const PROTOCOL_TAGS = new Set([0xefefefef, 0xeeeeeeee, 0xdddddddd]);
const FORBIDDEN_WORDS = new Set([
  0x44414548, // 'HEAD'
  0x54534f50, // 'POST'
  0x20544547, // 'GET '
  0x4954504f, // 'OPTI'
  0xdddddddd,
  0xeeeeeeee,
  0x02010316,
]);

const textEncoder = new TextEncoder();

// Pre-encoded static buffers for zero-allocation hot paths
const TOKEN_PREFIX_BYTES    = textEncoder.encode(TOKEN_LABEL_PREFIX);
const TOKEN_KEY_DERIV_BYTES = textEncoder.encode(TOKEN_KEY_DERIVATION);
const HELLO_FRAME_BYTES     = Uint8Array.of(FRAME_HELLO, 0, 0, 0, 0, 0, 0, 1, 1);
const WELCOME_FRAME_BYTES   = Uint8Array.of(FRAME_WELCOME, 0, 0, 0, 0, 0, 0, 0);

// ==================================================================================
// 2. BINARY & CRYPTOGRAPHIC PRIMITIVES
// ==================================================================================

const HEX_TABLE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const HEX_LUT = new Int8Array(128).fill(-1);
for (let i = 0; i < 10; i++) HEX_LUT[48 + i] = i;
for (let i = 0; i < 6; i++) {
  HEX_LUT[65 + i] = 10 + i;
  HEX_LUT[97 + i] = 10 + i;
}

function toHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += HEX_TABLE[bytes[i]];
  }
  return hex;
}

function parseHex(hexStr) {
  const len = hexStr.length;
  if (len % 2 !== 0) throw new Error('TWP: Invalid hex length');
  const bytes = new Uint8Array(len >>> 1);
  for (let i = 0, j = 0; i < len; i += 2, j++) {
    const c1 = hexStr.charCodeAt(i);
    const c2 = hexStr.charCodeAt(i + 1);
    const hi = c1 < 128 ? HEX_LUT[c1] : -1;
    const lo = c2 < 128 ? HEX_LUT[c2] : -1;
    if (hi < 0 || lo < 0) throw new Error('TWP: Invalid hex character');
    bytes[j] = (hi << 4) | lo;
  }
  return bytes;
}

function concatArrays(...arrays) {
  let length = 0;
  for (let i = 0; i < arrays.length; i++) length += arrays[i].length;
  const result = new Uint8Array(length);
  let offset = 0;
  for (let i = 0; i < arrays.length; i++) {
    const arr = arrays[i];
    if (arr.length > 0) {
      result.set(arr, offset);
      offset += arr.length;
    }
  }
  return result;
}

function reverseBytes(bytes) {
  const len = bytes.length;
  const reversed = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    reversed[i] = bytes[len - 1 - i];
  }
  return reversed;
}

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(base64Url) {
  const standard = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timingSafeEquals(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

function writeUint32BE(value) {
  const buffer = new Uint8Array(4);
  buffer[0] = value >>> 24;
  buffer[1] = value >>> 16;
  buffer[2] = value >>> 8;
  buffer[3] = value;
  return buffer;
}

function packFrame(type, streamId, payload) {
  const payloadLen = payload ? payload.length : 0;
  const frame = new Uint8Array(8 + payloadLen);
  frame[0] = type;
  frame[1] = streamId >>> 16;
  frame[2] = streamId >>> 8;
  frame[3] = streamId;
  frame[4] = payloadLen >>> 24;
  frame[5] = payloadLen >>> 16;
  frame[6] = payloadLen >>> 8;
  frame[7] = payloadLen;
  if (payloadLen > 0) frame.set(payload, 8);
  return frame;
}

function packFrameBatch(framesList) {
  if (framesList.length === 1) return framesList[0];
  return concatArrays(...framesList);
}

function unpackFrameBatch(bytes) {
  const frames = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 0;
  const totalLen = bytes.length;
  while (cursor < totalLen) {
    if (frames.length >= MAX_FRAMES_PER_MSG || totalLen - cursor < 8) {
      throw new Error('TWP: Batch size error');
    }
    const size = view.getUint32(cursor + 4);
    if (size > MAX_FRAME_PAYLOAD || cursor + 8 + size > totalLen) {
      throw new Error('TWP: Invalid frame length');
    }
    frames.push({
      type: bytes[cursor],
      id: (bytes[cursor + 1] << 16) | (bytes[cursor + 2] << 8) | bytes[cursor + 3],
      payload: bytes.subarray(cursor + 8, cursor + 8 + size),
    });
    cursor += 8 + size;
  }
  if (frames.length === 0) throw new Error('TWP: Empty frame batch');
  return frames;
}

function validateClientFrame(f) {
  if (f.id === 0) {
    if ((f.type !== FRAME_PONG && f.type !== FRAME_BYE) || f.payload.length > 64) {
      throw new Error('TWP: Invalid control frame');
    }
    return;
  }
  if (f.type === FRAME_OPEN || f.type === FRAME_CLOSE) {
    if (f.payload.length !== 0) throw new Error('TWP: Unexpected control payload');
  } else if (f.type === FRAME_DATA) {
    if (f.payload.length === 0) throw new Error('TWP: Zero-length data frame');
  } else if (f.type === FRAME_WINDOW) {
    if (f.payload.length !== 4 || new DataView(f.payload.buffer, f.payload.byteOffset, 4).getUint32(0) === 0) {
      throw new Error('TWP: Malformed window frame');
    }
  } else {
    throw new Error('TWP: Unknown frame type');
  }
}

// ==================================================================================
// 3. WEB CRYPTO PRIMITIVES (HMAC & FAST 32-BIT AES-256-CTR)
// ==================================================================================

async function createHmacKey(rawBytes) {
  return crypto.subtle.importKey('raw', rawBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function computeHmac(key, data) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

async function computeSha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

function incrementCounter128(initialIv, blockOffset) {
  const counter = initialIv.slice();
  if (blockOffset === 0) return counter;
  const view = new DataView(counter.buffer, counter.byteOffset, 16);
  let carry = blockOffset >>> 0;
  let highCarry = Math.floor(blockOffset / 0x100000000) >>> 0;

  for (let wordIdx = 3; wordIdx >= 0 && (carry > 0 || highCarry > 0); wordIdx--) {
    const bytePos = wordIdx * 4;
    const current = view.getUint32(bytePos, false);
    const addend = wordIdx === 3 ? carry : wordIdx === 2 ? carry + highCarry : carry;
    const sum = current + addend;
    view.setUint32(bytePos, sum >>> 0, false);
    carry = Math.floor(sum / 0x100000000);
    if (wordIdx === 2) highCarry = 0;
  }
  return counter;
}

async function createAesCtrCipher(keyBytes, iv) {
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-CTR', false, ['encrypt']);
  return { cryptoKey, iv };
}

async function applyAesCtr(cipher, byteOffset, inputData) {
  if (inputData.length === 0) return inputData;
  const remainder = byteOffset & 15;
  const blockCounter = incrementCounter128(cipher.iv, Math.floor(byteOffset / 16));
  if (remainder === 0) {
    return new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CTR', counter: blockCounter, length: 128 }, cipher.cryptoKey, inputData)
    );
  }
  const source = new Uint8Array(remainder + inputData.length);
  source.set(inputData, remainder);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CTR', counter: blockCounter, length: 128 }, cipher.cryptoKey, source)
  );
  return encrypted.subarray(remainder);
}

// ==================================================================================
// 4. CONFIGURATION & STATELESS TOKENS
// ==================================================================================

let cachedConfig = null;

function resolveConfig(env) {
  const secretInput = typeof env?.PROXY_SECRET === 'string'
    ? env.PROXY_SECRET
    : typeof env?.SECRET === 'string'
    ? env.SECRET
    : '';

  const rawSecret = secretInput.trim().toLowerCase() || '000102030405060708090a0b0c0d0e0f';

  if (!cachedConfig || cachedConfig.raw !== rawSecret) {
    const promise = buildConfigKeys(rawSecret).catch((err) => {
      if (cachedConfig && cachedConfig.raw === rawSecret) cachedConfig = null;
      throw err;
    });
    cachedConfig = { raw: rawSecret, value: promise };
  }
  return cachedConfig.value;
}

async function buildConfigKeys(rawSecret) {
  const match = /^(dd)?([0-9a-f]{32})$/.exec(rawSecret);
  if (!match) return null;
  const fullSecretBytes = parseHex(rawSecret);
  const secret16 = parseHex(match[2]);
  const isPadded = Boolean(match[1]);
  const capabilityKey = await createHmacKey(fullSecretBytes);
  const capabilityKey16 = isPadded ? await createHmacKey(secret16) : capabilityKey;
  const tokenMasterKey = await createHmacKey(
    await computeHmac(capabilityKey, TOKEN_KEY_DERIV_BYTES)
  );
  return {
    fullBytes: fullSecretBytes,
    secret16,
    isPadded,
    capabilityKey,
    capabilityKey16,
    tokenMasterKey,
  };
}

function resolveMaxDials(env) {
  const val = parseInt(env?.MAX_DIALS, 10);
  return Number.isFinite(val) && val >= 4 ? Math.min(val, 100000) : DEFAULT_DIAL_LIMIT;
}

async function issueStatelessToken(config, kind, epochSec = Math.floor(Date.now() / 1000)) {
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  new DataView(nonce.buffer).setUint32(0, epochSec);
  const mac = (
    await computeHmac(config.tokenMasterKey, concatArrays(TOKEN_PREFIX_BYTES, Uint8Array.of(kind), nonce))
  ).subarray(0, 16);
  return toBase64Url(concatArrays(nonce, mac));
}

async function verifyStatelessToken(config, tokenStr, kind, maxTtl, epochSec = Math.floor(Date.now() / 1000)) {
  if (typeof tokenStr !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(tokenStr)) return false;
  let rawBytes;
  try {
    rawBytes = fromBase64Url(tokenStr);
  } catch {
    return false;
  }
  if (rawBytes.length !== 32) return false;
  const nonce = rawBytes.subarray(0, 16);
  const providedMac = rawBytes.subarray(16);
  const expectedMac = (
    await computeHmac(config.tokenMasterKey, concatArrays(TOKEN_PREFIX_BYTES, Uint8Array.of(kind), nonce))
  ).subarray(0, 16);

  if (!timingSafeEquals(providedMac, expectedMac)) return false;
  const tokenAge = epochSec - new DataView(nonce.buffer, nonce.byteOffset, 4).getUint32(0);
  return tokenAge >= -30 && tokenAge <= maxTtl;
}

function extractBearerToken(request) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+([A-Za-z0-9_-]{43})$/i.exec(authHeader.trim());
  return match ? match[1] : '';
}

// ==================================================================================
// 5. IN-WORKER MTPROTO OBFUSCATED2 RELAY ENGINE
// ==================================================================================

function normalizeDcId(rawDcId) {
  if (rawDcId === 0) return 2;
  let absDc = Math.abs(rawDcId);
  if (absDc > 10000) absDc = absDc % 10000;
  if (!TELEGRAM_DCS[absDc]) return null;
  return rawDcId < 0 ? -absDc : absDc;
}

/**
 * Decrypts the 64-byte client Obfuscated2 handshake header using the shared secret.
 * Extracts upload/download encryption keys, DC target ID, and transport tag.
 */
async function parseClientHandshake(config, handshakeBuffer) {
  const clientUpKey = await computeSha256(concatArrays(handshakeBuffer.subarray(8, 40), config.secret16));
  const downKeySource = reverseBytes(handshakeBuffer.subarray(8, 56));
  const clientDownKey = await computeSha256(concatArrays(downKeySource.subarray(0, 32), config.secret16));
  const clientDownIv = downKeySource.slice(32, 48);

  const clientUpCipher = await createAesCtrCipher(clientUpKey, handshakeBuffer.slice(40, 56));
  const decryptedHeader = await applyAesCtr(clientUpCipher, 0, handshakeBuffer);

  const transportTag = new DataView(decryptedHeader.buffer, decryptedHeader.byteOffset + 56, 4).getUint32(0);
  const rawDcId = new DataView(decryptedHeader.buffer, decryptedHeader.byteOffset + 60, 2).getInt16(0, true);
  const normalizedDc = normalizeDcId(rawDcId);

  return {
    clientUpCipher,
    clientDownKey,
    clientDownIv,
    transportTag,
    datacenterId: normalizedDc !== null ? normalizedDc : rawDcId,
  };
}

/**
 * Constructs the 64-byte header for the target Telegram DC.
 * Mathematical Invariant: reversed(dcInit[8..56]) matches client.downKey + client.downIv,
 * so packets sent from the DC directly match client expectations (Zero-Copy Downlink).
 */
async function generateDcHandshake(clientHandshake) {
  while (true) {
    const dcInit = new Uint8Array(64);
    crypto.getRandomValues(dcInit);
    const view = new DataView(dcInit.buffer);
    const firstWordLE = view.getUint32(0, true);
    const firstWordBE = view.getUint32(0, false);
    const secondWord = view.getUint32(4, false);

    if (
      dcInit[0] === 0xef ||
      (dcInit[0] === 0x16 && dcInit[1] === 0x03) ||
      FORBIDDEN_WORDS.has(firstWordLE) ||
      FORBIDDEN_WORDS.has(firstWordBE) ||
      secondWord === 0
    ) {
      continue;
    }

    // Embed client's download keystream into DC's init header
    dcInit.set(reverseBytes(concatArrays(clientHandshake.clientDownKey, clientHandshake.clientDownIv)), 8);
    view.setUint32(56, clientHandshake.transportTag);
    view.setInt16(60, clientHandshake.datacenterId, true);

    const dcUpCipher = await createAesCtrCipher(dcInit.slice(8, 40), dcInit.slice(40, 56));
    const sealed = await applyAesCtr(dcUpCipher, 0, dcInit);

    const wirePayload = dcInit.slice();
    wirePayload.set(sealed.subarray(56, 64), 56);
    return { wirePayload, dcUpCipher };
  }
}

function safeCloseSocket(sock) {
  if (!sock) return;
  try {
    sock.close();
  } catch {}
}

/**
 * Connects to a Telegram Datacenter using reliable sequential failover without socket leakage.
 */
async function connectToDatacenter(dcId) {
  const normalized = normalizeDcId(dcId);
  const absDc = normalized !== null ? Math.abs(normalized) : Math.abs(dcId);
  const endpoints = TELEGRAM_DCS[absDc];
  if (!endpoints || endpoints.length === 0) {
    throw new Error(`TWP: Unsupported DC ID ${dcId}`);
  }
  let lastError = null;
  for (const hostname of endpoints) {
    let timerId = null;
    let tcpSocket = null;
    try {
      tcpSocket = connect({ hostname, port: 443 }, { secureTransport: 'off', allowHalfOpen: false });
      if (tcpSocket.closed && typeof tcpSocket.closed.catch === 'function') {
        tcpSocket.closed.catch(() => {});
      }
      if (tcpSocket.opened) {
        if (typeof tcpSocket.opened.catch === 'function') {
          tcpSocket.opened.catch(() => {});
        }
        await Promise.race([
          tcpSocket.opened,
          new Promise((_, reject) => {
            timerId = setTimeout(() => reject(new Error('TWP: DC Connect Timeout')), DIAL_TIMEOUT_MS);
          }),
        ]);
      }
      if (timerId) clearTimeout(timerId);
      return tcpSocket;
    } catch (err) {
      if (timerId) clearTimeout(timerId);
      safeCloseSocket(tcpSocket);
      lastError = err;
    }
  }
  throw lastError || new Error('TWP: Datacenter connection failed');
}

// ==================================================================================
// 6. MULTIPLEXED CARRIER SESSION MANAGER (SERVE)
// ==================================================================================

function handleCarrierSession(webSocket, config, options) {
  try { webSocket.binaryType = 'arraybuffer'; } catch {}
  const activeStreams = new Map();
  const retiredStreamIds = new Set();
  let totalDials = 0;
  let isClosed = false;
  let pingIntervalId = null;

  const sendRawBytes = (bytes) => {
    if (isClosed) return;
    try {
      webSocket.send(bytes);
    } catch {
      terminateSession(4001);
    }
  };

  const closeStreamSocket = (stream) => {
    if (stream.isTerminated) return;
    stream.isTerminated = true;
    if (stream.wakeResolver) {
      const resolver = stream.wakeResolver;
      stream.wakeResolver = null;
      resolver();
    }
    try { stream.streamReader?.cancel().catch(() => {}); } catch {}
    safeCloseSocket(stream.tcpSocket);
    stream.tcpSocket = null;
  };

  const terminateSession = (closeCode) => {
    if (isClosed) return;
    isClosed = true;
    if (pingIntervalId) {
      clearInterval(pingIntervalId);
      pingIntervalId = null;
    }
    for (const stream of activeStreams.values()) {
      closeStreamSocket(stream);
    }
    activeStreams.clear();
    try { webSocket.close(closeCode); } catch {}
  };

  const teardownStream = (stream, notifyPeer) => {
    if (stream.isTerminated) return;
    closeStreamSocket(stream);
    activeStreams.delete(stream.streamId);
    if (notifyPeer && !isClosed) {
      sendRawBytes(packFrame(FRAME_CLOSE, stream.streamId));
    }
  };

  const flushWindowGrant = (stream) => {
    stream.isWindowGrantScheduled = false;
    if (stream.isTerminated || isClosed || stream.pendingWindowGrant <= 0) return;
    const amount = stream.pendingWindowGrant;
    stream.pendingWindowGrant = 0;
    sendRawBytes(packFrame(FRAME_WINDOW, stream.streamId, writeUint32BE(amount)));
  };

  const grantFlowWindow = (stream, bytesConsumed) => {
    stream.pendingWindowGrant += bytesConsumed;
    if (stream.pendingWindowGrant >= WINDOW_FLUSH_THRESHOLD) {
      flushWindowGrant(stream);
      return;
    }
    if (stream.isWindowGrantScheduled) return;
    stream.isWindowGrantScheduled = true;
    queueMicrotask(() => flushWindowGrant(stream));
  };

  /**
   * Pumps data received from Telegram DC back to client as DATA frames.
   * Zero-copy downlink: bytes require no decryption because DC Keystream matches client.
   */
  const pumpDownlink = async (stream) => {
    try {
      while (!stream.isTerminated && !isClosed) {
        if (typeof webSocket.bufferedAmount === 'number' && webSocket.bufferedAmount > WS_HIGH_WATERMARK) {
          await new Promise((r) => setTimeout(r, 15));
          if (stream.isTerminated || isClosed) return;
        }

        const { value: chunk, done: isDone } = await stream.streamReader.read();
        if (isDone || stream.isTerminated || isClosed) break;
        if (!chunk || chunk.length === 0) continue;

        let offset = 0;
        const framesToBatch = [];
        let batchedBytes = 0;

        while (offset < chunk.length) {
          while (stream.outboundCredit <= 0 && !stream.isTerminated && !isClosed) {
            if (framesToBatch.length > 0) {
              sendRawBytes(packFrameBatch(framesToBatch.splice(0, framesToBatch.length)));
              batchedBytes = 0;
            }
            await new Promise((resolve) => (stream.wakeResolver = resolve));
          }
          if (stream.isTerminated || isClosed) return;

          const sendLen = Math.min(CHUNK_SIZE, chunk.length - offset, stream.outboundCredit);
          stream.outboundCredit -= sendLen;
          const packed = packFrame(FRAME_DATA, stream.streamId, chunk.subarray(offset, offset + sendLen));
          framesToBatch.push(packed);
          batchedBytes += packed.length;
          offset += sendLen;

          if (batchedBytes >= MAX_DOWNLINK_BATCH) {
            sendRawBytes(packFrameBatch(framesToBatch.splice(0, framesToBatch.length)));
            batchedBytes = 0;
          }
        }

        if (framesToBatch.length > 0) {
          sendRawBytes(packFrameBatch(framesToBatch));
        }
      }
    } catch {}
    teardownStream(stream, true);
  };

  const initializeDatacenterConnection = async (stream, initialPayloadAfterHandshake) => {
    const clientHandshake = await parseClientHandshake(config, stream.handshakeBuffer);
    if (
      !PROTOCOL_TAGS.has(clientHandshake.transportTag) ||
      (config.isPadded && clientHandshake.transportTag !== 0xdddddddd) ||
      normalizeDcId(clientHandshake.datacenterId) === null
    ) {
      throw new Error('TWP: Handshake header rejected');
    }

    const [dcHandshake, tcpSocket] = await Promise.all([
      generateDcHandshake(clientHandshake),
      connectToDatacenter(clientHandshake.datacenterId),
    ]);

    if (stream.isTerminated || isClosed) {
      safeCloseSocket(tcpSocket);
      return;
    }

    stream.tcpSocket = tcpSocket;
    stream.streamWriter = tcpSocket.writable.getWriter();
    stream.streamReader = tcpSocket.readable.getReader();
    stream.clientCipher = clientHandshake.clientUpCipher;
    stream.dcCipher = dcHandshake.dcUpCipher;

    if (initialPayloadAfterHandshake && initialPayloadAfterHandshake.length > 0) {
      const plaintext = await applyAesCtr(stream.clientCipher, stream.streamByteOffset, initialPayloadAfterHandshake);
      const reEncrypted = await applyAesCtr(stream.dcCipher, stream.streamByteOffset, plaintext);
      stream.streamByteOffset += initialPayloadAfterHandshake.length;
      await stream.streamWriter.write(concatArrays(dcHandshake.wirePayload, reEncrypted));
    } else {
      await stream.streamWriter.write(dcHandshake.wirePayload);
    }

    stream.isHandshakeComplete = true;
    pumpDownlink(stream);
  };

  const processUplinkPayload = async (stream, chunk) => {
    if (stream.isTerminated || isClosed) return;
    let remainingChunk = chunk;

    if (!stream.isHandshakeComplete) {
      const neededBytes = Math.min(64 - stream.handshakeBytesReceived, remainingChunk.length);
      stream.handshakeBuffer.set(remainingChunk.subarray(0, neededBytes), stream.handshakeBytesReceived);
      stream.handshakeBytesReceived += neededBytes;
      remainingChunk = remainingChunk.subarray(neededBytes);

      if (stream.handshakeBytesReceived < 64) {
        grantFlowWindow(stream, chunk.length);
        return;
      }
      await initializeDatacenterConnection(stream, remainingChunk);
      if (!stream.isTerminated) {
        grantFlowWindow(stream, chunk.length);
      }
      return;
    }

    if (remainingChunk.length > 0) {
      const plaintext = await applyAesCtr(stream.clientCipher, stream.streamByteOffset, remainingChunk);
      const reEncrypted = await applyAesCtr(stream.dcCipher, stream.streamByteOffset, plaintext);
      stream.streamByteOffset += remainingChunk.length;
      await stream.streamWriter.write(reEncrypted);
    }
    grantFlowWindow(stream, chunk.length);
  };

  const handleIncomingFrame = (f) => {
    if (f.id === 0) {
      if (f.type === FRAME_BYE) terminateSession(1000);
      return;
    }

    if (f.type === FRAME_OPEN) {
      if (retiredStreamIds.has(f.id)) {
        return terminateSession(4001);
      }
      if (retiredStreamIds.size >= MAX_RETIRED_IDS) {
        const oldest = retiredStreamIds.values().next().value;
        retiredStreamIds.delete(oldest);
      }
      retiredStreamIds.add(f.id);

      if (totalDials >= options.maxDials || activeStreams.size >= MAX_STREAMS_COUNT) {
        return sendRawBytes(packFrame(FRAME_CLOSE, f.id));
      }
      totalDials++;

      activeStreams.set(f.id, {
        streamId: f.id,
        isTerminated: false,
        isHandshakeComplete: false,
        outboundCredit: INITIAL_STREAM_WIN,
        wakeResolver: null,
        pendingWindowGrant: 0,
        isWindowGrantScheduled: false,
        handshakeBuffer: new Uint8Array(64),
        handshakeBytesReceived: 0,
        streamByteOffset: 64,
        clientCipher: null,
        dcCipher: null,
        tcpSocket: null,
        streamReader: null,
        streamWriter: null,
        pipelinePromise: Promise.resolve(),
      });
      return;
    }

    const stream = activeStreams.get(f.id);
    if (!stream) {
      if (!retiredStreamIds.has(f.id)) terminateSession(4001);
      return;
    }

    if (f.type === FRAME_DATA) {
      const payloadSlice = f.payload.slice();
      stream.pipelinePromise = stream.pipelinePromise
        .then(() => processUplinkPayload(stream, payloadSlice))
        .catch(() => teardownStream(stream, true));
    } else if (f.type === FRAME_CLOSE) {
      teardownStream(stream, false);
    } else if (f.type === FRAME_WINDOW) {
      const creditIncrement = new DataView(f.payload.buffer, f.payload.byteOffset, 4).getUint32(0);
      stream.outboundCredit = Math.min(0x7fffffff, stream.outboundCredit + creditIncrement);
      if (stream.wakeResolver) {
        const resolver = stream.wakeResolver;
        stream.wakeResolver = null;
        resolver();
      }
    }
  };

  let messageQueue = Promise.resolve();
  webSocket.addEventListener('message', (event) => {
    if (isClosed) return;
    messageQueue = messageQueue.then(async () => {
      if (isClosed) return;
      let data = event.data;
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        try {
          data = await data.arrayBuffer();
        } catch {
          return terminateSession(4001);
        }
      }
      let byteView;
      if (ArrayBuffer.isView(data)) {
        byteView = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else if (data instanceof ArrayBuffer) {
        byteView = new Uint8Array(data);
      } else {
        return terminateSession(4001);
      }
      if (byteView.byteLength === 0 || byteView.byteLength > MAX_CARRIER_MSG) {
        return terminateSession(4001);
      }
      let frames;
      try {
        frames = unpackFrameBatch(byteView);
        for (let i = 0; i < frames.length; i++) validateClientFrame(frames[i]);
      } catch {
        return terminateSession(4001);
      }
      for (let i = 0; i < frames.length; i++) {
        if (isClosed) return;
        handleIncomingFrame(frames[i]);
      }
    }).catch(() => {
      terminateSession(4001);
    });
  });

  webSocket.addEventListener('close', () => terminateSession(1000));
  webSocket.addEventListener('error', () => terminateSession(1000));

  if (options.pingMs) {
    pingIntervalId = setInterval(() => {
      if (isClosed) return;
      issueStatelessToken(config, 2).then((sessionToken) => {
        sendRawBytes(packFrame(FRAME_PING, 0, textEncoder.encode(sessionToken)));
      }, () => {});
    }, options.pingMs);
  }
}

// ==================================================================================
// 7. BRIDGE SCRIPT & WEB INTERFACE (HTML GENERATION)
// ==================================================================================

/**
 * Sandboxed bridge carrier client executing within Telegram's internal WebView.
 * Handles dual boundaries (TelegramWebProxy and loopback messagePort),
 * multi-lane rollover (cur, next), and ping keepalive.
 */
const EMBEDDED_BRIDGE_SCRIPT = String.raw`(()=>{
'use strict';
const BASE=__BASE__,BOOT=__BOOT__,DIALS=__DIALS__;
const found=/^#android=([A-Za-z0-9_-]{43})$/.exec(location.hash);
const androidNonce=found?found[1]:'';
history.replaceState(null,'',location.pathname);
const QUEUE_LIMIT=33554432,MESSAGE_LIMIT=262144,BUFFER_LIMIT=4194304,FRAME_LIMIT=4096,PAYLOAD_LIMIT=1048576;
const WARM_AT=Math.max(1,DIALS-12),SWITCH_AT=Math.max(1,DIALS-2),QUIET_MS=60000,CONNECT_TIMEOUT_MS=9000,TRIES=3,DEATHS=4,DEATH_WINDOW_MS=30000;
const HELLO=[16,0,0,0,0,0,0,1,1];
let closed=false,started=false,connected=false,token=BOOT,port=null,queued=0,cur=null,next=null,watch=0;
const lanes=new Set(),route=new Map(),deaths=[];
const post=(value)=>{if(port&&!closed)port.postMessage(value)};
const status=(state)=>post({t:'status',state});
const traffic=(up,down)=>post({t:'traffic',up,down});
const request=(method,token,body,signal)=>({method,body,signal,keepalive:method==='DELETE',mode:'same-origin',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:Object.assign(token?{Authorization:'Bearer '+token}:{},body?{'Content-Type':'application/octet-stream'}:{})});
const pause=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
function split(buffer){
 const view=new DataView(buffer),frames=[];let at=0;
 while(at<buffer.byteLength){
  if(buffer.byteLength-at<8||frames.length>=FRAME_LIMIT)throw new Error('batch');
  const size=view.getUint32(at+4),end=at+8+size;
  if(size>PAYLOAD_LIMIT||end>buffer.byteLength||(view.getUint8(at)===2&&!size))throw new Error('frame');
  frames.push(at===0&&end===buffer.byteLength?buffer:buffer.slice(at,end));at=end;
 }
 if(!frames.length)throw new Error('empty');
 return frames;
}
function frameOf(type,id,payload){
 const size=payload?payload.length:0,out=new Uint8Array(8+size),view=new DataView(out.buffer);
 view.setUint32(0,id);out[0]=type;view.setUint32(4,size);if(size)out.set(payload,8);
 return out.buffer;
}
const typeOf=(item)=>new DataView(item).getUint8(0);
const idOf=(item)=>new DataView(item).getUint32(0)&16777215;
function fail(){
 if(closed)return;
 status('failed');post({t:'close'});close(true);
}
function close(notify){
 if(closed)return;closed=true;
 if(watch)clearInterval(watch);
 for(const lane of lanes)shut(lane);
 if(notify&&token!==BOOT)fetch(BASE+'api/v1/session',request('DELETE',token,null)).catch(()=>{});
 if(port&&port.close)port.close();
}
function makeLane(){
 const lane={ws:null,ready:false,dead:false,opens:0,streams:new Set(),out:[],heard:Date.now(),timer:0};
 lanes.add(lane);return lane;
}
function shut(lane){
 if(lane.dead)return false;
 lane.dead=true;lane.ready=false;lanes.delete(lane);
 if(lane.timer)clearTimeout(lane.timer);
 for(const item of lane.out)queued-=item.byteLength;
 lane.out=[];
 try{if(lane.ws)lane.ws.close()}catch(e){}
 if(cur===lane)cur=null;
 if(next===lane)next=null;
 return true;
}
function lost(lane){
 if(!shut(lane)||closed)return;
 for(const id of lane.streams){if(route.get(id)===lane)route.delete(id);post(frameOf(3,id))}
 lane.streams.clear();
 const now=Date.now();deaths.push(now);
 while(deaths.length&&now-deaths[0]>DEATH_WINDOW_MS)deaths.shift();
 if(deaths.length>=DEATHS){fail();return}
 if(connected&&!cur)warm();
}
function retire(lane){
 if(lane!==cur&&lane!==next&&!lane.streams.size&&!lane.out.length)shut(lane);
}
function openSocket(lane,session){
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket(BASE.replace(/^http/,'ws')+'api/v1/ws','tproxy-v1.'+session);
  lane.ws=ws;ws.binaryType='arraybuffer';
  const timer=setTimeout(()=>{if(!lane.ready){try{ws.close()}catch(e){}reject(new Error('timeout'))}},CONNECT_TIMEOUT_MS);
  ws.onopen=()=>{clearTimeout(timer);if(lane.ws!==ws||lane.dead){reject(new Error('gone'));return}lane.ready=true;lane.heard=Date.now();resolve()};
  ws.onerror=()=>{if(!lane.ready){clearTimeout(timer);reject(new Error('socket'))}};
  ws.onclose=()=>{clearTimeout(timer);if(lane.ws!==ws)return;if(lane.ready)lost(lane);else reject(new Error('socket'))};
  ws.onmessage=(event)=>{if(lane.ws===ws)fromRelay(lane,event.data)};
 });
}
async function connectLane(lane,hello,tries){
 for(let i=1;;i++){
  let ctrl=null,tid=0;
  try{
   if(typeof AbortController!=='undefined'){ctrl=new AbortController();tid=setTimeout(()=>ctrl.abort(),CONNECT_TIMEOUT_MS)}
   const response=await fetch(BASE+'api/v1/session',request('POST',token,hello,ctrl?ctrl.signal:undefined));
   if(tid)clearTimeout(tid);
   if(response.status!==200||response.headers.get('X-Carrier-Mode')!=='websocket')throw new Error(response.status===404?'refused':'rejected');
   const session=response.headers.get('X-Session-Token')||'';
   if(!session)throw new Error('token');
   const welcome=await response.arrayBuffer();
   if(lane.dead)return null;
   token=session;
   await openSocket(lane,session);
   return welcome;
  }catch(e){
   if(tid)clearTimeout(tid);
   if(lane.dead||i>=tries||e.message==='refused')throw e;
   try{if(lane.ws)lane.ws.close()}catch(x){}
   await pause(500*i);
  }
 }
}
function promote(lane){
 if(next===lane)next=null;
 const old=cur;cur=lane;
 flush(lane);
 if(old)retire(old);
}
function warm(){
 if(next||closed)return;
 const lane=makeLane();next=lane;
 connectLane(lane,new Uint8Array(HELLO).buffer,TRIES).then((welcome)=>{if(welcome&&!closed&&!lane.dead)promote(lane)},()=>{
  if(closed)return;
  if(!cur||cur.opens>=DIALS){fail();return}
  lost(lane);
 });
}
function laneFor(){
 if(cur&&cur.opens<SWITCH_AT)return cur;
 warm();
 if(next&&next.ready)return next;
 if(cur&&cur.opens<DIALS)return cur;
 return next;
}
function send(lane,item){
 if(lane.dead)return;
 if(queued+item.byteLength>QUEUE_LIMIT){fail();return}
 queued+=item.byteLength;lane.out.push(item);flush(lane);
}
function flush(lane){
 if(closed||!lane.ready)return;
 const ws=lane.ws;
 while(lane.out.length){
  if(ws.bufferedAmount>BUFFER_LIMIT){if(!lane.timer)lane.timer=setTimeout(()=>{lane.timer=0;flush(lane);retire(lane)},10);return}
  let total=0,count=0;
  while(count<lane.out.length&&count<FRAME_LIMIT){
   const size=lane.out[count].byteLength;
   if(count&&total+size>MESSAGE_LIMIT)break;
   total+=size;count++;
  }
  const body=new Uint8Array(total);let at=0;
  for(const item of lane.out.splice(0,count)){body.set(new Uint8Array(item),at);at+=item.byteLength}
  queued-=total;
  try{ws.send(body)}catch(e){lost(lane);return}
  traffic(total,0);
 }
}
function fromApp(item){
 const type=typeOf(item),id=idOf(item);
 if(!id)return;
 if(type===1){
  const lane=laneFor();
  if(!lane)return;
  route.set(id,lane);lane.streams.add(id);lane.opens++;
  send(lane,item);
  if(lane===cur&&lane.opens>=WARM_AT)warm();
  return;
 }
 const lane=route.get(id);
 if(!lane)return;
 if(type===3){route.delete(id);lane.streams.delete(id)}
 send(lane,item);
 if(type===3)retire(lane);
}
function fromRelay(lane,data){
 if(lane.dead||closed)return;
 if(!(data instanceof ArrayBuffer)||!data.byteLength){lost(lane);return}
 let frames;try{frames=split(data)}catch(e){lost(lane);return}
 lane.heard=Date.now();
 traffic(0,data.byteLength);
 for(const item of frames){
  const type=typeOf(item),id=idOf(item);
  if(!id){if(type===5)ping(lane,item);continue}
  if(type===3){lane.streams.delete(id);if(route.get(id)===lane)route.delete(id)}
  post(item);
 }
 retire(lane);
 flush(lane);
}
function ping(lane,item){
 const echo=new Uint8Array(item,8);
 if(echo.length>64)return;
 const text=String.fromCharCode.apply(null,echo);
 if(/^[A-Za-z0-9_-]{43}$/.test(text))token=text;
 send(lane,frameOf(6,0,echo));
}
function check(){
 const now=Date.now();
 for(const lane of lanes)if(lane.ready&&now-lane.heard>QUIET_MS)lost(lane);
}
async function start(hello){
 status('connecting');
 const lane=makeLane();next=lane;
 try{
  const welcome=await connectLane(lane,hello,TRIES);
  if(!welcome||closed)return;
  connected=true;
  promote(lane);
  post(welcome);status('connected');
  watch=setInterval(check,15000);
 }catch(e){fail()}
}
function onApp(data){
 if(data instanceof ArrayBuffer){
  if(!started){started=true;start(data);return}
  let frames;try{frames=split(data)}catch(e){fail();return}
  for(const item of frames)fromApp(item);
 }else if(data&&data.t==='close')close(true);
}
const bridge=globalThis.TelegramWebProxy;
if(androidNonce&&bridge&&typeof bridge.postMessage==='function'){
 port={postMessage(value){bridge.postMessage(value instanceof ArrayBuffer?value:JSON.stringify(value))},close(){bridge.onmessage=null}};
 bridge.onmessage=(event)=>{
  let data=event.data;
  if(typeof data==='string'){try{data=JSON.parse(data)}catch(e){return}}
  onApp(data);
 };
 status('connecting');
 bridge.postMessage(JSON.stringify({t:'tproxy-android-init',v:1,nonce:androidNonce}));
}
addEventListener('message',(event)=>{
 if(port||event.source!==parent||event.data===null||typeof event.data!=='object')return;
 const keys=Object.keys(event.data).sort();
 if(keys.length!==2||keys[0]!=='t'||keys[1]!=='v'||event.data.t!=='tproxy-init'||event.data.v!==1||event.ports.length!==1)return;
 let from;try{from=new URL(event.origin)}catch(e){return}
 if(from.protocol!=='http:'||from.hostname!=='127.0.0.1'||!from.port||from.origin!==event.origin)return;
 const channel=event.ports[0];
 port={postMessage(value){if(value instanceof ArrayBuffer)channel.postMessage(value,[value]);else channel.postMessage(value)},close(){channel.close()}};
 channel.onmessage=(message)=>onApp(message.data);
 channel.start();status('connecting');
});
addEventListener('pagehide',()=>close(true),{once:true});
})();`;

const PERMISSIONS_POLICY =
  'accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), ' +
  'encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), ' +
  'magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), screen-wake-lock=(), ' +
  'serial=(), usb=(), web-share=(), xr-spatial-tracking=()';

function renderBridgeHtml(hostname, bootstrapToken, maxDials) {
  const nonceBytes = new Uint8Array(18);
  crypto.getRandomValues(nonceBytes);
  const nonceStr = toBase64Url(nonceBytes);

  const populatedScript = EMBEDDED_BRIDGE_SCRIPT
    .replace('__BASE__', () => JSON.stringify(`https://${hostname}/`))
    .replace('__BOOT__', () => JSON.stringify(bootstrapToken))
    .replace('__DIALS__', () => String(maxDials));

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Connection</title>
</head>
<body>
  <script nonce="${nonceStr}">${populatedScript}</script>
</body>
</html>`;

  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "child-src 'none'",
    `connect-src 'self' wss://${hostname}`,
    "font-src 'none'",
    "form-action 'none'",
    'frame-ancestors http://127.0.0.1:*',
    "frame-src 'none'",
    "img-src 'none'",
    "manifest-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    `script-src 'nonce-${nonceStr}'`,
    "style-src 'none'",
    "worker-src 'none'",
    'sandbox allow-same-origin allow-scripts',
  ].join('; ');

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'Permissions-Policy': PERMISSIONS_POLICY,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-DNS-Prefetch-Control': 'off',
    },
  });
}

// QR Code Generator for JavaScript — Copyright (c) 2009 Kazuhiko Arase — MIT License
const qrLibCode = `//---------------------------------------------------------------------
//
// QR Code Generator for JavaScript
//
// Copyright (c) 2009 Kazuhiko Arase
//
// URL: http://www.d-project.com/
//
// Licensed under the MIT license:
//  http://www.opensource.org/licenses/mit-license.php
//
// The word 'QR Code' is registered trademark of
// DENSO WAVE INCORPORATED
//  http://www.denso-wave.com/qrcode/faqpatent-e.html
//
//---------------------------------------------------------------------

var qrcode = function() {

  //---------------------------------------------------------------------
  // qrcode
  //---------------------------------------------------------------------

  /**
   * qrcode
   * @param typeNumber 1 to 40
   * @param errorCorrectionLevel 'L','M','Q','H'
   */
  var qrcode = function(typeNumber, errorCorrectionLevel) {

    var PAD0 = 0xEC;
    var PAD1 = 0x11;

    var _typeNumber = typeNumber;
    var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    var _modules = null;
    var _moduleCount = 0;
    var _dataCache = null;
    var _dataList = [];

    var _this = {};

    var makeImpl = function(test, maskPattern) {

      _moduleCount = _typeNumber * 4 + 17;
      _modules = function(moduleCount) {
        var modules = new Array(moduleCount);
        for (var row = 0; row < moduleCount; row += 1) {
          modules[row] = new Array(moduleCount);
          for (var col = 0; col < moduleCount; col += 1) {
            modules[row][col] = null;
          }
        }
        return modules;
      }(_moduleCount);

      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);

      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }

      if (_dataCache == null) {
        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
      }

      mapData(_dataCache, maskPattern);
    };

    var setupPositionProbePattern = function(row, col) {

      for (var r = -1; r <= 7; r += 1) {

        if (row + r <= -1 || _moduleCount <= row + r) continue;

        for (var c = -1; c <= 7; c += 1) {

          if (col + c <= -1 || _moduleCount <= col + c) continue;

          if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )
              || (0 <= c && c <= 6 && (r == 0 || r == 6) )
              || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
            _modules[row + r][col + c] = true;
          } else {
            _modules[row + r][col + c] = false;
          }
        }
      }
    };

    var getBestMaskPattern = function() {

      var minLostPoint = 0;
      var pattern = 0;

      for (var i = 0; i < 8; i += 1) {

        makeImpl(true, i);

        var lostPoint = QRUtil.getLostPoint(_this);

        if (i == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }

      return pattern;
    };

    var setupTimingPattern = function() {

      for (var r = 8; r < _moduleCount - 8; r += 1) {
        if (_modules[r][6] != null) {
          continue;
        }
        _modules[r][6] = (r % 2 == 0);
      }

      for (var c = 8; c < _moduleCount - 8; c += 1) {
        if (_modules[6][c] != null) {
          continue;
        }
        _modules[6][c] = (c % 2 == 0);
      }
    };

    var setupPositionAdjustPattern = function() {

      var pos = QRUtil.getPatternPosition(_typeNumber);

      for (var i = 0; i < pos.length; i += 1) {

        for (var j = 0; j < pos.length; j += 1) {

          var row = pos[i];
          var col = pos[j];

          if (_modules[row][col] != null) {
            continue;
          }

          for (var r = -2; r <= 2; r += 1) {

            for (var c = -2; c <= 2; c += 1) {

              if (r == -2 || r == 2 || c == -2 || c == 2
                  || (r == 0 && c == 0) ) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    };

    var setupTypeNumber = function(test) {

      var bits = QRUtil.getBCHTypeNumber(_typeNumber);

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
      }

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    };

    var setupTypeInfo = function(test, maskPattern) {

      var data = (_errorCorrectionLevel << 3) | maskPattern;
      var bits = QRUtil.getBCHTypeInfo(data);

      // vertical
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 6) {
          _modules[i][8] = mod;
        } else if (i < 8) {
          _modules[i + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i][8] = mod;
        }
      }

      // horizontal
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 8) {
          _modules[8][_moduleCount - i - 1] = mod;
        } else if (i < 9) {
          _modules[8][15 - i - 1 + 1] = mod;
        } else {
          _modules[8][15 - i - 1] = mod;
        }
      }

      // fixed module
      _modules[_moduleCount - 8][8] = (!test);
    };

    var mapData = function(data, maskPattern) {

      var inc = -1;
      var row = _moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      var maskFunc = QRUtil.getMaskFunction(maskPattern);

      for (var col = _moduleCount - 1; col > 0; col -= 2) {

        if (col == 6) col -= 1;

        while (true) {

          for (var c = 0; c < 2; c += 1) {

            if (_modules[row][col - c] == null) {

              var dark = false;

              if (byteIndex < data.length) {
                dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);
              }

              var mask = maskFunc(row, col - c);

              if (mask) {
                dark = !dark;
              }

              _modules[row][col - c] = dark;
              bitIndex -= 1;

              if (bitIndex == -1) {
                byteIndex += 1;
                bitIndex = 7;
              }
            }
          }

          row += inc;

          if (row < 0 || _moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };

    var createBytes = function(buffer, rsBlocks) {

      var offset = 0;

      var maxDcCount = 0;
      var maxEcCount = 0;

      var dcdata = new Array(rsBlocks.length);
      var ecdata = new Array(rsBlocks.length);

      for (var r = 0; r < rsBlocks.length; r += 1) {

        var dcCount = rsBlocks[r].dataCount;
        var ecCount = rsBlocks[r].totalCount - dcCount;

        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);

        dcdata[r] = new Array(dcCount);

        for (var i = 0; i < dcdata[r].length; i += 1) {
          dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
        }
        offset += dcCount;

        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

        var modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);
        for (var i = 0; i < ecdata[r].length; i += 1) {
          var modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;
        }
      }

      var totalCodeCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalCodeCount += rsBlocks[i].totalCount;
      }

      var data = new Array(totalCodeCount);
      var index = 0;

      for (var i = 0; i < maxDcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < dcdata[r].length) {
            data[index] = dcdata[r][i];
            index += 1;
          }
        }
      }

      for (var i = 0; i < maxEcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < ecdata[r].length) {
            data[index] = ecdata[r][i];
            index += 1;
          }
        }
      }

      return data;
    };

    var createData = function(typeNumber, errorCorrectionLevel, dataList) {

      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

      var buffer = qrBitBuffer();

      for (var i = 0; i < dataList.length; i += 1) {
        var data = dataList[i];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
        data.write(buffer);
      }

      // calc num max data.
      var totalDataCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalDataCount += rsBlocks[i].dataCount;
      }

      if (buffer.getLengthInBits() > totalDataCount * 8) {
        throw 'code length overflow. ('
          + buffer.getLengthInBits()
          + '>'
          + totalDataCount * 8
          + ')';
      }

      // end code
      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
        buffer.put(0, 4);
      }

      // padding
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }

      // padding
      while (true) {

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD0, 8);

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD1, 8);
      }

      return createBytes(buffer, rsBlocks);
    };

    _this.addData = function(data, mode) {

      mode = mode || 'Byte';

      var newData = null;

      switch(mode) {
      case 'Numeric' :
        newData = qrNumber(data);
        break;
      case 'Alphanumeric' :
        newData = qrAlphaNum(data);
        break;
      case 'Byte' :
        newData = qr8BitByte(data);
        break;
      case 'Kanji' :
        newData = qrKanji(data);
        break;
      default :
        throw 'mode:' + mode;
      }

      _dataList.push(newData);
      _dataCache = null;
    };

    _this.isDark = function(row, col) {
      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
        throw row + ',' + col;
      }
      return _modules[row][col];
    };

    _this.getModuleCount = function() {
      return _moduleCount;
    };

    _this.make = function() {
      if (_typeNumber < 1) {
        var typeNumber = 1;

        for (; typeNumber < 40; typeNumber++) {
          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
          var buffer = qrBitBuffer();

          for (var i = 0; i < _dataList.length; i++) {
            var data = _dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
            data.write(buffer);
          }

          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
          }

          if (buffer.getLengthInBits() <= totalDataCount * 8) {
            break;
          }
        }

        _typeNumber = typeNumber;
      }

      makeImpl(false, getBestMaskPattern() );
    };

    _this.createTableTag = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var qrHtml = '';

      qrHtml += '<table style="';
      qrHtml += ' border-width: 0px; border-style: none;';
      qrHtml += ' border-collapse: collapse;';
      qrHtml += ' padding: 0px; margin: ' + margin + 'px;';
      qrHtml += '">';
      qrHtml += '<tbody>';

      for (var r = 0; r < _this.getModuleCount(); r += 1) {

        qrHtml += '<tr>';

        for (var c = 0; c < _this.getModuleCount(); c += 1) {
          qrHtml += '<td style="';
          qrHtml += ' border-width: 0px; border-style: none;';
          qrHtml += ' border-collapse: collapse;';
          qrHtml += ' padding: 0px; margin: 0px;';
          qrHtml += ' width: ' + cellSize + 'px;';
          qrHtml += ' height: ' + cellSize + 'px;';
          qrHtml += ' background-color: ';
          qrHtml += _this.isDark(r, c)? '#000000' : '#ffffff';
          qrHtml += ';';
          qrHtml += '"/>';
        }

        qrHtml += '</tr>';
      }

      qrHtml += '</tbody>';
      qrHtml += '</table>';

      return qrHtml;
    };

    _this.createSvgTag = function(cellSize, margin, alt, title) {

      var opts = {};
      if (typeof arguments[0] == 'object') {
        // Called by options.
        opts = arguments[0];
        // overwrite cellSize and margin.
        cellSize = opts.cellSize;
        margin = opts.margin;
        alt = opts.alt;
        title = opts.title;
      }

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      // Compose alt property surrogate
      alt = (typeof alt === 'string') ? {text: alt} : alt || {};
      alt.text = alt.text || null;
      alt.id = (alt.text) ? alt.id || 'qrcode-description' : null;

      // Compose title property surrogate
      title = (typeof title === 'string') ? {text: title} : title || {};
      title.text = title.text || null;
      title.id = (title.text) ? title.id || 'qrcode-title' : null;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var c, mc, r, mr, qrSvg='', rect;

      rect = 'l' + cellSize + ',0 0,' + cellSize +
        ' -' + cellSize + ',0 0,-' + cellSize + 'z ';

      qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
      qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : '';
      qrSvg += ' viewBox="0 0 ' + size + ' ' + size + '" ';
      qrSvg += ' preserveAspectRatio="xMinYMin meet"';
      qrSvg += (title.text || alt.text) ? ' role="img" aria-labelledby="' +
          escapeXml([title.id, alt.id].join(' ').trim() ) + '"' : '';
      qrSvg += '>';
      qrSvg += (title.text) ? '<title id="' + escapeXml(title.id) + '">' +
          escapeXml(title.text) + '</title>' : '';
      qrSvg += (alt.text) ? '<description id="' + escapeXml(alt.id) + '">' +
          escapeXml(alt.text) + '</description>' : '';
      qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
      qrSvg += '<path d="';

      for (r = 0; r < _this.getModuleCount(); r += 1) {
        mr = r * cellSize + margin;
        for (c = 0; c < _this.getModuleCount(); c += 1) {
          if (_this.isDark(r, c) ) {
            mc = c*cellSize+margin;
            qrSvg += 'M' + mc + ',' + mr + rect;
          }
        }
      }

      qrSvg += '" stroke="transparent" fill="black"/>';
      qrSvg += '</svg>';

      return qrSvg;
    };

    _this.createDataURL = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      return createDataURL(size, size, function(x, y) {
        if (min <= x && x < max && min <= y && y < max) {
          var c = Math.floor( (x - min) / cellSize);
          var r = Math.floor( (y - min) / cellSize);
          return _this.isDark(r, c)? 0 : 1;
        } else {
          return 1;
        }
      } );
    };

    _this.createImgTag = function(cellSize, margin, alt) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;

      var img = '';
      img += '<img';
      img += '\\u0020src="';
      img += _this.createDataURL(cellSize, margin);
      img += '"';
      img += '\\u0020width="';
      img += size;
      img += '"';
      img += '\\u0020height="';
      img += size;
      img += '"';
      if (alt) {
        img += '\\u0020alt="';
        img += escapeXml(alt);
        img += '"';
      }
      img += '/>';

      return img;
    };

    var escapeXml = function(s) {
      var escaped = '';
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charAt(i);
        switch(c) {
        case '<': escaped += '&lt;'; break;
        case '>': escaped += '&gt;'; break;
        case '&': escaped += '&amp;'; break;
        case '"': escaped += '&quot;'; break;
        default : escaped += c; break;
        }
      }
      return escaped;
    };

    var _createHalfASCII = function(margin) {
      var cellSize = 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r1, r2, p;

      var blocks = {
        '██': '█',
        '█ ': '▀',
        ' █': '▄',
        '  ': ' '
      };

      var blocksLastLineNoMargin = {
        '██': '▀',
        '█ ': '▀',
        ' █': ' ',
        '  ': ' '
      };

      var ascii = '';
      for (y = 0; y < size; y += 2) {
        r1 = Math.floor((y - min) / cellSize);
        r2 = Math.floor((y + 1 - min) / cellSize);
        for (x = 0; x < size; x += 1) {
          p = '█';

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
            p = ' ';
          }

          if (min <= x && x < max && min <= y+1 && y+1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
            p += ' ';
          }
          else {
            p += '█';
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          ascii += (margin < 1 && y+1 >= max) ? blocksLastLineNoMargin[p] : blocks[p];
        }

        ascii += '\\n';
      }

      if (size % 2 && margin > 0) {
        return ascii.substring(0, ascii.length - size - 1) + Array(size+1).join('▀');
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.createASCII = function(cellSize, margin) {
      cellSize = cellSize || 1;

      if (cellSize < 2) {
        return _createHalfASCII(margin);
      }

      cellSize -= 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r, p;

      var white = Array(cellSize+1).join('██');
      var black = Array(cellSize+1).join('  ');

      var ascii = '';
      var line = '';
      for (y = 0; y < size; y += 1) {
        r = Math.floor( (y - min) / cellSize);
        line = '';
        for (x = 0; x < size; x += 1) {
          p = 1;

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
            p = 0;
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          line += p ? white : black;
        }

        for (r = 0; r < cellSize; r += 1) {
          ascii += line + '\\n';
        }
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.renderTo2dContext = function(context, cellSize) {
      cellSize = cellSize || 2;
      var length = _this.getModuleCount();
      for (var row = 0; row < length; row++) {
        for (var col = 0; col < length; col++) {
          context.fillStyle = _this.isDark(row, col) ? 'black' : 'white';
          context.fillRect(row * cellSize, col * cellSize, cellSize, cellSize);
        }
      }
    }

    return _this;
  };

  //---------------------------------------------------------------------
  // qrcode.stringToBytes
  //---------------------------------------------------------------------

  qrcode.stringToBytesFuncs = {
    'default' : function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        bytes.push(c & 0xff);
      }
      return bytes;
    }
  };

  qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];

  //---------------------------------------------------------------------
  // qrcode.createStringToBytes
  //---------------------------------------------------------------------

  /**
   * @param unicodeData base64 string of byte array.
   * [16bit Unicode],[16bit Bytes], ...
   * @param numChars
   */
  qrcode.createStringToBytes = function(unicodeData, numChars) {

    // create conversion map.

    var unicodeMap = function() {

      var bin = base64DecodeInputStream(unicodeData);
      var read = function() {
        var b = bin.read();
        if (b == -1) throw 'eof';
        return b;
      };

      var count = 0;
      var unicodeMap = {};
      while (true) {
        var b0 = bin.read();
        if (b0 == -1) break;
        var b1 = read();
        var b2 = read();
        var b3 = read();
        var k = String.fromCharCode( (b0 << 8) | b1);
        var v = (b2 << 8) | b3;
        unicodeMap[k] = v;
        count += 1;
      }
      if (count != numChars) {
        throw count + ' != ' + numChars;
      }

      return unicodeMap;
    }();

    var unknownChar = '?'.charCodeAt(0);

    return function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        if (c < 128) {
          bytes.push(c);
        } else {
          var b = unicodeMap[s.charAt(i)];
          if (typeof b == 'number') {
            if ( (b & 0xff) == b) {
              // 1byte
              bytes.push(b);
            } else {
              // 2bytes
              bytes.push(b >>> 8);
              bytes.push(b & 0xff);
            }
          } else {
            bytes.push(unknownChar);
          }
        }
      }
      return bytes;
    };
  };

  //---------------------------------------------------------------------
  // QRMode
  //---------------------------------------------------------------------

  var QRMode = {
    MODE_NUMBER :    1 << 0,
    MODE_ALPHA_NUM : 1 << 1,
    MODE_8BIT_BYTE : 1 << 2,
    MODE_KANJI :     1 << 3
  };

  //---------------------------------------------------------------------
  // QRErrorCorrectionLevel
  //---------------------------------------------------------------------

  var QRErrorCorrectionLevel = {
    L : 1,
    M : 0,
    Q : 3,
    H : 2
  };

  //---------------------------------------------------------------------
  // QRMaskPattern
  //---------------------------------------------------------------------

  var QRMaskPattern = {
    PATTERN000 : 0,
    PATTERN001 : 1,
    PATTERN010 : 2,
    PATTERN011 : 3,
    PATTERN100 : 4,
    PATTERN101 : 5,
    PATTERN110 : 6,
    PATTERN111 : 7
  };

  //---------------------------------------------------------------------
  // QRUtil
  //---------------------------------------------------------------------

  var QRUtil = function() {

    var PATTERN_POSITION_TABLE = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ];
    var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
    var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
    var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

    var _this = {};

    var getBCHDigit = function(data) {
      var digit = 0;
      while (data != 0) {
        digit += 1;
        data >>>= 1;
      }
      return digit;
    };

    _this.getBCHTypeInfo = function(data) {
      var d = data << 10;
      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
        d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );
      }
      return ( (data << 10) | d) ^ G15_MASK;
    };

    _this.getBCHTypeNumber = function(data) {
      var d = data << 12;
      while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
        d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );
      }
      return (data << 12) | d;
    };

    _this.getPatternPosition = function(typeNumber) {
      return PATTERN_POSITION_TABLE[typeNumber - 1];
    };

    _this.getMaskFunction = function(maskPattern) {

      switch (maskPattern) {

      case QRMaskPattern.PATTERN000 :
        return function(i, j) { return (i + j) % 2 == 0; };
      case QRMaskPattern.PATTERN001 :
        return function(i, j) { return i % 2 == 0; };
      case QRMaskPattern.PATTERN010 :
        return function(i, j) { return j % 3 == 0; };
      case QRMaskPattern.PATTERN011 :
        return function(i, j) { return (i + j) % 3 == 0; };
      case QRMaskPattern.PATTERN100 :
        return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };
      case QRMaskPattern.PATTERN101 :
        return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
      case QRMaskPattern.PATTERN110 :
        return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };
      case QRMaskPattern.PATTERN111 :
        return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };

      default :
        throw 'bad maskPattern:' + maskPattern;
      }
    };

    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
      var a = qrPolynomial([1], 0);
      for (var i = 0; i < errorCorrectLength; i += 1) {
        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );
      }
      return a;
    };

    _this.getLengthInBits = function(mode, type) {

      if (1 <= type && type < 10) {

        // 1 - 9

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 10;
        case QRMode.MODE_ALPHA_NUM : return 9;
        case QRMode.MODE_8BIT_BYTE : return 8;
        case QRMode.MODE_KANJI     : return 8;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 27) {

        // 10 - 26

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 12;
        case QRMode.MODE_ALPHA_NUM : return 11;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 10;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 41) {

        // 27 - 40

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 14;
        case QRMode.MODE_ALPHA_NUM : return 13;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 12;
        default :
          throw 'mode:' + mode;
        }

      } else {
        throw 'type:' + type;
      }
    };

    _this.getLostPoint = function(qrcode) {

      var moduleCount = qrcode.getModuleCount();

      var lostPoint = 0;

      // LEVEL1

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount; col += 1) {

          var sameCount = 0;
          var dark = qrcode.isDark(row, col);

          for (var r = -1; r <= 1; r += 1) {

            if (row + r < 0 || moduleCount <= row + r) {
              continue;
            }

            for (var c = -1; c <= 1; c += 1) {

              if (col + c < 0 || moduleCount <= col + c) {
                continue;
              }

              if (r == 0 && c == 0) {
                continue;
              }

              if (dark == qrcode.isDark(row + r, col + c) ) {
                sameCount += 1;
              }
            }
          }

          if (sameCount > 5) {
            lostPoint += (3 + sameCount - 5);
          }
        }
      };

      // LEVEL2

      for (var row = 0; row < moduleCount - 1; row += 1) {
        for (var col = 0; col < moduleCount - 1; col += 1) {
          var count = 0;
          if (qrcode.isDark(row, col) ) count += 1;
          if (qrcode.isDark(row + 1, col) ) count += 1;
          if (qrcode.isDark(row, col + 1) ) count += 1;
          if (qrcode.isDark(row + 1, col + 1) ) count += 1;
          if (count == 0 || count == 4) {
            lostPoint += 3;
          }
        }
      }

      // LEVEL3

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount - 6; col += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row, col + 1)
              &&  qrcode.isDark(row, col + 2)
              &&  qrcode.isDark(row, col + 3)
              &&  qrcode.isDark(row, col + 4)
              && !qrcode.isDark(row, col + 5)
              &&  qrcode.isDark(row, col + 6) ) {
            lostPoint += 40;
          }
        }
      }

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount - 6; row += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row + 1, col)
              &&  qrcode.isDark(row + 2, col)
              &&  qrcode.isDark(row + 3, col)
              &&  qrcode.isDark(row + 4, col)
              && !qrcode.isDark(row + 5, col)
              &&  qrcode.isDark(row + 6, col) ) {
            lostPoint += 40;
          }
        }
      }

      // LEVEL4

      var darkCount = 0;

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount; row += 1) {
          if (qrcode.isDark(row, col) ) {
            darkCount += 1;
          }
        }
      }

      var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;

      return lostPoint;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // QRMath
  //---------------------------------------------------------------------

  var QRMath = function() {

    var EXP_TABLE = new Array(256);
    var LOG_TABLE = new Array(256);

    // initialize tables
    for (var i = 0; i < 8; i += 1) {
      EXP_TABLE[i] = 1 << i;
    }
    for (var i = 8; i < 256; i += 1) {
      EXP_TABLE[i] = EXP_TABLE[i - 4]
        ^ EXP_TABLE[i - 5]
        ^ EXP_TABLE[i - 6]
        ^ EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i += 1) {
      LOG_TABLE[EXP_TABLE[i] ] = i;
    }

    var _this = {};

    _this.glog = function(n) {

      if (n < 1) {
        throw 'glog(' + n + ')';
      }

      return LOG_TABLE[n];
    };

    _this.gexp = function(n) {

      while (n < 0) {
        n += 255;
      }

      while (n >= 256) {
        n -= 255;
      }

      return EXP_TABLE[n];
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrPolynomial
  //---------------------------------------------------------------------

  function qrPolynomial(num, shift) {

    if (typeof num.length == 'undefined') {
      throw num.length + '/' + shift;
    }

    var _num = function() {
      var offset = 0;
      while (offset < num.length && num[offset] == 0) {
        offset += 1;
      }
      var _num = new Array(num.length - offset + shift);
      for (var i = 0; i < num.length - offset; i += 1) {
        _num[i] = num[i + offset];
      }
      return _num;
    }();

    var _this = {};

    _this.getAt = function(index) {
      return _num[index];
    };

    _this.getLength = function() {
      return _num.length;
    };

    _this.multiply = function(e) {

      var num = new Array(_this.getLength() + e.getLength() - 1);

      for (var i = 0; i < _this.getLength(); i += 1) {
        for (var j = 0; j < e.getLength(); j += 1) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );
        }
      }

      return qrPolynomial(num, 0);
    };

    _this.mod = function(e) {

      if (_this.getLength() - e.getLength() < 0) {
        return _this;
      }

      var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );

      var num = new Array(_this.getLength() );
      for (var i = 0; i < _this.getLength(); i += 1) {
        num[i] = _this.getAt(i);
      }

      for (var i = 0; i < e.getLength(); i += 1) {
        num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);
      }

      // recursive call
      return qrPolynomial(num, 0).mod(e);
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // QRRSBlock
  //---------------------------------------------------------------------

  var QRRSBlock = function() {

    var RS_BLOCK_TABLE = [

      // L
      // M
      // Q
      // H

      // 1
      [1, 26, 19],
      [1, 26, 16],
      [1, 26, 13],
      [1, 26, 9],

      // 2
      [1, 44, 34],
      [1, 44, 28],
      [1, 44, 22],
      [1, 44, 16],

      // 3
      [1, 70, 55],
      [1, 70, 44],
      [2, 35, 17],
      [2, 35, 13],

      // 4
      [1, 100, 80],
      [2, 50, 32],
      [2, 50, 24],
      [4, 25, 9],

      // 5
      [1, 134, 108],
      [2, 67, 43],
      [2, 33, 15, 2, 34, 16],
      [2, 33, 11, 2, 34, 12],

      // 6
      [2, 86, 68],
      [4, 43, 27],
      [4, 43, 19],
      [4, 43, 15],

      // 7
      [2, 98, 78],
      [4, 49, 31],
      [2, 32, 14, 4, 33, 15],
      [4, 39, 13, 1, 40, 14],

      // 8
      [2, 121, 97],
      [2, 60, 38, 2, 61, 39],
      [4, 40, 18, 2, 41, 19],
      [4, 40, 14, 2, 41, 15],

      // 9
      [2, 146, 116],
      [3, 58, 36, 2, 59, 37],
      [4, 36, 16, 4, 37, 17],
      [4, 36, 12, 4, 37, 13],

      // 10
      [2, 86, 68, 2, 87, 69],
      [4, 69, 43, 1, 70, 44],
      [6, 43, 19, 2, 44, 20],
      [6, 43, 15, 2, 44, 16],

      // 11
      [4, 101, 81],
      [1, 80, 50, 4, 81, 51],
      [4, 50, 22, 4, 51, 23],
      [3, 36, 12, 8, 37, 13],

      // 12
      [2, 116, 92, 2, 117, 93],
      [6, 58, 36, 2, 59, 37],
      [4, 46, 20, 6, 47, 21],
      [7, 42, 14, 4, 43, 15],

      // 13
      [4, 133, 107],
      [8, 59, 37, 1, 60, 38],
      [8, 44, 20, 4, 45, 21],
      [12, 33, 11, 4, 34, 12],

      // 14
      [3, 145, 115, 1, 146, 116],
      [4, 64, 40, 5, 65, 41],
      [11, 36, 16, 5, 37, 17],
      [11, 36, 12, 5, 37, 13],

      // 15
      [5, 109, 87, 1, 110, 88],
      [5, 65, 41, 5, 66, 42],
      [5, 54, 24, 7, 55, 25],
      [11, 36, 12, 7, 37, 13],

      // 16
      [5, 122, 98, 1, 123, 99],
      [7, 73, 45, 3, 74, 46],
      [15, 43, 19, 2, 44, 20],
      [3, 45, 15, 13, 46, 16],

      // 17
      [1, 135, 107, 5, 136, 108],
      [10, 74, 46, 1, 75, 47],
      [1, 50, 22, 15, 51, 23],
      [2, 42, 14, 17, 43, 15],

      // 18
      [5, 150, 120, 1, 151, 121],
      [9, 69, 43, 4, 70, 44],
      [17, 50, 22, 1, 51, 23],
      [2, 42, 14, 19, 43, 15],

      // 19
      [3, 141, 113, 4, 142, 114],
      [3, 70, 44, 11, 71, 45],
      [17, 47, 21, 4, 48, 22],
      [9, 39, 13, 16, 40, 14],

      // 20
      [3, 135, 107, 5, 136, 108],
      [3, 67, 41, 13, 68, 42],
      [15, 54, 24, 5, 55, 25],
      [15, 43, 15, 10, 44, 16],

      // 21
      [4, 144, 116, 4, 145, 117],
      [17, 68, 42],
      [17, 50, 22, 6, 51, 23],
      [19, 46, 16, 6, 47, 17],

      // 22
      [2, 139, 111, 7, 140, 112],
      [17, 74, 46],
      [7, 54, 24, 16, 55, 25],
      [34, 37, 13],

      // 23
      [4, 151, 121, 5, 152, 122],
      [4, 75, 47, 14, 76, 48],
      [11, 54, 24, 14, 55, 25],
      [16, 45, 15, 14, 46, 16],

      // 24
      [6, 147, 117, 4, 148, 118],
      [6, 73, 45, 14, 74, 46],
      [11, 54, 24, 16, 55, 25],
      [30, 46, 16, 2, 47, 17],

      // 25
      [8, 132, 106, 4, 133, 107],
      [8, 75, 47, 13, 76, 48],
      [7, 54, 24, 22, 55, 25],
      [22, 45, 15, 13, 46, 16],

      // 26
      [10, 142, 114, 2, 143, 115],
      [19, 74, 46, 4, 75, 47],
      [28, 50, 22, 6, 51, 23],
      [33, 46, 16, 4, 47, 17],

      // 27
      [8, 152, 122, 4, 153, 123],
      [22, 73, 45, 3, 74, 46],
      [8, 53, 23, 26, 54, 24],
      [12, 45, 15, 28, 46, 16],

      // 28
      [3, 147, 117, 10, 148, 118],
      [3, 73, 45, 23, 74, 46],
      [4, 54, 24, 31, 55, 25],
      [11, 45, 15, 31, 46, 16],

      // 29
      [7, 146, 116, 7, 147, 117],
      [21, 73, 45, 7, 74, 46],
      [1, 53, 23, 37, 54, 24],
      [19, 45, 15, 26, 46, 16],

      // 30
      [5, 145, 115, 10, 146, 116],
      [19, 75, 47, 10, 76, 48],
      [15, 54, 24, 25, 55, 25],
      [23, 45, 15, 25, 46, 16],

      // 31
      [13, 145, 115, 3, 146, 116],
      [2, 74, 46, 29, 75, 47],
      [42, 54, 24, 1, 55, 25],
      [23, 45, 15, 28, 46, 16],

      // 32
      [17, 145, 115],
      [10, 74, 46, 23, 75, 47],
      [10, 54, 24, 35, 55, 25],
      [19, 45, 15, 35, 46, 16],

      // 33
      [17, 145, 115, 1, 146, 116],
      [14, 74, 46, 21, 75, 47],
      [29, 54, 24, 19, 55, 25],
      [11, 45, 15, 46, 46, 16],

      // 34
      [13, 145, 115, 6, 146, 116],
      [14, 74, 46, 23, 75, 47],
      [44, 54, 24, 7, 55, 25],
      [59, 46, 16, 1, 47, 17],

      // 35
      [12, 151, 121, 7, 152, 122],
      [12, 75, 47, 26, 76, 48],
      [39, 54, 24, 14, 55, 25],
      [22, 45, 15, 41, 46, 16],

      // 36
      [6, 151, 121, 14, 152, 122],
      [6, 75, 47, 34, 76, 48],
      [46, 54, 24, 10, 55, 25],
      [2, 45, 15, 64, 46, 16],

      // 37
      [17, 152, 122, 4, 153, 123],
      [29, 74, 46, 14, 75, 47],
      [49, 54, 24, 10, 55, 25],
      [24, 45, 15, 46, 46, 16],

      // 38
      [4, 152, 122, 18, 153, 123],
      [13, 74, 46, 32, 75, 47],
      [48, 54, 24, 14, 55, 25],
      [42, 45, 15, 32, 46, 16],

      // 39
      [20, 147, 117, 4, 148, 118],
      [40, 75, 47, 7, 76, 48],
      [43, 54, 24, 22, 55, 25],
      [10, 45, 15, 67, 46, 16],

      // 40
      [19, 148, 118, 6, 149, 119],
      [18, 75, 47, 31, 76, 48],
      [34, 54, 24, 34, 55, 25],
      [20, 45, 15, 61, 46, 16]
    ];

    var qrRSBlock = function(totalCount, dataCount) {
      var _this = {};
      _this.totalCount = totalCount;
      _this.dataCount = dataCount;
      return _this;
    };

    var _this = {};

    var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {

      switch(errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default :
        return undefined;
      }
    };

    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {

      var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);

      if (typeof rsBlock == 'undefined') {
        throw 'bad rs block @ typeNumber:' + typeNumber +
            '/errorCorrectionLevel:' + errorCorrectionLevel;
      }

      var length = rsBlock.length / 3;

      var list = [];

      for (var i = 0; i < length; i += 1) {

        var count = rsBlock[i * 3 + 0];
        var totalCount = rsBlock[i * 3 + 1];
        var dataCount = rsBlock[i * 3 + 2];

        for (var j = 0; j < count; j += 1) {
          list.push(qrRSBlock(totalCount, dataCount) );
        }
      }

      return list;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrBitBuffer
  //---------------------------------------------------------------------

  var qrBitBuffer = function() {

    var _buffer = [];
    var _length = 0;

    var _this = {};

    _this.getBuffer = function() {
      return _buffer;
    };

    _this.getAt = function(index) {
      var bufIndex = Math.floor(index / 8);
      return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
    };

    _this.put = function(num, length) {
      for (var i = 0; i < length; i += 1) {
        _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
      }
    };

    _this.getLengthInBits = function() {
      return _length;
    };

    _this.putBit = function(bit) {

      var bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) {
        _buffer.push(0);
      }

      if (bit) {
        _buffer[bufIndex] |= (0x80 >>> (_length % 8) );
      }

      _length += 1;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrNumber
  //---------------------------------------------------------------------

  var qrNumber = function(data) {

    var _mode = QRMode.MODE_NUMBER;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var data = _data;

      var i = 0;

      while (i + 2 < data.length) {
        buffer.put(strToNum(data.substring(i, i + 3) ), 10);
        i += 3;
      }

      if (i < data.length) {
        if (data.length - i == 1) {
          buffer.put(strToNum(data.substring(i, i + 1) ), 4);
        } else if (data.length - i == 2) {
          buffer.put(strToNum(data.substring(i, i + 2) ), 7);
        }
      }
    };

    var strToNum = function(s) {
      var num = 0;
      for (var i = 0; i < s.length; i += 1) {
        num = num * 10 + chatToNum(s.charAt(i) );
      }
      return num;
    };

    var chatToNum = function(c) {
      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      }
      throw 'illegal char :' + c;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrAlphaNum
  //---------------------------------------------------------------------

  var qrAlphaNum = function(data) {

    var _mode = QRMode.MODE_ALPHA_NUM;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var s = _data;

      var i = 0;

      while (i + 1 < s.length) {
        buffer.put(
          getCode(s.charAt(i) ) * 45 +
          getCode(s.charAt(i + 1) ), 11);
        i += 2;
      }

      if (i < s.length) {
        buffer.put(getCode(s.charAt(i) ), 6);
      }
    };

    var getCode = function(c) {

      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      } else if ('A' <= c && c <= 'Z') {
        return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      } else {
        switch (c) {
        case ' ' : return 36;
        case '$' : return 37;
        case '%' : return 38;
        case '*' : return 39;
        case '+' : return 40;
        case '-' : return 41;
        case '.' : return 42;
        case '/' : return 43;
        case ':' : return 44;
        default :
          throw 'illegal char :' + c;
        }
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qr8BitByte
  //---------------------------------------------------------------------

  var qr8BitByte = function(data) {

    var _mode = QRMode.MODE_8BIT_BYTE;
    var _data = data;
    var _bytes = qrcode.stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _bytes.length;
    };

    _this.write = function(buffer) {
      for (var i = 0; i < _bytes.length; i += 1) {
        buffer.put(_bytes[i], 8);
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrKanji
  //---------------------------------------------------------------------

  var qrKanji = function(data) {

    var _mode = QRMode.MODE_KANJI;
    var _data = data;

    var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];
    if (!stringToBytes) {
      throw 'sjis not supported.';
    }
    !function(c, code) {
      // self test for sjis support.
      var test = stringToBytes(c);
      if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {
        throw 'sjis not supported.';
      }
    }('\\u53cb', 0x9746);

    var _bytes = stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return ~~(_bytes.length / 2);
    };

    _this.write = function(buffer) {

      var data = _bytes;

      var i = 0;

      while (i + 1 < data.length) {

        var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);

        if (0x8140 <= c && c <= 0x9FFC) {
          c -= 0x8140;
        } else if (0xE040 <= c && c <= 0xEBBF) {
          c -= 0xC140;
        } else {
          throw 'illegal char at ' + (i + 1) + '/' + c;
        }

        c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);

        buffer.put(c, 13);

        i += 2;
      }

      if (i < data.length) {
        throw 'illegal char at ' + (i + 1);
      }
    };

    return _this;
  };

  //=====================================================================
  // GIF Support etc.
  //

  //---------------------------------------------------------------------
  // byteArrayOutputStream
  //---------------------------------------------------------------------

  var byteArrayOutputStream = function() {

    var _bytes = [];

    var _this = {};

    _this.writeByte = function(b) {
      _bytes.push(b & 0xff);
    };

    _this.writeShort = function(i) {
      _this.writeByte(i);
      _this.writeByte(i >>> 8);
    };

    _this.writeBytes = function(b, off, len) {
      off = off || 0;
      len = len || b.length;
      for (var i = 0; i < len; i += 1) {
        _this.writeByte(b[i + off]);
      }
    };

    _this.writeString = function(s) {
      for (var i = 0; i < s.length; i += 1) {
        _this.writeByte(s.charCodeAt(i) );
      }
    };

    _this.toByteArray = function() {
      return _bytes;
    };

    _this.toString = function() {
      var s = '';
      s += '[';
      for (var i = 0; i < _bytes.length; i += 1) {
        if (i > 0) {
          s += ',';
        }
        s += _bytes[i];
      }
      s += ']';
      return s;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64EncodeOutputStream
  //---------------------------------------------------------------------

  var base64EncodeOutputStream = function() {

    var _buffer = 0;
    var _buflen = 0;
    var _length = 0;
    var _base64 = '';

    var _this = {};

    var writeEncoded = function(b) {
      _base64 += String.fromCharCode(encode(b & 0x3f) );
    };

    var encode = function(n) {
      if (n < 0) {
        // error.
      } else if (n < 26) {
        return 0x41 + n;
      } else if (n < 52) {
        return 0x61 + (n - 26);
      } else if (n < 62) {
        return 0x30 + (n - 52);
      } else if (n == 62) {
        return 0x2b;
      } else if (n == 63) {
        return 0x2f;
      }
      throw 'n:' + n;
    };

    _this.writeByte = function(n) {

      _buffer = (_buffer << 8) | (n & 0xff);
      _buflen += 8;
      _length += 1;

      while (_buflen >= 6) {
        writeEncoded(_buffer >>> (_buflen - 6) );
        _buflen -= 6;
      }
    };

    _this.flush = function() {

      if (_buflen > 0) {
        writeEncoded(_buffer << (6 - _buflen) );
        _buffer = 0;
        _buflen = 0;
      }

      if (_length % 3 != 0) {
        // padding
        var padlen = 3 - _length % 3;
        for (var i = 0; i < padlen; i += 1) {
          _base64 += '=';
        }
      }
    };

    _this.toString = function() {
      return _base64;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64DecodeInputStream
  //---------------------------------------------------------------------

  var base64DecodeInputStream = function(str) {

    var _str = str;
    var _pos = 0;
    var _buffer = 0;
    var _buflen = 0;

    var _this = {};

    _this.read = function() {

      while (_buflen < 8) {

        if (_pos >= _str.length) {
          if (_buflen == 0) {
            return -1;
          }
          throw 'unexpected end of file./' + _buflen;
        }

        var c = _str.charAt(_pos);
        _pos += 1;

        if (c == '=') {
          _buflen = 0;
          return -1;
        } else if (c.match(/^\\s$/) ) {
          // ignore if whitespace.
          continue;
        }

        _buffer = (_buffer << 6) | decode(c.charCodeAt(0) );
        _buflen += 6;
      }

      var n = (_buffer >>> (_buflen - 8) ) & 0xff;
      _buflen -= 8;
      return n;
    };

    var decode = function(c) {
      if (0x41 <= c && c <= 0x5a) {
        return c - 0x41;
      } else if (0x61 <= c && c <= 0x7a) {
        return c - 0x61 + 26;
      } else if (0x30 <= c && c <= 0x39) {
        return c - 0x30 + 52;
      } else if (c == 0x2b) {
        return 62;
      } else if (c == 0x2f) {
        return 63;
      } else {
        throw 'c:' + c;
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // gifImage (B/W)
  //---------------------------------------------------------------------

  var gifImage = function(width, height) {

    var _width = width;
    var _height = height;
    var _data = new Array(width * height);

    var _this = {};

    _this.setPixel = function(x, y, pixel) {
      _data[y * _width + x] = pixel;
    };

    _this.write = function(out) {

      //---------------------------------
      // GIF Signature

      out.writeString('GIF87a');

      //---------------------------------
      // Screen Descriptor

      out.writeShort(_width);
      out.writeShort(_height);

      out.writeByte(0x80); // 2bit
      out.writeByte(0);
      out.writeByte(0);

      //---------------------------------
      // Global Color Map

      // black
      out.writeByte(0x00);
      out.writeByte(0x00);
      out.writeByte(0x00);

      // white
      out.writeByte(0xff);
      out.writeByte(0xff);
      out.writeByte(0xff);

      //---------------------------------
      // Image Descriptor

      out.writeString(',');
      out.writeShort(0);
      out.writeShort(0);
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(0);

      //---------------------------------
      // Local Color Map

      //---------------------------------
      // Raster Data

      var lzwMinCodeSize = 2;
      var raster = getLZWRaster(lzwMinCodeSize);

      out.writeByte(lzwMinCodeSize);

      var offset = 0;

      while (raster.length - offset > 255) {
        out.writeByte(255);
        out.writeBytes(raster, offset, 255);
        offset += 255;
      }

      out.writeByte(raster.length - offset);
      out.writeBytes(raster, offset, raster.length - offset);
      out.writeByte(0x00);

      //---------------------------------
      // GIF Terminator
      out.writeString(';');
    };

    var bitOutputStream = function(out) {

      var _out = out;
      var _bitLength = 0;
      var _bitBuffer = 0;

      var _this = {};

      _this.write = function(data, length) {

        if ( (data >>> length) != 0) {
          throw 'length over';
        }

        while (_bitLength + length >= 8) {
          _out.writeByte(0xff & ( (data << _bitLength) | _bitBuffer) );
          length -= (8 - _bitLength);
          data >>>= (8 - _bitLength);
          _bitBuffer = 0;
          _bitLength = 0;
        }

        _bitBuffer = (data << _bitLength) | _bitBuffer;
        _bitLength = _bitLength + length;
      };

      _this.flush = function() {
        if (_bitLength > 0) {
          _out.writeByte(_bitBuffer);
        }
      };

      return _this;
    };

    var getLZWRaster = function(lzwMinCodeSize) {

      var clearCode = 1 << lzwMinCodeSize;
      var endCode = (1 << lzwMinCodeSize) + 1;
      var bitLength = lzwMinCodeSize + 1;

      // Setup LZWTable
      var table = lzwTable();

      for (var i = 0; i < clearCode; i += 1) {
        table.add(String.fromCharCode(i) );
      }
      table.add(String.fromCharCode(clearCode) );
      table.add(String.fromCharCode(endCode) );

      var byteOut = byteArrayOutputStream();
      var bitOut = bitOutputStream(byteOut);

      // clear code
      bitOut.write(clearCode, bitLength);

      var dataIndex = 0;

      var s = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;

      while (dataIndex < _data.length) {

        var c = String.fromCharCode(_data[dataIndex]);
        dataIndex += 1;

        if (table.contains(s + c) ) {

          s = s + c;

        } else {

          bitOut.write(table.indexOf(s), bitLength);

          if (table.size() < 0xfff) {

            if (table.size() == (1 << bitLength) ) {
              bitLength += 1;
            }

            table.add(s + c);
          }

          s = c;
        }
      }

      bitOut.write(table.indexOf(s), bitLength);

      // end code
      bitOut.write(endCode, bitLength);

      bitOut.flush();

      return byteOut.toByteArray();
    };

    var lzwTable = function() {

      var _map = {};
      var _size = 0;

      var _this = {};

      _this.add = function(key) {
        if (_this.contains(key) ) {
          throw 'dup key:' + key;
        }
        _map[key] = _size;
        _size += 1;
      };

      _this.size = function() {
        return _size;
      };

      _this.indexOf = function(key) {
        return _map[key];
      };

      _this.contains = function(key) {
        return typeof _map[key] != 'undefined';
      };

      return _this;
    };

    return _this;
  };

  var createDataURL = function(width, height, getPixel) {
    var gif = gifImage(width, height);
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        gif.setPixel(x, y, getPixel(x, y) );
      }
    }

    var b = byteArrayOutputStream();
    gif.write(b);

    var base64 = base64EncodeOutputStream();
    var bytes = b.toByteArray();
    for (var i = 0; i < bytes.length; i += 1) {
      base64.writeByte(bytes[i]);
    }
    base64.flush();

    return 'data:image/gif;base64,' + base64;
  };

  //---------------------------------------------------------------------
  // returns qrcode function.

  return qrcode;
}();

// multibyte support
!function() {

  qrcode.stringToBytesFuncs['UTF-8'] = function(s) {
    // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array
    function toUTF8Array(str) {
      var utf8 = [];
      for (var i=0; i < str.length; i++) {
        var charcode = str.charCodeAt(i);
        if (charcode < 0x80) utf8.push(charcode);
        else if (charcode < 0x800) {
          utf8.push(0xc0 | (charcode >> 6),
              0x80 | (charcode & 0x3f));
        }
        else if (charcode < 0xd800 || charcode >= 0xe000) {
          utf8.push(0xe0 | (charcode >> 12),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
        // surrogate pair
        else {
          i++;
          // UTF-16 encodes 0x10000-0x10FFFF by
          // subtracting 0x10000 and splitting the
          // 20 bits of 0x0-0xFFFFF into two halves
          charcode = 0x10000 + (((charcode & 0x3ff)<<10)
            | (str.charCodeAt(i) & 0x3ff));
          utf8.push(0xf0 | (charcode >>18),
              0x80 | ((charcode>>12) & 0x3f),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
      }
      return utf8;
    }
    return toUTF8Array(s);
  };

}();

(function (factory) {
  if (typeof define === 'function' && define.amd) {
      define([], factory);
  } else if (typeof exports === 'object') {
      module.exports = factory();
  }
}(function () {
    return qrcode;
}));
`;

/**
 * Renders the AMOLED Dark, responsive, bilingual (Persian & English)
 * dashboard with self-contained QR code generation and one-click Telegram connect.
 */
function renderTwpDashboard(hostname, secretHex) {
  const deepLink = "tg://webproxy?server=" + hostname + "&secret=" + secretHex;
  const webLink = "https://t.me/webproxy?server=" + hostname + "&secret=" + secretHex;

  const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>⚡ MAXIMUS TWP Core v2.2 | Telegram WEB Proxy</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Vazirmatn:wght@400;500;700;900&display=swap');

    :root {
      --bg: #000000;
      --card-bg: #0c0c0c;
      --widget-bg: #141414;
      --widget-border: #242424;
      --widget-hover: #383838;
      --accent-red: #D71921;
      --accent-red-glow: rgba(215, 25, 33, 0.3);
      --text: #ffffff;
      --text-muted: #a3a3a3;
      --text-dim: #777777;
      --mono-font: 'Space Mono', SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
      --main-font: 'Vazirmatn', -apple-system, BlinkMacSystemFont, 'Segoe UI', Tahoma, Arial, sans-serif;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
    }

    html, body {
      width: 100%;
      max-width: 100%;
      overflow-x: hidden;
    }

    body {
      background-color: var(--bg);
      background-image: radial-gradient(rgba(255, 255, 255, 0.12) 1px, transparent 1px);
      background-size: 16px 16px;
      color: var(--text);
      font-family: var(--main-font);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 1.5rem 1rem;
      line-height: 1.5;
    }

    [dir="ltr"] {
      --main-font: var(--mono-font);
    }

    /* Prevent Persian letters from disconnecting by clearing letter-spacing in RTL */
    [dir="rtl"] .detail-label,
    [dir="rtl"] .guide-header,
    [dir="rtl"] h1,
    [dir="rtl"] .desc,
    [dir="rtl"] .status-badge,
    [dir="rtl"] .qr-caption,
    [dir="rtl"] .btn-lbl {
      letter-spacing: normal !important;
      font-family: 'Vazirmatn', -apple-system, BlinkMacSystemFont, 'Segoe UI', Tahoma, Arial, sans-serif !important;
    }

    .container {
      width: 100%;
      max-width: 480px;
      margin: 0 auto;
      box-sizing: border-box;
    }

    /* Header Bar: Status & Language */
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
      gap: 0.75rem;
      width: 100%;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--card-bg);
      border: 1px solid var(--widget-border);
      padding: 0.4rem 0.85rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-family: var(--mono-font);
      color: var(--text-muted);
    }

    .pulse-dot {
      width: 8px;
      height: 8px;
      background: var(--accent-red);
      border-radius: 50%;
      box-shadow: 0 0 10px var(--accent-red-glow), 0 0 4px var(--accent-red);
      animation: pulse 2s infinite ease-in-out;
      flex-shrink: 0;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }

    .lang-toggle {
      display: inline-flex;
      background: var(--card-bg);
      border: 1px solid var(--widget-border);
      border-radius: 9999px;
      padding: 3px;
    }

    .lang-btn {
      background: transparent;
      border: none;
      color: var(--text-dim);
      padding: 0.3rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-family: var(--mono-font);
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .lang-btn.active {
      background: #ffffff;
      color: #000000;
    }

    /* Main Bento Card */
    .card {
      width: 100%;
      max-width: 100%;
      box-sizing: border-box;
      background: var(--card-bg);
      border: 1px solid var(--widget-border);
      border-radius: 24px;
      padding: 1.65rem 1.25rem;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.7);
      position: relative;
      overflow: hidden;
    }

    .card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 15%;
      right: 15%;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
    }

    .title-area {
      text-align: center;
      margin-bottom: 1.4rem;
    }

    /* MAXIMUS Deployer Bot Bento Banner */
    .channel-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      background: linear-gradient(135deg, rgba(215, 25, 33, 0.15) 0%, #141414 70%);
      border: 1px solid rgba(215, 25, 33, 0.4);
      border-radius: 18px;
      padding: 0.85rem 1rem;
      margin-bottom: 1.25rem;
      text-decoration: none;
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.6), 0 0 16px rgba(215, 25, 33, 0.15);
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      width: 100%;
      box-sizing: border-box;
      position: relative;
      overflow: hidden;
    }

    .channel-banner::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.3), transparent);
    }

    .channel-banner:hover {
      border-color: var(--accent-red);
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(215, 25, 33, 0.3);
      background: linear-gradient(135deg, rgba(215, 25, 33, 0.22) 0%, #181818 70%);
    }

    .channel-banner-left {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      min-width: 0;
      flex: 1;
    }

    .telegram-icon-box {
      width: 40px;
      height: 40px;
      background: var(--accent-red);
      color: #ffffff;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      box-shadow: 0 0 12px var(--accent-red-glow);
    }

    .channel-banner-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      text-align: right;
    }

    [dir="ltr"] .channel-banner-info {
      text-align: left;
    }

    .channel-banner-title {
      font-size: 0.925rem;
      font-weight: 800;
      font-family: var(--mono-font);
      color: #ffffff;
      letter-spacing: 0.05em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .channel-banner-sub {
      font-size: 0.72rem;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    [dir="rtl"] .channel-banner-sub {
      font-family: 'Vazirmatn', -apple-system, sans-serif !important;
      letter-spacing: normal !important;
    }

    .channel-banner-action {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: #ffffff;
      color: #000000;
      font-weight: 800;
      font-size: 0.75rem;
      padding: 0.4rem 0.85rem;
      border-radius: 9999px;
      flex-shrink: 0;
      transition: all 0.2s;
    }

    .channel-banner:hover .channel-banner-action {
      background: #f0f0f0;
      box-shadow: 0 0 10px rgba(255, 255, 255, 0.4);
    }

    .brand-tag {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      font-family: var(--mono-font);
      font-size: 0.7rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent-red);
      margin-bottom: 0.45rem;
      font-weight: 700;
      text-decoration: none;
      direction: ltr;
      padding: 0.2rem 0.6rem;
      background: rgba(215, 25, 33, 0.08);
      border: 1px solid rgba(215, 25, 33, 0.22);
      border-radius: 9999px;
      transition: all 0.2s ease;
    }

    .brand-tag:hover {
      background: rgba(215, 25, 33, 0.16);
      border-color: var(--accent-red);
      transform: translateY(-1px);
    }

    .brand-tag svg {
      flex-shrink: 0;
    }

    h1 {
      font-size: 1.25rem;
      font-weight: 900;
      letter-spacing: -0.01em;
      color: var(--text);
      margin-bottom: 0.4rem;
    }

    .desc {
      font-size: 0.8rem;
      color: var(--text-muted);
      line-height: 1.45;
    }

    /* MAXIMUS Primary Action Pill */
    .main-connect-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.6rem;
      width: 100%;
      height: 52px;
      background: #ffffff;
      color: #000000;
      border-radius: 9999px;
      text-decoration: none;
      font-weight: 700;
      font-size: 0.925rem;
      font-family: var(--main-font);
      margin-bottom: 1.15rem;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      border: 1px solid #ffffff;
      box-sizing: border-box;
    }

    .main-connect-btn:hover {
      background: #e6e6e6;
      transform: translateY(-1px);
      box-shadow: 0 8px 24px rgba(255, 255, 255, 0.15);
    }

    .main-connect-btn:active {
      transform: translateY(0);
    }

    /* Bento Link Boxes */
    .link-box {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      background: var(--widget-bg);
      border: 1px solid var(--widget-border);
      border-radius: 14px;
      padding: 0.65rem 0.85rem;
      margin-bottom: 0.65rem;
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      transition: border-color 0.2s;
    }

    .link-box:hover {
      border-color: var(--widget-hover);
    }

    .link-box code {
      font-family: var(--mono-font);
      font-size: 0.75rem;
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: ltr;
      text-align: left;
      flex: 1 1 0%;
      min-width: 0;
    }

    .btn-copy {
      background: transparent;
      border: 1px solid #333333;
      color: var(--text);
      border-radius: 9999px;
      padding: 0.35rem 0.8rem;
      font-size: 0.72rem;
      font-family: var(--mono-font);
      font-weight: 600;
      cursor: pointer;
      flex-shrink: 0;
      transition: all 0.2s;
      min-width: 68px;
      text-align: center;
    }

    .btn-copy:hover {
      border-color: #666666;
      background: rgba(255, 255, 255, 0.05);
    }

    .btn-copy.copied {
      background: var(--accent-red);
      border-color: var(--accent-red);
      color: #ffffff;
    }

    /* QR Code Widget */
    .qr-section {
      text-align: center;
      margin: 1.15rem 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 100%;
    }

    .qr-wrapper {
      background: #000000;
      padding: 12px;
      border: 1px solid var(--widget-border);
      border-radius: 18px;
      display: inline-block;
      box-shadow: inset 0 0 15px rgba(255, 255, 255, 0.02);
      max-width: 100%;
      box-sizing: border-box;
    }

    #qr-canvas {
      display: block;
      border-radius: 6px;
      max-width: 100%;
      height: auto;
    }

    .qr-caption {
      font-size: 0.725rem;
      color: var(--text-dim);
      font-family: var(--mono-font);
      margin-top: 0.55rem;
    }

    /* Bento Spec Grid - 100% Responsive with min-width: 0 */
    .details-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.65rem;
      margin-top: 1.15rem;
      width: 100%;
      box-sizing: border-box;
    }

    .detail-item {
      background: var(--widget-bg);
      border: 1px solid var(--widget-border);
      border-radius: 14px;
      padding: 0.75rem 0.85rem;
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-width: 0;
      overflow: hidden;
      box-sizing: border-box;
      transition: border-color 0.2s;
    }

    .detail-item:hover {
      border-color: var(--widget-hover);
    }

    /* Long domain and protocol span full card width for perfect responsiveness */
    .detail-item.span-2 {
      grid-column: span 2;
    }

    .detail-label {
      font-size: 0.68rem;
      color: var(--text-dim);
      font-family: var(--mono-font);
      text-transform: uppercase;
      margin-bottom: 0.25rem;
    }

    .detail-val {
      font-size: 0.8rem;
      font-weight: 700;
      font-family: var(--mono-font);
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: ltr;
      text-align: left;
      min-width: 0;
      width: 100%;
    }

    .proto-link {
      color: var(--text);
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: color 0.2s;
      max-width: 100%;
      min-width: 0;
    }

    .proto-link span {
      border-bottom: 1px dotted var(--text-dim);
      transition: border-color 0.2s;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .proto-link:hover {
      color: #ffffff;
    }

    .proto-link:hover span {
      border-bottom-color: var(--accent-red);
      color: var(--accent-red);
    }

    /* Guide Box */
    .guide-box {
      margin-top: 1.15rem;
      background: var(--widget-bg);
      border: 1px solid var(--widget-border);
      border-radius: 16px;
      padding: 0.9rem 1rem;
      font-size: 0.78rem;
      line-height: 1.6;
      color: var(--text-muted);
      width: 100%;
      box-sizing: border-box;
    }

    .guide-header {
      font-weight: 700;
      font-size: 0.8rem;
      color: var(--text);
      margin-bottom: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .guide-box ol {
      list-style: none;
      counter-reset: guide-counter;
    }

    .guide-box li {
      counter-increment: guide-counter;
      position: relative;
      padding-right: 1.6rem;
      margin-bottom: 0.4rem;
    }

    [dir="ltr"] .guide-box li {
      padding-right: 0;
      padding-left: 1.6rem;
    }

    .guide-box li::before {
      content: counter(guide-counter, decimal-leading-zero);
      position: absolute;
      right: 0;
      top: 0;
      font-family: var(--mono-font);
      font-size: 0.68rem;
      font-weight: 700;
      color: var(--accent-red);
    }

    [dir="ltr"] .guide-box li::before {
      right: auto;
      left: 0;
    }

    .guide-box li:last-child {
      margin-bottom: 0;
    }

    footer {
      text-align: center;
      margin-top: 1.4rem;
      font-size: 0.72rem;
      font-family: var(--mono-font);
      color: var(--text-dim);
      letter-spacing: 0.04em;
    }

    footer a {
      color: var(--text-muted);
      text-decoration: none;
      border-bottom: 1px dotted var(--text-dim);
      transition: all 0.2s;
    }

    footer a:hover {
      color: #ffffff;
      border-bottom-color: #ffffff;
    }

    @media (max-width: 440px) {
      body {
        padding: 0.85rem 0.6rem;
      }
      .card {
        padding: 1.25rem 0.85rem;
        border-radius: 20px;
      }
      .details-grid {
        grid-template-columns: 1fr;
      }
      .detail-item.span-2 {
        grid-column: span 1;
      }
      .qr-wrapper {
        padding: 8px;
      }
      #qr-canvas {
        width: 170px !important;
        height: 170px !important;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-bar">
      <div class="status-badge">
        <span class="pulse-dot"></span>
        <span id="txt-status">آنلاین • آماده اتصال</span>
      </div>
      <div class="lang-toggle">
        <button id="btn-fa" class="lang-btn active" onclick="setLang('fa')">FA</button>
        <button id="btn-en" class="lang-btn" onclick="setLang('en')">EN</button>
      </div>
    </div>

    <div class="card">
      <!-- MAXIMUS Deployer Bot Banner -->
      <a href="https://t.me/drfxtwp_bot" target="_blank" rel="noopener noreferrer" class="channel-banner">
        <div class="channel-banner-left">
          <div class="telegram-icon-box">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.75-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
            </svg>
          </div>
          <div class="channel-banner-info">
            <span class="channel-banner-title">MAXIMUS DEPLOYER BOT</span>
            <span class="channel-banner-sub" id="txt-channel-sub">ربات رسمی DrFXAi • ساخت پروکسی شخصی در چند ثانیه</span>
          </div>
        </div>
        <div class="channel-banner-action">
          <span id="txt-channel-join">شروع</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </div>
      </a>

      <div class="title-area">
        <h1 id="txt-title">⚡ وب‌پروکسی تلگرام (MAXIMUS TWP v2.2)</h1>
        <p class="desc" id="txt-desc">سرورلس روی لبه کلادفلر با فناوری رمزنگاری مستقیم و دانلود صفر-کپی</p>
      </div>

      <a href="${deepLink}" class="main-connect-btn">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.75-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
        </svg>
        <span id="txt-connect-btn">اتصال مستقیم به تلگرام</span>
      </a>

      <div class="link-box">
        <code>${deepLink}</code>
        <button class="btn-copy" onclick="copyText('${deepLink}', this)">
          <span class="btn-lbl" id="txt-copy-deep">کپی لینک</span>
        </button>
      </div>

      <div class="link-box">
        <code>${webLink}</code>
        <button class="btn-copy" onclick="copyText('${webLink}', this)">
          <span class="btn-lbl" id="txt-copy-web">اشتراک</span>
        </button>
      </div>

      <div class="qr-section">
        <div class="qr-wrapper">
          <canvas id="qr-canvas" width="200" height="200"></canvas>
        </div>
        <span class="qr-caption" id="txt-qr-caption">اسکن با دوربین گوشی جهت اتصال سریع</span>
      </div>

      <div class="details-grid">
        <div class="detail-item span-2">
          <div class="detail-label" id="lbl-server">سرور / دامنه</div>
          <div class="detail-val">${hostname}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label" id="lbl-port">پورت اتصال</div>
          <div class="detail-val">443 // TLS 1.3 // WSS</div>
        </div>
        <div class="detail-item">
          <div class="detail-label" id="lbl-enc">رمزنگاری داده</div>
          <div class="detail-val">Obfuscated2 (Zero-Copy)</div>
        </div>
        <div class="detail-item span-2">
          <div class="detail-label" id="lbl-proto">نوع پروتکل</div>
          <div class="detail-val">
            <a href="https://github.com/telegramdesktop/tproxy-server" target="_blank" rel="noopener noreferrer" class="proto-link">
              <span>Telegram WEB Proxy v1</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            </a>
          </div>
        </div>
      </div>

      <div class="guide-box">
        <div class="guide-header" id="txt-guide-title">راهنمای اتصال سریع:</div>
        <ol>
          <li id="txt-g1">روی دکمه «اتصال مستقیم به تلگرام» کلیک کنید تا پروکسی در اپلیکیشن باز شود.</li>
          <li id="txt-g2">در پنجره باز شده تلگرام، دکمه «Connect Proxy» را بزنید.</li>
          <li id="txt-g3">این پروتکل نیاز به هیچ اپلیکیشن جانبی یا فیلترشکن ندارد و مستقیم به شبکه لبه متصل می‌شود.</li>
        </ol>
      </div>
    </div>

    <footer>
      MAXIMUS TWP Core v2.2 • by DrFXAi • Powered by Cloudflare Workers • <a href="https://github.com/drfxai/TWP" target="_blank">GitHub</a>
    </footer>
  </div>

  <script>${qrLibCode}</script>
  <script>
    // QR Code rendering with the high-contrast monochrome MAXIMUS theme
    try {
      var qr = qrcode(0, 'M');
      qr.addData('${deepLink}');
      qr.make();
      var cv = document.getElementById('qr-canvas');
      var ctx = cv.getContext('2d');
      var n = qr.getModuleCount();
      var cell = Math.floor(200 / (n + 2));
      var off = Math.floor((200 - cell * n) / 2);
      ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, 200, 200);
      ctx.fillStyle = '#ffffff';
      for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(off + c * cell, off + r * cell, cell, cell);
    } catch(e) {}

    // Clipboard copy with robust fallback
    function copyText(str, btn) {
      function markCopied() {
        const lbl = btn.querySelector('.btn-lbl');
        const orig = lbl.getAttribute('data-orig') || lbl.innerText;
        lbl.setAttribute('data-orig', orig);
        btn.classList.add('copied');
        lbl.innerText = currentLang === 'fa' ? 'کپی شد!' : 'COPIED!';
        setTimeout(function() {
          btn.classList.remove('copied');
          lbl.innerText = lbl.getAttribute('data-orig') || orig;
        }, 2000);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(str).then(markCopied, function() {
          const ta = document.createElement('textarea');
          ta.value = str;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); } catch (e) {}
          document.body.removeChild(ta);
          markCopied();
        });
      } else {
        const ta = document.createElement('textarea');
        ta.value = str;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
        markCopied();
      }
    }

    // Bilingual i18n
    const i18n = {
      fa: {
        status: 'آنلاین • آماده اتصال',
        title: '⚡ وب‌پروکسی تلگرام (MAXIMUS TWP v2.2)',
        desc: 'سرورلس روی لبه کلادفلر با فناوری رمزنگاری مستقیم و دانلود صفر-کپی',
        channelSub: 'ربات رسمی DrFXAi • ساخت پروکسی شخصی در چند ثانیه',
        channelJoin: 'شروع',
        connectBtn: 'اتصال مستقیم به تلگرام',
        copyDeep: 'کپی لینک',
        copyWeb: 'اشتراک',
        qrCaption: 'اسکن با دوربین گوشی جهت اتصال سریع',
        server: 'سرور / دامنه',
        port: 'پورت اتصال',
        proto: 'نوع پروتکل',
        enc: 'رمزنگاری داده',
        guideTitle: 'راهنمای اتصال سریع:',
        g1: 'روی دکمه «اتصال مستقیم به تلگرام» کلیک کنید تا پروکسی در اپلیکیشن باز شود.',
        g2: 'در پنجره باز شده تلگرام، دکمه «Connect Proxy» را بزنید.',
        g3: 'این پروتکل نیاز به هیچ اپلیکیشن جانبی یا فیلترشکن ندارد و مستقیم به شبکه لبه متصل می‌شود.'
      },
      en: {
        status: 'ONLINE // READY',
        title: '⚡ Telegram WEB Proxy (MAXIMUS TWP v2.2)',
        desc: 'High-performance serverless relay on Cloudflare Workers with zero-copy downlink',
        channelSub: 'Official DrFXAi Bot • Deploy your own proxy in seconds',
        channelJoin: 'START',
        connectBtn: 'Direct Connect to Telegram',
        copyDeep: 'Copy Link',
        copyWeb: 'Share Link',
        qrCaption: 'Scan with camera to connect instantly',
        server: 'Server / Hostname',
        port: 'Port',
        proto: 'Protocol',
        enc: 'Encryption',
        guideTitle: 'Quick Setup Guide:',
        g1: 'Tap "Direct Connect to Telegram" to open the proxy in your client.',
        g2: 'In the Telegram modal prompt, tap "Connect Proxy".',
        g3: 'No third-party apps required; runs purely over serverless Anycast edge.'
      }
    };

    let currentLang = 'fa';

    function setLang(lang) {
      if (!i18n[lang]) return;
      currentLang = lang;
      const htmlEl = document.documentElement;
      htmlEl.setAttribute('lang', lang);
      htmlEl.setAttribute('dir', lang === 'fa' ? 'rtl' : 'ltr');

      document.getElementById('btn-fa').classList.toggle('active', lang === 'fa');
      document.getElementById('btn-en').classList.toggle('active', lang === 'en');

      const t = i18n[lang];
      document.getElementById('txt-status').innerText = t.status;
      document.getElementById('txt-title').innerText = t.title;
      document.getElementById('txt-desc').innerText = t.desc;
      if (document.getElementById('txt-channel-sub')) document.getElementById('txt-channel-sub').innerText = t.channelSub;
      if (document.getElementById('txt-channel-join')) document.getElementById('txt-channel-join').innerText = t.channelJoin;
      document.getElementById('txt-connect-btn').innerText = t.connectBtn;
      document.getElementById('txt-copy-deep').innerText = t.copyDeep;
      document.getElementById('txt-copy-web').innerText = t.copyWeb;
      document.getElementById('txt-qr-caption').innerText = t.qrCaption;
      document.getElementById('lbl-server').innerText = t.server;
      document.getElementById('lbl-port').innerText = t.port;
      document.getElementById('lbl-proto').innerText = t.proto;
      document.getElementById('lbl-enc').innerText = t.enc;
      document.getElementById('txt-guide-title').innerText = t.guideTitle;
      document.getElementById('txt-g1').innerText = t.g1;
      document.getElementById('txt-g2').innerText = t.g2;
      document.getElementById('txt-g3').innerText = t.g3;

      try { localStorage.setItem('twp_lang', lang); } catch(e) {}
    }

    try {
      const saved = localStorage.getItem('twp_lang');
      if (saved && (saved === 'fa' || saved === 'en')) {
        setLang(saved);
      }
    } catch(e) {}
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function renderNotFound() {
  const notFoundHtml = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>404 Not Found</title></head><body><h1>404 Not Found</h1></body></html>';
  return new Response(notFoundHtml, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function serveCamouflage(request, camouflageUrl) {
  try {
    const cleanHeaders = new Headers();
    const copyKeys = ['accept', 'accept-language', 'user-agent', 'cache-control', 'if-none-match', 'if-modified-since'];
    for (const k of copyKeys) {
      const val = request.headers.get(k);
      if (val) cleanHeaders.set(k, val);
    }
    return await fetch(camouflageUrl, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: cleanHeaders,
      redirect: 'follow',
    });
  } catch {
    return renderNotFound();
  }
}

// ==================================================================================
// 8. HTTP REQUEST ROUTER & EXPORT
// ==================================================================================

async function handleHttpRequest(request, env) {
  const config = await resolveConfig(env);
  if (!config) return renderNotFound();

  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase();

  // Route 1: Bridge Initializer
  if (url.pathname === '/' && request.method === 'GET' && /^\?bridge=[A-Za-z0-9_-]{43}$/.test(url.search)) {
    const providedCapability = url.search.slice(8);
    const providedBytes = textEncoder.encode(providedCapability);
    const contextBytes = textEncoder.encode(BRIDGE_DOMAIN_LABEL + hostname);

    const expectedFull = toBase64Url(await computeHmac(config.capabilityKey, contextBytes));
    let isValid = timingSafeEquals(providedBytes, textEncoder.encode(expectedFull));
    if (!isValid && config.isPadded) {
      const expected16 = toBase64Url(await computeHmac(config.capabilityKey16, contextBytes));
      isValid = timingSafeEquals(providedBytes, textEncoder.encode(expected16));
    }
    if (!isValid) {
      return renderNotFound();
    }
    const bootstrapToken = await issueStatelessToken(config, 1);
    return renderBridgeHtml(hostname, bootstrapToken, resolveMaxDials(env));
  }

  // Route 2: Browser Landing Page / Camouflage Mode
  if (url.pathname === '/' && request.method === 'GET' && !url.search) {
    const camouflageUrl = typeof env?.CAMOUFLAGE_URL === 'string' ? env.CAMOUFLAGE_URL.trim() : '';
    if (camouflageUrl) {
      return serveCamouflage(request, camouflageUrl);
    }
    const secretHex = toHex(config.fullBytes);
    return renderTwpDashboard(hostname, secretHex);
  }

  // Route 3: Session Lifecycle API
  if (url.pathname === '/api/v1/session') {
    if (request.method === 'POST') {
      const authBearer = extractBearerToken(request);
      const isBootstrapValid = await verifyStatelessToken(config, authBearer, 1, TOKEN_TTL_BOOTSTRAP);
      const isRenewalValid = isBootstrapValid || (await verifyStatelessToken(config, authBearer, 2, TOKEN_TTL_RENEWAL));
      if (!isRenewalValid) return renderNotFound();

      const declaredLength = parseInt(request.headers.get('Content-Length') || '0', 10);
      if (declaredLength > 64) return renderNotFound();

      const requestBody = new Uint8Array(await request.arrayBuffer());
      if (!timingSafeEquals(requestBody, HELLO_FRAME_BYTES)) return renderNotFound();

      return new Response(WELCOME_FRAME_BYTES, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Session-Token': await issueStatelessToken(config, 2),
          'X-Down-Cursor': '0',
          'X-Carrier-Mode': 'websocket',
        },
      });
    }

    if (request.method === 'DELETE') {
      const authBearer = extractBearerToken(request);
      if (!(await verifyStatelessToken(config, authBearer, 2, TOKEN_TTL_RENEWAL))) {
        return renderNotFound();
      }
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }

    return renderNotFound();
  }

  // Route 4: Multiplexed WebSocket Upgrade
  if (
    url.pathname === '/api/v1/ws' &&
    request.method === 'GET' &&
    (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket'
  ) {
    const rawProtocols = request.headers.get('Sec-WebSocket-Protocol') || '';
    const subprotocols = rawProtocols.split(',').map((p) => p.trim());
    let tokenMatch = null;
    let selectedProtocol = '';
    for (const sp of subprotocols) {
      const match = /^tproxy-v1\.([A-Za-z0-9_-]{43})$/.exec(sp);
      if (match) {
        tokenMatch = match[1];
        selectedProtocol = sp;
        break;
      }
    }
    if (!tokenMatch || !(await verifyStatelessToken(config, tokenMatch, 2, TOKEN_TTL_SESSION))) {
      return renderNotFound();
    }

    const pair = new WebSocketPair();
    const [clientSocket, serverSocket] = Object.values(pair);
    try { serverSocket.binaryType = 'arraybuffer'; } catch {}
    serverSocket.accept();

    handleCarrierSession(serverSocket, config, {
      maxDials: resolveMaxDials(env),
      pingMs: CARRIER_PING_MS,
    });

    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
      headers: { 'Sec-WebSocket-Protocol': selectedProtocol },
    });
  }

  return renderNotFound();
}

export function getTwpInternals() {
  return {
    TELEGRAM_DCS,
    HELLO_FRAME_BYTES,
    WELCOME_FRAME_BYTES,
    FRAME_OPEN,
    FRAME_DATA,
    FRAME_CLOSE,
    FRAME_WINDOW,
    FRAME_PING,
    FRAME_PONG,
    FRAME_HELLO,
    FRAME_WELCOME,
    FRAME_BYE,
    toHex,
    parseHex,
    toBase64Url,
    fromBase64Url,
    concatArrays,
    reverseBytes,
    incrementCounter128,
    packFrame,
    packFrameBatch,
    unpackFrameBatch,
    validateClientFrame,
    createAesCtrCipher,
    applyAesCtr,
    resolveConfig,
    issueStatelessToken,
    verifyStatelessToken,
    normalizeDcId,
    parseClientHandshake,
    generateDcHandshake,
    connectToDatacenter,
    safeCloseSocket,
    handleHttpRequest,
  };
}

export default {
  async fetch(request, env) {
    try {
      return await handleHttpRequest(request, env);
    } catch {
      return renderNotFound();
    }
  },
};
