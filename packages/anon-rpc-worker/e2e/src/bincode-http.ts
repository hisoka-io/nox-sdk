// Decoder for the exit's HttpRequest reply, `SerializableHttpResponse`
// (crates/nox-node/src/services/handlers/http.rs), as returned raw by the SDK's
// NoxClient.httpRequest(). Encoding is bincode 1.x defaults: little-endian,
// fixed-width integers, u64 length prefixes.

import { TestbedError } from "./errors.js";

export interface ExitHttpResponse {
  readonly status: number;
  /** HashMap on the exit: order and duplicate names are not preserved. */
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Uint8Array;
  readonly truncated: boolean;
}

class Reader {
  #offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  #take(count: number, what: string): Uint8Array {
    if (this.#offset + count > this.bytes.length) {
      throw new TestbedError(
        "decode",
        `SerializableHttpResponse: ${what} needs ${count} bytes at offset ${this.#offset}, ${this.bytes.length - this.#offset} left`,
      );
    }
    const out = this.bytes.subarray(this.#offset, this.#offset + count);
    this.#offset += count;
    return out;
  }

  u16(what: string): number {
    const b = this.#take(2, what);
    return (b[0] ?? 0) | ((b[1] ?? 0) << 8);
  }

  u64(what: string): number {
    const b = this.#take(8, what);
    let value = 0n;
    for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(b[i] ?? 0);
    if (value > BigInt(this.bytes.length)) {
      throw new TestbedError("decode", `SerializableHttpResponse: ${what} length ${value} exceeds the payload`);
    }
    return Number(value);
  }

  bool(what: string): boolean {
    const b = this.#take(1, what)[0];
    if (b !== 0 && b !== 1) throw new TestbedError("decode", `SerializableHttpResponse: ${what} is ${String(b)}, not 0/1`);
    return b === 1;
  }

  bytesWithLength(what: string): Uint8Array {
    return this.#take(this.u64(`${what} length`), what).slice();
  }

  string(what: string): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.bytesWithLength(what));
  }

  finish(): void {
    if (this.#offset !== this.bytes.length) {
      throw new TestbedError(
        "decode",
        `SerializableHttpResponse: ${this.bytes.length - this.#offset} trailing bytes after the struct`,
      );
    }
  }
}

export function decodeExitHttpResponse(bytes: Uint8Array): ExitHttpResponse {
  const reader = new Reader(bytes);
  const status = reader.u16("status");
  const headerCount = reader.u64("header count");
  const headers = new Map<string, string>();
  for (let i = 0; i < headerCount; i++) {
    const name = reader.string(`header ${i} name`);
    headers.set(name, reader.string(`header ${i} value`));
  }
  const body = reader.bytesWithLength("body");
  const truncated = reader.bool("truncated");
  reader.finish();
  return { status, headers, body, truncated };
}

/** Encoder mirror of the exit's bincode layout, used by unit tests. */
export function encodeExitHttpResponse(response: ExitHttpResponse): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const u64 = (value: number): Uint8Array => {
    const out = new Uint8Array(8);
    let rest = BigInt(value);
    for (let i = 0; i < 8; i++) {
      out[i] = Number(rest & 0xffn);
      rest >>= 8n;
    }
    return out;
  };
  parts.push(new Uint8Array([response.status & 0xff, (response.status >> 8) & 0xff]));
  parts.push(u64(response.headers.size));
  for (const [name, value] of response.headers) {
    const n = encoder.encode(name);
    const v = encoder.encode(value);
    parts.push(u64(n.length), n, u64(v.length), v);
  }
  parts.push(u64(response.body.length), response.body, new Uint8Array([response.truncated ? 1 : 0]));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
