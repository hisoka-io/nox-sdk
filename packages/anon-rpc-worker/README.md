# @hisoka-io/anon-rpc-worker

The Nox mixnet worker for the [anon-rpc](https://github.com/ethereum/anon-rpc) standard: one classic-script
bundle that a wallet's anon-rpc harness loads and pins by its keccak-256 hash.

The worker dials Nox entry nodes over KPS (`anonRpcWorker.kps`), sends each `fetch` call as a Sphinx packet
through the mixnet, and an exit node performs the HTTP request; the reply returns over single-use reply blocks
(SURBs). The node set comes from a NoxRegistry snapshot pinned inside the bundle, so a cold boot needs no seed
server and no public RPC. The bundle reaches the network only through the harness's KPS dialer.

What each party sees: the entry node sees the wallet's IP address and encrypted packets; the exit node sees the
HTTP request (RPC URL, headers it forwards, body) and never who sent it. End-to-end TLS inside the worker,
which also hides the request from the exit, is the next milestone.

## Layout

| Path | Contents |
|---|---|
| `src/` | The worker: `worker.ts` (bundle entry), `core.ts` (boot, readiness, accept loop, deadlines), `config.ts`, `fetch-map.ts` (`fetch` to Nox `HttpRequest`), `jsonrpc.ts`, `errors.ts`, `log.ts`, `storage.ts`, `spec-types.ts` (anon-rpc SPEC 0.3.2 worker types) |
| `snapshot/` | The pinned registry snapshot, its keccak-256, JSON Schema and reviewed capability hints |
| `scripts/` | Snapshot generator and verifier, reproducible WASM and bundle build, hashing, provenance |
| `specifier/` | Worker specifier contracts (Foundry) and a read-only deploy planner and inspector |
| `e2e/` | End-to-end test bed: a local Nox mesh with `nox-kps` sidecars, the reference harness in headless Chromium |

## Configuration

`anonRpcWorker.config` is optional; the worker boots with no config because entries and the node set are pinned
in the bundle. Every field is optional:

| Field | Type | Default | Range |
|---|---|---|---|
| `v` | number | 1 | must be 1 |
| `gateways` | string[] | all KPS-capable pinned members | 1-16 KPS addresses (`<ip>:<port>:<certhash>`), each a pinned member's address; restricts entries and topology sources |
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

## Readiness and failure codes

The worker signals ready once the config is valid, the embedded WebAssembly is initialised, the pinned snapshot
verifies, a KPS entry has answered and a served topology was accepted. Transient faults (no entry reachable,
a topology fetch failing) are retried with back-off while `ready` stays pending.

`signalFailed` codes: `bad-config`, `unsupported-platform` (no KPS dialer, `crypto.getRandomValues` or
WebAssembly), `wasm-blocked` (the embedder's CSP must allow `'wasm-unsafe-eval'`), `snapshot-invalid`,
`snapshot-stale` (two or more nodes agree the pinned set no longer forms a route: a newer bundle is due) and
`internal-error`.

A rejected call carries a string `code`: `cancelled` (`AbortError`), `timeout`, `network-error`, `too-large`,
`unsupported`, `protocol-error` or `internal-error`. Redirects follow `fetch` rules inside the call deadline (at
most 5 hops). `eth_sendRawTransaction` is sent once and never resent; after a `timeout`, check the receipt by
transaction hash.

## What the bundle contains

- `dist/anon-rpc-worker.js`: a single IIFE built by esbuild (target es2022, not minified, so it can be read
  and audited). Every module is inlined: the worker source, the `@hisoka-io/nox-client` sources, the
  `nox-wasm` WebAssembly module (base64) and the pinned registry snapshot, embedded byte for byte as one string.
  The bundle has no imports and never loads code or WebAssembly by URL. The SDK's ambient `fetch` and
  `WebSocket` defaults are replaced at build time by a stand-in that fails closed, and the build checks the
  output for any other network API.
- `dist/anon-rpc-worker.js.keccak256`: the Ethereum keccak-256 of those exact bytes, the value a worker
  specifier pins as `workerHash()`.
- `dist/anon-rpc-worker.provenance.json`: source commit, toolchain versions, input digests (snapshot, WASM,
  lockfile) and output digests.

## Pinned registry snapshot

`snapshot/nox-snapshot.json` (format `nox-anon-rpc-snapshot/1`, schema in `snapshot/nox-snapshot.schema.json`)
records every NoxRegistry member on Arbitrum Sepolia at one block: address, Sphinx key, routing and ingress
URLs, `metadataUrl` (where each node publishes its KPS address as `kps:<ip>:<port>:<certhash>/metadata.json`),
stake, role, layer, status, and reviewed capability hints from `snapshot/capabilities.json`. Its topology
fingerprint is computed with the SDK's own `computeTopologyFingerprint` and equals the registry's on-chain
`topologyFingerprint()` at that block.

Nodes may serve fresher topology over KPS. The worker accepts it only as removals from the pinned set, only when
two different nodes agree, and keeps at least two members per route layer; additions need a new bundle.

The committed snapshot records the fleet before the nodes publish their KPS addresses. The release snapshot is
generated once every node publishes its address, and passes the release gate against the chain through two RPC
providers.

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
