# Changelog

All notable changes to `@hisoka-io/anon-rpc-worker`.

## 0.1.0

First version of the Nox mixnet worker for the anon-rpc standard (SPEC 0.3.2), built on
`@hisoka-io/nox-client` 0.5.0 in KPS mode.

### Added

- The worker: boots from the NoxRegistry snapshot pinned in the bundle, dials Nox entry nodes through
  `anonRpcWorker.kps`, and serves `fetch` calls as Nox HTTP requests through an exit, with JSON-RPC aware reply
  sizing and retries for reads, per-call deadlines and abort, `fetch`-style redirects and stable `signalFailed` and
  per-call error codes. The config is optional and validated before ready.
- A reproducible single-file bundle: the nox-wasm module and the snapshot are embedded, the snapshot byte for byte;
  the SDK's ambient `fetch` and `WebSocket` defaults are replaced by a stand-in that fails closed, and the build
  checks the output for other network APIs. Provenance records the toolchain and every input digest.
- Snapshot tools: generation from the chain, offline and on-chain verification, and a release gate that requires
  every member's KPS address and two RPC providers.
- Worker specifier contracts (the reference `WorkerSpecifier` and an `ImmutableWorkerSpecifier`) with a read-only
  deploy planner and inspector.
- An end-to-end test bed: a local Nox mesh with `nox-kps` sidecars and the reference harness in headless Chromium.
