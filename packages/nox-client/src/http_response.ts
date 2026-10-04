/**
 * The exit's reply to a `ServiceRequest::HttpRequest`: nox-node's
 * `SerializableHttpResponse { status: u16, headers: HashMap<String, String>,
 * body: Vec<u8>, truncated: bool }` (crates/nox-node/src/services/handlers/http.rs),
 * serialized with bincode 1 defaults: fixed-width little-endian integers and
 * u64 lengths.
 */
import { NoxClientError, NoxClientErrorCode } from "./types.js";

export interface DecodedHttpResponse {
  /** The upstream status, or the exit's own refusal (400 scheme, 403 SSRF, 502 upstream). */
  status: number;
  /**
   * Header pairs in wire order. The exit keeps headers in a map, so names are
   * unique and their order carries no meaning.
   */
  headers: [string, string][];
  body: Uint8Array;
  /** True when the exit cut the body at its `max_response_bytes`. */
  truncated: boolean;
}

const MALFORMED = "malformed exit HTTP reply";

/** Decode the bytes `NoxClient.httpRequest` returns. Throws `DECRYPTION_FAILED`. */
export function decodeHttpResponse(bytes: Uint8Array): DecodedHttpResponse {
  const reader = new ReplyReader(bytes);
  const status = reader.u16();
  const count = reader.u64();
  const headers: [string, string][] = [];
  for (let index = 0n; index < count; index++) {
    headers.push([reader.utf8(), reader.utf8()]);
  }
  const body = reader.bytes();
  const flag = reader.u8();
  if (flag > 1) throw malformed(`truncated flag byte ${flag} is not a bool`);
  if (!reader.atEnd()) throw malformed(`${reader.remaining()} trailing bytes`);
  return { status, headers, body, truncated: flag === 1 };
}

class ReplyReader {
  private offset = 0;
  private readonly view: DataView;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly buffer: Uint8Array) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.offset++);
  }

  u16(): number {
    this.need(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u64(): bigint {
    this.need(8);
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  bytes(): Uint8Array {
    const length = this.u64();
    if (length > BigInt(this.remaining())) {
      throw malformed(`length ${length} exceeds the ${this.remaining()} bytes left`);
    }
    const size = Number(length);
    const out = this.buffer.slice(this.offset, this.offset + size);
    this.offset += size;
    return out;
  }

  utf8(): string {
    const raw = this.bytes();
    try {
      return this.decoder.decode(raw);
    } catch (error) {
      throw malformed("a header is not UTF-8", error);
    }
  }

  remaining(): number {
    return this.buffer.length - this.offset;
  }

  atEnd(): boolean {
    return this.offset === this.buffer.length;
  }

  private need(count: number): void {
    if (this.offset + count > this.buffer.length) {
      throw malformed(`ends at byte ${this.buffer.length}, needs ${count} more at ${this.offset}`);
    }
  }
}

function malformed(detail: string, cause?: unknown): NoxClientError {
  return new NoxClientError(`${MALFORMED}: ${detail}`, NoxClientErrorCode.DecryptionFailed, cause);
}
