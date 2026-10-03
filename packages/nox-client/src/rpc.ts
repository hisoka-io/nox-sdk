import type { NoxFetch } from "./types.js";

/** Late-bound global `fetch`, so a runtime that installs it later still works. */
export const defaultFetch: NoxFetch = (input, init) => globalThis.fetch(input, init);

export interface JsonRpcCall {
  readonly method: string;
  readonly params: readonly unknown[];
}

/** Calls per JSON-RPC batch. Public endpoints commonly accept 50 to 100. */
export const MAX_RPC_BATCH_SIZE = 50;
/** Batches (or single calls, when batching is unavailable) in flight at once. */
export const RPC_CONCURRENCY = 4;
export const RPC_TIMEOUT_MS = 10_000;

/**
 * Run read-only JSON-RPC calls and return their hex results in input order.
 *
 * Calls go out as JSON-RPC batches of at most `MAX_RPC_BATCH_SIZE`. An endpoint
 * that rejects batches (a non-array reply, or a client error such as HTTP 400,
 * 405 or 413) gets the same calls one by one, at most `RPC_CONCURRENCY` at a
 * time. Rate limiting (HTTP 429), timeouts (408) and server errors (5xx) are
 * reported as errors instead, so a throttled endpoint is not sent more
 * requests. The first RPC error rejects the whole set with that error's
 * message.
 */
export async function jsonRpcCalls(
  ethRpcUrl: string,
  calls: readonly JsonRpcCall[],
  fetchImpl: NoxFetch = defaultFetch,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<string[]> {
  if (calls.length === 0) return [];
  if (calls.length === 1) {
    return [await jsonRpcCall(ethRpcUrl, calls[0]!, fetchImpl, timeoutMs)];
  }
  const chunks: JsonRpcCall[][] = [];
  for (let start = 0; start < calls.length; start += MAX_RPC_BATCH_SIZE) {
    chunks.push(calls.slice(start, start + MAX_RPC_BATCH_SIZE));
  }
  const results = await mapWithConcurrency(chunks, RPC_CONCURRENCY, (chunk) =>
    jsonRpcBatch(ethRpcUrl, chunk, fetchImpl, timeoutMs)
  );
  return results.flat();
}

/** One JSON-RPC call. Throws a plain `Error` carrying the RPC error message. */
export async function jsonRpcCall(
  ethRpcUrl: string,
  call: JsonRpcCall,
  fetchImpl: NoxFetch = defaultFetch,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<string> {
  const json = await postJson(
    ethRpcUrl,
    { jsonrpc: "2.0", id: 1, method: call.method, params: call.params },
    fetchImpl,
    timeoutMs,
  );
  if (!json.ok) {
    throw new Error(`HTTP ${json.status}`);
  }
  return hexResult(json.body);
}

class BatchUnsupported extends Error {}

async function jsonRpcBatch(
  ethRpcUrl: string,
  calls: readonly JsonRpcCall[],
  fetchImpl: NoxFetch,
  timeoutMs: number,
): Promise<string[]> {
  if (calls.length === 1) {
    return [await jsonRpcCall(ethRpcUrl, calls[0]!, fetchImpl, timeoutMs)];
  }
  try {
    const json = await postJson(
      ethRpcUrl,
      calls.map((call, id) => ({
        jsonrpc: "2.0",
        id,
        method: call.method,
        params: call.params,
      })),
      fetchImpl,
      timeoutMs,
    );
    if (!json.ok && !batchRejectedByStatus(json.status)) {
      throw new Error(`HTTP ${json.status}`);
    }
    if (!json.ok || !Array.isArray(json.body)) {
      throw new BatchUnsupported();
    }
    const byId = new Map<number, unknown>();
    for (const entry of json.body) {
      if (isRecord(entry) && typeof entry.id === "number") {
        byId.set(entry.id, entry);
      }
    }
    return calls.map((_, id) => {
      if (!byId.has(id)) {
        throw new Error(`RPC batch response is missing call ${id}`);
      }
      return hexResult(byId.get(id));
    });
  } catch (error) {
    if (!(error instanceof BatchUnsupported)) throw error;
    return mapWithConcurrency(calls, RPC_CONCURRENCY, (call) =>
      jsonRpcCall(ethRpcUrl, call, fetchImpl, timeoutMs)
    );
  }
}

/**
 * Whether an HTTP status means the endpoint refused the batch itself, so the
 * calls are worth retrying one by one. 408, 429 and 5xx mean the endpoint is
 * slow, throttling or failing, and more requests would not help.
 */
function batchRejectedByStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function postJson(
  url: string,
  body: unknown,
  fetchImpl: NoxFetch,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let parsed: unknown = undefined;
    try {
      parsed = await response.json();
    } catch {
      // A non-JSON body is reported through `ok`/`status` or the shape check.
    }
    return { ok: response.ok, status: response.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

function hexResult(entry: unknown): string {
  if (!isRecord(entry)) {
    throw new Error("RPC response is not an object");
  }
  const error = entry.error;
  if (isRecord(error) && typeof error.message === "string") {
    throw new Error(error.message);
  }
  if (typeof entry.result !== "string") {
    throw new Error("RPC response has no hex result");
  }
  return entry.result;
}

/** Map with at most `limit` promises in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
