/**
 * A Nox network in memory, reached through a SPEC §10 `kps` capability:
 * every pinned node answers KPS-HTTP/1 exchanges (one per stream) for
 * `/topology`, `/health`, `/api/v1/packets` and `/api/v1/responses/claim`,
 * like `nox-kps` in front of a node. The "mixnet" behind it decodes the
 * packets that `fakeWasm()` builds (plain payload behind a length prefix),
 * hands each `ServiceRequest` to `exit`, and buffers the reply under the
 * request's first SURB ID until a claim collects it.
 */
import {
  computeTopologyFingerprint,
  encodeServiceRequest,
  kpsAddrFromMetadataUrl,
  type PinnedMember,
  type PinnedSnapshot,
  type ServiceRequest,
  type TopologySnapshot,
} from "@hisoka-io/nox-client";
import type { KpsApi, KpsConn, KpsStream } from "../../src/spec-types.js";
import { relayerOf } from "./fixtures.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PACKET_BYTES = 32_768;
/** Fake SURBs are their 32-character hex IDs. */
const FAKE_SURB_BYTES = 32;
const PAYLOAD_VERSION_BYTE = 1;

/** WASM bindings with the exports the SDK calls: no cryptography, see the module comment. */
export function fakeWasm(): Record<string, unknown> {
  class PathHop {
    constructor(
      readonly pubKeyHex: string,
      readonly address: string,
    ) {}
  }
  class SurbRecovery {
    static from_json(text: string): { id: string } {
      return JSON.parse(text) as { id: string };
    }
  }
  return {
    JsPathHop: PathHop,
    JsSurbRecovery: SurbRecovery,
    build_sphinx_packet: (_hops: unknown[], payload: Uint8Array) => {
      const packet = new Uint8Array(PACKET_BYTES);
      new DataView(packet.buffer).setUint32(0, payload.length, true);
      packet.set(payload, 4);
      return packet;
    },
    create_surb: (_path: unknown[], idHex: string) => ({
      surb_bytes: encoder.encode(idHex),
      recovery: { id_hex: idHex, to_json: () => JSON.stringify({ id: idHex }) },
    }),
    decrypt_surb_response: (_recovery: unknown, body: Uint8Array) => body,
  };
}

export type FakeExit = (request: ServiceRequest) => Uint8Array | Promise<Uint8Array>;

interface ParsedHttpRequest {
  method: string;
  path: string;
  body: Uint8Array;
}

export class FakeNoxNetwork {
  readonly dials: string[] = [];
  readonly served: ServiceRequest[] = [];
  readonly refused = new Set<string>();
  /** Member addresses every served topology lists but reports offline (P2P liveness not yet re-formed). */
  readonly offline = new Set<string>();
  /** Member addresses every served topology leaves out (gone from the registry). */
  readonly omitted = new Set<string>();
  readonly conns: { address: string; open: boolean }[] = [];
  /** Member each KPS address serves for (its `/metadata.json` node); starts with the pinned addresses. */
  readonly nodeAt = new Map<string, string>();
  /** The registry the nodes observe (default: the pinned members), for discovery tests. */
  registryView: (() => PinnedMember[]) | undefined;
  /** Block the nodes report having observed (default: one after the snapshot). */
  observedBlock: (() => number) | undefined;
  private readonly buffered = new Map<string, { id: string; data: number[] }>();
  private next = 1;

  constructor(
    private readonly pinned: PinnedSnapshot,
    public exit: FakeExit,
  ) {
    for (const member of pinned.members) {
      const address = kpsAddrFromMetadataUrl(member.metadataUrl);
      if (address !== null) this.nodeAt.set(address, member.address);
    }
  }

  /** The `anonRpcWorker.kps` capability. */
  readonly kps: KpsApi = {
    dial: async (address) => this.dial(address),
    openStream: async (address) => (await this.dial(address)).openStream(),
  };

  /** A node-served schema v2 topology consistent with the pinned snapshot, minus `omitted`. */
  topology(): TopologySnapshot {
    const members = this.registryView?.() ?? this.pinned.members;
    const nodes = members.filter((member) => !this.omitted.has(member.address)).map(relayerOf);
    const now = Math.floor(Date.now() / 1000);
    return {
      nodes,
      fingerprint: computeTopologyFingerprint(nodes),
      schema_version: 2,
      block_number: this.observedBlock?.() ?? this.pinned.blockNumber + 1,
      timestamp: now,
      pow_difficulty: 1,
      liveness: nodes.map((node) => ({
        address: node.address,
        status: this.offline.has(node.address) ? "offline" as const : "online" as const,
        observed_at_unix: now,
      })),
    };
  }

  private async dial(address: string): Promise<KpsConn> {
    this.dials.push(address);
    if (this.refused.has(address)) {
      throw Object.assign(new Error("connection refused"), { code: "network-error" });
    }
    const state = { address, open: true };
    this.conns.push(state);
    let settle!: (info: { ok: boolean }) => void;
    const closed = new Promise<{ ok: boolean }>((resolve) => {
      settle = resolve;
    });
    const conn: KpsConn = {
      remoteAddress: { ip: address.slice(0, address.indexOf(":")), port: 15005 },
      openStream: async () => {
        if (!state.open) throw Object.assign(new Error("closed"), { code: "closed" });
        return this.stream(address);
      },
      acceptStream: () => new Promise(() => undefined),
      sendDatagram: async () => undefined,
      receiveDatagram: () => new Promise(() => undefined),
      close: async () => {
        state.open = false;
        settle({ ok: true });
      },
      closed,
    };
    return conn;
  }

  private stream(address: string): KpsStream {
    const up = new TransformStream<Uint8Array, Uint8Array>();
    const down = new TransformStream<Uint8Array, Uint8Array>();
    let settle!: (info: { ok: boolean }) => void;
    const closed = new Promise<{ ok: boolean }>((resolve) => {
      settle = resolve;
    });
    void this.serve(address, up.readable, down.writable.getWriter());
    return {
      readable: down.readable,
      writable: up.writable,
      closeWrite: () => up.writable.close(),
      cancelRead: () => down.readable.cancel(),
      resetWrite: () => up.writable.abort(),
      close: async () => settle({ ok: true }),
      closed,
    };
  }

  private async serve(address: string, readable: ReadableStream<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
    const raw = await readAll(readable);
    if (raw === null) return;
    const request = parseHttpRequest(raw);
    const node = this.nodeAt.get(address);
    const { status, body } = request.method === "GET" && request.path === "/metadata.json"
      ? node === undefined
        ? { status: 404, body: encoder.encode("no node") }
        : { status: 200, body: encoder.encode(JSON.stringify({ protocol: "nox-kps-http/1", node })) }
      : await this.answer(request);
    try {
      await writer.write(encoder.encode(`HTTP/1.1 ${status} X\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n`));
      if (body.length > 0) await writer.write(body);
      await writer.close();
    } catch {
      // The client reset the stream.
    }
  }

  private async answer(request: ParsedHttpRequest): Promise<{ status: number; body: Uint8Array }> {
    const json = (status: number, value: unknown) => ({ status, body: encoder.encode(JSON.stringify(value)) });
    if (request.method === "GET" && request.path === "/topology") return json(200, this.topology());
    if (request.method === "GET" && request.path === "/health") return json(200, { status: "ok" });
    if (request.method === "POST" && request.path === "/api/v1/packets") {
      void this.packet(request.body);
      return { status: 202, body: new Uint8Array(0) };
    }
    if (request.method === "POST" && request.path === "/api/v1/responses/claim") {
      const { surb_ids: ids } = JSON.parse(decoder.decode(request.body)) as { surb_ids: string[] };
      const items = ids.flatMap((id) => {
        const item = this.buffered.get(id);
        if (item === undefined) return [];
        this.buffered.delete(id);
        return [item];
      });
      return json(200, items);
    }
    return { status: 404, body: encoder.encode("not found") };
  }

  /** Packets received that are not fake-WASM packets (real Sphinx bytes). */
  opaquePackets = 0;

  private async packet(packet: Uint8Array): Promise<void> {
    try {
      await this.servePacket(packet);
    } catch {
      this.opaquePackets += 1;
    }
  }

  private async servePacket(packet: Uint8Array): Promise<void> {
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const payload = packet.subarray(4, 4 + view.getUint32(0, true));
    const payloadView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    // RelayerPayload::AnonymousRequest = version byte, u32 variant 4, u64-prefixed inner, u64 SURB count, SURBs.
    if (payload[0] !== PAYLOAD_VERSION_BYTE || payloadView.getUint32(1, true) !== 4) {
      throw new Error("not a fake-WASM AnonymousRequest packet");
    }
    const innerLength = Number(payloadView.getBigUint64(5, true));
    const inner = payload.slice(13, 13 + innerLength);
    let offset = 13 + innerLength;
    const count = Number(payloadView.getBigUint64(offset, true));
    offset += 8;
    const surbIds: string[] = [];
    for (let index = 0; index < count; index++) {
      surbIds.push(decoder.decode(payload.subarray(offset, offset + FAKE_SURB_BYTES)));
      offset += FAKE_SURB_BYTES;
    }
    const request = decodeServiceRequestShape(inner);
    this.served.push(request);
    const reply = await this.exit(request);
    const first = surbIds[0];
    if (first === undefined) return;
    const id = this.next++;
    this.buffered.set(first, { id: `resp-${id}-${first}`, data: Array.from(serviceResponse(BigInt(id), reply)) });
  }
}

/** Decode the HttpRequest variant the worker sends (fields in wire order). */
function decodeServiceRequestShape(inner: Uint8Array): ServiceRequest {
  const view = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);
  let offset = 1;
  if (view.getUint32(offset, true) !== 1) throw new Error("fake exit: only ServiceRequest::HttpRequest is served");
  offset += 4;
  const bytes = (): Uint8Array => {
    const length = Number(view.getBigUint64(offset, true));
    offset += 8;
    const out = inner.slice(offset, offset + length);
    offset += length;
    return out;
  };
  const text = (): string => decoder.decode(bytes());
  const method = text();
  const url = text();
  const headerCount = Number(view.getBigUint64(offset, true));
  offset += 8;
  const headers: [string, string][] = [];
  for (let index = 0; index < headerCount; index++) headers.push([text(), text()]);
  const body = bytes();
  const request = { tag: "HttpRequest", method, url, headers, body } as ServiceRequest;
  // Cross-check against the SDK's own encoder: the bytes must round-trip.
  const again = encodeServiceRequest(request);
  if (again.length !== inner.length || again.some((byte, index) => byte !== inner[index])) {
    throw new Error("fake exit: not an HttpRequest in the expected layout");
  }
  return request;
}

/** `RelayerPayload::ServiceResponse` with one fragment carrying `data`. */
function serviceResponse(requestId: bigint, data: Uint8Array): Uint8Array {
  const parts: number[] = [PAYLOAD_VERSION_BYTE];
  const u32 = (value: number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    parts.push(...bytes);
  };
  const u64 = (value: bigint) => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    parts.push(...bytes);
  };
  u32(5);
  u64(requestId);
  // FragmentWire { message_id: u64, total_fragments: u32, sequence: u32, data: Vec<u8>, fec: Option<FecInfo> }
  u64(requestId);
  u32(1);
  u32(0);
  u64(BigInt(data.length));
  parts.push(...data);
  parts.push(0);
  return Uint8Array.from(parts);
}

async function readAll(readable: ReadableStream<Uint8Array>): Promise<Uint8Array | null> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function parseHttpRequest(raw: Uint8Array): ParsedHttpRequest {
  let end = -1;
  for (let index = 0; index + 3 < raw.length; index++) {
    if (raw[index] === 13 && raw[index + 1] === 10 && raw[index + 2] === 13 && raw[index + 3] === 10) {
      end = index;
      break;
    }
  }
  const [method = "", path = ""] = (decoder.decode(raw.subarray(0, end)).split("\r\n")[0] ?? "").split(" ");
  return { method, path, body: raw.slice(end + 4) };
}
