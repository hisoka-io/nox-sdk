/**
 * Worker-local answers: JSON-RPC calls whose answer
 * cannot change are answered from memory instead of crossing the mixnet
 * again. Fewer queries leave the device, and a hit costs no round trip.
 *
 * What is answered locally, per upstream URL and exact params:
 *
 * - `eth_chainId` and `net_version`: memoised once a second, independently
 *   routed request through the mixnet returned the same result (the worker
 *   sends that check in the background after the first answer).
 * - Reads addressed by block hash, whose result is fixed by the hash:
 *   `eth_getBlockByHash`, `eth_getBlockReceipts`, `eth_getLogs` with a
 *   `blockHash` filter, the `…ByBlockHash…` lookups, and EIP-1898 state reads
 *   (`eth_call`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`,
 *   `eth_getTransactionCount`, `eth_getProof`) whose block is
 *   `{"blockHash": …}` without `requireCanonical`. They are kept once two
 *   separate calls returned the same result. Each call takes its own route,
 *   so a wrong answer is kept only when both calls went through exits that
 *   returned the same wrong result.
 *
 * Only single calls (not batches) with a `result` that is not null are kept;
 * errors never are, and neither is an empty list for a block-hash read: an
 * upstream that has not seen the block yet may answer `[]` for its logs or
 * receipts, and a later call returns the full list. A request with `Cache-Control: no-cache` or `no-store`
 * always goes through the mixnet. The reply carries the caller's own
 * JSON-RPC `id`. Memory is bounded by entry count and bytes (oldest out).
 */
import type { AnonFetchResponse, HeaderList } from "./spec-types.js";
import type { PreparedRequest } from "./fetch-map.js";

/** Most answers kept. */
export const LOCAL_ANSWER_MAX_ENTRIES = 512;
/** Most result bytes kept in total. */
export const LOCAL_ANSWER_MAX_BYTES = 4 * 1024 * 1024;
/** Largest single result kept. */
export const LOCAL_ANSWER_MAX_ENTRY_BYTES = 512 * 1024;
/** Matching answers needed before a content-addressed result is served locally. */
export const LOCAL_ANSWER_CONFIRMATIONS = 2;

const MEMO_METHODS: ReadonlySet<string> = new Set(["eth_chainId", "net_version"]);

/** Methods whose first param is a block hash. */
const BY_BLOCK_HASH: ReadonlySet<string> = new Set([
  "eth_getBlockByHash",
  "eth_getBlockTransactionCountByHash",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getUncleByBlockHashAndIndex",
  "eth_getUncleCountByBlockHash",
]);

/** EIP-1898 state reads: the block selector is the last param. */
const STATE_READS: ReadonlySet<string> = new Set([
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_getProof",
]);

const HASH_RE = /^0x[0-9a-fA-F]{64}$/u;

/** Why a call was or was not answered locally (for debug logs). */
export type LocalKind = "memo" | "block-hash";

interface Entry {
  readonly kind: LocalKind;
  /** The JSON text of `result`. */
  readonly result: string;
  readonly headers: HeaderList;
  confirmations: number;
}

/** A single JSON-RPC call read from a prepared request. */
interface Call {
  readonly key: string;
  readonly kind: LocalKind;
  readonly id: unknown;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export class LocalAnswers {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  /** The local answer for `request`, if one is confirmed. */
  lookup(request: PreparedRequest): { response: AnonFetchResponse; kind: LocalKind } | undefined {
    const call = cacheableCall(request);
    if (call === undefined) return undefined;
    const entry = this.entries.get(call.key);
    if (entry === undefined || !this.served(entry)) return undefined;
    this.entries.delete(call.key);
    this.entries.set(call.key, entry);
    const body = `{"jsonrpc":"2.0","id":${JSON.stringify(call.id ?? null)},"result":${entry.result}}`;
    return {
      kind: call.kind,
      response: { status: 200, headers: entry.headers.map(([name, value]) => [name, value]), body: encoder.encode(body), url: request.url },
    };
  }

  /**
   * Record a mixnet answer. Returns `verify` when the call is a memo method
   * seen for the first time: the caller sends it once more through the
   * mixnet and passes that answer here too.
   */
  observe(request: PreparedRequest, response: AnonFetchResponse): "verify" | undefined {
    const call = cacheableCall(request);
    if (call === undefined || response.status !== 200 || !(response.body instanceof Uint8Array)) return undefined;
    const result = resultOf(response.body);
    if (result === undefined || result.length > LOCAL_ANSWER_MAX_ENTRY_BYTES) return undefined;
    if (call.kind === "block-hash" && result === "[]") return undefined;
    const existing = this.entries.get(call.key);
    if (existing !== undefined) {
      if (existing.result === result) {
        existing.confirmations += 1;
      } else {
        // Two answers disagree: keep neither.
        this.remove(call.key, existing);
      }
      return undefined;
    }
    const headers = response.headers.filter(([name]) => name.toLowerCase() === "content-type");
    this.entries.set(call.key, { kind: call.kind, result, headers, confirmations: 1 });
    this.bytes += result.length;
    this.evict();
    return call.kind === "memo" ? "verify" : undefined;
  }

  /** Number of answers held (served or awaiting confirmation). */
  get size(): number {
    return this.entries.size;
  }

  private served(entry: Entry): boolean {
    return entry.confirmations >= LOCAL_ANSWER_CONFIRMATIONS;
  }

  private remove(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.bytes -= entry.result.length;
  }

  private evict(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= LOCAL_ANSWER_MAX_ENTRIES && this.bytes <= LOCAL_ANSWER_MAX_BYTES) return;
      this.remove(key, entry);
    }
  }
}

/** The call's cache key and kind, when `request` is one call whose answer is fixed. */
function cacheableCall(request: PreparedRequest): Call | undefined {
  if (request.method !== "POST" || request.profile.method === undefined || request.profile.method === "batch") {
    return undefined;
  }
  for (const [name, value] of request.headers) {
    if (name.toLowerCase() === "cache-control" && /no-cache|no-store/iu.test(value)) return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(request.body));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const call = value as { jsonrpc?: unknown; method?: unknown; params?: unknown; id?: unknown };
  if (call.jsonrpc !== "2.0" || typeof call.method !== "string" || !("id" in call)) return undefined;
  const id = call.id;
  if (id !== null && typeof id !== "string" && typeof id !== "number") return undefined;
  const params = call.params ?? [];
  const kind = classify(call.method, params);
  if (kind === undefined) return undefined;
  return { key: `${request.url}\n${call.method}\n${JSON.stringify(params)}`, kind, id };
}

function classify(method: string, params: unknown): LocalKind | undefined {
  if (MEMO_METHODS.has(method)) return Array.isArray(params) && params.length === 0 ? "memo" : undefined;
  if (!Array.isArray(params) || params.length === 0) return undefined;
  const first: unknown = params[0];
  if (BY_BLOCK_HASH.has(method)) return isHash(first) ? "block-hash" : undefined;
  if (method === "eth_getBlockReceipts") return isHash(first) || isBlockHashSelector(first) ? "block-hash" : undefined;
  if (method === "eth_getLogs") {
    if (typeof first !== "object" || first === null) return undefined;
    const filter = first as Record<string, unknown>;
    return isHash(filter["blockHash"]) && filter["fromBlock"] === undefined && filter["toBlock"] === undefined
      ? "block-hash"
      : undefined;
  }
  if (STATE_READS.has(method)) return isBlockHashSelector(params[params.length - 1]) ? "block-hash" : undefined;
  return undefined;
}

function isHash(value: unknown): boolean {
  return typeof value === "string" && HASH_RE.test(value);
}

/** EIP-1898 `{"blockHash": …}` without `requireCanonical: true` (whose answer can turn into an error after a reorg). */
function isBlockHashSelector(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const selector = value as Record<string, unknown>;
  return isHash(selector["blockHash"]) && selector["requireCanonical"] !== true && selector["blockNumber"] === undefined;
}

/** The JSON text of a successful reply's `result` (not null), else undefined. */
function resultOf(body: Uint8Array): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(body));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const reply = value as { result?: unknown; error?: unknown };
  if (reply.error !== undefined || reply.result === undefined || reply.result === null) return undefined;
  return JSON.stringify(reply.result);
}
