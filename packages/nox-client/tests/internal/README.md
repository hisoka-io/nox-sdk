# Internal test scripts

These tests and scripts exercise the SDK against a running Nox mesh. They are **not** part of the
default `pnpm test` suite because they require external infrastructure.

## What's here

| Script / test | Needs | Run with |
| --- | --- | --- |
| `run_e2e.sh` | `NOX_REPO` + anvil + node | `NOX_REPO=/path/to/nox bash tests/internal/run_e2e.sh` |
| `stress_mesh.ts` | Running local mesh via `$MESH_INFO_PATH` | `npx tsx tests/internal/stress_mesh.ts` |
| `test_100mb_burst.ts` | Running local mesh | `npx tsx tests/internal/test_100mb_burst.ts` |
| `traffic_generator.ts` | Verified live config; `FUNDED_KEY` unless writes are skipped | `SEED=... ETH_RPC_URL=... REGISTRY_ADDRESS=... SKIP_WEB3_WRITES=1 npx tsx tests/internal/traffic_generator.ts` |
| `live_comprehensive.ts`, `live_testnet.ts` | Verified live config; `FUNDED_KEY` for comprehensive writes | `SEED=... ETH_RPC_URL=... REGISTRY_ADDRESS=... npx tsx tests/internal/live_testnet.ts` |
| `live.test.ts`, `live_stability.test.ts` | `LIVE_TESTS=1` + reachable seed URL | `LIVE_TESTS=1 pnpm --filter @hisoka-io/nox-client test` |
| `echo_debug.ts`, `quick_echo.ts`, `e2e_mesh.ts` | Local mesh inputs, see file headers | `npx tsx tests/internal/<file>.ts` |

## Required tooling

- **anvil** for local EVM node: <https://book.getfoundry.sh/>
- **Node.js 18+**
- **pnpm** for the workspace
- A clone of **[hisoka-io/nox](https://github.com/hisoka-io/nox)** for mesh-based tests

## Environment variables

| Variable | Required for | Default | Description |
| --- | --- | --- | --- |
| `NOX_REPO` | `run_e2e.sh` | sibling `../../../../../nox` | Path to a checkout of the Nox server repo |
| `MESH_INFO_PATH` | Tests that attach to a running mesh | `/tmp/nox_mesh/mesh_info.json` | JSON emitted by a running mesh describing node endpoints |
| `SEED` | Public live scripts | none | HTTP endpoint that returns the topology snapshot |
| `ETH_RPC_URL` | Public live scripts | none | Trusted RPC used for independent Registry verification |
| `REGISTRY_ADDRESS` | Public live scripts | none | Current Registry address from the signed deployment record |
| `FUNDED_KEY` | Explicit live write tests | none | Nonzero lowercase private key supplied through the environment |
| `SKIP_WEB3_WRITES` | `traffic_generator.ts` | unset | Set to `1` to run read-only traffic without a funded key |
| `LIVE_TESTS` | vitest live test suites | unset | Set to `1` to un-skip the live test suites |
| `ANVIL_PORT`, `BASE_PORT`, `MESH_NODES` | `run_e2e.sh` | `8545`, `14000`, `10` | Port and size overrides for the local mesh |
| `RUN_LARGE_DOWNLOADS` | `run_e2e.sh` | unset | Set to `1` to include the 10MB + 100MB response tests |
| `DEBUG_POLL` | `run_e2e.sh` | unset | Set to `1` for verbose SURB replenishment logs |

## Scripts fail cleanly if their inputs are missing

Scripts validate required inputs and fail with the missing or malformed field name. Public live scripts never
enable the loopback-only topology bypass.

## Why these live in the public repo

They're development aids, not public APIs. The tests that DO cover the public
SDK surface live in `packages/nox-client/tests/` and run under `pnpm test`. If
you're consuming `@hisoka-io/nox-client` as an npm dependency, you don't need
anything in this directory.
