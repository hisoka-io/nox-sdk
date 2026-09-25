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
  registryAddress: "0xF7BFf88A1412054a001Dc4b8aCBddAd6F9b26cB6",
  timeoutMs: 30_000,
  topologyRefreshMs: 60_000,
  livenessMaxAgeMs: 180_000,
  surbsPerRequest: 10,
  fecRatio: 0.3,
  powDifficulty: 0,
});
```

## Options

### `seeds`

**Type:** `string[]`  - **Default:** `["https://api.hisoka.io/seed"]`

Seed node URLs for topology discovery. The SDK tries these first, then falls back to the default seed API (`api.hisoka.io/seed`).

Set this if you're running your own seed node or need deterministic bootstrapping in CI/tests.

### `ethRpcUrl`

**Type:** `string`  - **Default:** `""`

Ethereum RPC endpoint for on-chain topology verification. Required alongside `registryAddress` unless every
seed is loopback and the local-test bypass is explicit.

This catches compromised or stale seed nodes. If the fingerprints don't match, `connect()` throws a `TopologyVerificationFailed` error.

### `registryAddress`

**Type:** `string`  - **Default:** `""`

Address of the NoxRegistry contract. Required alongside `ethRpcUrl`.

The current Arbitrum Sepolia testnet registry (deployed 2026-09-25) is `0xF7BFf88A1412054a001Dc4b8aCBddAd6F9b26cB6`, used in the
examples on this page. See [Deployments](./deployments.mdx) for the full contract set. The retired April 2026
registry `0x8626aF80db409BeD3C19871FAdf9b0Ce7Aa641Bc` fails verification.

### `timeoutMs`

**Type:** `number`  - **Default:** `30000`

Per-request timeout in milliseconds. Applies to `rpcCall`, `broadcastSignedTransaction`, `httpRequest`, and other request methods.

Mixnet requests have inherent latency from three hops plus any mixing delays. If you're seeing timeouts on complex calls (large `eth_getLogs` ranges, heavy contract reads), increase this. For simple calls like `eth_blockNumber`, the default is generous.

### `topologyRefreshMs`

**Type:** `number`  - **Default:** `60000`

How often the SDK re-fetches the node list from the seed node. The network topology can change as nodes join, leave, or get slashed.

### `livenessMaxAgeMs`

**Type:** `number`  - **Default:** `180000`

Maximum age for an indexer's `online` observation. The SDK verifies the full registered member set and every
profile at the seed's pinned chain block, then routes only through members that are both chain-eligible and
recently observed online. A stale, future-dated, missing, duplicate, or incomplete liveness set fails closed.

Lower values react more quickly to node loss. The default permits three one-minute indexer probe intervals.

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

**Type:** `number`  - **Default:** `3`

Proof-of-work difficulty for Sphinx packets. The network can require PoW to prevent spam. `0` means no PoW (typical for testnet). In production, the SDK reads the required difficulty from the topology and uses it automatically  - you rarely need to set this manually.

### `dangerouslySkipFingerprintCheck`

**Type:** `boolean`  - **Default:** `false`

Skip topology fingerprint verification. The SDK accepts this option only when every configured seed is a
loopback URL.

:::warning
Only use this for local development with a test mesh where you control all nodes. In any other context, this disables a critical safety check.
:::

## Defaults

Production connections require both verification inputs and fail before seed discovery if either is absent:

```ts
const client = await NoxClient.connect({
  ethRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
  registryAddress: "0xF7BFf88A1412054a001Dc4b8aCBddAd6F9b26cB6",
});
```

## On-chain verification

Outside a loopback test mesh, the SDK accepts only schema version 2 snapshots. It verifies the full registered
member set, fingerprint, count, deterministic layer assignment, and every profile against one pinned registry
block. The indexer contributes availability only: a member must also be recently observed online before routing.

The SDK verifies both the snapshot's self-consistency and its fingerprint against the on-chain registry:

```ts
const client = await NoxClient.connect({
  ethRpcUrl: "https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY",
  registryAddress: "0xF7BFf88A1412054a001Dc4b8aCBddAd6F9b26cB6",
});
```

The SDK pins every Registry read to the snapshot block when supplied, or to one fetched block for a legacy
snapshot. It checks the complete address set and every routing profile. Any mismatch fails with
`TopologyVerificationFailed` and a bounded field-specific diagnostic.
