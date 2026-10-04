// Spec helpers: JSON-RPC through a booted worker, an HTTP request monitor for
// "no ambient network" assertions, and host network facts for the KPS probe.

import { networkInterfaces } from "node:os";
import type { BrowserContext, Page, Request } from "@playwright/test";
import type { FetchResult } from "../../page/api.js";

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

/** Records every HTTP(S) request the browser context makes (pages, frames, workers). */
export class RequestMonitor {
  readonly #urls: string[] = [];
  readonly #onRequest = (request: Request): void => {
    this.#urls.push(`${request.method()} ${request.url()}`);
  };

  constructor(private readonly context: BrowserContext) {
    context.on("request", this.#onRequest);
  }

  get requests(): readonly string[] {
    return this.#urls;
  }

  /** Requests whose URL starts with any of `prefixes`. */
  matching(prefixes: readonly string[]): string[] {
    return this.#urls.filter((entry) => {
      const url = entry.slice(entry.indexOf(" ") + 1);
      return prefixes.some((prefix) => url.startsWith(prefix));
    });
  }

  stop(): void {
    this.context.off("request", this.#onRequest);
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
