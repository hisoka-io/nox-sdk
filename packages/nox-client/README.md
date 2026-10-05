# @hisoka-io/nox-client

TypeScript client SDK for the NOX mixnet. Route Ethereum transactions, JSON RPC calls, and HTTP requests through a 3-hop Sphinx mix network for network-layer privacy.

## Install

```bash
npm install @hisoka-io/nox-client
```

The WASM dependency (`@hisoka-io/nox-wasm`) is installed automatically.

## Quick start

```ts
import { NoxClient } from "@hisoka-io/nox-client";

const client = await NoxClient.init({
  ethRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
  registryAddress: "0xF7BFf88A1412054a001Dc4b8aCBddAd6F9b26cB6",
});

const balance = await client.rpcCall("eth_getBalance", ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "latest"]);
console.log(balance);

client.disconnect();
```

`init()` connects to the Hisoka testnet and verifies the discovered topology against the configured registry.
Both verification inputs are required outside a loopback test mesh. Use your own RPC endpoint for
`ethRpcUrl` when you can: the public one is rate limited.
`0xF7BFf88A1412054a001Dc4b8aCBddAd6F9b26cB6` is the NoxRegistry proxy of the current Arbitrum Sepolia testnet deployment (2026-09-25).
The retired April 2026 registry `0x8626aF80db409BeD3C19871FAdf9b0Ce7Aa641Bc` is not compatible with the complete
profile verifier.

## Usage

### Connect with overrides

```ts
// Override specific settings while keeping the rest as defaults
const client = await NoxClient.init({
  ethRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
  registryAddress: "0xF7BFf88A1412054a001Dc4b8aCBddAd6F9b26cB6",
  timeoutMs: 60_000,
  surbsPerRequest: 20,
});
```

### Full custom configuration

For local development or connecting to a custom mesh:

```ts
const client = await NoxClient.connect({
  seeds: ["http://localhost:14001"],
  powDifficulty: 0,
  timeoutMs: 30_000,
  dangerouslySkipFingerprintCheck: true,
});
```

### Paid execution

`submitPaidTransaction` is the transaction path served by nox 0.4.0-rc.2 and later exits. The client selects
one exit, requests its signed EIP-712 quote through the mixnet, and submits `NoxEntryPoint.execute` calldata
through that same exit, which broadcasts it and pays the gas. The quoted exit and network fees are paid on
chain through the payment adapter named in the quote.

```ts
import { AbiCoder, Interface, getBytes, hexlify, keccak256, randomBytes } from "ethers";
import type { PaidQuoteRequestV2 } from "@hisoka-io/nox-client";

const NOX_ENTRY_POINT = "0xad911Ca217C6dC779fCE6A6538bDda3071c38E7E"; // Arbitrum Sepolia
const trackedAssets: string[] = [];

const request: PaidQuoteRequestV2 = {
  chainId: 421614n,
  entryPoint: getBytes(NOX_ENTRY_POINT),
  clientIntentId: randomBytes(32),
  paymentAdapter: getBytes(paymentAdapter), // e.g. the HowlPaymentAdapter
  paymentId: getBytes(paymentId), // 32 bytes, defined by the payment adapter
  feeAsset: getBytes(feeAsset),
  paymentGasLimit: 4_000_000n,
  actionTarget: getBytes(actionTarget),
  actionCalldataHash: getBytes(keccak256(actionData)),
  actionGasLimit: 4_000_000n,
  trackedAssetsHash: getBytes(
    keccak256(AbiCoder.defaultAbiCoder().encode(["address[]"], [trackedAssets])),
  ),
  maximumTransactionGas: 12_000_000n, // at least paymentGasLimit + actionGasLimit + 250000
  returnDataLimit: 256, // up to 4096
  validUntilUnix: BigInt(Math.floor(Date.now() / 1000) + 120),
};

const quote = await client.requestPaidQuote(request, client.selectPaidExit());
if (quote.status === "rejected") {
  throw new Error(`${quote.code}: ${quote.detail}`);
}

// ABI-encode NoxEntryPoint.execute with the signed quote.
const entryPoint = new Interface([
  "function execute((uint8 quoteVersion, uint256 chainId, address entryPoint, address exitAddress, bytes32 clientIntentId, address paymentAdapter, bytes32 paymentId, address feeAsset, uint256 exitFee, uint256 networkFee, uint256 paymentGasLimit, address actionTarget, bytes32 actionCalldataHash, uint256 actionGasLimit, bytes32 trackedAssetsHash, uint256 maximumTransactionGas, uint256 maximumFeePerGas, uint256 returnDataLimit, uint64 validAfterUnix, uint64 validUntilUnix, uint256 quoteNonce) quote, bytes exitSignature, bytes actionData, address[] trackedAssets, bytes paymentData)",
]);
const quoteTuple = Object.fromEntries(
  Object.entries(quote.quote).map(([key, value]) => [
    key,
    value instanceof Uint8Array ? hexlify(value) : value,
  ]),
);
const entryPointCalldata = getBytes(
  entryPoint.encodeFunctionData("execute", [
    quoteTuple,
    quote.exitSignature,
    actionData,
    trackedAssets,
    paymentData, // built by the payment adapter for quote.executionId
  ]),
);

const outcome = await client.submitPaidTransaction(quote, entryPointCalldata);
if (outcome.status === "submitted") {
  console.log("tx", hexlify(outcome.transactionHash));
} else {
  console.log(outcome.code, outcome.retryable, outcome.detail);
}
```

The quote request and paid submission use the same exit: always submit with the quote returned by
`requestPaidQuote`, whose `selectedExit` is the exit that signed it. If the chosen exit does not answer in
time, the quote request is sent once more to a different exit. The client re-resolves that exit from a
recently chain-verified topology, verifies the EIP-712 quote and execution ID, and returns a typed submission or
rejection outcome. Applications provide opaque EntryPoint calldata; Nox does not parse Howl proofs. The
payment must cover `exitFee + networkFee` from the quote and be bound to `quote.executionId`; the
[anonymous paymaster docs](https://docs.hisoka.io/docs/crypto/paymaster) describe the Howl payment path.

When the seed publishes node capabilities, only exits that advertise `paid_v2` are used, and
`selectPaidExit()` throws `PAID_EXIT_UNAVAILABLE` if none does. An exit with no capability data counts as
not paid-capable once any node in the topology has some, so a seed must publish capabilities for every
exit or for none.

The client reads the chain time for quote checks through the mixnet, which adds one mixnet round trip
(typically 1-2 s) before each quote and each submission. Send any simulation of your own (`eth_call`,
`eth_estimateGas`) the same way, with `client.rpcCall`.

### Legacy transaction submission

`submitTransaction(to, data)` and `submitTransactionTyped(to, data)` send the legacy `SubmitTransaction`
request, whose wire encoding is unchanged. Exits running nox 0.4.0-rc.2 or later, including the current
testnet fleet, answer it with a `SUBMISSION` rejection (`submitTransactionTyped` returns it as
`{ status: "rejected", code: "SUBMISSION" }`). Use `submitPaidTransaction` for transactions.

### Broadcast a signed transaction

```ts
const txHash = await client.broadcastSignedTransaction(signedTxBytes);
```

### JSON RPC calls

```ts
const blockNumber = await client.rpcCall("eth_blockNumber", []);
const balance = await client.rpcCall("eth_getBalance", [address, "latest"]);
const logs = await client.rpcCall("eth_getLogs", [{ address, fromBlock: "0x0", toBlock: "latest" }]);
```

All RPC calls are routed through the mixnet. The exit node forwards them to its configured Ethereum RPC endpoint.

### HTTP requests

```ts
const body = await client.httpRequest(
  "GET",
  "https://api.example.com/data",
  [["Accept", "application/json"]],
  new Uint8Array(0),
);
```

### KPS mode

For hosts that reach nodes over [KPS](https://github.com/ethereum/kps) (for example inside an anon-rpc worker),
the client boots from a pinned registry snapshot and sends everything over KPS streams, with no seed, no
Ethereum RPC, no `fetch` and no WebSocket. Only members that publish a KPS address in their registry
`metadataUrl` serve as entries.

```ts
const client = await NoxClient.connect({
  mode: "kps",
  wasm: noxWasmBindings,                    // initialised @hisoka-io/nox-wasm exports
  kps: {
    dial: (address, opts) => anonRpcWorker.kps.dial(address, opts),
    pinned: snapshot,                       // "nox-anon-rpc-snapshot/1"
  },
});
```

KPS mode never falls back to HTTPS: classic-only settings (`seeds`, `ethRpcUrl`, `transport`) and non-`kps:`
endpoints fail with `MODE_VIOLATION`. Classic mode stays the default.

#### Run-time discovery (`kps.discovery`)

With `kps.discovery` the snapshot says who a member is (address, Sphinx key, role) and acts as the floor, while
where a member is (IP, port, certhash, P2P address) is looked up at run time, so operators can change IPs with
`updateUrl` / `updateMetadataUrl` and new members join without a client release:

```ts
kps: {
  dial,
  pinned: snapshot,
  discovery: {
    bootstrap,                 // "nox-anon-rpc-bootstrap/1": default anchors, registry implementation, RPC URLs, policy
    gateways: ["203.0.113.9:15005:uEiB..."],   // optional: tried first, in place of the bootstrap anchors
    // bridges: [...],         // optional: the only addresses ever dialled (excludes gateways)
    learned,                   // optional: addresses earlier checks confirmed (onVerified)
    onVerified: (state) => saveLearnedAnchors(state),
  },
}
```

- Boot dials anchors in priority classes, each shuffled: bridges only (when set); otherwise gateways or the
  bootstrap anchors, learned anchors, then the snapshot's KPS addresses. An address the snapshot does not hold
  answers `GET /metadata.json`; the node it names must be an eligible snapshot member. Presence in served
  topologies is judged on identity: a changed url or `metadataUrl` is a move, never a removal. A new routing url
  that documents from two anchors agree on is used until the chain check confirms it.
- After ready, a chain check reads NoxRegistry at one finalized block through the mixnet: `chainQuorum` (2) exits
  to as many different RPC providers, every call pinned with EIP-1898 `{ blockHash, requireCanonical: true }`. The
  answer is used only when every pair returns byte for byte the same values, the registered members close the set
  (`relayerCount()` and `topologyFingerprint()`), and the proxy's EIP-1967 slot holds `bootstrap.registryImpl`.
  It repeats every `chainRefreshSeconds` (600) and early when a served fingerprint differs or every entry failed.
- A verified read updates locations and removes members (each route layer keeps at least two snapshot members).
  A member outside the snapshot is on probation for `probationSeconds` (14 days) after the client first saw it,
  and a route holds at most `probationMaxPerRoute` (1) such member.
- Logs: `discovery.verified`, `discovery.disagreement`, `discovery.incomplete`, `discovery.rejected`,
  `discovery.probation`, `discovery.floor`, `discovery.failed`. With `chain: false` the snapshot stays the only
  membership source and no RPC provider is ever involved.

Trust: RPC providers are data sources reached anonymously through exits; they see exit IPs and public registry
reads. Until TLS runs inside the client, the exits terminate HTTPS, so the quorum is attested by the exits;
probation and the snapshot floor bound what a forged answer can change.

### Cover traffic

Send dummy packets at a configurable rate to hide when you're actually using the network:

```ts
import { createCoverController } from "@hisoka-io/nox-client";

const cover = createCoverController(client);
cover.start({ lambdaP: 1.0 }); // ~1 packet/sec (Poisson)
cover.stop();
```

### Errors

```ts
import { NoxClientError, NoxClientErrorCode } from "@hisoka-io/nox-client";

try {
  await client.sendEcho(new Uint8Array([1]));
} catch (error) {
  if (error instanceof NoxClientError && error.code === NoxClientErrorCode.ResponseTimeout) {
    // The request and its single retry on another route both timed out.
  }
}
```

### Disconnect

```ts
client.disconnect();
```

## Configuration reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `seeds` | `string[]` | `["https://api.hisoka.io/seed"]` | Seed node URLs for topology discovery |
| `powDifficulty` | `number` | `3` | Proof-of-work difficulty (anti-spam) |
| `timeoutMs` | `number` | `30000` | Per-request timeout in milliseconds |
| `surbsPerRequest` | `number` | `10` | SURBs sent with each request (~30KB each) |
| `topologyRefreshMs` | `number` | `60000` | Background topology refresh interval |
| `livenessMaxAgeMs` | `number` | `180000` | Maximum age of an online indexer observation |
| `fecRatio` | `number` | `0.3` | Reed-Solomon FEC redundancy ratio (0.0--1.0) |
| `ethRpcUrl` | `string` | `""` | Ethereum RPC for on-chain topology verification |
| `registryAddress` | `string` | `""` | NoxRegistry contract address |
| `dangerouslySkipFingerprintCheck` | `boolean` | `false` | Skip verification on a loopback test mesh only |
| `retryOnTimeout` | `boolean` | `true` | Resend idempotent requests once on another route after a timeout (worst case about 2x `timeoutMs`) |
| `surbFormat` | `"auto" \| "v1" \| "v2"` | `"auto"` | Reply block format. `auto` uses v2 only when every hop of the route advertises `surb_v2`; `v2` requires it and throws `SURB_V2_UNAVAILABLE` otherwise |
| `transport` | `{ fetch?, WebSocket? }` | runtime globals | Network primitives; `WebSocket: null` uses HTTP polling |

`ethRpcUrl` and `registryAddress` are required together. Connection fails before fetching a seed if either is
missing. `dangerouslySkipFingerprintCheck: true` is accepted only when every seed URL is loopback.

### Seeds

A seed is any base URL that serves the topology document at `{seed}/topology`: the seed API
(`https://api.hisoka.io/seed`) or a node's ingress URL. `connect()` tries your seeds in order, then the
default seed API, and uses the first one whose topology passes every check. Membership is verified against
the registry, so a seed cannot add nodes or change their keys or roles. Liveness is not on chain: the seed
decides which registered nodes count as online, and that decides which nodes the client routes through, so
only add seeds you trust. Liveness ages are measured on the seed's clock, so a client clock that is off by a
few minutes still connects.

Background refreshes always try the seeds first: the last seed that worked, then your seeds and the default
seed API. Only when all of them fail does the client fetch the topology from up to three verified nodes, and
then only to confirm membership: a node-served snapshot must be pinned at or after the last seed's block,
can only remove nodes that left the registry or were frozen, and does not change liveness, capabilities or
the PoW difficulty. The next refresh tries the seeds again.

To inspect or spread the defaults programmatically:

```ts
import { DEFAULTS } from "@hisoka-io/nox-client";

const client = await NoxClient.connect({
  ...DEFAULTS,
  timeoutMs: 60_000,
  ethRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
  registryAddress: "0xF7BFf88A1412054a001Dc4b8aCBddAd6F9b26cB6",
});
```

## How it works

1. Client fetches the complete registered member set and separate liveness observations from a seed node
2. Selects a 3-hop route: entry node, mix node, exit node
3. For each request, builds a Sphinx packet with layered encryption -- each relay can only decrypt its own layer and learn the next hop
4. Packet is sent to the entry node via HTTPS
5. Each relay peels one encryption layer and forwards to the next hop via libp2p
6. Exit node decrypts the final layer, executes the request (RPC, transaction, or HTTP fetch), and sends the response back through SURBs
7. SURBs are pre-built anonymous return paths -- the exit node packs the response without knowing the destination
8. Client polls the entry node for responses and decrypts them using SURB recovery keys

Large responses are automatically fragmented and reassembled with Reed-Solomon forward error correction.

## Requirements

Node.js 20+ or a browser runtime with Web Crypto and WASM support.

See [CHANGELOG.md](./CHANGELOG.md) for changes between versions, including the 0.1.x to 0.2.0 migration.

## License

Apache-2.0
