---
sidebar_position: 7
title: Configuration
---

# Configuration

Pass options to `NoxClient.connect()` to control how the SDK discovers nodes, verifies the network, and handles requests.

```ts
const client = await NoxClient.connect({
  seeds: ["https://seed.example.com"],
  ethRpcUrl: "https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY",
  registryAddress: "0x8626aF80db409BeD3C19871FAdf9b0Ce7Aa641Bc",
  timeoutMs: 30_000,
  topologyRefreshMs: 60_000,
  surbsPerRequest: 10,
  fecRatio: 0.3,
  powDifficulty: 0,
});
```

## Options

### `seeds`

**Type:** `string[]`  - **Default:** `[]`

Seed node URLs for topology discovery. The SDK tries these first, then falls back to the default seed API (`api.hisoka.io/seed`).

Set this if you're running your own seed node or need deterministic bootstrapping in CI/tests.

### `ethRpcUrl`

**Type:** `string`  - **Default:** `""`

Ethereum RPC endpoint for on-chain topology verification. When set alongside `registryAddress`, the SDK fetches the topology fingerprint from the NoxRegistry contract and compares it to the seed node's topology.

This catches compromised or stale seed nodes. If the fingerprints don't match, `connect()` throws a `TopologyVerificationFailed` error.

### `registryAddress`

**Type:** `string`  - **Default:** `""`

Address of the NoxRegistry contract. Only used when `ethRpcUrl` is also set. See [Deployments](./deployments) for the current address.

### `timeoutMs`

**Type:** `number`  - **Default:** `30000`

Per-request timeout in milliseconds. Applies to `rpcCall`, `broadcastSignedTransaction`, `httpRequest`, and other request methods.

Mixnet requests have inherent latency from three hops plus any mixing delays. If you're seeing timeouts on complex calls (large `eth_getLogs` ranges, heavy contract reads), increase this. For simple calls like `eth_blockNumber`, the default is generous.

### `topologyRefreshMs`

**Type:** `number`  - **Default:** `60000`

How often the SDK re-fetches the node list from the seed node. The network topology can change as nodes join, leave, or get slashed.

Lower values mean faster reaction to node changes but more background traffic. In most cases, 60 seconds is fine. For long-running processes that need high availability, consider 30 seconds.

### `surbsPerRequest`

**Type:** `number`  - **Default:** `10`

Number of SURBs (Single-Use Reply Blocks) included with each request. Each SURB can carry ~30 KB of response data, so 10 SURBs support responses up to ~300 KB.

The SDK also uses adaptive budgeting  - it tracks response sizes per operation and adjusts SURB counts automatically. This default is the starting point before the SDK has history.

Increase this if your first request to a new endpoint returns a large response and you can't use `expectedResponseBytes` to hint the size.

### `fecRatio`

**Type:** `number`  - **Default:** `0.3`

Forward error correction redundancy ratio (0.0–1.0). A ratio of 0.3 means 30% extra redundancy fragments are generated.

FEC allows the client to reconstruct a response even if some fragments are lost in transit. Higher values tolerate more loss but increase bandwidth. On a reliable connection, 0.2 is fine. On lossy networks (mobile, unstable WiFi), try 0.5.

### `powDifficulty`

**Type:** `number`  - **Default:** `0`

Proof-of-work difficulty for Sphinx packets. The network can require PoW to prevent spam. `0` means no PoW (typical for testnet). In production, the SDK reads the required difficulty from the topology and uses it automatically  - you rarely need to set this manually.

### `dangerouslySkipFingerprintCheck`

**Type:** `boolean`  - **Default:** `false`

Skip topology fingerprint self-consistency verification. The SDK normally verifies that the topology data is internally consistent (the fingerprint matches the node list).

:::warning
Only use this for local development with a test mesh where you control all nodes. In any other context, this disables a critical safety check.
:::

## Defaults

With no options, the SDK:

1. Resolves seed nodes via DNS
2. Fetches the topology from the first reachable seed
3. Verifies topology self-consistency (no on-chain check)
4. Refreshes the node list every 60 seconds
5. Uses PoW difficulty from the network (or 0 if not set)

```ts
const client = await NoxClient.connect();
```

## On-chain verification

For stronger security, verify the topology against the on-chain registry:

```ts
const client = await NoxClient.connect({
  ethRpcUrl: "https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY",
  registryAddress: "0x8626aF80db409BeD3C19871FAdf9b0Ce7Aa641Bc",
});
```

The SDK compares the topology fingerprint against the smart contract. If they don't match, connection fails with `TopologyVerificationFailed`.
