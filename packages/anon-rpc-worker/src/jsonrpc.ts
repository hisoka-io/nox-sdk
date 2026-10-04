/**
 * Just enough JSON-RPC awareness to size the reply path and decide whether a
 * request may be resent (ARCHITECTURE §4.6). The body is forwarded byte for
 * byte, batches included; nothing here rewrites it. Params are never logged.
 */

/** How a request is sized and retried. */
export type RpcClass = "small" | "medium" | "large" | "write" | "other";

/** Expected reply bytes per class; the SDK turns them into reply blocks. `other` uses the adaptive budget. */
export const CLASS_REPLY_BYTES: Readonly<Record<Exclude<RpcClass, "other">, number>> = Object.freeze({
  small: 30_000,
  medium: 120_000,
  large: 300_000,
  write: 30_000,
});

/** Reply-block floor for every request through the worker. */
export const MIN_SURBS = 2;

const SMALL_READS: ReadonlySet<string> = new Set([
  "eth_chainId",
  "net_version",
  "web3_clientVersion",
  "eth_blockNumber",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_blobBaseFee",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_getStorageAt",
  "eth_call",
  "eth_estimateGas",
  "eth_syncing",
]);

const MEDIUM_READS: ReadonlySet<string> = new Set([
  "eth_getCode",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_feeHistory",
  "eth_getProof",
  "eth_createAccessList",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
]);

const LARGE_READS: ReadonlySet<string> = new Set(["eth_getLogs", "eth_getBlockReceipts"]);

const WRITES: ReadonlySet<string> = new Set(["eth_sendRawTransaction"]);

const BLOCK_METHODS: ReadonlySet<string> = new Set(["eth_getBlockByNumber", "eth_getBlockByHash"]);

/** What the worker needs to know about one request. */
export interface RequestProfile {
  readonly rpcClass: RpcClass;
  /** `undefined` lets the SDK's adaptive budget size the reply (`other`). */
  readonly expectedResponseBytes: number | undefined;
  /** Small and medium reads only: a resend cannot change the outcome. */
  readonly retryable: boolean;
  /**
   * Adaptive budget key: `http:jsonrpc:<method>` for the methods the class
   * table names, `http:jsonrpc:batch`, or `http:other` for everything else
   * (so an app cannot grow the SDK's budget map without bound).
   */
  readonly opKey: string;
  /** JSON-RPC method of a single call (for debug logs), `batch`, or undefined. */
  readonly method: string | undefined;
}

/**
 * Adaptive-budget key for requests outside the class table: non-JSON-RPC
 * bodies and stateful or unlisted methods share it (ARCHITECTURE §4.6).
 */
export const OTHER_OP_KEY = "http:other";

const OTHER: RequestProfile = Object.freeze({
  rpcClass: "other",
  expectedResponseBytes: undefined,
  retryable: false,
  opKey: OTHER_OP_KEY,
  method: undefined,
});

/** Class of one JSON-RPC call. */
export function classifyCall(method: string, params: unknown): RpcClass {
  if (BLOCK_METHODS.has(method) && Array.isArray(params) && params[1] === true) return "large";
  if (SMALL_READS.has(method)) return "small";
  if (MEDIUM_READS.has(method)) return "medium";
  if (LARGE_READS.has(method)) return "large";
  if (WRITES.has(method)) return "write";
  return "other";
}

/**
 * Profile a request. Only a `POST` with a JSON body (a content type containing
 * `json`, or a body that starts with `{` or `[`) is read as JSON-RPC; anything
 * else, and any JSON that is not JSON-RPC, is `other`.
 */
export function profileRequest(method: string, contentType: string | undefined, body: Uint8Array): RequestProfile {
  if (method !== "POST" || body.length === 0) return OTHER;
  const first = firstNonSpace(body);
  const looksJson = (contentType !== undefined && contentType.toLowerCase().includes("json")) ||
    first === 0x7b || first === 0x5b;
  if (!looksJson) return OTHER;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return OTHER;
  }
  const batch = Array.isArray(value);
  const calls: unknown[] = batch ? (value as unknown[]) : [value];
  if (calls.length === 0) return OTHER;
  const classes: RpcClass[] = [];
  let firstMethod: string | undefined;
  for (const call of calls) {
    if (typeof call !== "object" || call === null) return OTHER;
    const callMethod = (call as { method?: unknown }).method;
    if (typeof callMethod !== "string" || callMethod.length === 0) return OTHER;
    firstMethod ??= callMethod;
    classes.push(classifyCall(callMethod, (call as { params?: unknown }).params));
  }
  if (!batch) {
    const rpcClass = classes[0] ?? "other";
    return {
      rpcClass,
      expectedResponseBytes: rpcClass === "other" ? undefined : CLASS_REPLY_BYTES[rpcClass],
      retryable: rpcClass === "small" || rpcClass === "medium",
      opKey: rpcClass === "other" ? OTHER_OP_KEY : `http:jsonrpc:${safeMethodName(firstMethod ?? "")}`,
      method: safeMethodName(firstMethod ?? ""),
    };
  }
  const reads = classes.every((rpcClass) => rpcClass === "small" || rpcClass === "medium");
  const sized = classes.every((rpcClass) => rpcClass !== "other");
  const total = classes.reduce(
    (sum, rpcClass) => sum + (rpcClass === "other" ? 0 : CLASS_REPLY_BYTES[rpcClass]),
    0,
  );
  const rpcClass: RpcClass = !sized
    ? "other"
    : classes.includes("write")
    ? "write"
    : reads
    ? (classes.includes("medium") ? "medium" : "small")
    : "large";
  return {
    rpcClass,
    expectedResponseBytes: sized ? Math.min(total, CLASS_REPLY_BYTES.large) : undefined,
    retryable: reads,
    opKey: "http:jsonrpc:batch",
    method: "batch",
  };
}

/** Method names reach logs and budget keys; keep them short and printable. */
function safeMethodName(method: string): string {
  return /^[A-Za-z0-9_]{1,64}$/u.test(method) ? method : "nonstandard";
}

function firstNonSpace(body: Uint8Array): number | undefined {
  for (const byte of body) {
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return byte;
  }
  return undefined;
}
