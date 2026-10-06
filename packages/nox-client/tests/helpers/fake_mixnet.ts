/**
 * A stand-in for the WASM module and for the entry → mix → exit → entry path,
 * so `NoxClient` in KPS mode can be driven end to end in Node without Rust:
 *
 * - `fakeWasmBindings()` "encrypts" nothing: a Sphinx packet is the plain
 *   payload behind a length prefix, padded to 32,768 bytes, a SURB is its ID,
 *   and SURB decryption is the identity.
 * - `FakeMixnet.handler` is a `FakeKpsNetwork` route that plays the entry
 *   node's ingress: it accepts packets, runs the request through `exit`
 *   (decoded `ServiceRequest`), and buffers the reply under each SURB ID until
 *   a claim collects it. `/topology` and `/health` are answered too.
 */
import {
  decodeRelayerPayload,
  decodeServiceRequest,
  encodeRelayerPayload,
  type ServiceRequest,
} from "../../src/bincode.js";
import type { TopologySnapshot } from "../../src/types.js";
import { CLAIM_BINARY_MEDIA_TYPE, encodeBinaryClaim, type ClaimedItem } from "../../src/transport.js";
import { json, type FakeHandler, type FakeReply, type FakeRequest } from "./fake_kps.js";

export const SPHINX_PACKET_BYTES = 32_768;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

class FakePathHop {
  constructor(
    readonly pubKeyHex: string,
    readonly address: string,
  ) {}
}

class FakeSurbRecovery {
  constructor(readonly idHex: string) {}

  static from_json(text: string): FakeSurbRecovery {
    return new FakeSurbRecovery((JSON.parse(text) as { id: string }).id);
  }
}

/**
 * WASM bindings with the exports `NoxClient` calls; see the module comment.
 * With `v2`, `create_surb_v2` returns a random delivery ID as both the SURB
 * bytes and the recovery ID, so format 2 reply blocks route like format 1.
 */
export function fakeWasmBindings(options: { v2?: boolean } = {}): Record<string, unknown> {
  const v2 = options.v2 === true
    ? {
      create_surb_v2(_path: unknown[], _pow: number) {
        const idHex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
        return {
          surb_bytes: encoder.encode(idHex),
          recovery: { id_hex: idHex, to_json: () => JSON.stringify({ id: idHex }) },
        };
      },
    }
    : {};
  return {
    ...v2,
    JsPathHop: FakePathHop,
    JsSurbRecovery: FakeSurbRecovery,
    build_sphinx_packet(_hops: unknown[], payload: Uint8Array, _pow: number): Uint8Array {
      const packet = new Uint8Array(SPHINX_PACKET_BYTES);
      new DataView(packet.buffer).setUint32(0, payload.length, true);
      packet.set(payload, 4);
      return packet;
    },
    create_surb(_path: unknown[], idHex: string, _pow: number) {
      return {
        surb_bytes: encoder.encode(idHex),
        recovery: { id_hex: idHex, to_json: () => JSON.stringify({ id: idHex }) },
      };
    },
    decrypt_surb_response(_recovery: unknown, body: Uint8Array): Uint8Array {
      return body;
    },
  };
}

/** The exit's behaviour: answer a decoded request with reply bytes, or drop it (`null`). */
export type FakeExit = (request: ServiceRequest) => Uint8Array | null | Promise<Uint8Array | null>;

/** One claim the fake entry saw. */
export interface FakeClaim {
  readonly ids: string[];
  readonly ack: string[];
  readonly body: Record<string, unknown>;
  readonly accept: string | undefined;
  readonly at: number;
}

/**
 * Claim protocol of the fake entry: `v1` answers JSON number arrays and
 * deletes on claim (nox 0.4.0-rc.6); `v2` follows nox `docs/claim-api.md`
 * (binary batch, retain until ack or grace, ack, long-poll with retain).
 */
export type FakeClaimProtocol = "v1" | "v2";

export class FakeMixnet {
  /** Requests the exit saw, in order. */
  readonly served: ServiceRequest[] = [];
  /** Reply blocks carried by each served request. */
  readonly surbCounts: number[] = [];
  /** Packets received per KPS address. */
  readonly packetsByAddress = new Map<string, number>();
  claims = 0;
  /** Status the ingress answers packets with (the node answers 202). */
  packetStatus = 202;
  /** Delay before replies become claimable. */
  replyDelayMs = 0;
  /** Claim protocol the entry speaks. */
  claimProtocol: FakeClaimProtocol = "v1";
  /** Also buffer each reply under the next SURB, standing in for the exit's RS parity block. */
  parity = false;
  /** Leave the data block's reply out (lost in the mixnet); only the parity copy arrives. */
  dropData = false;
  /** v2: how long a retained reply stays re-claimable. */
  claimGraceMs = 20_000;
  /** v2: longest wait honoured (sent as `x-nox-claim-wait-max-ms`). */
  claimWaitMaxMs = 20_000;
  /** The relay's `/metadata.json` lists `claim-v2` with `limits.claimWaitMaxMs` (relays long-polls). */
  relayClaimV2 = false;
  /** Claims seen, in order. */
  readonly claimLog: FakeClaim[] = [];
  private readonly buffered = new Map<string, { item: ClaimedItem; claimedAt: number | undefined }>();
  private readonly arrivals = new Set<() => void>();
  private nextResponse = 1;

  constructor(
    private readonly topology: () => TopologySnapshot,
    public exit: FakeExit,
  ) {}

  readonly handler: FakeHandler = (request) => this.answer(request);

  private async answer(request: FakeRequest): Promise<FakeReply> {
    if (request.method === "GET" && request.path === "/topology") return json(200, this.topology());
    if (request.method === "GET" && request.path === "/health") return json(200, { status: "ok" });
    if (request.method === "GET" && request.path === "/metadata.json") {
      return json(200, {
        protocol: "nox-kps-http/1",
        software: "nox-kps",
        capabilities: ["metadata", "health", "packets", "claim", "topology", ...(this.relayClaimV2 ? ["claim-v2"] : [])],
        limits: { claimMaxSurbIds: 128, ...(this.relayClaimV2 ? { claimWaitMaxMs: this.claimWaitMaxMs } : {}) },
      });
    }
    if (request.method === "POST" && request.path === "/api/v1/packets") return this.packet(request);
    if (request.method === "POST" && request.path === "/api/v1/responses/claim") return this.claim(request);
    return { status: 404, body: "not found" };
  }

  private async packet(request: FakeRequest): Promise<FakeReply> {
    if (request.body.length !== SPHINX_PACKET_BYTES) return { status: 400, body: "bad packet size" };
    this.packetsByAddress.set(request.address, (this.packetsByAddress.get(request.address) ?? 0) + 1);
    const length = new DataView(request.body.buffer, request.body.byteOffset).getUint32(0, true);
    const parsed = parseAnonymousRequest(request.body.slice(4, 4 + length));
    if (parsed === null) return { status: 202, body: "" };
    const inner = decodeServiceRequest(parsed.inner);
    this.served.push(inner);
    const surbIds = parsed.surbIds;
    this.surbCounts.push(surbIds.length);
    const status = this.packetStatus;
    void this.deliver(inner, surbIds);
    return { status, body: "" };
  }

  private async deliver(inner: ServiceRequest, surbIds: string[]): Promise<void> {
    const reply = await this.exit(inner);
    if (reply === null || surbIds.length === 0) return;
    if (this.replyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.replyDelayMs));
    const plaintext = encodeRelayerPayload({
      tag: "ServiceResponse",
      requestId: BigInt(this.nextResponse),
      fragment: {
        messageId: BigInt(this.nextResponse),
        totalFragments: 1,
        sequence: 0,
        data: reply,
        fec: null,
      },
    });
    const store = (id: string): void => {
      this.buffered.set(id, { item: { id: `resp-${this.nextResponse}-${id}`, data: plaintext }, claimedAt: undefined });
    };
    if (!this.dropData) store(surbIds[0]!);
    if (this.parity && surbIds.length > 1) store(surbIds[1]!);
    this.nextResponse += 1;
    for (const wake of [...this.arrivals]) wake();
  }

  /** Whether a reply is buffered (and claimable) under `id`. */
  holds(id: string): boolean {
    return this.buffered.has(id);
  }

  private async claim(request: FakeRequest): Promise<FakeReply> {
    this.claims += 1;
    const body = JSON.parse(decoder.decode(request.body)) as Record<string, unknown>;
    const ids = (body["surb_ids"] as string[] | undefined) ?? [];
    const ack = (body["ack"] as string[] | undefined) ?? [];
    const accept = request.headers.find(([name]) => name === "accept")?.[1];
    this.claimLog.push({ ids, ack, body, accept, at: Date.now() });
    if (this.claimProtocol === "v1") {
      const items: { id: string; data: number[] }[] = [];
      for (const id of ids) {
        const held = this.buffered.get(id);
        if (held !== undefined) {
          items.push({ id: held.item.id, data: Array.from(held.item.data) });
          this.buffered.delete(id);
        }
      }
      return json(200, items);
    }
    for (const id of ack) this.buffered.delete(id);
    const retain = body["retain"] === true;
    const waitMs = retain ? Math.min(Number(body["wait_ms"] ?? 0), this.claimWaitMaxMs) : 0;
    const headers: [string, string][] = [
      ["x-nox-claim-version", "2"],
      ["x-nox-claim-wait-max-ms", String(this.claimWaitMaxMs)],
    ];
    const take = (): ClaimedItem[] => {
      const now = Date.now();
      const items: ClaimedItem[] = [];
      for (const id of ids) {
        const held = this.buffered.get(id);
        if (held === undefined) continue;
        if (held.claimedAt !== undefined && now - held.claimedAt >= this.claimGraceMs) {
          this.buffered.delete(id);
          continue;
        }
        items.push({ ...held.item, reclaimed: held.claimedAt !== undefined });
        if (retain) held.claimedAt ??= now;
        else this.buffered.delete(id);
      }
      return items;
    };
    let items = take();
    if (items.length === 0 && waitMs > 0 && ids.length > 0) {
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          if (ids.some((id) => this.buffered.has(id))) done();
        };
        const timer = setTimeout(() => done(), waitMs);
        const done = (): void => {
          clearTimeout(timer);
          this.arrivals.delete(wake);
          resolve();
        };
        this.arrivals.add(wake);
      });
      items = take();
    }
    if (items.length === 0) return { status: 204, reason: "No Content", headers, contentLength: false };
    const binary = body["encoding"] === "binary" || (accept ?? "").includes(CLAIM_BINARY_MEDIA_TYPE);
    if (binary) {
      return { status: 200, headers: [["content-type", CLAIM_BINARY_MEDIA_TYPE], ...headers], body: encodeBinaryClaim(items) };
    }
    const reply = json(200, items.map((item) => ({ id: item.id, data: Array.from(item.data) })));
    return { ...reply, headers: [...(("headers" in reply && reply.headers) || []), ...headers] } as FakeReply;
  }
}

/** Length of a fake SURB: its 32-character hex ID. */
const FAKE_SURB_BYTES = 32;

/**
 * `RelayerPayload::AnonymousRequest` as the client writes it: version byte,
 * u32 variant 4, u64-prefixed inner request, u64 SURB count, then the SURBs
 * inline (fake SURBs are their 32-byte IDs). `null` for other variants.
 */
function parseAnonymousRequest(payload: Uint8Array): { inner: Uint8Array; surbIds: string[] } | null {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (view.getUint32(1, true) !== 4) {
    decodeRelayerPayload(payload);
    return null;
  }
  const innerLength = Number(view.getBigUint64(5, true));
  const inner = payload.slice(13, 13 + innerLength);
  let offset = 13 + innerLength;
  const count = Number(view.getBigUint64(offset, true));
  offset += 8;
  const surbIds: string[] = [];
  for (let index = 0; index < count; index++) {
    surbIds.push(decoder.decode(payload.subarray(offset, offset + FAKE_SURB_BYTES)));
    offset += FAKE_SURB_BYTES;
  }
  return { inner, surbIds };
}

/**
 * Bincode 1 `SerializableHttpResponse { status: u16, headers: HashMap<String,
 * String>, body: Vec<u8>, truncated: bool }`, as the exit sends it.
 */
export function encodeExitHttpResponse(
  status: number,
  headers: [string, string][],
  body: Uint8Array | string,
  truncated = false,
): Uint8Array {
  const bodyBytes = typeof body === "string" ? encoder.encode(body) : body;
  const parts: number[] = [];
  const u64 = (value: number): void => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    parts.push(...bytes);
  };
  const bytes = (value: Uint8Array): void => {
    u64(value.length);
    parts.push(...value);
  };
  parts.push(status & 0xff, status >> 8);
  u64(headers.length);
  for (const [name, value] of headers) {
    bytes(encoder.encode(name));
    bytes(encoder.encode(value));
  }
  bytes(bodyBytes);
  parts.push(truncated ? 1 : 0);
  return Uint8Array.from(parts);
}
