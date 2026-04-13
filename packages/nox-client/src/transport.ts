import { NoxClientError, NoxClientErrorCode } from "./types.js";
import type { BatchResponseItem } from "./types.js";

export const SPHINX_PACKET_SIZE = 32_768;

export async function postPacket(
  entryUrl: string,
  packet: Uint8Array,
  timeoutMs = 30_000,
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
    resp = await fetch(url, {
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

/** Claim SURB responses by ID (multi-client safe, unlike `/pending`). */
export async function claimResponses(
  entryUrl: string,
  surbIds: string[],
  timeoutMs = 10_000,
): Promise<BatchResponseItem[]> {
  if (surbIds.length === 0) return [];

  const url = `${entryUrl.replace(/\/$/, "")}/api/v1/responses/claim`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surb_ids: surbIds }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new NoxClientError(
      `Response claim failed from ${url}: ${String(err)}`,
      NoxClientErrorCode.TransportFailed,
      err,
    );
  }
  clearTimeout(timer);

  if (!resp.ok && resp.status !== 204) {
    throw new NoxClientError(
      `Response claim returned HTTP ${resp.status} from ${url}`,
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
      `Response claim returned invalid JSON from ${url}`,
      NoxClientErrorCode.TransportFailed,
      err,
    );
  }

  if (!Array.isArray(items)) {
    throw new NoxClientError(
      `Response claim expected JSON array, got ${typeof items} from ${url}`,
      NoxClientErrorCode.TransportFailed,
    );
  }

  return parseResponseItems(items);
}

/** Poll an entry node for all pending SURB responses. */
export async function pollResponses(
  entryUrl: string,
  timeoutMs = 10_000,
): Promise<BatchResponseItem[]> {
  const url = `${entryUrl.replace(/\/$/, "")}/api/v1/responses/pending`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, { signal: controller.signal });
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

  constructor(entryUrl: string, onResponse: WsResponseHandler) {
    this.url = toWsUrl(entryUrl);
    this.onResponse = onResponse;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;

    try {
      this.ws = new WebSocket(this.url);
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingSubscribes.push(...surbIds);
      return;
    }
    this.ws.send(JSON.stringify({ type: "subscribe", surb_ids: surbIds }));
  }

  unsubscribe(surbIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || surbIds.length === 0) return;
    this.ws.send(JSON.stringify({ type: "unsubscribe", surb_ids: surbIds }));
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
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
