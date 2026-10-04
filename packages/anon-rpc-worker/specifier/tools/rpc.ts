// JSON-RPC clients with the trust boundary in the type: `readOnlyRpc` can only call methods that read chain
// state, so nothing built on it can send a transaction; `localChainRpc` can send, but only to a loopback node
// (the anvil instances these tools start themselves).

export type HarnessRpcProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

export interface RpcClient {
  readonly url: string;
  request(method: string, params?: readonly unknown[]): Promise<unknown>;
}

export class RpcError extends Error {
  readonly method: string;
  readonly url: string;
  readonly code: number | undefined;

  constructor(method: string, url: string, detail: string, code?: number) {
    super(`${method} via ${redactUrl(url)} failed: ${detail}`);
    this.name = "RpcError";
    this.method = method;
    this.url = url;
    this.code = code;
  }
}

/** Methods that only read chain state (eth_estimateGas and eth_call simulate; neither changes anything). */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "net_version",
]);

export type RpcOptions = {
  /** Per-request timeout. */
  timeoutMs: number;
};

export const DEFAULT_RPC_OPTIONS: RpcOptions = { timeoutMs: 30_000 };

/** API keys sometimes live in RPC URL paths or queries; keep only scheme, host and port in messages. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const hidden = u.pathname !== "/" || u.search !== "";
    return `${u.protocol}//${u.host}${hidden ? "/…" : ""}`;
  } catch {
    return "<unparseable RPC URL>";
  }
}

type JsonRpcResponse = {
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class HttpJsonRpc implements RpcClient {
  readonly url: string;
  readonly #options: RpcOptions;
  #nextId = 1;

  constructor(url: string, options: RpcOptions) {
    this.url = url;
    this.#options = options;
  }

  async request(method: string, params: readonly unknown[] = []): Promise<unknown> {
    const id = this.#nextId++;
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(this.#options.timeoutMs),
      });
    } catch (e) {
      const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      throw new RpcError(method, this.url, `no response within ${this.#options.timeoutMs} ms (${reason})`);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new RpcError(method, this.url, `HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RpcError(method, this.url, `response is not JSON: ${text.slice(0, 200)}`);
    }
    if (!isRecord(body)) throw new RpcError(method, this.url, "response is not a JSON-RPC object");
    const parsed = body as JsonRpcResponse;
    if (parsed.error !== undefined && parsed.error !== null) {
      const code = typeof parsed.error.code === "number" ? parsed.error.code : undefined;
      const message = typeof parsed.error.message === "string" ? parsed.error.message : "unknown error";
      const data = parsed.error.data === undefined ? "" : ` data=${JSON.stringify(parsed.error.data)}`;
      throw new RpcError(method, this.url, `code ${code ?? "?"}: ${message}${data}`, code);
    }
    if (!("result" in parsed)) throw new RpcError(method, this.url, "response has neither result nor error");
    return parsed.result;
  }
}

/** A client that refuses every method outside READ_ONLY_METHODS before any byte leaves the process. */
export function readOnlyRpc(url: string, options: RpcOptions = DEFAULT_RPC_OPTIONS): RpcClient {
  const inner = new HttpJsonRpc(url, options);
  return {
    url,
    request(method: string, params?: readonly unknown[]): Promise<unknown> {
      if (!READ_ONLY_METHODS.has(method)) {
        return Promise.reject(
          new RpcError(
            method,
            url,
            "refused: not a read-only method, and these tools never send transactions to a public chain",
          ),
        );
      }
      return inner.request(method, params);
    },
  };
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A client for a local development chain (anvil). Any non-loopback URL is rejected. */
export function localChainRpc(url: string, options: RpcOptions = DEFAULT_RPC_OPTIONS): RpcClient {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new RpcError("connect", url, "not a URL");
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new RpcError(
      "connect",
      url,
      `refused: ${host} is not a loopback host; only local chains may receive transactions`,
    );
  }
  return new HttpJsonRpc(url, options);
}

/** The EIP-1193-shaped object the anon-rpc harness reads specifiers through. */
export function harnessProvider(rpc: RpcClient): HarnessRpcProvider {
  return { request: ({ method, params }) => rpc.request(method, params ?? []) };
}

export function expectHex(value: unknown, what: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new Error(`${what}: expected a 0x-prefixed hex string, got ${JSON.stringify(value)}`);
  }
  return value as `0x${string}`;
}

export function hexToBigInt(value: unknown, what: string): bigint {
  const hex = expectHex(value, what);
  return hex === "0x" ? 0n : BigInt(hex);
}

export function toQuantity(value: bigint): `0x${string}` {
  return `0x${value.toString(16)}`;
}

/** Polls for a transaction receipt (a local node may answer eth_sendTransaction before the block is sealed). */
export async function waitForReceipt(
  rpc: RpcClient,
  txHash: string,
  timeoutMs: number,
  pollMs = 50,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await rpc.request("eth_getTransactionReceipt", [txHash]);
    if (typeof receipt === "object" && receipt !== null) return receipt as Record<string, unknown>;
    if (Date.now() > deadline) {
      throw new RpcError("eth_getTransactionReceipt", rpc.url, `no receipt for ${txHash} within ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
