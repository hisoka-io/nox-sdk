---
sidebar_position: 2
title: Quickstart
---

# Quickstart

Send your first private transaction through the Nox mixnet.

## Install

```bash
npm install @hisoka-io/nox-client @hisoka-io/nox-wasm
```

## 1. Connect

```ts
import { NoxClient } from "@hisoka-io/nox-client";

const client = await NoxClient.connect();
```

This fetches the network topology, loads the WASM crypto module, and connects you to the mixnet.

## 2. Read from the chain (anonymous RPC)

```ts
const block = await client.rpcCall("eth_blockNumber", []);

const balance = await client.rpcCall("eth_getBalance", [
  "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "latest",
]);
```

Any `eth_*` JSON-RPC method works. The RPC provider sees the exit node's IP, not yours.

## 3. Send a transaction privately

Sign a transaction with your wallet, then broadcast it through the mixnet:

```ts
const signedTx = await wallet.signTransaction({
  to: "0xRecipientAddress",
  value: parseEther("0.1"),
  gasLimit: 21000n,
});

const raw = Uint8Array.from(Buffer.from(signedTx.slice(2), "hex"));
await client.broadcastSignedTransaction(raw);
```

Your transaction is encrypted into Sphinx packets, routed through three relay nodes, and submitted by the exit node. The RPC provider never sees your IP.

## 4. Disconnect

```ts
client.disconnect();
```

Stops background topology refresh, closes WebSocket connections, and rejects any pending requests. Always call this when you're done  - otherwise background timers keep the process alive.

## Full example

```ts
import { NoxClient, NoxClientError } from "@hisoka-io/nox-client";

async function main() {
  const client = await NoxClient.connect();

  try {
    const block = await client.blockNumber();
    console.log("Block:", block);

    const signedTx = await wallet.signTransaction(tx);
    const raw = Uint8Array.from(Buffer.from(signedTx.slice(2), "hex"));
    await client.broadcastSignedTransaction(raw);
  } catch (err) {
    if (err instanceof NoxClientError) {
      console.error(`NOX error [${err.code}]:`, err.message);
      if (err.cause) console.error("Cause:", err.cause);
    } else {
      throw err;
    }
  } finally {
    client.disconnect();
  }
}

main();
```

:::tip
Wrap your work in `try/finally` and call `client.disconnect()` in the `finally` block. This ensures cleanup happens even if a request fails.
:::

## Error handling

Every SDK error is a `NoxClientError` with a machine-readable `code`:

```ts
import { NoxClient, NoxClientError, NoxClientErrorCode } from "@hisoka-io/nox-client";

try {
  const client = await NoxClient.connect();
} catch (err) {
  if (err instanceof NoxClientError) {
    switch (err.code) {
      case NoxClientErrorCode.TopologyFetchFailed:
        console.error("Can't reach seed nodes  - check your network");
        break;
      case NoxClientErrorCode.NoNodesAvailable:
        console.error("Network has no active nodes");
        break;
      case NoxClientErrorCode.WasmNotInitialized:
        console.error("WASM module failed to load");
        break;
    }
  }
}
```

See [Error Handling](./error-handling) for the full error reference.

## `initNodeCrypto`

In browsers, the SDK uses the native `crypto` API automatically. In Node.js < 20 or environments where `globalThis.crypto` is not available, call `initNodeCrypto()` before connecting:

```ts
import { initNodeCrypto, NoxClient } from "@hisoka-io/nox-client";

await initNodeCrypto();
const client = await NoxClient.connect();
```

`NoxClient.connect()` calls this internally, so you only need it if you're using lower-level SDK functions (like `resolveSeedUrl` or `buildSphinxPacket`) without going through `connect()`.

## Requirements

- Node.js >= 18 or any modern browser
- Works with webpack, vite, and other bundlers
- WASM module (~175 KB gzipped) loads automatically
