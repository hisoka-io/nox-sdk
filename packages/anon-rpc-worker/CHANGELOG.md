# Changelog

All notable changes to `@hisoka-io/anon-rpc-worker`.

## 0.4.0 (unreleased)

Built on `@hisoka-io/nox-client` 0.8.0. Every 0.3.0 config stays valid; with the new defaults, https calls go
through TLS tunnels and need exits on nox rc.9 or later with `[tunnel]` enabled.

### Added

- End-to-end TLS (README "End-to-end TLS"): the worker runs TLS 1.3 and 1.2 itself (rustls with ring in a second
  embedded WebAssembly module, `packages/nox-tls`, compiled at boot) and exits relay TLS records over one TCP
  connection per tunnel. Requests and responses stay end-to-end encrypted between the worker and the RPC provider,
  and the mixnet keeps the sender anonymous; the exit sees the provider's host name, timing and sizes.
- Config `tls` (`"required"` default, `"preferred"`, `"off"`), `tlsSession` (`"per-call"` default, `"keep-alive"`),
  `tlsSpares`, `tlsSpareTtlMs`, `tlsKeepAliveMs`, `tlsMaxCallsPerSession`, `tlsOpenTimeoutMs`, `tlsCopyAfterMs`,
  `tlsGapMs`, `tlsMaxCopies`.
- Per-call sessions with handshaken spares per recently used host, opened in the background after the first wallet
  call settled; keep-alive sessions as an opt-in. Resumption and 0-RTT stay off; ALPN is `http/1.1`.
- HTTP/1.1 in the worker: caller headers keep their order and duplicates; framing, hop-by-hop and `User-Agent`
  headers are set by the encoder alone; CR, LF and NUL are refused; a whole JSON request is padded to a size bucket;
  responses are complete only by HTTP framing or TLS close_notify.
- Call code `permission-denied` (the tunnel exit refuses the destination). Log events `boot.tls`, `tls.open`,
  `tls.fallback`, `tls.reject`, `tls.exit.skipped`, `tls.retry`.
- Build: `nox-tls` built with the pinned toolchain and a pinned clang (`DEBIAN_SNAPSHOT`, `CLANG_PACKAGE_VERSION`,
  `CLANG_VERSION` in `scripts/toolchain.env`); provenance records its digest, clang, the webpki-roots version and
  release date, and `extraRoots`. `build.mjs --extra-root` and `build-test-worker.mjs --extra-root` for test beds;
  `build-worker.sh --release` refuses a bundle with extra roots.
- Release gate: `verify-snapshot.mjs --release` requires an exit whose capability hints carry `tunnel_v1`.

## 0.3.0 (2026-10-06)

Every 0.2.0 config stays valid. Works against entries on nox 0.4.0-rc.6 and on nodes with claim protocol v2.

### Added

- Config `hedgeAfterMs` (default 3,000, 0 turns it off): resendable reads send a second copy on another route at
  about the observed p95 reply time; the first reply wins.
- The client runs with the low-latency settings: binary, retaining, long-polling claims where the entry supports
  them; concurrent claims with data blocks first; immediate resend on a lost reply; two transport-failure resends;
  same-entry resends for a single bridge; a standby entry kept connected (claims share the primary connection).
- Wallet calls first: the first registry check waits for the first call to settle (at most 15 s).
- Compressed replies: upstream requests carry `accept-encoding: gzip` where the runtime has `DecompressionStream`,
  and the worker inflates gzip bodies itself, capped at `maxResponseBytes`. A 414 KB `eth_getLogs` reply crosses the
  mixnet as about 41 KB (2 reply packets instead of 14), a full block of 490 KB as about 81 KB (3 instead of 16).
- Worker-local answers: `eth_chainId` and `net_version` per upstream URL once a second, independently routed
  request agrees. Reads addressed by block hash (`eth_getBlockByHash`, `eth_getBlockReceipts`, `eth_getLogs`
  with `blockHash`, EIP-1898 `{blockHash}` state reads, kept once two calls returned the same result) are behind
  the `LocalAnswers` option `blockHashReads`, off in the worker until answers are checked against the hash. A hit answers at
  once with the caller's JSON-RPC `id` and sends nothing. `Cache-Control: no-cache` or `no-store` skips it. An
  empty log or receipt list is always fetched again, since an upstream behind the chain head answers `[]`.
- The client's send-path settings: chunked packet writes, a send-window warm-up after each entry connection
  opens, and concurrent calls spread over the pinned and standby entries.

## 0.2.0 (2026-10-06)

Built on `@hisoka-io/nox-client` 0.6.0 (`kps.discovery`). Every 0.1.0 config stays valid.

### Added

- Discovery (S1): identity from the snapshot and NoxRegistry, location looked up at run time. The bundle pins a
  `nox-anon-rpc-bootstrap/1` file next to the snapshot: default anchors nox-1, nox-2 and nox-8 on their Elastic IPs,
  the registry implementation, two keyless Arbitrum Sepolia RPC providers of different organisations and the
  discovery policy. An empty config boots on those anchors.
- Chain checks through the mixnet after ready: two exits to two providers at one finalized block, used on
  byte-identical agreement only; location updates, removals, new members on probation (1 per route, 14 days).
- Config: `bridges` (only addresses ever dialled), `registryRpcUrls`, `chainQuorum`, `discovery`
  (`"chain"` / `"snapshot"`), reserved `trust` and `checkpoint`.
- Learned-anchor cache `nox/v1/anchors` (public chain data, at most 32 entries, 30 days), validated whole and
  confirmed through `/metadata.json` before use.
- Build: `--bootstrap`, bootstrap digest in the build record and provenance; the test-bed build writes a bed
  bootstrap (local providers, anchors, short check interval).

- Release snapshot of NoxRegistry at Arbitrum Sepolia block 316207920 (10 members; nox-1, nox-2 and nox-8 publish
  their KPS addresses), read and re-verified byte for byte through two RPC providers.
- `verify-reproducible.sh --native` (a third build with host tools next to the two container builds) and `--bwrap`
  (host builds at the container paths for hosts without a container runtime).

### Changed

- `gateways` no longer has to be a pinned member's published address; gateways are tried first in place of the
  default anchors instead of restricting entries. After the gateways, the worker may dial the default anchors and
  other published entries. Wallets that used `gateways` to keep traffic on chosen addresses switch to `bridges`,
  which the worker treats as the only addresses it ever dials.
- A gateway or bridge must answer `/metadata.json` with the node it serves (nox-kps `node_address`), and that node
  must be a member in the bundle's snapshot.

### Fixed

- Reproducible WASM across checkout paths: `reproducible-rustc.sh` strips the cargo home, sysroot and workspace
  prefixes only at the start of a source path. A checkout at a path such as `/src` used to rewrite the
  `registry/src/` part of every dependency path, which changed each crate's `-C metadata` and the module bytes.

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
