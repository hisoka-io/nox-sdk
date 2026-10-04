// Echo exchange over one KPS stream, shared by the host page (direct
// @kpstreams/webrtc-client) and the probe worker (anonRpcWorker.kps).
// The reader runs concurrently with the writer: KPS flow control (1 MiB per
// stream by default) would otherwise deadlock an echo larger than the window.

export interface ByteStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

export interface EchoSample {
  readonly bytes: number;
  readonly ms: number;
  readonly ok: boolean;
  readonly error?: string;
}

/** Deterministic payload: byte i is (31 * i + seed) mod 256. */
export function patternBytes(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (31 * i + seed) & 0xff;
  return out;
}

export async function readToEnd(readable: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`stream returned more than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** Write `size` pattern bytes, half-close, read the echo to EOF and compare. */
export async function echoOverStream(stream: ByteStream, size: number, seed: number): Promise<EchoSample> {
  const started = performance.now();
  const payload = patternBytes(size, seed);
  try {
    const echoed = readToEnd(stream.readable, size);
    // Observed below; keeps a read failure from becoming an unhandled rejection
    // when the write fails first.
    echoed.catch(() => undefined);
    const writer = stream.writable.getWriter();
    if (size > 0) await writer.write(payload);
    await writer.close();
    const got = await echoed;
    let ok = got.byteLength === size;
    for (let i = 0; ok && i < size; i++) ok = got[i] === payload[i];
    const ms = Math.round(performance.now() - started);
    return ok
      ? { bytes: size, ms, ok }
      : { bytes: size, ms, ok, error: `echo mismatch: sent ${size} bytes, got ${got.byteLength}` };
  } catch (error) {
    return { bytes: size, ms: Math.round(performance.now() - started), ok: false, error: describe(error) };
  }
}
