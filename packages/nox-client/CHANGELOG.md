# Changelog

All notable changes to `@hisoka-io/nox-client`.

## 0.4.0 (2026-10-03)

Needs `@hisoka-io/nox-wasm` 0.2.0. Wire-compatible with nox 0.4.0-rc.2 and
rc.3 nodes and with mixed meshes; on a mesh without `surb_v2` capability data
it behaves exactly like 0.3.0.

### Added

- `surbFormat: "auto" | "v1" | "v2"` (default `"auto"`). Format v2 reply
  blocks are claimed with a delivery ID that only the client and the entry can
  compute, so the exit and mixes cannot claim or link the reply, and replies
  carry a 128-bit reply tag that the client checks before decoding.
  - `"auto"` uses v2 only when every hop of the chosen route (entry, mix and
    exit) advertises `surb_v2` in the seed's liveness data and the loaded WASM
    module can build v2 reply blocks; otherwise v1.
  - `"v2"` routes only over nodes that advertise `surb_v2` and fails fast with
    `NoxClientErrorCode.SurbV2Unavailable` when there is no such route. Use it
    if you do not want a seed to be able to push you back to v1.
  - `"v1"` is the 0.3.0 behaviour.
- After a timeout on a v2 route, the resend uses v2 again through a different
  entry, and replies are claimed from that entry. A v2 request is never resent
  with v1 reply blocks. If no other fully capable entry exists, the timeout is
  returned.
- SURB replenishment uses the format and the entry of the request it tops up.
- New exports: `SurbFormat`, `SURB_V2_CAPABILITY`, `supportsSurbV2`,
  `routeSupportsSurbV2`, `MAX_SURB_V2_ADDRESS_BYTES`, `wasmSupportsSurbV2`,
  `SurbEntry`, `SurbVersion`.

### Changed

- The fragment `messageId` of a large request and the JSON-RPC `id` of
  `rpcCall` are random 64-bit values instead of per-client counters.
- v2 reply blocks are only matched by their delivery ID; trial decryption is
  kept for v1 only.

## 0.3.0 (2026-10-03)

Wire-compatible with nox 0.4.0-rc.1 nodes and the 0.2.0 client: packets, SURBs
and service requests are unchanged.

### Added

- `retryOnTimeout` (default `true`). After a response timeout, echo, `rpcCall`,
  `broadcastSignedTransaction*` and GET/HEAD/OPTIONS `httpRequest` are sent once
  more on a route with a different mix or exit, and a paid quote request goes
  once to a different paid-capable exit. `submitTransaction`,
  `submitPaidTransaction` and `send` are never resent. The mix and exit of a
  timed-out route are avoided for 5 minutes (`ROUTE_AVOID_MS`) while other
  candidates exist; a reply through a hop clears it. A resent call can take up
  to about twice `timeoutMs`. With `retryOnTimeout: false` nothing is resent
  and timeouts do not affect later route choice.
- `transport: { fetch, WebSocket }` to supply the network primitives instead of
  the runtime globals. `WebSocket: null` selects HTTP claim polling.
- Seed liveness may carry `capabilities` (for example `["paid_v2"]`) and
  `build_version`. When a seed publishes capabilities, `selectPaidExit()` and
  `requestPaidQuote()` only use exits that advertise `paid_v2`, and fail fast
  with `NoxClientErrorCode.PaidExitUnavailable` when none does. Seeds that
  publish no capability data keep the 0.2.0 behaviour. Once any node carries
  capabilities, exits without them count as not paid-capable, so a seed must
  publish capabilities for every exit.
- New exports: `NoxTransport`, `NoxFetch`, `NoxWebSocketConstructor`,
  `NoxClientSettings`, `TopologyLiveness`, `PAID_V2_CAPABILITY`, `DEFAULT_SEED`,
  `ROUTE_AVOID_MS`.

### Changed

- Registry verification sends all reads as JSON-RPC batches pinned to the
  snapshot block: one HTTP request for up to 24 members instead of 2N+2
  sequential calls (a 10-node connect drops from about 7 s to under 1 s).
  Endpoints that reject batches (a non-array reply or an HTTP 4xx other than
  408 and 429) get individual calls, four at a time. HTTP 408, 429 and 5xx are
  reported as errors without fanning out.
- Background topology refreshes no longer overlap; the paid freshness gate
  waits for a refresh that is already running.
- Liveness ages are measured against the snapshot's own `timestamp`, so a
  client clock that runs behind or ahead no longer empties the topology. The
  local clock only rejects a snapshot older than `livenessMaxAgeMs` plus 60 s.
- `connect()` tries each seed in turn until one serves a topology that passes
  every check. Previously the first seed that answered HTTP 200 was used even
  if its topology then failed verification.
- A seed can be a node ingress URL (`https://nox-1.hisoka.io`) as well as the
  seed API, as long as it serves schema v2 at `/topology`. When every seed
  fails, background refreshes also read the topology served by the current
  entry and up to two other verified nodes, but only to confirm membership:
  the snapshot must be pinned at or after the last seed's block, it can only
  remove nodes that left the registry or were frozen, and liveness,
  capabilities and PoW difficulty stay as the last seed reported. Every
  refresh tries the seeds first.
- Paid quote and submission read the chain timestamp through the mixnet
  (`eth_getBlockByNumber` via an exit) instead of calling `ethRpcUrl` directly.
  This adds one mixnet round trip (typically 1-2 s) before each quote and each
  submission.
- `NoxClient.init(overrides)` is now exactly `NoxClient.connect(overrides)`.
  A PoW difficulty advertised by the seed (above 0) is adopted unless the
  caller passed a higher one, capped at 16.
- `NoxClientErrorCode` is a regular `enum`, so `NoxClientErrorCode.X` compiles
  under `isolatedModules` and `verbatimModuleSyntax` (Vite, Next.js).
- `DEFAULTS` is typed `NoxClientSettings`, and `client.config` returns it.

### Removed

- The fallback seeds `entry1.nox.hisoka.io`, `entry2.nox.hisoka.io` and
  `entry3.nox.hisoka.io`. They never resolved. Pass extra seeds explicitly.
- With `dangerouslySkipFingerprintCheck`, `connect()` no longer falls back to
  the public seed API when the loopback seeds are down.

## 0.2.0 (2026-09-11)

### Migrating from 0.1.x

- Topology verification is on by default. Pass both `ethRpcUrl` and
  `registryAddress`; `NoxClient.init()` and `NoxClient.connect(DEFAULTS)`
  without them throw `INVALID_CONFIG`:

  ```ts
  const client = await NoxClient.connect({
    ethRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    registryAddress: "0xF7BFf88A1412054a001Dc4b8aCBddAd6F9b26cB6",
  });
  ```

- `dangerouslySkipFingerprintCheck: true` is accepted only when every seed is
  a loopback URL.
- The April 2026 registry `0x8626aF80db409BeD3C19871FAdf9b0Ce7Aa641Bc` is
  retired and fails the complete profile check.
- Entry nodes need an explicit `http(s)` `ingress_url`; `url` is no longer used
  as a fallback HTTP address.
- Node.js 20 or newer. `ethers` is a runtime dependency; `@hisoka-io/nox-wasm`
  is pinned to `0.1.5`.

### Added

- Seed schema v2: canonical ordering, primary-layer rule and a complete
  liveness set. Routing uses only online, fresh, chain-eligible members.
- Full on-chain verification of every member's profile and role at the
  snapshot block.
- Paid execution: `selectPaidExit`, `requestPaidQuote`,
  `submitPaidTransaction`, with EIP-712 quote validation and typed outcomes.
- `submitTransactionTyped` with bounded rejection detail.
- Route, entry and cover selection use a CSPRNG.
