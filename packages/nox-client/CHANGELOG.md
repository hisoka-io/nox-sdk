# Changelog

All notable changes to `@hisoka-io/nox-client`.

## 0.8.0 (2026-10-10)

Additive; every 0.7.0 configuration behaves as before.

### Added

- End-to-end TLS tunnels through exits (`ServiceRequest::TunnelV1`, bincode tag 8, nox `docs/tunnel.md`): the
  wire types `TunnelRequestV1`, `TunnelOpenV1`, `TunnelReplyV1` (`encodeTunnelReplyV1`, `decodeTunnelReplyV1`,
  strict: trailing bytes and unknown indices are refused), `TUNNEL_ID_LEN`, `TUNNEL_PART_MAX_DATA`,
  `TUNNEL_REJECT_DETAIL_MAX`, `TUNNEL_FIN_V1`, `TUNNEL_REJECT_CODES_V1`, pinned to the nox-core vectors byte for byte.
- `TUNNEL_V1_CAPABILITY` and `NoxClient.tunnelExits()`: exits that advertise `tunnel_v1`. Tunnel requests go only to
  them; exits before nox rc.9 drop tag 8 without a reply.
- `NoxClient.tunnelSend(exit, request, options)` (`TunnelSendOptions`, `TunnelSendHandle`): one copy of a tunnel
  exchange to a fixed exit on a fresh entry and mix (outside `avoid` when possible). Each reply part goes to
  `onReply` as it arrives; reassembly, reply-block top-up and resends stay with the caller. `surbs: 0` sends a
  teardown without listening.

### Changed

- `ReplyClaimScheduler.track` takes the number of reply blocks to claim from the start (default 1, as before).

## 0.7.0 (2026-10-06)

Additive; every 0.6.0 configuration behaves as before except where noted under Changed. Works against entries on
nox 0.4.0-rc.6 (claim protocol v1) and on nodes with claim protocol v2 alike.

### Added

- Claim protocol v2 (nox `docs/claim-api.md`), negotiated per response: claims ask for the binary claim batch
  (`encoding: "binary"`, `Accept: application/vnd.nox.claim-batch`), `retain` (a cut-off transfer can be claimed
  again within the entry's grace), `ack` (delivered replies and the unused blocks of settled requests) and `wait_ms`
  (long-poll; over KPS only when the relay's `/metadata.json` lists `claim-v2`, capped by its
  `limits.claimWaitMaxMs`). A v1 entry ignores every v2 field and its JSON answer is read as before. `claimReplies`,
  `decodeBinaryClaim`, `encodeBinaryClaim`, `decodeBase64`.
- `ReplyClaimScheduler` and `NoxClientConfig.replyClaims`: concurrent claims per entry (an ID is never in two claims
  at once), data blocks first and parity only after `parityFallbackMs` or a failed claim, bounded IDs per claim,
  re-claim right after a failed claim, `reply.lost` after `lostReplyGraceMs`.
- `NoxClientConfig.resend` (`ResendPolicy`, `RESEND_LEGACY`, `RESEND_FAST`): hedged copies at about the p95 reply
  time, an immediate resend on a lost reply, transport-failure resends counted apart, same-entry resends when only
  one entry can carry them (single bridge).
- `kps.claimLane` (claims on a second connection to the entry) and `kps.standby` (a second entry kept connected,
  with failover when the pinned connection closes); `KpsHttpTransport.fetchOn`, `retain`, `prewarm`, `rttMs`,
  `dialMs`, `onConnectionClosed`.
- `kps.discovery.firstCheckDeferMs`: the first chain check waits for the first wallet call (bounded).
- Logs: `claim.failed`, `claim.recovered`, `claim.mode`, `reply.lost`, `call.resend`, `entry.failover`, and
  `request.timing` (info: upload, wait, claim, download and decode durations of each request).
- KPS send path: `kps.writeChunkBytes` (packets written as about eight sends of four SCTP packets), a send-window
  warm-up per pinned-entry and standby connection (`kps.warmupBytes`, `kps.warmupMaxBytesPerMinute`,
  `KpsHttpTransport.warmUp`), and `kps.spreadCalls` (concurrent calls over the pinned and standby entries).
- `replyClaims.firstArrival`: on entries that hold long-polls, a request claims its data block and its replica
  together and takes whichever arrives first.
- A failed relay capability probe is retried with backoff (`claim.probe.retry`).

### Changed

- Claims are no longer single-flight per entry, and a request claims its data blocks before its parity blocks.
- At most `maxClaimsInFlight - 1` claims per entry long-poll at once, so one claim slot stays free for new requests.
- Registry reads of chain checks carry two reply blocks and are resent once on another route (same exit).
- The KPS transport forwards `Accept` next to `Content-Type`.
- `computeTopologyFingerprint` hashes with ethers' `keccak256` (same digest); `js-sha3` is no longer a dependency.

## 0.6.0 (2026-10-06)

Additive; every 0.5.0 configuration behaves as before.

### Added

- `kps.discovery` (S1): identity from the snapshot and the chain, location looked up at run time.
  - Boot anchors in priority classes: `bridges` only (Tor bridge semantics), or `gateways` (in place of the
    bootstrap's default anchors), learned anchors, then the snapshot's KPS addresses. Unknown addresses are mapped
    to a member through their `/metadata.json` and must name an eligible snapshot member.
  - Identity-only presence: url, ingressUrl and metadataUrl changes in served topologies are moves, not removals.
    A new routing url two anchors agree on is used provisionally.
  - Chain check after ready and every `chainRefreshSeconds`: NoxRegistry read through `chainQuorum` exits to as many
    RPC providers at one finalized block (EIP-1898 pinned), used only on byte-identical agreement, a closed member
    set and the expected EIP-1967 implementation; registration logs complete a set served documents did not name.
  - New members on probation (`probationSeconds`, `probationMaxPerRoute`), removal floor per route layer,
    `onVerified` callback with chain-confirmed KPS addresses and first-seen records.
  - `nox-anon-rpc-bootstrap/1` format with `verifyBootstrap`; discovery building blocks exported for tools.
- `selectRoute` takes an optional probation cap; `TopologyNode.probation`. A pinned entry and a selected exit that
  both are on probation over the cap are refused while a settled exit exists; paid-exit selection and entry
  switches prefer settled members.
- Chain checks read at most 256 candidate addresses (`DISCOVERY_LIMITS.maxCandidates`, `rankChainCandidates`):
  snapshot and verified members first, then addresses at least `minRemovalSources` anchors list, then the rest.
  Served documents listing more than 256 nodes are refused.

### Changed

- KPS mode judges served topologies on identity (address, Sphinx key, role, layer) also without discovery: a
  member whose served `metadataUrl` or `ingressUrl` differs from the snapshot is kept instead of removed.

## 0.5.0

Needs `@hisoka-io/nox-wasm` 0.2.0 (unchanged). Classic mode is the default and behaves exactly as 0.4.0: the 0.4.0
test suite runs unchanged against it.

### Added

- KPS mode (`mode: "kps"`), opt-in, for hosts that dial nodes over KPS, such as the anon-rpc worker harness. The client
  boots from a pinned NoxRegistry snapshot (`kps.pinned`, format `nox-anon-rpc-snapshot/1`) through
  `kps.dial`, with no seed and no Ethereum RPC; packets, reply claims and topology refreshes all travel over KPS
  streams (HTTP/1.1, one stream per exchange, one connection per entry). It fails closed: seeds, `ethRpcUrl`,
  `transport` and any non-`kps:` endpoint are refused with `MODE_VIOLATION`, and the client never switches to
  HTTPS or WebSocket.
  - Served topologies are accepted only as removals from the pinned set, only when documents from two different
    nodes agree, and every route layer keeps at least two members; additions need a new snapshot.
  - `TOPOLOGY_STALE` rests on registry evidence: two nodes agree that every pinned member of a route layer is gone
    from the registry or has a changed profile. A layer whose members are listed but reported offline (as while
    the P2P mesh re-forms after a restart) keeps its previous members, logs `topology.offline` and fails calls one
    by one until a refresh sees members online again.
  - Entries are limited to members that publish a KPS address in their `metadataUrl`
    (`kps:<ip>:<port>:<certhash>/metadata.json`), optionally narrowed with `kps.entries`.
  - At most one reply claim per entry is in flight, and one claim carries at most `KPS_CLAIM_MAX_SURB_IDS` (128)
    IDs, the `nox-kps` default limit; larger sets rotate across polls.
  - Two transport failures in a row move the pinned entry; replies already routed to the old entry are still
    claimed there.
- `wasm` (both modes): pass initialised `@hisoka-io/nox-wasm` bindings instead of the dynamic import.
- `log` (both modes): a structured diagnostics sink that never receives URLs, bodies, keys or SURB IDs.
- `httpRequest` options: `opKey`, `minSurbs`, `retry`, `signal` (rejects with `ABORTED` and frees the reply blocks
  at once) and `maxResponseBytes` (`RESPONSE_TOO_LARGE`).
- `decodeHttpResponse` for the exit's HTTP reply encoding.
- New exports: `createKpsFetch`, `parseKpsAddress`, `parseKpsEndpoint`, `isKpsAddress`, `kpsAddrFromMetadataUrl`,
  `verifyPinnedSnapshot`, `applyServedTopologies`, `eligiblePinnedMembers`, `pinnedKpsAddresses`,
  `pinnedRelayerNodes`, `primaryLayerForRole`, `KPS_CLIENT_DEFAULTS`, `KPS_TRANSPORT_DEFAULTS`,
  `KPS_CLAIM_MAX_SURB_IDS`, `NoxKpsError` and their types.
- Error codes `KPS_UNAVAILABLE`, `MODE_VIOLATION`, `TOPOLOGY_STALE`, `ABORTED` and `RESPONSE_TOO_LARGE`.

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
