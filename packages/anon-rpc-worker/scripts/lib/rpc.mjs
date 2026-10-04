// @ts-check
/**
 * Minimal JSON-RPC 2.0 client for build-time chain reads (snapshot.mjs and
 * verify-snapshot.mjs). The worker never uses it.
 *
 * The endpoint URL may carry an API key, so errors name only its origin.
 */

/** Tunables; every one can be overridden per client. */
export const RPC_DEFAULTS = Object.freeze({
  /** Per HTTP request. */
  timeoutMs: 30_000,
  /** Extra attempts after a transport failure, HTTP 429 or HTTP 5xx. */
  retries: 3,
  /** First retry delay; doubles on each further attempt. */
  retryBaseDelayMs: 500,
  /** Calls per JSON-RPC batch request. */
  batchSize: 20,
});

/** Typed RPC failure. */
export class RpcError extends Error {
  /**
   * @param {string} message
   * @param {"transport" | "http" | "rpc" | "malformed"} code
   * @param {{ rpcCode?: number, rpcMessage?: string, status?: number }} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.details = details;
  }
}

/**
 * @typedef {object} RpcCall
 * @property {string} method
 * @property {unknown[]} params
 */

/**
 * @typedef {object} RpcClient
 * @property {string} url     the endpoint (keep out of logs)
 * @property {string} origin  scheme and host, safe to print
 * @property {(method: string, params: unknown[]) => Promise<unknown>} call
 * @property {(calls: RpcCall[]) => Promise<unknown[]>} batch  results in call order
 * @property {typeof fetch} fetch  fetch with this client's timeout and retry policy, for
 *                                 code that builds its own JSON-RPC requests (the SDK verifier)
 */

/**
 * @typedef {object} RpcClientOptions
 * @property {string} url
 * @property {number} [timeoutMs]
 * @property {number} [retries]
 * @property {number} [retryBaseDelayMs]
 * @property {number} [batchSize]
 * @property {typeof fetch} [fetchImpl]
 */

/**
 * Scheme and host of an endpoint URL, without path, query or credentials.
 * @param {string} url
 * @returns {string}
 */
export function endpointOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    throw new RpcError("the RPC URL is not a valid absolute URL", "transport");
  }
}

/**
 * @param {RpcClientOptions} options
 * @returns {RpcClient}
 */
export function createRpcClient(options) {
  const origin = endpointOrigin(options.url);
  const protocol = new URL(options.url).protocol;
  if (protocol !== "https:" && protocol !== "http:") {
    throw new RpcError(`unsupported RPC URL scheme ${protocol} (use https: or http:)`, "transport");
  }
  const timeoutMs = positiveInteger(options.timeoutMs ?? RPC_DEFAULTS.timeoutMs, "timeoutMs");
  const retries = nonNegativeInteger(options.retries ?? RPC_DEFAULTS.retries, "retries");
  const retryBaseDelayMs = nonNegativeInteger(
    options.retryBaseDelayMs ?? RPC_DEFAULTS.retryBaseDelayMs,
    "retryBaseDelayMs",
  );
  const batchSize = positiveInteger(options.batchSize ?? RPC_DEFAULTS.batchSize, "batchSize");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let nextId = 1;

  /**
   * POST one JSON body with retries; returns the parsed JSON response.
   * @param {unknown} body
   * @param {string} what  method name(s), for messages
   * @returns {Promise<unknown>}
   */
  async function post(body, what) {
    /** @type {RpcError | undefined} */
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await sleep(retryBaseDelayMs * 2 ** (attempt - 1));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      /** @type {Response} */
      let response;
      try {
        response = await fetchImpl(options.url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        const reason = controller.signal.aborted
          ? `timed out after ${timeoutMs} ms`
          : error instanceof Error ? error.message : String(error);
        lastError = new RpcError(`${what} to ${origin} failed: ${reason}`, "transport");
        continue;
      }
      let text;
      try {
        text = await response.text();
      } catch (error) {
        clearTimeout(timer);
        const reason = controller.signal.aborted
          ? `timed out after ${timeoutMs} ms`
          : error instanceof Error ? error.message : String(error);
        lastError = new RpcError(`${what} to ${origin}: reading the response failed: ${reason}`, "transport");
        continue;
      }
      clearTimeout(timer);
      if (response.status === 429 || response.status >= 500) {
        lastError = new RpcError(
          `${what} to ${origin} returned HTTP ${response.status}`,
          "http",
          { status: response.status },
        );
        continue;
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new RpcError(
          `${what} to ${origin} returned HTTP ${response.status} with a non-JSON body`,
          response.ok ? "malformed" : "http",
          { status: response.status },
        );
      }
    }
    throw /** @type {RpcError} */ (lastError);
  }

  /**
   * `fetch` with the client's per-request timeout, retrying transport
   * failures, HTTP 429 and HTTP 5xx like `call` does. Returns the last
   * response when every attempt was answered with a retryable status.
   * @type {typeof fetch}
   */
  async function retryingFetch(input, init) {
    /** @type {unknown} */
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await sleep(retryBaseDelayMs * 2 ** (attempt - 1));
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const response = await fetchImpl(input, { ...init, signal });
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          await response.body?.cancel();
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
      }
    }
    throw new RpcError(`request to ${origin} failed after ${retries + 1} attempts: ${errorText(lastError)}`, "transport");
  }

  /**
   * @param {string} method
   * @param {unknown[]} params
   * @returns {Promise<unknown>}
   */
  async function call(method, params) {
    const id = nextId++;
    const reply = await post({ jsonrpc: "2.0", id, method, params }, method);
    return unwrap(reply, method, id);
  }

  /**
   * @param {RpcCall[]} calls
   * @returns {Promise<unknown[]>}
   */
  async function batch(calls) {
    /** @type {unknown[]} */
    const results = [];
    for (let start = 0; start < calls.length; start += batchSize) {
      const chunk = calls.slice(start, start + batchSize);
      const ids = chunk.map(() => nextId++);
      const label = `batch of ${chunk.length} (${[...new Set(chunk.map((c) => c.method))].join(", ")})`;
      const reply = await post(
        chunk.map((c, i) => ({ jsonrpc: "2.0", id: ids[i], method: c.method, params: c.params })),
        label,
      );
      if (!Array.isArray(reply)) {
        // The endpoint refused the batch as a whole: fall back to single calls.
        for (const c of chunk) results.push(await call(c.method, c.params));
        continue;
      }
      /** @type {Map<unknown, unknown>} */
      const byId = new Map();
      for (const item of reply) {
        if (typeof item === "object" && item !== null && "id" in item) byId.set(item.id, item);
      }
      chunk.forEach((c, i) => {
        const id = ids[i];
        if (!byId.has(id)) {
          throw new RpcError(`${label} to ${origin}: no reply for ${c.method} (id ${String(id)})`, "malformed");
        }
        results.push(unwrap(byId.get(id), c.method, id));
      });
    }
    return results;
  }

  /**
   * @param {unknown} reply
   * @param {string} method
   * @param {unknown} id
   * @returns {unknown}
   */
  function unwrap(reply, method, id) {
    if (typeof reply !== "object" || reply === null) {
      throw new RpcError(`${method} to ${origin}: reply is not a JSON object`, "malformed");
    }
    const fields = /** @type {Record<string, unknown>} */ (reply);
    if (fields["id"] !== id) {
      throw new RpcError(`${method} to ${origin}: reply id ${String(fields["id"])} does not match request id ${String(id)}`, "malformed");
    }
    if (fields["error"] !== undefined && fields["error"] !== null) {
      const error = /** @type {Record<string, unknown>} */ (fields["error"]);
      const rpcCode = typeof error["code"] === "number" ? error["code"] : undefined;
      const rpcMessage = typeof error["message"] === "string" ? error["message"] : JSON.stringify(error);
      /** @type {{ rpcCode?: number, rpcMessage?: string }} */
      const details = { rpcMessage };
      if (rpcCode !== undefined) details.rpcCode = rpcCode;
      throw new RpcError(
        `${method} to ${origin} failed with JSON-RPC error ${rpcCode ?? "?"}: ${rpcMessage}`,
        "rpc",
        details,
      );
    }
    if (!("result" in fields)) {
      throw new RpcError(`${method} to ${origin}: reply has neither result nor error`, "malformed");
    }
    return fields["result"];
  }

  return { url: options.url, origin, call, batch, fetch: retryingFetch };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {number} value
 * @param {string} name
 * @returns {number}
 */
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RpcError(`${name} must be a positive integer, got ${value}`, "transport");
  }
  return value;
}

/**
 * @param {number} value
 * @param {string} name
 * @returns {number}
 */
function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RpcError(`${name} must be a non-negative integer, got ${value}`, "transport");
  }
  return value;
}
