import { NoxClientError, NoxClientErrorCode } from "./types.js";
import type { FecInfo } from "./fragmentation.js";

export const PAYLOAD_VERSION = 1;

export type RelayerPayload =
  | { tag: "SubmitTransaction"; to: Uint8Array; data: Uint8Array }
  | { tag: "Dummy"; padding: Uint8Array }
  | { tag: "Heartbeat"; id: bigint; timestamp: bigint }
  | { tag: "Fragment"; frag: FragmentWire }
  | { tag: "AnonymousRequest"; inner: Uint8Array; replySurbs: Uint8Array[] }
  | { tag: "ServiceResponse"; requestId: bigint; fragment: FragmentWire }
  | { tag: "NeedMoreSurbs"; requestId: bigint; fragmentsRemaining: number };

export type ServiceRequest =
  | { tag: "Echo"; data: Uint8Array }
  | {
      tag: "HttpRequest";
      method: string;
      url: string;
      headers: [string, string][];
      body: Uint8Array;
    }
  | {
      tag: "RpcRequest";
      method: string;
      params: Uint8Array;
      id: bigint;
      rpcUrl: string | null;
    }
  | { tag: "SubmitTransaction"; to: Uint8Array; data: Uint8Array }
  | {
      tag: "BroadcastSignedTransaction";
      signedTx: Uint8Array;
      rpcUrl: string | null;
      rpcMethod: string | null;
    }
  | { tag: "ReplenishSurbs"; requestId: bigint; surbs: Uint8Array[] };

export interface FragmentWire {
  messageId: bigint;
  totalFragments: number;
  sequence: number;
  data: Uint8Array;
  fec: FecInfo | null;
}

/** Encode a `ServiceRequest` with the version prefix byte. */
export function encodeServiceRequest(req: ServiceRequest): Uint8Array {
  const w = new Writer();
  w.u8(PAYLOAD_VERSION);
  writeServiceRequest(w, req);
  return w.finish();
}

/** Encode a `RelayerPayload` with the version prefix byte. */
export function encodeRelayerPayload(payload: RelayerPayload): Uint8Array {
  const w = new Writer();
  w.u8(PAYLOAD_VERSION);
  writeRelayerPayload(w, payload);
  return w.finish();
}

/** Decode a versioned wire payload into a `RelayerPayload`. */
export function decodeRelayerPayload(bytes: Uint8Array): RelayerPayload {
  checkVersion(bytes);
  const r = new Reader(bytes, 1);
  return readRelayerPayload(r);
}

/** Decode a versioned wire payload into a `ServiceRequest`. */
export function decodeServiceRequest(bytes: Uint8Array): ServiceRequest {
  checkVersion(bytes);
  const r = new Reader(bytes, 1);
  return readServiceRequest(r);
}

function checkVersion(bytes: Uint8Array): void {
  if (bytes.length === 0) {
    throw new NoxClientError(
      "Cannot decode empty payload bytes",
      NoxClientErrorCode.DecryptionFailed,
    );
  }
  const ver = bytes[0]!;
  if (ver !== PAYLOAD_VERSION) {
    throw new NoxClientError(
      `Unsupported payload version ${ver} (expected ${PAYLOAD_VERSION})`,
      NoxClientErrorCode.DecryptionFailed,
    );
  }
}

class Writer {
  private readonly chunks: Uint8Array[] = [];
  private totalLen = 0;

  u8(v: number): void {
    this.raw(new Uint8Array([v & 0xff]));
  }

  u32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.raw(b);
  }

  u64(v: bigint): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    this.raw(b);
  }

  bytes(v: Uint8Array): void {
    this.u64(BigInt(v.length));
    if (v.length > 0) this.raw(v);
  }

  fixedBytes(v: Uint8Array): void {
    if (v.length > 0) this.raw(v);
  }

  string(v: string): void {
    this.bytes(new TextEncoder().encode(v));
  }

  optString(v: string | null): void {
    if (v === null) {
      this.u8(0);
    } else {
      this.u8(1);
      this.string(v);
    }
  }

  private raw(chunk: Uint8Array): void {
    this.chunks.push(new Uint8Array(chunk));
    this.totalLen += chunk.length;
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.totalLen);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

class Reader {
  private pos: number;
  private readonly view: DataView;
  private readonly buf: Uint8Array;

  constructor(bytes: Uint8Array, offset = 0) {
    this.buf = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = offset;
  }

  private ensure(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new NoxClientError(
        `Unexpected end of payload at offset ${this.pos} (need ${n} more bytes, have ${this.buf.length - this.pos})`,
        NoxClientErrorCode.DecryptionFailed,
      );
    }
  }

  u8(): number {
    this.ensure(1);
    return this.view.getUint8(this.pos++);
  }

  u32(): number {
    this.ensure(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  u64(): bigint {
    this.ensure(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }

  bytes(): Uint8Array {
    const len = Number(this.u64());
    this.ensure(len);
    const slice = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  fixedBytes(n: number): Uint8Array {
    this.ensure(n);
    const slice = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  string(): string {
    return new TextDecoder().decode(this.bytes());
  }

  optString(): string | null {
    return this.u8() === 0 ? null : this.string();
  }
}

function writeFragmentWire(w: Writer, f: FragmentWire): void {
  w.u64(f.messageId);
  w.u32(f.totalFragments);
  w.u32(f.sequence);
  w.bytes(f.data);
  if (f.fec === null) {
    w.u8(0);
  } else {
    w.u8(1);
    w.u32(f.fec.dataShardCount);
    w.u64(BigInt(f.fec.originalDataLen));
  }
}

function readFragmentWire(r: Reader): FragmentWire {
  const messageId = r.u64();
  const totalFragments = r.u32();
  const sequence = r.u32();
  const data = r.bytes();
  const fecTag = r.u8();
  const fec: FecInfo | null =
    fecTag === 1
      ? { dataShardCount: r.u32(), originalDataLen: Number(r.u64()) }
      : null;
  return { messageId, totalFragments, sequence, data, fec };
}

// SURBs are opaque bincode blobs from WASM - written inline (no length prefix)
function writeSurbOpaque(w: Writer, surb: Uint8Array): void {
  w.fixedBytes(surb);
}

function writeRelayerPayload(w: Writer, p: RelayerPayload): void {
  switch (p.tag) {
    case "SubmitTransaction":
      w.u32(0);
      assertLen(p.to, 20, "RelayerPayload.SubmitTransaction.to");
      w.fixedBytes(p.to);
      w.bytes(p.data);
      return;
    case "Dummy":
      w.u32(1);
      w.bytes(p.padding);
      return;
    case "Heartbeat":
      w.u32(2);
      w.u64(p.id);
      w.u64(p.timestamp);
      return;
    case "Fragment":
      w.u32(3);
      writeFragmentWire(w, p.frag);
      return;
    case "AnonymousRequest":
      w.u32(4);
      w.bytes(p.inner);
      w.u64(BigInt(p.replySurbs.length));
      for (const surb of p.replySurbs) writeSurbOpaque(w, surb);
      return;
    case "ServiceResponse":
      w.u32(5);
      w.u64(p.requestId);
      writeFragmentWire(w, p.fragment);
      return;
    case "NeedMoreSurbs":
      w.u32(6);
      w.u64(p.requestId);
      w.u32(p.fragmentsRemaining);
      return;
  }
}

function readRelayerPayload(r: Reader): RelayerPayload {
  const variant = r.u32();
  switch (variant) {
    case 0:
      return { tag: "SubmitTransaction", to: r.fixedBytes(20), data: r.bytes() };
    case 1:
      return { tag: "Dummy", padding: r.bytes() };
    case 2:
      return { tag: "Heartbeat", id: r.u64(), timestamp: r.u64() };
    case 3:
      return { tag: "Fragment", frag: readFragmentWire(r) };
    case 4: {
      // Client only encodes this variant; decoding non-empty SURBs not implemented
      const inner = r.bytes();
      const count = Number(r.u64());
      if (count > 0) {
        throw new NoxClientError(
          "Cannot decode AnonymousRequest with non-empty reply_surbs in TypeScript " +
          "(inline Surb struct parsing not implemented - client only encodes this variant)",
          NoxClientErrorCode.DecryptionFailed,
        );
      }
      return { tag: "AnonymousRequest", inner, replySurbs: [] };
    }
    case 5:
      return {
        tag: "ServiceResponse",
        requestId: r.u64(),
        fragment: readFragmentWire(r),
      };
    case 6:
      return {
        tag: "NeedMoreSurbs",
        requestId: r.u64(),
        fragmentsRemaining: r.u32(),
      };
    default:
      throw new NoxClientError(
        `Unknown RelayerPayload variant index ${variant}`,
        NoxClientErrorCode.DecryptionFailed,
      );
  }
}

function writeServiceRequest(w: Writer, req: ServiceRequest): void {
  switch (req.tag) {
    case "Echo":
      w.u32(0);
      w.bytes(req.data);
      return;
    case "HttpRequest":
      w.u32(1);
      w.string(req.method);
      w.string(req.url);
      w.u64(BigInt(req.headers.length));
      for (const [k, v] of req.headers) {
        w.string(k);
        w.string(v);
      }
      w.bytes(req.body);
      return;
    case "RpcRequest":
      w.u32(2);
      w.string(req.method);
      w.bytes(req.params);
      w.u64(req.id);
      w.optString(req.rpcUrl);
      return;
    case "SubmitTransaction":
      w.u32(3);
      assertLen(req.to, 20, "ServiceRequest.SubmitTransaction.to");
      w.fixedBytes(req.to);
      w.bytes(req.data);
      return;
    case "BroadcastSignedTransaction":
      w.u32(4);
      w.bytes(req.signedTx);
      w.optString(req.rpcUrl);
      w.optString(req.rpcMethod);
      return;
    case "ReplenishSurbs":
      w.u32(5);
      w.u64(req.requestId);
      w.u64(BigInt(req.surbs.length));
      for (const surb of req.surbs) writeSurbOpaque(w, surb);
      return;
  }
}

function readServiceRequest(r: Reader): ServiceRequest {
  const variant = r.u32();
  switch (variant) {
    case 0:
      return { tag: "Echo", data: r.bytes() };
    case 1: {
      const method = r.string();
      const url = r.string();
      const headerCount = Number(r.u64());
      const headers: [string, string][] = [];
      for (let i = 0; i < headerCount; i++) headers.push([r.string(), r.string()]);
      return { tag: "HttpRequest", method, url, headers, body: r.bytes() };
    }
    case 2:
      return {
        tag: "RpcRequest",
        method: r.string(),
        params: r.bytes(),
        id: r.u64(),
        rpcUrl: r.optString(),
      };
    case 3:
      return { tag: "SubmitTransaction", to: r.fixedBytes(20), data: r.bytes() };
    case 4:
      return {
        tag: "BroadcastSignedTransaction",
        signedTx: r.bytes(),
        rpcUrl: r.optString(),
        rpcMethod: r.optString(),
      };
    case 5: {
      const requestId = r.u64();
      const count = Number(r.u64());
      if (count > 0) {
        throw new NoxClientError(
          "Cannot decode ReplenishSurbs with non-empty surbs in TypeScript " +
          "(inline Surb struct parsing not implemented - client only encodes this variant)",
          NoxClientErrorCode.DecryptionFailed,
        );
      }
      return { tag: "ReplenishSurbs", requestId, surbs: [] };
    }
    default:
      throw new NoxClientError(
        `Unknown ServiceRequest variant index ${variant}`,
        NoxClientErrorCode.DecryptionFailed,
      );
  }
}

export interface RpcResponse {
  id: bigint;
  result: { ok: true; data: Uint8Array } | { ok: false; error: string };
}

/** Decode a bincode-serialized `RpcResponse`. */
export function decodeRpcResponse(bytes: Uint8Array): RpcResponse {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  const id = view.getBigUint64(offset, true);
  offset += 8;

  const tag = view.getUint32(offset, true);
  offset += 4;

  const len = Number(view.getBigUint64(offset, true));
  offset += 8;
  const payload = bytes.slice(offset, offset + len);

  if (tag === 0) {
    return { id, result: { ok: true, data: payload } };
  } else {
    const error = new TextDecoder().decode(payload);
    return { id, result: { ok: false, error } };
  }
}

function assertLen(v: Uint8Array, expected: number, name: string): void {
  if (v.length !== expected) {
    throw new NoxClientError(
      `${name} must be exactly ${expected} bytes, got ${v.length}`,
      NoxClientErrorCode.PacketBuildFailed,
    );
  }
}
