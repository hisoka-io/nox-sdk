# Internal test scripts

These tests and scripts exercise the SDK against a running Nox mesh and (for the
DeFi scenario) an external EVM contracts project. They are **not** part of the
default `pnpm test` suite because they require external infrastructure.

## What's here

| Script / test | Needs | Run with |
| --- | --- | --- |
| `run_e2e.sh` | `NOX_REPO` + anvil + node | `NOX_REPO=/path/to/nox bash tests/internal/run_e2e.sh` |
| `run_defi_e2e.sh` | `CONTRACTS_DIR` (+ optional `NOX_REPO` in mixnet mode) + anvil + node | `CONTRACTS_DIR=/path/to/contracts bash tests/internal/run_defi_e2e.sh [--mixnet]` |
| `stress_mesh.ts` | Running local mesh via `$MESH_INFO_PATH` | `npx tsx tests/internal/stress_mesh.ts` |
| `test_100mb_burst.ts` | Running local mesh | `npx tsx tests/internal/test_100mb_burst.ts` |
| `traffic_generator.ts` | `SEED` URL pointing at a mesh | `SEED=https://api.hisoka.io/seed npx tsx tests/internal/traffic_generator.ts` |
| `live.test.ts`, `live_stability.test.ts` | `LIVE_TESTS=1` + reachable seed URL | `LIVE_TESTS=1 pnpm --filter @hisoka-io/nox-client test` |
| `diagnose_*.ts`, `echo_debug.ts`, `quick_echo.ts`, `latency_*.ts`, `live_*.ts`, `e2e_mesh.ts`, `defi_e2e.ts` | Various, see file headers | `npx tsx tests/internal/<file>.ts` |

## Required tooling

- **anvil** for local EVM node: <https://book.getfoundry.sh/>
- **Node.js 18+**
- **pnpm** for the workspace
- A clone of **[hisoka-io/nox](https://github.com/hisoka-io/nox)** for mesh-based tests
- An EVM contracts project (Hardhat-based) with `packages/wallets`, `packages/prover`,
  and `packages/evm-contracts` subpackages for the DeFi scenario

## Environment variables

| Variable | Required for | Default | Description |
| --- | --- | --- | --- |
| `NOX_REPO` | `run_e2e.sh`, `run_defi_e2e.sh --mixnet` | sibling `../../../../../nox` | Path to a checkout of the Nox server repo |
| `CONTRACTS_DIR` | `run_defi_e2e.sh`, `defi_e2e.ts` | sibling `../../../../../contracts` | Root of the EVM contracts project |
| `MESH_INFO_PATH` | Tests that attach to a running mesh | `/tmp/nox_mesh/mesh_info.json` | JSON emitted by a running mesh describing node endpoints |
| `SEED` | `traffic_generator.ts`, live tests | `https://api.hisoka.io/seed` | HTTP endpoint that returns the topology snapshot |
| `LIVE_TESTS` | vitest live test suites | unset | Set to `1` to un-skip the live test suites |
| `ANVIL_PORT`, `BASE_PORT`, `MESH_NODES` | `run_e2e.sh` | `8545`, `14000`, `10` | Port and size overrides for the local mesh |
| `RUN_LARGE_DOWNLOADS` | `run_e2e.sh` | unset | Set to `1` to include the 10MB + 100MB response tests |
| `DEBUG_POLL` | `run_e2e.sh` | unset | Set to `1` for verbose SURB replenishment logs |

## Scripts fail cleanly if their inputs are missing

Every script checks its required environment variables and either exits `0`
with a `skip:` message (when the input is optional) or exits `2` with a clear
error (when the input is required for the scenario to mean anything). You won't
get silent failures or stray `cd: No such file or directory` errors.

## Why these live in the public repo

They're development aids, not public APIs. The tests that DO cover the public
SDK surface live in `packages/nox-client/tests/` and run under `pnpm test`. If
you're consuming `@hisoka-io/nox-client` as an npm dependency, you don't need
anything in this directory.
