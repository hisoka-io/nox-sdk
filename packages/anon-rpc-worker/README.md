# @hisoka-io/anon-rpc-worker

The Nox mixnet worker for the [anon-rpc](https://github.com/ethereum/anon-rpc) standard: one classic-script
bundle that a wallet's anon-rpc harness loads and pins by its keccak-256 hash.

The worker dials Nox entry nodes over KPS (`anonRpcWorker.kps`), sends each `fetch` call as a Sphinx packet
through the mixnet, and an exit node performs the HTTP request; the reply returns over single-use reply blocks
(SURBs). Who the nodes are comes from NoxRegistry: a snapshot pinned inside the bundle is the floor, and after
ready the worker reads the registry through the mixnet itself. Where the nodes are (IP, port, KPS certhash) is
looked up at run time, so operators change IPs whenever they like and new nodes join without a new bundle. A cold
boot needs no seed server and no public RPC; the bundle reaches the network only through the harness's KPS dialer.

What each party sees: the entry node sees the wallet's IP address and encrypted packets; the exit node sees the
HTTP request (RPC URL, headers it forwards, body) and never who sent it. End-to-end TLS inside the worker,
which also hides the request from the exit, is the next milestone.

## Layout

| Path | Contents |
|---|---|
| `src/` | The worker: `worker.ts` (bundle entry), `core.ts` (boot, readiness, accept loop, deadlines), `config.ts`, `fetch-map.ts` (`fetch` to Nox `HttpRequest`), `jsonrpc.ts`, `errors.ts`, `log.ts`, `storage.ts`, `spec-types.ts` (anon-rpc SPEC 0.3.2 worker types) |
| `snapshot/` | The pinned registry snapshot, its keccak-256, JSON Schema and reviewed capability hints, and the discovery bootstrap (`nox-bootstrap.json`) |
| `scripts/` | Snapshot generator and verifier, reproducible WASM and bundle build, hashing, provenance |
| `specifier/` | Worker specifier contracts (Foundry) and a read-only deploy planner and inspector |
| `e2e/` | End-to-end test bed: a local Nox mesh with `nox-kps` sidecars, the reference harness in headless Chromium |

## Configuration

`anonRpcWorker.config` is optional; `undefined` and `{}` boot on the anchors pinned in the bundle. Every field is
optional, and every config valid for 0.1.0 stays valid:

| Field | Type | Default | Range and meaning |
|---|---|---|---|
| `v` | number | 1 | must be 1 |
| `gateways` | string[] | the bundle's default anchors | 1-16 unique KPS addresses (`<ip>:<port>:<certhash>`, no DNS names), tried first in place of the default anchors. Any address is accepted: the node behind it must name an eligible member in its `/metadata.json` before the worker routes through it |
| `bridges` | string[] | none | 1-16 KPS addresses. When set, the worker dials **only** bridges and never a published Nox address (Tor bridge semantics). Each bridge's `/metadata.json` names the member it serves (nox-kps `node_address`), which must be in the bundle's snapshot. Excludes `gateways` |
| `registryRpcUrls` | string[] | the bundle's list | 2-8 `https:` URLs, replacing the bundle's registry RPC providers (for example a wallet's own Arbitrum node) |
| `chainQuorum` | integer | 2 (bundle policy) | 2-4 (exit, provider) pairs that must answer byte for byte the same; a check waits when fewer distinct exits or providers are available |
| `discovery` | `"chain"`, `"snapshot"` | `"chain"` | `"snapshot"`: no registry reads, the pinned snapshot is the only membership source (0.1.0 behaviour, no RPC provider involved) |
| `trust` | `"auto"` | `"auto"` | reserved for proof-backed discovery; any other value fails with `bad-config` |
| `checkpoint` | | | reserved; any value fails with `bad-config` |
| `logLevel` | `"debug"`, `"info"`, `"warn"`, `"error"` | `"info"` | |
| `attemptTimeoutMs` | integer | 12,000 | 3,000-60,000 |
| `callDeadlineMs` | integer | 25,000 | at least `attemptTimeoutMs`, at most 120,000 |
| `maxConcurrentCalls` | integer | 16 | 1-64 |
| `maxRequestBytes` | integer | 1,048,576 | 1,024-4,194,304 |
| `maxResponseBytes` | integer | 8,388,608 | 65,536-67,108,864 |
| `surbFormat` | `"auto"`, `"v1"`, `"v2"` | `"auto"` | |
| `claimIntervalMs` | integer | 200 | 50-2,000 |
| `bootRetryMaxMs` | integer | 60,000 | 5,000-300,000 |
| `topologySources` | integer | 2 | 1-4 |
| `warmup` | boolean | false | one echo through a full route before ready |

An unknown key, a wrong type or an out-of-range value fails the boot with `bad-config`, naming the field.

Examples:

- default wallet: no config, or `{}`;
- censored user: `{ "bridges": ["203.0.113.9:15005:uEiB..."] }`;
- adopters listing `exampleConfig`:

```json5
{ gateways: ["100.56.0.72:15005:uEiBVDwIs40bsslDkM-BYb2AOHw3PHe70_bj5U_09r7vdIQ"] }
```

## Discovery (identity from chain, location at run time)

The bundle pins `snapshot/nox-bootstrap.json` (`nox-anon-rpc-bootstrap/1`) next to the snapshot, both covered by
the worker hash:

| Field | Value |
|---|---|
| `anchors` | nox-1 `100.56.0.72:15005`, nox-2 `3.232.137.146:15005`, nox-8 `18.215.18.61:15005` (Elastic IPs) with their KPS certhashes |
| `registry`, `registryImpl` | NoxRegistry `0xf7bf...6cb6` on Arbitrum Sepolia (421614), implementation `0x7285...e2a2` behind the EIP-1967 proxy |
| `registryRpcUrls` | `https://sepolia-rollup.arbitrum.io/rpc` (Offchain Labs) and `https://arbitrum-sepolia-testnet.api.pocket.network` (Pocket Network): keyless, and checked through the live exits for `finalized`, EIP-1898 block-hash reads at the finalized block and 20-call batches. Tenderly's and Tatum's public gateways rate-limit or charge for those batches, PublicNode prunes the state of the finalized block, dRPC's free tier caps batches at 3 calls; a wallet can add its own providers with `registryRpcUrls` |
| `policy` | quorum 2, state at most 3,600 s old, check every 600 s, at most 1 member on probation per route, probation 14 days, removals need 2 anchors, 2 members per layer |

Boot: the worker dials, in priority classes and shuffled within each, bridges only (when set); otherwise the
wallet's gateways or the bundle's anchors, then learned anchors, then the snapshot's KPS addresses, three at a time.
As soon as one anchor serves an acceptable topology it signals ready (boot time unchanged). Served topologies are
judged on identity (address, Sphinx key, role): a changed IP is a move, never a removal.

After ready, the SDK reads NoxRegistry at one finalized block through the mixnet: two different exits to two
different providers, every call pinned to the block hash. It uses the answer only when both pairs agree byte for
byte, the registered members close the set (`relayerCount()` and the XOR `topologyFingerprint()`), and the proxy
still points at the implementation the bundle knows. The answer updates locations and removes members (each route
layer keeps at least two snapshot members); a member outside the snapshot is on probation for 14 days after the
worker first saw it, and a route holds at most one such member. Checks repeat every 10 minutes, and early when a
served fingerprint differs or every entry failed. Log events: `discovery.verified`, `discovery.disagreement`,
`discovery.incomplete`, `discovery.rejected`, `discovery.probation`, `discovery.floor`, `discovery.failed`.

What each party learns: RPC providers see exit IPs and public registry reads, never the wallet's address. Until
TLS runs inside the worker, the exits terminate HTTPS, so the two-exit quorum is attested by the exits; probation
and the snapshot floor bound what a forged answer can change. If every chain path fails, the worker keeps working
on the snapshot floor.

Operators move by sending `updateUrl` / `updateMetadataUrl` from the node key (self-service, about 0.00002 ETH);
running workers pick the new address up within about 10 minutes.

## Readiness and failure codes

The worker signals ready once the config is valid, the embedded WebAssembly is initialised, the pinned snapshot
verifies, a KPS entry has answered and a served topology was accepted. Transient faults (no entry reachable,
a topology fetch failing) are retried with back-off while `ready` stays pending.

`signalFailed` codes: `bad-config`, `unsupported-platform` (no KPS dialer, `crypto.getRandomValues` or
WebAssembly), `wasm-blocked` (the embedder's CSP must allow `'wasm-unsafe-eval'`), `snapshot-invalid`,
`snapshot-invalid` also covers an invalid discovery bootstrap. `snapshot-stale` (two or more nodes agree the registry no
longer lists any known member of a route layer with its identity, and a chain check does not resolve it: a newer
bundle is due) and `internal-error`. Members that are listed but reported offline, as while
nodes reconnect after a restart, keep the worker running: calls through them fail one by one (`timeout` or
`network-error`) until a topology refresh sees them online.

A rejected call carries a string `code`: `cancelled` (`AbortError`), `timeout`, `network-error`, `too-large`,
`unsupported`, `protocol-error` or `internal-error`. Redirects follow `fetch` rules inside the call deadline (at
most 5 hops). `eth_sendRawTransaction` is sent once and never resent; after a `timeout`, check the receipt by
transaction hash.

## Storage

The worker stores public network state only, under `nox/v1/`: members recent topologies removed (reorders anchors)
and the learned-anchor cache (`nox/v1/anchors`): KPS addresses verified chain checks confirmed, with the block they
were read at, and when each member outside the snapshot was first seen. At most 32 anchors, each dropped after 30
days. A cache that fails any check (another registry, too many records, one malformed record) is ignored whole, and
a learned address is used only after the node's `/metadata.json` names the same member.

## What the bundle contains

- `dist/anon-rpc-worker.js`: a single IIFE built by esbuild (target es2022, not minified, so it can be read
  and audited). Every module is inlined: the worker source, the `@hisoka-io/nox-client` sources, the
  `nox-wasm` WebAssembly module (base64), the pinned registry snapshot and the discovery bootstrap, each embedded
  byte for byte as one string.
  The bundle has no imports and never loads code or WebAssembly by URL. The SDK's ambient `fetch` and
  `WebSocket` defaults are replaced at build time by a stand-in that fails closed, and the build checks the
  output for any other network API.
- `dist/anon-rpc-worker.js.keccak256`: the Ethereum keccak-256 of those exact bytes, the value a worker
  specifier pins as `workerHash()`.
- `dist/anon-rpc-worker.provenance.json`: source commit, toolchain versions, input digests (snapshot, bootstrap,
  WASM, lockfile) and output digests.

## Pinned registry snapshot

`snapshot/nox-snapshot.json` (format `nox-anon-rpc-snapshot/1`, schema in `snapshot/nox-snapshot.schema.json`)
records every NoxRegistry member on Arbitrum Sepolia at one block: address, Sphinx key, routing and ingress
URLs, `metadataUrl` (where each node publishes its KPS address as `kps:<ip>:<port>:<certhash>/metadata.json`),
stake, role, layer, status, and reviewed capability hints from `snapshot/capabilities.json`. Its topology
fingerprint is computed with the SDK's own `computeTopologyFingerprint` and equals the registry's on-chain
`topologyFingerprint()` at that block.

Nodes may serve fresher topology over KPS. The worker uses it for liveness and removals (only when two different
nodes agree, keeping at least two members per route layer) and for moved routing addresses two nodes agree on;
additions and confirmed locations come from the chain check.

The committed snapshot records the fleet before the nodes publish their KPS addresses; with the default anchors it
boots anyway. A release snapshot taken after the migration lets older clients find more entries without any chain
read, and passes the release gate against the chain through two RPC providers.

```bash
pnpm --filter @hisoka-io/nox-client build
node scripts/make-snapshot.mjs --rpc <arbitrum-sepolia-rpc> --rpc <second-rpc> [--block <n>]
node scripts/verify-snapshot.mjs --offline                           # schema, hashes, SDK-derived fields
node scripts/verify-snapshot.mjs --rpc <rpc> --rpc <rpc> --release   # chain re-read + every member publishes a KPS address
```

## Building and checking the hash

```bash
corepack enable && pnpm install --frozen-lockfile
bash packages/anon-rpc-worker/scripts/build-worker.sh --release   # pinned toolchain, clean tree
node packages/anon-rpc-worker/scripts/hash.mjs packages/anon-rpc-worker/dist/anon-rpc-worker.js
```

`scripts/toolchain.env` pins every tool that shapes the bytes: the Node and Rust container images by digest,
rustc, wasm-pack, wasm-bindgen and binaryen (with sha256 digests of their release archives); pnpm comes from the
repository's `packageManager` field and esbuild from the lockfile. `scripts/build-wasm.sh` follows the
tor-js recipe: path remapping, a `RUSTC_WRAPPER` that makes cargo's metadata host-independent, `--locked`, and
a pinned `wasm-opt` on `PATH`.

`scripts/verify-reproducible.sh` builds a commit twice from clean `git archive` exports in fresh containers
of the pinned images, at two different paths, and compares the WASM, bundle and provenance digests
(`--local` does the same with the host's tools).

For a test bed, `node scripts/build.mjs --snapshot <file>` embeds another canonical snapshot (for example a
local mesh); the provenance records which snapshot a bundle carries.

## Tests

```bash
pnpm --filter @hisoka-io/anon-rpc-worker test     # worker, SDK integration over an in-memory KPS network, build
pnpm --filter @hisoka-io/anon-rpc-specifier test        # Foundry and harness-path tests (forge, anvil)
```

The end-to-end bed has its own lockfile: see `e2e/README.md`.
