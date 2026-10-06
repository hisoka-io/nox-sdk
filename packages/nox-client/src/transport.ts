import { NoxClientError, NoxClientErrorCode } from "./types.js";
import type { BatchResponseItem, NoxFetch, NoxWebSocketConstructor } from "./types.js";
import { defaultFetch } from "./rpc.js";
import { kpsExchangeTiming } from "./kps/transport.js";

export const SPHINX_PACKET_SIZE = 32_768;

export async function postPacket(
  entryUrl: string,
  packet: Uint8Array,
  timeoutMs = 30_000,
  fetchImpl: NoxFetch = defaultFetch,
): Promise<void> {
  if (packet.length !== SPHINX_PACKET_SIZE) {
    throw new NoxClientError(
      `Sphinx packet must be exactly ${SPHINX_PACKET_SIZE} bytes, got ${packet.length}`,
      NoxClientErrorCode.PacketBuildFailed,
    );
  }

  const url = `${entryUrl.replace(/\/$/, "")}/api/v1/packets`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      // Fresh copy satisfies TS 5.9+ BodyInit constraint (Uint8Array<ArrayBuffer>)
      body: new Uint8Array(packet) as Uint8Array<ArrayBuffer>,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new NoxClientError(
      `Packet delivery failed to ${url}: ${String(err)}`,
      NoxClientErrorCode.TransportFailed,
      err,
    );
  }
  clearTimeout(timer);

  if (!resp.ok) {
    throw new NoxClientError(
      `Packet delivery returned HTTP ${resp.status} from ${url}`,
      NoxClientErrorCode.TransportFailed,
    );
  }
}

/**
 * Claim protocol v2 (nox `docs/claim-api.md`). Every v2 option is an optional
 * field of the JSON claim body, so a v1 entry ignores them and answers v1
 * JSON with delete-on-claim; the response's own `Content-Type` decides how it
 * is read.
 *
 * - `encoding: "binary"` (and `Accept: application/vnd.nox.claim-batch`, for
 *   relays that forward `Accept`): a length-prefixed binary batch.
 * - `retain: true`: the entry keeps returned replies until they are acked or
 *   its claim grace passes, so a cut-off transfer can be claimed again.
 * - `ack: [...]`: SURB IDs whose replies the client has; removed first.
 * - `wait_ms`: long-poll (honoured with `retain` only), capped by the entry.
 */
export const CLAIM_BINARY_MEDIA_TYPE = "application/vnd.nox.claim-batch";

/** `Accept` of a claim that prefers the binary batch and still takes JSON. */
export const CLAIM_ACCEPT_BINARY = `${CLAIM_BINARY_MEDIA_TYPE}, application/json;q=0.5`;

/** Version byte at the start of a binary claim batch. */
export const CLAIM_BATCH_VERSION = 1;

/** Per-item flag in the binary batch: a retaining claim returned this reply before. */
export const CLAIM_ITEM_FLAG_RECLAIMED = 0x01;

/** Response header naming the entry's claim protocol version (v2 entries send "2"). */
export const CLAIM_VERSION_HEADER = "x-nox-claim-version";

/** Response header with the longest `wait_ms` the entry (and its relay) honours. */
export const CLAIM_WAIT_MAX_HEADER = "x-nox-claim-wait-max-ms";

/** One claimed reply: the entry's response ID and the Sphinx reply body. */
export interface ClaimedItem {
  readonly id: string;
  readonly data: Uint8Array;
  /** A retaining claim had already returned this reply (claim protocol v2). */
  readonly reclaimed?: boolean;
}

/** Wire format a claim response came in. */
export type ClaimFormat = "binary" | "base64" | "json" | "empty";

export interface ClaimOutcome {
  readonly items: ClaimedItem[];
  readonly format: ClaimFormat;
  /** Response body bytes. */
  readonly bytes: number;
  /**
   * True when the entry speaks claim protocol v2 (version header, binary
   * batch or base64 items); false when it answered v1 JSON; undefined when
   * nothing in the answer tells (a 204 through a relay that drops headers).
   */
  readonly v2: boolean | undefined;
  /** The entry's `x-nox-claim-wait-max-ms`, when relayed. */
  readonly waitMaxMs: number | undefined;
  /** When the claim was sent, its response head arrived and its body was read (`Date.now()`). */
  readonly timing: ClaimTiming;
}

/** Phases of one claim exchange (`Date.now()` values). */
export interface ClaimTiming {
  readonly startedAt: number;
  readonly headAt: number;
  readonly bodyAt: number;
}

/** Options of `claimReplies`. */
export interface ClaimRequestOptions {
  /** Abort the exchange after this long. */
  readonly timeoutMs: number;
  readonly fetchImpl?: NoxFetch;
  /** Ask for the binary batch. JSON answers are read either way. */
  readonly binary?: boolean;
  /** Ask the entry to keep returned replies until acked (re-claimable). */
  readonly retain?: boolean;
  /** SURB IDs whose replies the client already has. */
  readonly ack?: readonly string[];
  /**
   * Long-poll: ask the entry to hold the claim up to this long until a reply
   * for one of the IDs arrives. Honoured with `retain` only; entries that do
   * not support it answer at once, so the client keeps polling.
   */
  readonly waitMs?: number;
  /** Caller abort; rejects with the signal's reason. */
  readonly signal?: AbortSignal;
}

/**
 * Claim replies by SURB ID (`POST /api/v1/responses/claim`). Only replies for
 * exactly these IDs are returned. An empty `surbIds` with acks only sends the
 * acks (v2 entries answer 204).
 */
export async function claimReplies(
  entryUrl: string,
  surbIds: readonly string[],
  options: ClaimRequestOptions,
): Promise<ClaimOutcome> {
  const ack = options.ack ?? [];
  const startedAt = Date.now();
  if (surbIds.length === 0 && ack.length === 0) {
    return {
      items: [],
      format: "empty",
      bytes: 0,
      v2: undefined,
      waitMaxMs: undefined,
      timing: { startedAt, headAt: startedAt, bodyAt: startedAt },
    };
  }
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const binary = options.binary === true;
  const retain = options.retain === true;
  const waitMs = retain ? options.waitMs ?? 0 : 0;

  const url = `${entryUrl.replace(/\/$/, "")}/api/v1/responses/claim`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new NoxClientError(
      `Response claim from ${url} timed out after ${options.timeoutMs} ms`,
      NoxClientErrorCode.TransportFailed,
    )),
    options.timeoutMs,
  );
  const caller = options.signal;
  const onCallerAbort = (): void => controller.abort(caller?.reason);
  if (caller?.aborted === true) onCallerAbort();
  else caller?.addEventListener("abort", onCallerAbort, { once: true });

  const body: Record<string, unknown> = { surb_ids: [...surbIds] };
  if (binary) body["encoding"] = "binary";
  if (retain) body["retain"] = true;
  if (ack.length > 0) body["ack"] = [...ack];
  if (waitMs > 0) body["wait_ms"] = waitMs;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (binary) headers["Accept"] = CLAIM_ACCEPT_BINARY;

  try {
    let resp: Response;
    try {
      resp = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new NoxClientError(
        `Response claim failed from ${url}: ${String(controller.signal.aborted ? controller.signal.reason : err)}`,
        NoxClientErrorCode.TransportFailed,
        err,
      );
    }

    const fetchedAt = Date.now();
    const exchange = kpsExchangeTiming(resp);
    const headAt = exchange?.headAt ?? fetchedAt;
    if (!resp.ok && resp.status !== 204) {
      throw new NoxClientError(
        `Response claim returned HTTP ${resp.status} from ${url}`,
        NoxClientErrorCode.TransportFailed,
      );
    }
    const version = header(resp, CLAIM_VERSION_HEADER);
    const waitMax = Number.parseInt(header(resp, CLAIM_WAIT_MAX_HEADER) ?? "", 10);
    const waitMaxMs = Number.isSafeInteger(waitMax) && waitMax >= 0 ? waitMax : undefined;
    const versionV2 = version === undefined ? undefined : version.trim() === "2";
    if (resp.status === 204) {
      return { items: [], format: "empty", bytes: 0, v2: versionV2, waitMaxMs, timing: { startedAt, headAt, bodyAt: headAt } };
    }

    let raw: Uint8Array;
    try {
      raw = new Uint8Array(await resp.arrayBuffer());
    } catch (err) {
      throw new NoxClientError(
        `Response claim body from ${url} could not be read: ${String(controller.signal.aborted ? controller.signal.reason : err)}`,
        NoxClientErrorCode.TransportFailed,
        err,
      );
    }
    const timing: ClaimTiming = { startedAt, headAt, bodyAt: exchange?.bodyAt ?? Date.now() };
    const mediaType = (header(resp, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (mediaType === CLAIM_BINARY_MEDIA_TYPE) {
      return { items: decodeBinaryClaim(raw, url), format: "binary", bytes: raw.length, v2: true, waitMaxMs, timing };
    }
    const { items, base64 } = decodeJsonClaim(raw, url);
    return {
      items,
      format: base64 ? "base64" : "json",
      bytes: raw.length,
      v2: versionV2 ?? (base64 ? true : false),
      waitMaxMs,
      timing,
    };
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onCallerAbort);
  }
}

/** Claim SURB responses by ID as v1 JSON number arrays (no v2 options). */
export async function claimResponses(
  entryUrl: string,
  surbIds: string[],
  timeoutMs = 10_000,
  fetchImpl: NoxFetch = defaultFetch,
): Promise<BatchResponseItem[]> {
  const outcome = await claimReplies(entryUrl, surbIds, { timeoutMs, fetchImpl });
  return outcome.items.map((item) => ({ id: item.id, data: Array.from(item.data) }));
}

/**
 * Binary claim batch (all integers big-endian):
 * `u8 version (1) | u16 item count | per item: u8 flags (bit 0: reclaimed) |
 * u16 id length | id (ASCII) | u32 data length | data`.
 * Throws `TRANSPORT_FAILED` naming the offset on any malformed input.
 */
export function decodeBinaryClaim(body: Uint8Array, where = "the entry"): ClaimedItem[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const items: ClaimedItem[] = [];
  let offset = 0;
  const fail = (detail: string): never => {
    throw new NoxClientError(
      `Binary claim batch from ${where} is malformed at byte ${offset} of ${body.length}: ${detail}`,
      NoxClientErrorCode.TransportFailed,
    );
  };
  const need = (bytes: number, what: string): void => {
    if (body.length - offset < bytes) fail(`truncated ${what}`);
  };
  need(3, "header");
  const version = view.getUint8(offset);
  if (version !== CLAIM_BATCH_VERSION) fail(`unknown batch version ${version}`);
  const count = view.getUint16(offset + 1, false);
  offset += 3;
  for (let index = 0; index < count; index++) {
    need(3, `item ${index} flags and ID length`);
    const flags = view.getUint8(offset);
    const idLength = view.getUint16(offset + 1, false);
    offset += 3;
    if (idLength === 0) fail(`item ${index} has an empty ID`);
    need(idLength, `item ${index} ID`);
    let id = "";
    for (let i = 0; i < idLength; i++) {
      const byte = body[offset + i]!;
      if (byte < 0x20 || byte > 0x7e) fail(`item ${index} ID is not printable ASCII`);
      id += String.fromCharCode(byte);
    }
    offset += idLength;
    need(4, `item ${index} data length`);
    const dataLength = view.getUint32(offset, false);
    offset += 4;
    need(dataLength, `item ${index} data (${dataLength} bytes declared)`);
    items.push({
      id,
      data: body.slice(offset, offset + dataLength),
      reclaimed: (flags & CLAIM_ITEM_FLAG_RECLAIMED) !== 0,
    });
    offset += dataLength;
  }
  if (offset !== body.length) fail(`${body.length - offset} bytes after the last item`);
  return items;
}

/** Encode claim items as a binary claim batch (tests and tooling). */
export function encodeBinaryClaim(items: readonly ClaimedItem[]): Uint8Array {
  const ids = items.map((item) => Uint8Array.from(item.id, (char) => char.charCodeAt(0)));
  const total = 3 + items.reduce((sum, item, index) => sum + 1 + 2 + ids[index]!.length + 4 + item.data.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint8(0, CLAIM_BATCH_VERSION);
  view.setUint16(1, items.length, false);
  let offset = 3;
  items.forEach((item, index) => {
    const id = ids[index]!;
    view.setUint8(offset, item.reclaimed === true ? CLAIM_ITEM_FLAG_RECLAIMED : 0);
    view.setUint16(offset + 1, id.length, false);
    offset += 3;
    out.set(id, offset);
    offset += id.length;
    view.setUint32(offset, item.data.length, false);
    offset += 4;
    out.set(item.data, offset);
    offset += item.data.length;
  });
  return out;
}

function header(resp: Response, name: string): string | undefined {
  const value = (resp.headers as Headers | undefined)?.get?.(name);
  return value === null || value === undefined ? undefined : value;
}

/** v1 items (`data` number arrays) or v2 base64 items (`data_b64`, `reclaimed`). */
function decodeJsonClaim(body: Uint8Array, url: string): { items: ClaimedItem[]; base64: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch (err) {
    throw new NoxClientError(
      `Response claim returned invalid JSON from ${url}`,
      NoxClientErrorCode.TransportFailed,
      err,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new NoxClientError(
      `Response claim expected JSON array, got ${typeof parsed} from ${url}`,
      NoxClientErrorCode.TransportFailed,
    );
  }
  let base64 = false;
  const items = parsed.map((item, i): ClaimedItem => {
    const record = item as Record<string, unknown> | null;
    if (typeof record === "object" && record !== null && typeof record["id"] === "string" && typeof record["data_b64"] === "string") {
      base64 = true;
      const data = decodeBase64(record["data_b64"]);
      if (data === null) {
        throw new NoxClientError(
          `Response item at index ${i} has invalid data_b64 from ${url}`,
          NoxClientErrorCode.TransportFailed,
        );
      }
      return { id: record["id"], data, reclaimed: record["reclaimed"] === true };
    }
    const [v1] = parseResponseItems([item]);
    return { id: v1!.id, data: Uint8Array.from(v1!.data) };
  });
  return { items, base64 };
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES: ReadonlyMap<string, number> = new Map([...BASE64_ALPHABET].map((char, index) => [char, index]));

/** Standard padded base64 (RFC 4648 §4), or null when malformed. */
export function decodeBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let written = 0;
  for (let index = 0; index < text.length; index += 4) {
    let word = 0;
    for (let j = 0; j < 4; j++) {
      const char = text[index + j]!;
      const last = index + 4 === text.length;
      if (char === "=" && last && j >= 4 - padding) {
        word <<= 6;
        continue;
      }
      const value = BASE64_VALUES.get(char);
      if (value === undefined) return null;
      word = (word << 6) | value;
    }
    for (let shift = 16; shift >= 0 && written < out.length; shift -= 8) {
      out[written++] = (word >> shift) & 0xff;
    }
  }
  return out;
}

/** Poll an entry node for all pending SURB responses. */
export async function pollResponses(
  entryUrl: string,
  timeoutMs = 10_000,
  fetchImpl: NoxFetch = defaultFetch,
): Promise<BatchResponseItem[]> {
  const url = `${entryUrl.replace(/\/$/, "")}/api/v1/responses/pending`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetchImpl(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new NoxClientError(
      `Response poll failed from ${url}: ${String(err)}`,
      NoxClientErrorCode.TransportFailed,
      err,
    );
  }
  clearTimeout(timer);

  if (!resp.ok) {
    throw new NoxClientError(
      `Response poll returned HTTP ${resp.status} from ${url}`,
      NoxClientErrorCode.TransportFailed,
    );
  }

  if (resp.status === 204) {
    return [];
  }

  let items: unknown;
  try {
    items = await resp.json();
  } catch (err) {
    throw new NoxClientError(
      `Response poll returned invalid JSON from ${url}`,
      NoxClientErrorCode.TransportFailed,
      err,
    );
  }

  if (!Array.isArray(items)) {
    throw new NoxClientError(
      `Response poll expected JSON array, got ${typeof items} from ${url}`,
      NoxClientErrorCode.TransportFailed,
    );
  }

  return parseResponseItems(items);
}

/** Check if WebSocket is available in this runtime. */
export function hasWebSocket(): boolean {
  return typeof globalThis.WebSocket === "function";
}

// WebSocket readyState OPEN. Read as a constant so an injected constructor
// without static fields still works.
const WS_OPEN = 1;

/** Convert HTTP entry URL to WebSocket URL. */
function toWsUrl(entryUrl: string): string {
  return entryUrl
    .replace(/\/$/, "")
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:")
    + "/api/v1/ws";
}

export type WsResponseHandler = (item: BatchResponseItem) => void;

/** Persistent WebSocket connection for SURB response delivery. */
export class ResponseWebSocket {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private onResponse: WsResponseHandler;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private pendingSubscribes: string[] = [];
  private readonly WebSocketImpl: NoxWebSocketConstructor;

  constructor(
    entryUrl: string,
    onResponse: WsResponseHandler,
    WebSocketImpl: NoxWebSocketConstructor = globalThis.WebSocket,
  ) {
    this.url = toWsUrl(entryUrl);
    this.onResponse = onResponse;
    this.WebSocketImpl = WebSocketImpl;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;

    try {
      this.ws = new this.WebSocketImpl(this.url);
    } catch {
      return;
    }

    this.ws.onopen = () => {
      if (this.pendingSubscribes.length > 0) {
        this.ws!.send(JSON.stringify({ type: "subscribe", surb_ids: this.pendingSubscribes }));
        this.pendingSubscribes = [];
      }
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (msg.type === "response" && typeof msg.id === "string" && Array.isArray(msg.data)) {
          this.onResponse({ id: msg.id as string, data: msg.data as number[] });
        }
      } catch {
        // malformed message, ignore
      }
    };

    this.ws.onclose = () => {
      if (!this.closed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 1000);
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  subscribe(surbIds: string[]): void {
    if (surbIds.length === 0) return;
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      this.pendingSubscribes.push(...surbIds);
      return;
    }
    this.ws.send(JSON.stringify({ type: "subscribe", surb_ids: surbIds }));
  }

  unsubscribe(surbIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN || surbIds.length === 0) return;
    this.ws.send(JSON.stringify({ type: "unsubscribe", surb_ids: surbIds }));
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }
}

function parseResponseItems(items: unknown[]): BatchResponseItem[] {
  return items.map((item, i) => {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>)["id"] !== "string" ||
      !Array.isArray((item as Record<string, unknown>)["data"])
    ) {
      throw new NoxClientError(
        `Response item at index ${i} missing required fields {id: string, data: number[]}`,
        NoxClientErrorCode.TransportFailed,
      );
    }
    const raw = item as { id: string; data: number[] };
    return { id: raw.id, data: raw.data };
  });
}
