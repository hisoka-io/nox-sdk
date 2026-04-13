---
sidebar_position: 4
title: RPC Calls
---

# RPC Calls

Route any JSON-RPC call through the mixnet. The RPC provider sees the exit node, not your IP or wallet.

## Generic RPC call

```ts
const result = await client.rpcCall(method, params);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `method` | `string` | JSON-RPC method name |
| `params` | `unknown` | Method parameters |
| `rpcUrlOrOpts` | `string \| object?` | Target RPC URL, or options object |

When passing an options object:

| Option | Type | Description |
|--------|------|-------------|
| `rpcUrl` | `string?` | Target RPC endpoint |
| `expectedResponseBytes` | `number?` | Expected response size for SURB allocation |

**Returns:** Parsed JSON-RPC result.

```ts
// Simple  - use exit node's default RPC
const block = await client.rpcCall("eth_blockNumber", []);

// Custom RPC endpoint
const block = await client.rpcCall("eth_blockNumber", [], "https://rpc.ankr.com/eth");

// With options  - useful for large responses
const logs = await client.rpcCall("eth_getLogs", [filter], {
  rpcUrl: "https://rpc.ankr.com/eth",
  expectedResponseBytes: 50_000,
});
```

## Convenience methods

The SDK provides typed wrappers for common RPC calls.

### blockNumber

```ts
const block: number = await client.blockNumber();
```

Returns the current block number as a `number` (parsed from hex).

### estimateGas

```ts
const gas: string = await client.estimateGas(
  "0xContractAddress",
  "0xCalldata"
);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `to` | `string` | Target contract address |
| `data` | `string` | Hex-encoded calldata |

Returns the gas estimate as a hex string.

### getTransactionReceipt

```ts
const receipt = await client.getTransactionReceipt(
  "0xTransactionHash"
);
```

Returns the receipt object, or `null` if the transaction hasn't been mined yet.

```ts
// Poll until mined
let receipt = null;
while (!receipt) {
  receipt = await client.getTransactionReceipt(txHash);
  if (!receipt) await new Promise((r) => setTimeout(r, 2000));
}
console.log("Status:", receipt.status);
```

### getLogs

```ts
const logs = await client.getLogs({
  address: "0xContractAddress",
  fromBlock: "0x0",
  toBlock: "latest",
  topics: ["0xEventSignatureHash"],
});
```

| Option | Type | Description |
|--------|------|-------------|
| `address` | `string?` | Filter by contract address |
| `fromBlock` | `string?` | Start block (hex or tag) |
| `toBlock` | `string?` | End block (hex or tag) |
| `topics` | `(string \| null)[]?` | Topic filters |

Returns an array of log objects.

:::info
`getLogs` auto-estimates the SURB budget based on the block range. Large ranges produce large responses  - the SDK allocates extra SURBs to handle them.
:::

## Custom RPC endpoint

By default, the exit node uses its own configured RPC provider. You can specify a different one:

```ts
const result = await client.rpcCall(
  "eth_blockNumber",
  [],
  "https://rpc.ankr.com/eth"
);
```

The exit node validates the target URL to prevent SSRF.

## What's hidden

| Without NOX | With NOX |
|------------|----------|
| RPC provider sees your IP | Provider sees exit node IP |
| Provider links all your calls | Each request can take a different route |
| Provider sees your wallet addresses | Provider sees queries without identity |
| Timing reveals your activity | Cover traffic masks real requests |
