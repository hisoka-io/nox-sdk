# Nox anon-rpc worker: local end-to-end test bed

This package runs the Nox anon-rpc worker the way a wallet runs it, entirely on one machine:

```
headless Chromium (Playwright)
  host page: published @anon-rpc/browser-harness 0.3.2 and 0.3.0
    reads a WorkerSpecifier on a local anvil chain, fetches the bundle from a local keccak resolver,
    verifies keccak256, boots the worker in the harness sandbox
      worker -> anonRpcWorker.kps (WebRTC) -> nox-kps sidecar (one per node, UDP base+10N+5)
        -> 10-node local Nox mesh (nox_mesh_server, real nox processes)
          -> exit HttpRequest -> upstream anvil (the wallet's RPC URL)
```

It also proves each layer on its own first: the harness with the upstream passthrough worker, browser
WebRTC-KPS against reference KPS servers, and the existing SDK HTTP transport through the same mesh and exits.

## One command

```sh
pnpm install --ignore-workspace          # once; this package has its own lockfile
NOX_REPO=/path/to/nox NOX_KPS_REPO=/path/to/nox-kps pnpm e2e:all       # scripts/run-all.sh
```

`run-all.sh` builds whatever is missing (nox and `nox_mesh_server` in `NOX_REPO`, the KPS reference servers, the
SDK's `nox-wasm` Node build and `nox-client` dist, Playwright's Chromium), then runs typecheck, unit tests and every
Playwright spec. With `NOX_KPS_REPO` it also builds nox-kps (`scripts/build-nox-kps-testbed.sh`, from a copy of the
checkout) and runs one sidecar per mesh node. `E2E_SKIP_BUILD=1` skips the builds; `E2E_ONLY=classic-sdk` runs one
spec file.

Prerequisites: Node 20+, pnpm 10, anvil (foundry 1.3.2), a Rust toolchain, Go 1.24+ (KPS reference and bulk
servers), solc 0.8.28 only to regenerate the vendored specifier artifact.

## Specs

| Spec | What it proves | Needs |
|---|---|---|
| `harness-passthrough.spec.ts` | The harness setup end to end with a known-good worker: the exact 1,704-byte passthrough bundle pinned by the mainnet passthrough specifier, deployed behind a real `WorkerSpecifier` on anvil, served by the local keccak resolver; JSON-RPC (single, batch), host abort, sandbox `allow-scripts`, tampered bytes refused. Its ambient fetches double as a negative control: the egress check flags each of them on the proxy and CDP layers. Harness 0.3.2 and 0.3.0. | anvil |
| `egress-guard.spec.ts` | Controls for the egress check. Negative: a hash-pinned leaky worker that, while getting ready, opens a WebSocket to an ingress-shaped `/api/v1/ws`, fetches `/topology` through `localhost` and calls a public RPC host; the check flags all three at boot, and the trap server confirms the WebSocket handshake really happened. Positive: the KPS probe worker completes KPS streams and the check reports an empty list. | anvil (KPS servers for the stream part) |
| `kps-webrtc.spec.ts` | Browser WebRTC-KPS in this environment: the page dials with `@kpstreams/webrtc-client` and a hash-pinned probe worker dials through `anonRpcWorker.kps` (`dial` and `openStream`). Echo (32 B, 32 KiB, 512 KiB, 10 sequential and 4 parallel streams) against the Go and Rust reference servers; small-request/large-response (32 KiB to 16 MiB) against `tools/kps-bulk-server`. Loopback and the host's external IPv4, with Chromium's default WebRTC settings and with the flags the upstream anon-rpc e2e uses. | KPS servers |
| `classic-sdk.spec.ts` | The existing SDK transport (HTTP ingress, seed topology, SURB replies) through the 10-node mesh: echo, then `eth_chainId`, `eth_getBalance`, a 3-call batch and a JSON-RPC error through an exit to the upstream anvil, compared with direct calls. | nox binaries, SDK dist |
| `nox-kps-sidecar.spec.ts` | One nox-kps per mesh node, reached from a hash-pinned probe worker through `anonRpcWorker.kps` with KPS-HTTP/1: `/topology` matches the node's own topology, `/health` and `/metadata.json` answer, `/api/v1/ws` stays unexposed. Runs once `NOX_KPS_CMD` is set. | nox binaries, nox-kps |
| `nox-worker.spec.ts` | The Nox worker through harness → KPS → nox-kps → mesh → exit → anvil: boot (`.ready`, sandbox), JSON-RPC parity with direct calls, a signed transaction landing on the upstream chain, calls issued before `ready`, host abort, `bad-config`, a latency sample. Every test runs under the egress check below, from page load on. Harness 0.3.2 and 0.3.0. Runs once `NOX_KPS_CMD` and a worker bundle are present. | everything above, nox-kps, worker bundle |

Reports land in `.run/reports/*.json` (latest) and in each run directory `.run/<timestamp>-<label>-<pid>/`
(`logs/` for anvil, mesh, node, KPS server, page console; `testbed.json`; `reports/`).

## Egress check

The Nox worker must reach the network only through KPS. Each test that asserts this opens the host page in its own
browser context, routed through a recording forward proxy (`src/egress-proxy.ts`). Playwright proxies loopback too
(`<-loopback>`), so every HTTP(S) request and every WebSocket from the page, the sandboxed harness frame and the
worker passes the proxy and is recorded, from before the first navigation. The proxy forwards loopback targets and
refuses all others without resolving them. Playwright's context `request` events and page `websocket` events are recorded
alongside.

The allowlist (`src/egress.ts`) holds three origins: the host page, the bundle resolver and the specifier RPC. Any other
HTTP(S) origin (including `localhost` aliases of a loopback port), every CONNECT tunnel to a host outside it, and every
WebSocket is a violation, and the test fails with the list. `egress-guard.spec.ts` proves both directions on every
run. WebRTC (the KPS transport itself) runs outside the HTTP stack; Chromium NetLog and packet capture, which cover
that layer and DNS, are the next step for TST-562.

## Long-running bed

```sh
NOX_REPO=/path/to/nox pnpm testbed            # chains + resolver + host page + mesh (+ nox-kps with NOX_KPS_CMD)
pnpm testbed --no-mesh                         # chains + resolver + host page
```

It prints every endpoint, writes `testbed.json` in the run directory and stops everything on Ctrl-C.

## nox-kps sidecars

`run-all.sh` sets this up from `NOX_KPS_REPO`. By hand: build with `scripts/build-nox-kps-testbed.sh` (add
`--ipfilter` on hosts whose `lo` carries more than one IPv4 address, see below), then set a command template; the bed
renders it once per mesh node and reads the KPS address the process prints:

```sh
export NOX_KPS_BIN=$PWD/.cache/bin/nox-kps            # or .cache/bin/nox-kps-ipfilter
export NOX_KPS_CONFIG_TEMPLATE=fixtures/nox-kps.toml.tmpl
export NOX_KPS_INIT_CMD="$NOX_KPS_BIN --config {config_file} init"
export NOX_KPS_CMD="$NOX_KPS_BIN --config {config_file} run"
```

Placeholders: `{node}`, `{node_address}`, `{udp_port}`, `{advertise_ip}`, `{listen}`, `{ingress_port}`, `{ingress_url}`,
`{topology_port}`, `{topology_url}`, `{admin_port}`, `{key_file}`, `{config_file}`, `{bundle_dir}`. Values never contain
whitespace and commands run without a shell. Port layout per node N: p2p `base+10N`, metrics and topology `+1`,
ingress `+2`, nox-kps UDP `+5`, nox-kps admin `+6` (base 27000 by default, `E2E_BASE_PORT`; the plan's bed L uses
14000).

## Nox worker bundle

The worker pins its topology snapshot inside the bundle, and the mesh generates fresh node keys on every run, so the
bundle is built for the running mesh:

```sh
export NOX_WORKER_BUILD_CMD="node ../scripts/build-test-worker.mjs --testbed {testbed_json} --out {out}"
```

`{testbed_json}` is the run's `testbed.json` (`src/testbed.ts` `TestbedInfo`): `mesh.nodes[]` with `id`, `role`
(1 relay, 2 exit, 3 full), `address`, `sphinxPublicKey`, `peerId`, `p2pMultiaddr`, `ingressUrl`, `topologyUrl` and
`kpsAddress`, plus both chains. The command writes the bundle to `{out}`; the bed pins it behind a fresh
`WorkerSpecifier` and boots it. Without a build command, `NOX_WORKER_BUNDLE` (default `../dist/anon-rpc-worker.js`)
is used as is. The worker config defaults to `{ "gateways": [<every sidecar address>], "logLevel": "debug" }`;
`NOX_WORKER_CONFIG` (a JSON file) or `NOX_WORKER_CONFIG_MODULE` (exports `buildWorkerConfig(testbed)`) replace it.

## Configuration

Every port, path, timeout and size comes from `src/config.ts`; each default can be overridden:

| Variable | Default | Meaning |
|---|---|---|
| `NOX_REPO`, `NOX_BIN`, `NOX_MESH_BIN` | `../nox-e2e`, `../nox`, `../nox-clean` next to nox-sdk | nox checkout and binaries |
| `E2E_MESH_NODES`, `E2E_MESH_ROLES` | 10, fleet layout `1,1,1,1,1,2,2,1,1,2` | mesh size and registry roles |
| `E2E_BASE_PORT`, `E2E_MIX_DELAY_MS` | 27000, 0 | mesh ports, Poisson mix delay per hop |
| `E2E_SPECIFIER_CHAIN_ID`, `E2E_UPSTREAM_CHAIN_ID` | 1, 31337 | anvil chain ids |
| `KPS_BIN_DIR`, `E2E_KPS_IP`, `E2E_KPS_DEBUG` | `.cache/bin`, 127.0.0.1, off | KPS servers |
| `E2E_KPS_ECHO_SIZES`, `E2E_KPS_DOWNLOAD_SIZES` | `32,32768,524288`, `32768,1048576,4194304,16777216` | KPS probe sizes |
| `NOX_KPS_CMD`, `NOX_KPS_INIT_CMD`, `NOX_KPS_CONFIG_TEMPLATE` | unset | nox-kps sidecars |
| `NOX_WORKER_BUILD_CMD`, `NOX_WORKER_BUNDLE` | unset, `../dist/anon-rpc-worker.js` | worker under test |
| `NOX_WORKER_CONFIG`, `NOX_WORKER_CONFIG_MODULE` | unset | worker config |
| `E2E_EXPECT_BAD_CONFIG_CODE` | `bad-config` | `signalFailed` code for an invalid config |
| `NOX_CLIENT_ENTRY` | `../../nox-client/dist/index.js` | classic SDK build |
| `E2E_*_TIMEOUT_MS` | see `src/config.ts` | readiness and call deadlines |

## KPS measurements on WSL2 (Chromium 153.0.8010.12 headless shell, Playwright 1.63.0)

| Server | Dials | Echo 32 B / 32 KiB / 512 KiB | Response 1 / 4 / 16 MiB |
|---|---|---|---|
| Go reference (`libs/go/cmd/server`) | 16/16, 57-71 ms | 2 / 4-17 / 27-38 ms | — |
| Rust reference + loopback IP filter | 16/16, 61-89 ms | 2-3 / 7-10 / 71-190 ms | — |
| Go bulk server (`tools/kps-bulk-server`) | 16/16, 55-77 ms | — | 24-92 / 88-234 / 365-729 ms |

Dials count 3 page dials and 1 harness dial per address and browser profile. Every row holds through the page client and through the harness bridge (`anonRpcWorker.kps.dial` and `openStream`),
for loopback and the external interface, with and without the upstream e2e's WebRTC flags.

Two results, each pinned by a test that flips when it changes:

- **Loopback with two IPv4 addresses.** The `kps` crate's WebRTC listener gathers candidates on interfaces named `lo*`
  and expects one address per family. WSL2 adds `10.255.255.254/32` to `lo`, and browser dials to the stock Rust
  server then end in `kps: HELLO timeout`. Restricting gathering to `127.0.0.1` and `::1`
  (`scripts/build-kps-ipfilter-probe.sh`, one line, diagnostic build only) brings it to 16/16. Hosts whose `lo`
  carries only `127.0.0.1/8` and `::1/128` use the stock crate.
- **Single-stream echo at the window.** One stream echoes up to 1,048,512 bytes in about 60 ms (Go server). A 1 MiB
  echo on one stream, with both directions in flight at the default 1 MiB stream window, waits past its deadline with
  both reference servers (Go: from 1,048,560 bytes); the cause is an open item, and the test records it as an
  expected failure. Nox sends at most 64 KiB per request stream and receives large replies as responses, which the
  16 MiB rows cover.

## Layout

```
src/           test-bed library: config, processes, anvil, mesh, KPS servers, specifier, resolver, host page server, egress proxy and allowlist, CLI
page/          host page script (window.e2e), bundled per harness version
workers/       hash-pinned test workers: KPS probe, leaky worker (egress negative control)
shared/        echo, bulk and KPS-HTTP/1 helpers used by the page and the probe worker
tools/         kps-bulk-server (Go, built against ethereum/kps libs/go)
contracts/     vendored reference WorkerSpecifier (MIT) and its compiled artifact
fixtures/      upstream passthrough worker bundle, nox-kps config template
tests/unit     vitest; tests/e2e Playwright specs
scripts/       run-all, KPS server builds, specifier compile
```
