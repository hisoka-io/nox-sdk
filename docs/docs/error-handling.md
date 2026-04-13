---
sidebar_position: 8
title: Error Handling
---

# Error Handling

Every SDK error is a `NoxClientError` with a machine-readable `code` and an optional `cause`.

```ts
import { NoxClientError, NoxClientErrorCode } from "@hisoka-io/nox-client";

try {
  await client.rpcCall("eth_blockNumber", []);
} catch (err) {
  if (err instanceof NoxClientError) {
    console.error(`[${err.code}] ${err.message}`);
    if (err.cause) console.error("Cause:", err.cause);
  }
}
```

## Error codes

| Code | When it happens |
|------|----------------|
| `TOPOLOGY_FETCH_FAILED` | Can't reach any seed node, or the response is malformed |
| `TOPOLOGY_VERIFICATION_FAILED` | Topology fingerprint doesn't match the on-chain registry |
| `NO_NODES_AVAILABLE` | The topology has no nodes, or not enough nodes to build a 3-hop route |
| `PACKET_BUILD_FAILED` | Sphinx packet encoding failed (usually a WASM issue) |
| `TRANSPORT_FAILED` | Network error sending/receiving, or the RPC returned an error |
| `RESPONSE_TIMEOUT` | Request exceeded `timeoutMs` without a complete response |
| `DECRYPTION_FAILED` | SURB response couldn't be decrypted or decoded |
| `WASM_NOT_INITIALIZED` | WASM module didn't load before a crypto operation was attempted |
| `INVALID_CONFIG` | Bad config parameter (e.g., `to` address isn't 20 bytes) |

## Common failure modes

### Connection failures

```ts
try {
  const client = await NoxClient.connect();
} catch (err) {
  if (err instanceof NoxClientError) {
    switch (err.code) {
      case NoxClientErrorCode.TopologyFetchFailed:
        // Seed nodes unreachable  - network issue or all seeds down
        break;
      case NoxClientErrorCode.TopologyVerificationFailed:
        // On-chain fingerprint mismatch  - possible tampering
        break;
      case NoxClientErrorCode.NoNodesAvailable:
        // Topology fetched but empty or insufficient nodes
        break;
      case NoxClientErrorCode.WasmNotInitialized:
        // WASM failed to load  - bundler issue or missing wasm file
        break;
    }
  }
}
```

### Request failures

```ts
try {
  await client.rpcCall("eth_getBalance", [addr, "latest"]);
} catch (err) {
  if (err instanceof NoxClientError) {
    switch (err.code) {
      case NoxClientErrorCode.ResponseTimeout:
        // Request took too long  - increase timeoutMs or check network
        break;
      case NoxClientErrorCode.TransportFailed:
        // Entry node unreachable, or exit node returned an RPC error
        // Check err.cause for the underlying error
        break;
      case NoxClientErrorCode.DecryptionFailed:
        // Response fragments couldn't be reassembled
        break;
    }
  }
}
```

### RPC errors

When the exit node successfully contacts the RPC provider but the provider returns an error (invalid params, execution reverted), you get a `TRANSPORT_FAILED` error. The RPC error details are in `err.cause`:

```ts
try {
  await client.rpcCall("eth_call", [{ to: "0xBadAddress", data: "0x" }, "latest"]);
} catch (err) {
  if (err instanceof NoxClientError && err.code === NoxClientErrorCode.TransportFailed) {
    console.error("RPC error:", err.cause);
  }
}
```

## Retry patterns

Some errors are transient and worth retrying. Others indicate a configuration or network problem.

### Retryable errors

| Code | Retry? | Strategy |
|------|--------|----------|
| `RESPONSE_TIMEOUT` | Yes | Retry with the same or increased timeout |
| `TRANSPORT_FAILED` | Maybe | Retry if it's a network blip; don't retry RPC errors (reverts, invalid params) |
| `TOPOLOGY_FETCH_FAILED` | Yes | Retry after a delay  - seed nodes may be temporarily down |
| `DECRYPTION_FAILED` | Yes | Rare, but a different route may succeed |

### Non-retryable errors

| Code | Why |
|------|-----|
| `TOPOLOGY_VERIFICATION_FAILED` | The seed node and on-chain state disagree  - investigate before retrying |
| `NO_NODES_AVAILABLE` | The network is empty  - retrying won't help until nodes come online |
| `INVALID_CONFIG` | Fix the config and reconnect |
| `WASM_NOT_INITIALIZED` | Fix the WASM loading issue (bundler config, missing file) |
| `PACKET_BUILD_FAILED` | Usually a bug  - check payload size and WASM state |

### Simple retry helper

```ts
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  delayMs = 1000
): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (
        err instanceof NoxClientError &&
        (err.code === NoxClientErrorCode.ResponseTimeout ||
         err.code === NoxClientErrorCode.DecryptionFailed)
      ) {
        if (i < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
          continue;
        }
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

const block = await withRetry(() => client.blockNumber());
```
