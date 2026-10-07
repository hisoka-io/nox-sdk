# @hisoka-io/anon-rpc-worker

The Nox mixnet worker for the [anon-rpc](https://github.com/ethereum/anon-rpc) standard: one classic-script
bundle that a wallet's anon-rpc harness loads and pins by its keccak-256 hash.

The worker dials Nox entry nodes over KPS (`anonRpcWorker.kps`), sends each `fetch` call as a Sphinx packet
through the mixnet, and an exit node performs the HTTP request; the reply returns over single-use reply blocks
(SURBs). Who the nodes are comes from NoxRegistry: a snapshot pinned inside the bundle is the floor, and after
ready the worker reads the registry through the mixnet itself. Where the nodes are (IP, port, KPS certhash) is
looked up at run time, so operators change IPs whenever they like and new nodes join without a new bundle. A cold
boot needs no seed server and no public RPC; the bundle reaches the network only through the harness's KPS dialer.

What each party sees: the entry node sees the wallet's IP address and encrypted packets. With end-to-end TLS (the
default, `tls: "required"`), requests and responses stay end-to-end encrypted between the worker and the RPC
provider, and the mixnet keeps the sender anonymous: the worker runs TLS itself and the exit relays TLS ciphertext
over one TCP connection, seeing the provider's host name, timing and sizes (see [End-to-end TLS](#end-to-end-tls)).

## Layout

| Path | Contents |
|---|---|
| `src/` | The worker: `worker.ts` (bundle entry), `core.ts` (boot, readiness, accept loop, deadlines), `config.ts`, `fetch-map.ts` (`fetch` to Nox `HttpRequest`, redirects, gzip), `tls/` (end-to-end TLS: `tunnel.ts` one exit tunnel, `channel.ts` TLS and HTTP/1.1 over it, `pool.ts` sessions, spares and exit choice, `transport.ts` the per-hop transport and error mapping, `module.ts` the TLS module bindings), `jsonrpc.ts`, `errors.ts`, `log.ts`, `storage.ts`, `spec-types.ts` (anon-rpc SPEC 0.3.2 worker types) |
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
| `hedgeAfterMs` | integer | 3,000 | 0-60,000. Resendable reads send a second copy on another route when no reply arrived after this long, raised to the observed p95 reply time and kept below `attemptTimeoutMs`; the first reply wins. 0 turns hedging off |
| `callDeadlineMs` | integer | 25,000 | at least `attemptTimeoutMs`, at most 120,000 |
| `maxConcurrentCalls` | integer | 16 | 1-64 |
| `maxRequestBytes` | integer | 1,048,576 | 1,024-4,194,304 |
| `maxResponseBytes` | integer | 8,388,608 | 65,536-67,108,864 |
| `surbFormat` | `"auto"`, `"v1"`, `"v2"` | `"auto"` | |
| `claimIntervalMs` | integer | 200 | 50-2,000 |
| `bootRetryMaxMs` | integer | 60,000 | 5,000-300,000 |
| `topologySources` | integer | 2 | 1-4 |
| `warmup` | boolean | false | one echo through a full route before ready |
| `tls` | `"required"`, `"preferred"`, `"off"` | `"required"` | end-to-end TLS, see [End-to-end TLS](#end-to-end-tls) |
| `tlsSession` | `"per-call"`, `"keep-alive"` | `"per-call"` | one TLS session per call, or sessions shared by the calls to one host |
| `tlsSpares` | integer | 1 | 0-4 handshaken spare sessions per recently used host (per-call mode) |
| `tlsSpareTtlMs` | integer | 20,000 | 1,000-50,000; an unused spare is closed after this long |
| `tlsKeepAliveMs` | integer | 30,000 | 1,000-50,000; how long a keep-alive session serves calls after it opened |
| `tlsMaxCallsPerSession` | integer | 100 | 1-1,000 calls per keep-alive session |
| `tlsOpenTimeoutMs` | integer | 5,000 | 1,000-30,000; an exit that does not answer a tunnel open in this long is skipped for 10 minutes |
| `tlsCopyAfterMs` | integer | 2,500 | 500-30,000; another copy of the current tunnel exchange when nothing arrived for this long (raised to the observed p95) |
| `tlsGapMs` | integer | 800 | 100-10,000; another copy when a gap in the reply stream stays open this long |
| `tlsMaxCopies` | integer | 3 | 1-5 copies per exchange for silence or a gap |

An unknown key, a wrong type or an out-of-range value fails the boot with `bad-config`, naming the field.

Examples:

- default wallet: no config, or `{}`;
- censored user: `{ "bridges": ["203.0.113.9:15005:uEiB..."] }`;
- adopters listing `exampleConfig`:

```json5
{ gateways: ["100.56.0.72:15005:uEiBVDwIs40bsslDkM-BYb2AOHw3PHe70_bj5U_09r7vdIQ"] }
```

## End-to-end TLS

The worker carries a TLS client (rustls with ring, compiled to WebAssembly, `packages/nox-tls`) and runs TLS with
the RPC provider itself. A Nox exit that advertises `tunnel_v1` holds one TCP connection to the provider per tunnel
and relays TLS records both ways (`ServiceRequest::TunnelV1`, nox `docs/tunnel.md`). Requests and responses stay
end-to-end encrypted between the worker and the provider, and the mixnet keeps the sender anonymous; the exit relays
ciphertext.

What the exit learns: the provider's host name (from SNI, its own DNS lookup and the IP) and port 443; when a tunnel
opens and closes; the number, size and timing of TLS records in both directions (a whole JSON request is padded to
512 B, 1 KiB, 4 KiB, 16 KiB, then 16 KiB steps, so calls of similar size share one record size; response sizes stay
visible, and larger buckets are a later milestone); the TLS client fingerprint, shared by every worker of one
version; in keep-alive mode, which calls share a session. The URL path and query (API keys included), headers,
JSON-RPC methods and parameters, signed transactions, response content and the sender stay hidden from it, and the
worker detects any change or truncation of a response.

`tls`:

| `tls` | https on port 443, host by name | http, another port, or an IP-literal host | no known exit advertises `tunnel_v1` |
|---|---|---|---|
| `"required"` (default) | tunnel | rejects `unsupported` | rejects `network-error` |
| `"preferred"` | tunnel | exit `HttpRequest` (logged `tls.fallback`) | exit `HttpRequest` (logged `tls.fallback`) |
| `"off"` | exit `HttpRequest` | exit `HttpRequest` | exit `HttpRequest` |

The transport is chosen before any byte of a call leaves the worker, from the URL and the capability data, and a
call that started on a tunnel never continues on `HttpRequest`, redirects included. The capabilities of pinned
members are the hints in the bundle's snapshot (`snapshot/capabilities.json`), so tunnel exits change, and an exit
stops counting as one, only with a new bundle; with discovery, other members' capabilities come from the seed's
liveness data. `"preferred"` uses plaintext whenever no known exit advertises `tunnel_v1`; `"required"` keeps every
call end-to-end encrypted. An exit that answers `Disabled`, or no tunnel open within `tlsOpenTimeoutMs`, is skipped
for 10 minutes and the open moves to another tunnel exit; skipped exits still count as tunnel exits, so with every one
skipped a call fails with `network-error` under both settings.

Session modes:

- `"per-call"` (default): every call has its own TLS session and `Connection: close`; no resumption, no 0-RTT, a
  fresh key share each time. `tlsSpares` keeps handshaken, unused sessions for hosts the wallet called, opened in
  the background (only after the first wallet call settled) on a random tunnel exit after an exponential delay
  (mean 2 s), each serving one call. Each call travels in its own session; at low traffic the timing of a spare's
  open can still chain sequential calls of one wallet to one host, which weakens as traffic grows.
- `"keep-alive"`: calls to one host share a session on one exit for `tlsKeepAliveMs`, up to 4 sessions per host.
  The exit links the calls of a session, and the provider sees them on one TLS connection.

Latency: a call on a ready session (a spare, or a warm keep-alive session) costs what the exit `HttpRequest` path
costs. The first call to a host, and calls beyond the ready spares, add one mixnet round trip for the handshake.

Certificates are checked against the Mozilla root store compiled into the bundle (webpki-roots; the version and its
release date are in the provenance, refreshed with every worker release), with the host name and the device clock;
a wrong clock fails with a message that names it. Each worker release ships its root store, so wallets keep their
roots current by moving to new worker releases. Resends of a tunnel exchange go to the same exit through another
entry and mix and carry identical bytes, which the exit writes once; after a lost tunnel only reads that may be resent
run again on a new tunnel.

`tls` governs the wallet's calls. The chain check's registry reads (discovery) use the exit `HttpRequest` path: public
chain data, accepted only when a quorum of exit and provider pairs agrees byte for byte.

Next milestones: registry reads through tunnels as well, Encrypted Client Hello for providers that publish it, and
a hybrid post-quantum key exchange (X25519MLKEM768).

Errors: `permission-denied` (the exit refuses the destination), `network-error` (no tunnel exit, a certificate
failure, the exit cannot reach the provider), `protocol-error` (TLS or HTTP checks failed, a truncated response),
`too-large`, `timeout`. Log events: `boot.tls`, `tls.open` (debug: handshake time and CPU), `tls.fallback{reason}`,
`tls.reject{code}`, `tls.exit.skipped`, `tls.retry`; none carries bytes or a host name.

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

## Release 0.3.0

| | |
|---|---|
| `workerHash` (keccak-256 of `dist/anon-rpc-worker.js`) | `0x24604525d220bcc7e39f2dbc22966a814600a63ada51baafad5dd0bcc1d28549` |
| Size | 961,799 bytes; 279,515 bytes with `gzip -9 -n` |
| sha256 | `0458b19258dffcfb9ce23d584096f3df06532080390d34ee71b201b6b78dbbac` |
| Specifier | Ethereum Sepolia `0x29B51ca9Ad80E9c0B0D111C8748E6a7908b82eDB` (`ImmutableWorkerSpecifier`, resolvers in [specifier/README.md](./specifier/README.md#deployments)) |
| Snapshot | NoxRegistry at Arbitrum Sepolia block 316,207,920, keccak-256 `0xa351960e…94fbb2` |
| nox-wasm module | 188,708 bytes, sha256 `5171416972ea4499fd4b4ea8bcadf002f4c10f10ed42cafb0d5a426121da9c4f` |
| Built from | `nox-sdk` commit `6bddd851c5b1f4e5508f4718e2ea9b4db626b17f`, rustc 1.95.0, wasm-pack 0.13.1, wasm-bindgen 0.2.114, binaryen 117, esbuild 0.27.3 |

The npm package carries the bundle and provenance file of the first pinned container build.

Release 0.2.0: `workerHash` `0x0a58f9915f686950072a4786249d396ecbf2194a39ac835effe8ea1a7c76f324` (924,847 bytes, commit
`ef019a7`), specifier `0x29b4a6A8Cc11769531854d87f9F33EC63Efe8fe6`.

Two builds in fresh containers of the pinned images (at two different paths) give these exact bytes
(`scripts/verify-reproducible.sh --ref 6bddd85`). Run it from the repository root as
`packages/anon-rpc-worker/scripts/verify-reproducible.sh` (or `pnpm verify:reproducible` inside the package); host builds (`--native`,
`--local`) use rustc 1.95.0, so set `RUSTUP_TOOLCHAIN=1.95.0` when the host default differs.

## What the bundle contains

- `dist/anon-rpc-worker.js`: a single IIFE built by esbuild (target es2022, not minified, so it can be read
  and audited). Every module is inlined: the worker source, the `@hisoka-io/nox-client` sources, the
  `nox-wasm` and `nox-tls` WebAssembly modules (base64), the pinned registry snapshot and the discovery bootstrap,
  each embedded byte for byte as one string. The TLS module is compiled at boot, off the first call's path.
  The bundle has no imports and never loads code or WebAssembly by URL. The SDK's ambient `fetch` and
  `WebSocket` defaults are replaced at build time by a stand-in that fails closed, and the build checks the
  output for any other network API.
- `dist/anon-rpc-worker.js.keccak256`: the Ethereum keccak-256 of those exact bytes, the value a worker
  specifier pins as `workerHash()`.
- `dist/anon-rpc-worker.provenance.json`: source commit, toolchain versions, input digests (snapshot, bootstrap,
  both WASM modules, lockfile), the compiled-in root store (webpki-roots version and release date, and
  `extraRoots`, 0 in every release) and output digests.

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

The committed release snapshot is of block 316207920 (finalized, read and re-verified byte for byte through two RPC
providers of different organisations). It carries the KPS addresses nox-1, nox-2 and nox-8 publish, so the worker
finds its entries from the snapshot alone, and the default anchors and the chain check add any later moves.
The release gate names the seven mix and exit nodes, which serve the mixnet without a KPS listener, with
`--allow-missing-kps`, and requires an exit whose capability hints carry `tunnel_v1`: the hints in
`snapshot/capabilities.json` are regenerated from the seed once the exits relay tunnels, and the worker is rebuilt
(a new `workerHash`) before the 0.4.0 release.

```bash
pnpm --filter @hisoka-io/nox-client build
node scripts/make-snapshot.mjs --rpc <arbitrum-sepolia-rpc> --rpc <second-rpc> [--block <n>]
node scripts/verify-snapshot.mjs --offline                           # schema, hashes, SDK-derived fields
node scripts/verify-snapshot.mjs --rpc <rpc> --rpc <rpc> --release   # chain re-read, KPS addresses, a tunnel exit
```

## Building and checking the hash

```bash
corepack enable && pnpm install --frozen-lockfile
bash packages/anon-rpc-worker/scripts/build-worker.sh --release   # pinned toolchain, clean tree
node packages/anon-rpc-worker/scripts/hash.mjs packages/anon-rpc-worker/dist/anon-rpc-worker.js
```

`scripts/toolchain.env` pins every tool that shapes the bytes: the Node and Rust container images by digest,
rustc, wasm-pack, wasm-bindgen and binaryen (with sha256 digests of their release archives), and clang with llvm-ar
for ring's C sources in `nox-tls` (Debian bookworm packages at a snapshot.debian.org timestamp, the same on x86_64
and aarch64); pnpm comes from the repository's `packageManager` field and esbuild from the lockfile.
`scripts/build-wasm.sh` follows the tor-js recipe: path remapping, a `RUSTC_WRAPPER` that makes cargo's metadata
host-independent, `--locked`, and a pinned `wasm-opt` on `PATH`.

`scripts/verify-reproducible.sh` builds a commit twice from clean `git archive` exports in fresh containers
of the pinned images, at two different paths, and compares the WASM, bundle and provenance digests
(`--local` does the same with the host's tools). `--native` adds a third build with the host's tools to the two
container builds and requires all three to match; `--local --bwrap` runs the two host builds in bubblewrap mount
namespaces at the container paths, for hosts without a container runtime.

For a test bed, `node scripts/build.mjs --snapshot <file>` embeds another canonical snapshot (for example a
local mesh) and `--extra-root <ca.der>` a test CA next to the Mozilla roots; the provenance records which snapshot a
bundle carries and how many extra roots. The release build (`build-worker.sh --release`) refuses a bundle with an
extra root (`provenance.mjs --release`).

## Tests

```bash
pnpm --filter @hisoka-io/anon-rpc-worker test     # worker, SDK integration over an in-memory KPS network, build
pnpm --filter @hisoka-io/anon-rpc-specifier test        # Foundry and harness-path tests (forge, anvil)
```

The end-to-end bed has its own lockfile: see `e2e/README.md`.
