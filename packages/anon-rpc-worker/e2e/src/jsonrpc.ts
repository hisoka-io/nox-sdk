// Minimal JSON-RPC 2.0 client for the local anvil chains.

import { TestbedError } from "./errors.js";

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

let nextId = 1;

export function jsonRpcRequest(method: string, params: readonly unknown[] = []): JsonRpcRequest {
  return { jsonrpc: "2.0", id: nextId++, method, params };
}

/** POST one JSON-RPC call and return its `result`; throws "rpc" errors with the endpoint named. */
export async function jsonRpc(
  url: string,
  method: string,
  params: readonly unknown[] = [],
  timeoutMs = 15_000,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(jsonRpcRequest(method, params)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new TestbedError("rpc", `${method} at ${url} failed to connect: ${String(error)}`, {
      cause: error,
    });
  }
  const text = await response.text();
  if (!response.ok) {
    throw new TestbedError("rpc", `${method} at ${url}: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TestbedError("rpc", `${method} at ${url}: reply is not JSON: ${text.slice(0, 200)}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new TestbedError("rpc", `${method} at ${url}: reply is not an object`);
  }
  const reply = parsed as { result?: unknown; error?: { code?: unknown; message?: unknown } };
  if (reply.error !== undefined) {
    throw new TestbedError(
      "rpc",
      `${method} at ${url}: error ${String(reply.error.code)} ${String(reply.error.message)}`,
    );
  }
  return reply.result;
}

/** Narrow a JSON-RPC result to a 0x-prefixed hex string. */
export function expectHex(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/u.test(value)) {
    throw new TestbedError("rpc", `${what}: expected a 0x hex string, got ${JSON.stringify(value)}`);
  }
  return value;
}
