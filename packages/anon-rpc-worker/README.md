# @hisoka-io/anon-rpc-worker

The Nox mixnet worker for the [anon-rpc](https://github.com/ethereum/anon-rpc) standard: one classic-script
bundle that a wallet's anon-rpc harness loads and pins by its keccak-256 hash.

This package holds the build pipeline and the pinned NoxRegistry snapshot. `src/index.ts` is a minimal
conforming worker that answers `fetch` calls directly, so the pipeline can be exercised end to end; the Nox
worker that routes calls through the mixnet takes its place next.

## What the bundle contains

- `dist/anon-rpc-worker.js`: a single IIFE built by esbuild (target es2022, not minified, so it can be read
  and audited). Every module is inlined: the worker source, the `@hisoka-io/nox-client` sources, the
  `nox-wasm` WebAssembly module (base64) and the pinned registry snapshot. The bundle has no imports and never
  loads code or WebAssembly by URL.
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

```bash
pnpm --filter @hisoka-io/nox-client build
node scripts/make-snapshot.mjs --rpc <arbitrum-sepolia-rpc> [--rpc <second-rpc>] [--block <n>]
node scripts/verify-snapshot.mjs --offline                 # schema, hashes, SDK-derived fields
node scripts/verify-snapshot.mjs --rpc <rpc> [--rpc <rpc>] # re-read the chain at the recorded block
node scripts/verify-snapshot.mjs --offline --release       # every member publishes a KPS address
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

## Tests

```bash
pnpm --filter @hisoka-io/anon-rpc-worker test
```
