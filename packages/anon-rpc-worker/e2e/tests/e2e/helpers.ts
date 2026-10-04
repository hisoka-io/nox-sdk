// Spec helpers: JSON-RPC through a booted worker, the egress monitor for
// "no ambient network" assertions, and host network facts for the KPS probe.

import { networkInterfaces } from "node:os";
import type { BrowserContext, Page, Request, WebSocket } from "@playwright/test";
import type { FetchResult } from "../../page/api.js";
import {
  describeEvents,
  violations,
  type EgressEvent,
  type EgressKind,
  type EgressLayer,
  type EgressPolicy,
} from "../../src/egress.js";
import type { EgressProxy } from "../../src/egress-proxy.js";

export interface RpcOutcome {
  readonly result: FetchResult;
  /** Parsed JSON body when the call succeeded with JSON. */
  readonly json?: unknown;
}

/** POST a JSON-RPC body (single call or batch) through worker `id` to `url`. */
export async function rpcViaWorker(
  page: Page,
  id: string,
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<RpcOutcome> {
  const result = await page.evaluate((request) => window.e2e.fetch(request), {
    id,
    url,
    method: "POST",
    headers: [["content-type", "application/json"]] as [string, string][],
    body: JSON.stringify(body),
    timeoutMs,
  });
  if (!result.ok || result.bodyText === undefined) return { result };
  try {
    return { result, json: JSON.parse(result.bodyText) as unknown };
  } catch {
    return { result };
  }
}

export function rpcCall(method: string, params: unknown[] = [], id = 1): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, params };
}

/** The `result` of a single JSON-RPC reply, or undefined. */
export function rpcResult(json: unknown): unknown {
  return typeof json === "object" && json !== null ? (json as { result?: unknown }).result : undefined;
}

/**
 * The egress check (TST-562 .03): watches a guarded browser context from before
 * its first page exists, on three layers, and reports everything outside the
 * allowlist (host page, resolver, specifier RPC).
 *   - proxy: the recording forward proxy every request of the context goes
 *     through, loopback included: HTTP(S) and WebSockets from pages, sandboxed
 *     frames and Web Workers.
 *   - cdp-request: Playwright's context `request` events (HTTP(S) only).
 *   - cdp-websocket: Playwright's page `websocket` events (page-level sockets).
 * WebRTC traffic (the KPS transport) does not pass through either and is out of
 * scope here; NetLog and packet capture cover it (TST-562 .01/.04).
 */
export class EgressMonitor {
  readonly #events: EgressEvent[] = [];
  readonly #started = Date.now();
  readonly #pages = new Set<Page>();
  readonly #onRequest = (request: Request): void => {
    const url = request.url();
    this.#record("cdp-request", /^wss?:/iu.test(url) ? "websocket" : "http", url, request.method());
  };
  readonly #onWebSocket = (socket: WebSocket): void => {
    this.#record("cdp-websocket", "websocket", socket.url());
  };
  readonly #onPage = (page: Page): void => {
    this.#pages.add(page);
    page.on("websocket", this.#onWebSocket);
  };

  constructor(
    private readonly context: BrowserContext,
    private readonly proxy: EgressProxy,
    readonly policy: EgressPolicy,
  ) {
    context.on("request", this.#onRequest);
    context.on("page", this.#onPage);
    for (const page of context.pages()) this.#onPage(page);
  }

  #record(layer: EgressLayer, kind: EgressKind, target: string, method?: string): void {
    this.#events.push({ layer, kind, target, atMs: Date.now() - this.#started, ...(method === undefined ? {} : { method }) });
  }

  /** Every observed event: proxy first, then the CDP layers. */
  events(layer?: EgressLayer): EgressEvent[] {
    const all = [...this.proxy.events, ...this.#events];
    return layer === undefined ? all : all.filter((event) => event.layer === layer);
  }

  /** Events outside the allowlist; a KPS-only worker leaves this empty. */
  violations(): EgressEvent[] {
    return violations(this.policy, this.events());
  }

  /** Human-readable violations, for assertion messages. */
  describeViolations(): string {
    return describeEvents(this.violations()).join("\n");
  }

  stop(): void {
    this.context.off("request", this.#onRequest);
    this.context.off("page", this.#onPage);
    for (const page of this.#pages) page.off("websocket", this.#onWebSocket);
    this.#pages.clear();
  }
}

/** IPv4 addresses on loopback interfaces (WSL2 adds 10.255.255.254 next to 127.0.0.1). */
export function loopbackIpv4Addresses(): string[] {
  return Object.entries(networkInterfaces())
    .flatMap(([, entries]) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && entry.internal)
    .map((entry) => entry.address);
}

/** First non-internal IPv4 address (eth0 and the like), if any. */
export function externalIpv4(): string | undefined {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
}
