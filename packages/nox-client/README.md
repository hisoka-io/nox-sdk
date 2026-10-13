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

A paid execution sends one contract call through an exit that broadcasts it and pays the gas. The exit and
network fees are paid on chain by a payment source, such as a private Howl note, through the payment adapter
named in the exit's signed quote. `executePaid` runs the whole path in one call: quote, checks on the signed
quote, payment proof, calldata, simulation, submission through the quoting exit, and the on-chain settlement
evidence.

```ts
import { executePaid, rpcChainReader } from "@hisoka-io/nox-client";
import { JsonRpcProvider } from "ethers";

const provider = new JsonRpcProvider(yourRpcUrl);
const result = await executePaid(client, {
  chainId: 421614n,
  entryPoint: "0xad911Ca217C6dC779fCE6A6538bDda3071c38E7E", // NoxEntryPoint, Arbitrum Sepolia
  action: { target, data: actionCalldata, gasLimit: actionGasLimit },
  payment, // a PaidPaymentSource for your payment adapter, e.g. a private Howl note
  maxTotalFee, // ceiling on exitFee + networkFee, in fee-asset units
  intentSalt, // 32 random bytes you store with this action and reuse on every retry
  preflight: rpcChainReader((method, params) => provider.send(method, params)),
});

switch (result.status) {
  case "settled": // fee paid, action succeeded
    console.log(result.transactionHash, result.exitFee + result.networkFee);
    break;
  case "paid-action-failed": // fee paid, the action reverted inside its sandbox
  case "not-paid": // final for this call: result.stage and result.code say where it stopped
    break;
  case "unknown": // submitted, chain evidence pending: see "After `unknown`" below
    break;
}
```

**Gas cap and fee.** The exit prices its fee on `maximumTransactionGas`, so the helper requests the smallest
cap an exit accepts for the declared limits: `paymentGasLimit + actionGasLimit + 250000` (what
`NoxEntryPoint` requires), plus the transaction envelope (base gas, calldata gas and, on rollups, the data
fee from `dataFeeGas`), plus the exit's own 20% estimate buffer and 5% headroom. Declare tight limits to get
a low fee: `payment.gasLimit` comes from the payment source and `action.gasLimit` from the caller.
`planPaidGas` exposes the same arithmetic, and `gas` overrides each margin. On Arbitrum One and Arbitrum
Sepolia the data fee is read from `NodeInterface` automatically (`arbitrumDataFeeGas`); a reader with its own
`dataFeeGas` takes precedence.

**Checks before anything is proven or submitted.**

- `payment.checkAction` lets the payment source refuse an action it cannot be combined with, for example a
  Howl action that spends the fee note itself.
- `isPaymentConsumed` and `isClientIntentConsumed` are read before the quote.
- The quote is verified by `requestPaidQuote` (exit membership, EIP-712 digest and signature, every field
  against the request), then `exitFee + networkFee <= maxTotalFee`. A fee above the ceiling ends the call
  with `not-paid` / `fee-cap`.
- The quote must already be active (`validAfter` at or before chain time) and leave `minSubmitHeadroomSecs`
  (default 12) before `validUntil`, measured on the later of chain time and the local clock, both before
  proving and before submission.
- The exact `execute` calldata is simulated through the `preflight` reader as the exit will send it
  (`eth_estimateGas` and `eth_call` from the exit address at the quoted cap and gas price). The call is
  submitted only when the estimate with the exit buffer fits the cap and the simulated action succeeds.

**Preflight reader.** `preflight` is required. It receives the complete signed calldata, fee proof included,
a few seconds before the quoting exit does, and the simulation needs `from`, `gas` and `gasPrice` applied.
Use an endpoint you choose and trust with that calldata: `rpcChainReader(send)` over your own node or RPC
provider. Only the quoting exit can broadcast the calldata, and only until the quote's `validUntil`.

**One payment per action.** `NoxEntryPoint` consumes each `clientIntentId` once, across all callers. The
helper derives it as `deriveClientIntentId(chainId, entryPoint, target, data, intentSalt)`: `intentSalt` is 32
random bytes that you generate once per action, store, and pass again on every retry. The payment id is fixed
by the payment source, so every retry reuses both ids and `NoxEntryPoint` settles at most one of them, on any
exit, including after an app restart. Calling `executePaid` again with the same inputs resumes: a consumed
intent and payment are answered from their settlement log alone. Use a fresh salt to run the
same calldata again, or pass a `clientIntentId` of your own in place of the salt. Keep the fee note reserved
until the result is `settled`, `paid-action-failed` or `not-paid`.

**After `unknown`.** The result carries `executionId` and `validUntilUnix`. Pass them back as `pending` on
the next call: while that quote can still settle the helper answers `unknown` again and requests nothing, and
once chain time has passed `validUntilUnix` it reports the settlement or continues with a new quote.

**Retries.** A quote or submission that an exit explicitly rejects moves the call to another exit, up to
`maxExits` exits contacted (default 2). After a submission with no usable reply the helper waits for chain
evidence and tries a second exit only once the first quote has expired unsettled. `fee-cap` and `expired`
end the call. Once any submission has left the client, the payment id is read from the chain before each
further exit and before a `not-paid` result: a consumed payment id is reported from its settlement log, and
`not-paid` is returned only after every submitted quote has expired unconsumed on chain.

**Evidence.** `settled` and `paid-action-failed` come from the `PaidExecutionSettled` log for the quote's
`executionId`, matched against the quoted exit, payment id and fees; `transactionHash` is the hash that
landed, which differs from the submission reply when the exit replaced the transaction.

**Dry run.** `dryRun: true` stops after the simulation and returns the quoted fee, the gas estimate against
the cap and per-stage timings. It builds a real fee proof and shows it to the `preflight` reader, and it
uses one quote from one exit for that payment id; exits keep one quote per payment id until it leaves their
retention window (10 to 20 minutes on the current fleet), so use a spare fee note for dry runs.

**Chain reads.** State and evidence reads (consumed flags, block time, settlement logs) use `chain`, which
defaults to `mixnetChainReader(client)`: every read goes through the mixnet and an exit's RPC endpoint
answers it from its latest block. The amount at risk is fixed by local checks on the signed quote and by the
payment proof. When `action.gasLimit` is given, the gas limits are local too. When it is omitted, the limit
is estimated through the `preflight` reader (`eth_estimateGas` from the predicted sandbox, times
`gas.actionMarginBps`) and so trusts that reader's answer; declare the limit for actions that move funds.
For evidence that is independent of every exit, pass the same `rpcChainReader(send)` as `chain`.

#### Lower-level methods

`executePaid` is built from public methods that remain available: `client.selectPaidExit({ exclude })`,
`client.requestPaidQuote(request, exit)`, `encodeEntryPointExecute(quote, actionData, trackedAssets,
paymentData)` and `client.submitPaidTransaction(quote, calldata)`. Always submit with the quote returned by
`requestPaidQuote`, whose `selectedExit` is the exit that signed it. If the chosen exit does not answer in
time, the quote request is sent once more to a different exit. The payment must cover `exitFee + networkFee`
from the quote and be bound to `quote.executionId`; the
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

### TLS tunnels

Exits on nox 0.4.0-rc.9 and later that advertise `tunnel_v1` relay TLS records over one TCP connection per tunnel
(the testnet fleet runs 0.4.0-rc.10 with `[tunnel]` enabled on its three exits), so a
client that runs TLS itself keeps requests and responses end-to-end encrypted (the anon-rpc worker does this; see
its README). `tunnelExits()` lists those exits; `tunnelSend` sends one copy of an exchange and hands each reply part
(an encoded `TunnelReplyV1`) to `onReply`:

```ts
const exit = client.tunnelExits()[0];
const copy = client.tunnelSend(exit, {
  tunnelId, seq: 0, open: { host: "rpc.example", port: 443 },
  ackOffset: 0n, data: clientHello, close: false, holdMs: 20_000,
}, {
  surbs: 2,
  timeoutMs: 25_000,
  onReply: (body) => handle(decodeTunnelReplyV1(body)),
});
await copy.done;
```

The caller owns the tunnel: sequence numbers, reordering by offset, acknowledgements and copies (every copy of one
`seq` carries identical `data`; nox `docs/tunnel.md` has the rules).

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
reads. Registry reads use the exit `HttpRequest` path, so the quorum is attested by the exits; registry reads
through tunnels are the next milestone. Probation and the snapshot floor bound what a forged answer can change.

#### Send path (`kps.writeChunkBytes`, `kps.warmupBytes`, `kps.spreadCalls`)

A browser data channel hands at most four SCTP packets to the network per send call and starts each connection
with a congestion window of about 12 KB, so one 32 KB packet written at once took two to three round trips even
on a warm connection. Three settings shorten that:

| `kps` field | Default | Meaning |
|---|---|---|
| `writeChunkBytes` | 4,600 | Largest single stream write: a packet goes out as about eight writes of four SCTP packets each |
| `warmupBytes` | 96,000 | Padding sent once per pinned-entry or standby connection right after it opens, as four growing `POST /api/v1/responses/claim` bodies that claim nothing (12, 18, 27 and 39 KB, about one round trip apart), so the window has grown before the first packet. It pauses while a packet uploads and stops when a round is slower than three round trips. 0 turns it off |
| `warmupMaxBytesPerMinute` | 400,000 | Ceiling on warm-up bytes over all connections in any 60 s |
| `spreadCalls` | true | With `standby`: a call goes through the standby entry when the pinned entry is uploading more packets, so a burst uploads over two windows. A single call and each host batch stay one packet through one entry |

Bandwidth: about 96 KB per connection when it opens (192 KB at boot with a standby), nothing while idle; a redial
warms its new connection again, within `warmupMaxBytesPerMinute`. Every node release answers a claim that names
no reply at once, so the warm-up needs no node change.

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
| `replyClaims` | `Partial<ReplyClaimSettings>` | see below | Reply claim tuning: concurrent claims, binary batch, retain and ack, long-poll, data blocks before parity |
| `resend` | `Partial<ResendPolicy>` | `RESEND_LEGACY` | Hedged copies, resend on a lost reply, transport-failure resends, same-entry resends. `RESEND_FAST` is the anon-rpc worker's policy |

### Reply claims

Replies are claimed by SURB ID with claim protocol v2 where the entry supports it, and v1 JSON otherwise; the
response's `Content-Type` decides. Several claims may be in flight per entry, and one SURB ID is never in two at
once. A request claims its first reply block; once a fragment names the data shard count it claims every data
block, and its parity blocks only after `parityFallbackMs` or after a claim carrying it failed. Where the entry
speaks claim v2 and holds long-polls (`firstArrival`), a request claims its first two blocks at once: a
one-fragment reply travels as a data item and a parity replica over independent mix delays, and the held claim
answers with whichever reaches the entry first; the other is acked.

| `replyClaims` field | Default (KPS / classic) | Meaning |
|---|---|---|
| `intervalMs` | `kps.claimIntervalMs` (200) / 200 | How often IDs not in flight are claimed |
| `claimTimeoutMs`, `claimTimeoutPerIdMs` | 10,000, 2,500 | Bound on one claim: base plus per further ID, plus the wait |
| `maxIdsPerClaim` | 4 / 128 | Bounds one claim response to that many replies (entries that answered claim protocol v2) |
| `maxClaimsInFlight` | 4 | Claims open at once per entry |
| `jsonMaxIdsPerClaim`, `jsonMaxClaimsInFlight` | 1, 2 / 128, 4 | The same limits for entries that answer v1 JSON (about 115 KB per reply) or have not answered yet |
| `waitMs` | 4,000 / 0 | Long-poll hold asked of v2 entries: over KPS only when the relay's `/metadata.json` lists `claim-v2` (capped by its `limits.claimWaitMaxMs`), directly once the entry sent `x-nox-claim-wait-max-ms` (capped by it) |
| `binary`, `retain` | true, true | Ask for the binary batch; keep replies re-claimable until acked |
| `parityFallbackMs` | 2,000 | When parity blocks are claimed too |
| `lostReplyGraceMs` | 1,500 | After a failed claim, when a reply still missing is reported lost (`reply.lost`) |
| `firstArrival` | true | Claim a request's first two blocks together on entries that hold long-polls (see above) |

A failed `/metadata.json` capability probe is retried after 5 s, doubling up to 60 s (`claim.probe.retry`), so one
lost exchange does not leave the session polling; a relay that answers 404 has no `claim-v2`.

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
