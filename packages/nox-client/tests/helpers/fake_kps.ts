/**
 * In-memory KPS network for tests: a dialer typed like anon-rpc SPEC §10 and a
 * fake KPS-HTTP/1 server per address that parses each request and answers with
 * a scripted reply. Streams are WHATWG stream pairs, so the client code under
 * test runs exactly as it would against `anonRpcWorker.kps`.
 */
import { createHash } from "node:crypto";
import type { KpsConnLike, KpsDial, KpsReason, KpsStreamLike } from "../../src/types.js";

type CloseInfo = { ok: boolean; reason?: KpsReason };

/** Deterministic, well-formed certhash for a label. */
export function certhashFor(label: string): string {
  const digest = createHash("sha256").update(label).digest();
  return `u${Buffer.concat([Buffer.from([0x12, 0x20]), digest]).toString("base64url")}`;
}

/** `<ip>:<port>:<certhash>` for test node `index`. */
export function kpsAddressFor(index: number, port = 15005): string {
  return `10.0.0.${index}:${port}:${certhashFor(`node-${index}`)}`;
}

export interface FakeRequest {
  readonly address: string;
  readonly method: string;
  readonly path: string;
  readonly headers: [string, string][];
  readonly body: Uint8Array;
  readonly raw: Uint8Array;
}

export type FakeReply =
  | {
      status: number;
      reason?: string;
      headers?: [string, string][];
      body?: Uint8Array | string;
      /** Default true: send Content-Length for the body. */
      contentLength?: boolean;
    }
  | { raw: Uint8Array | string }
  | { hang: true };

export type FakeHandler = (request: FakeRequest) => FakeReply | Promise<FakeReply>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBytes(value: Uint8Array | string | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array(0);
  return typeof value === "string" ? encoder.encode(value) : value;
}

export class FakeConnection implements KpsConnLike {
  readonly closed: Promise<CloseInfo>;
  private readonly settle: (info: CloseInfo) => void;
  private readonly abortStreams = new Set<(reason: unknown) => void>();
  open = true;
  streamsOpened = 0;
  /** When set, openStream never resolves (models kps ISSUES #14). */
  hangOpenStream = false;

  constructor(
    readonly address: string,
    private readonly network: FakeKpsNetwork,
  ) {
    const done = deferred<CloseInfo>();
    this.closed = done.promise;
    this.settle = done.resolve;
  }

  async openStream(opts?: { signal?: AbortSignal }): Promise<KpsStreamLike> {
    if (!this.open) throw Object.assign(new Error("connection closed"), { code: "closed" });
    if (this.hangOpenStream) {
      return new Promise<KpsStreamLike>((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
      });
    }
    this.streamsOpened += 1;
    this.network.streamsOpened += 1;
    const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
    const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
    const streamClosed = deferred<CloseInfo>();
    const serverWriter = serverToClient.writable.getWriter();
    const abort = (reason: unknown): void => {
      void serverWriter.abort(reason).catch(() => {});
      streamClosed.resolve({ ok: false, reason: { code: "reset" } });
    };
    this.abortStreams.add(abort);
    const stream: KpsStreamLike = {
      readable: serverToClient.readable,
      writable: clientToServer.writable,
      closeWrite: async () => {
        await clientToServer.writable.close();
      },
      cancelRead: async () => {
        await serverToClient.readable.cancel().catch(() => {});
      },
      resetWrite: async () => {
        await clientToServer.writable.abort().catch(() => {});
      },
      close: async () => {
        this.network.streamsClosed += 1;
        this.abortStreams.delete(abort);
        streamClosed.resolve({ ok: true });
      },
      closed: streamClosed.promise,
    };
    void this.network.serve(this, clientToServer.readable, serverWriter, abort);
    return stream;
  }

  async close(): Promise<void> {
    this.shutdown({ ok: true });
  }

  /** Simulate the peer or the path dying. */
  kill(): void {
    this.shutdown({ ok: false, reason: { code: "network-error", message: "peer gone" } });
  }

  private shutdown(info: CloseInfo): void {
    if (!this.open) return;
    this.open = false;
    for (const abort of [...this.abortStreams]) abort(new Error("connection closed"));
    this.abortStreams.clear();
    this.settle(info);
  }
}

export class FakeKpsNetwork {
  readonly dials: string[] = [];
  readonly requests: FakeRequest[] = [];
  readonly connections: FakeConnection[] = [];
  streamsOpened = 0;
  streamsClosed = 0;
  /** Addresses whose dial rejects with network-error. */
  readonly refuse = new Set<string>();
  /** Addresses whose dial never resolves (until aborted). */
  readonly hangDial = new Set<string>();
  private readonly handlers = new Map<string, FakeHandler>();
  private fallback: FakeHandler | undefined;

  /** Dialer typed like `(a, o) => anonRpcWorker.kps.dial(a, o)`. */
  readonly dial: KpsDial = async (address, opts) => {
    this.dials.push(address);
    if (this.hangDial.has(address)) {
      return new Promise<KpsConnLike>((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
      });
    }
    if (this.refuse.has(address)) {
      throw Object.assign(new Error(`dial ${address} refused`), { code: "network-error" });
    }
    const conn = new FakeConnection(address, this);
    this.connections.push(conn);
    return conn;
  };

  /** Answer requests to `address` (or every address when omitted). */
  route(address: string | undefined, handler: FakeHandler): void {
    if (address === undefined) this.fallback = handler;
    else this.handlers.set(address, handler);
  }

  async serve(
    conn: FakeConnection,
    readable: ReadableStream<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    abort: (reason: unknown) => void,
  ): Promise<void> {
    const raw = await readAll(readable);
    if (raw === null) return;
    const request = parseRequest(conn.address, raw);
    this.requests.push(request);
    const handler = this.handlers.get(conn.address) ?? this.fallback;
    const reply: FakeReply = handler === undefined
      ? { status: 404, body: "no route" }
      : await handler(request);
    if ("hang" in reply) return;
    try {
      if ("raw" in reply) {
        await writer.write(toBytes(reply.raw));
      } else {
        const body = toBytes(reply.body);
        const lines = [`HTTP/1.1 ${reply.status} ${reply.reason ?? "OK"}`];
        for (const [name, value] of reply.headers ?? []) lines.push(`${name}: ${value}`);
        if (reply.contentLength !== false) lines.push(`Content-Length: ${body.length}`);
        await writer.write(encoder.encode(`${lines.join("\r\n")}\r\n\r\n`));
        if (body.length > 0) await writer.write(body);
      }
      await writer.close();
    } catch (error) {
      abort(error);
    }
  }
}

async function readAll(readable: ReadableStream<Uint8Array>): Promise<Uint8Array | null> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function parseRequest(address: string, raw: Uint8Array): FakeRequest {
  let end = -1;
  for (let i = 0; i + 3 < raw.length; i++) {
    if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("fake ingress: request without a head terminator");
  const lines = decoder.decode(raw.subarray(0, end)).split("\r\n");
  const [method = "", path = ""] = (lines[0] ?? "").split(" ");
  const headers = lines.slice(1).map((line): [string, string] => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  });
  return { address, method, path, headers, body: raw.slice(end + 4), raw };
}

/** JSON reply helper. */
export function json(status: number, value: unknown): FakeReply {
  return {
    status,
    headers: [["content-type", "application/json"]],
    body: JSON.stringify(value),
  };
}
