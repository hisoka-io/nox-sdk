#!/usr/bin/env bash
# DeFi E2E integration test orchestrator.
#
# Exercises the SDK against a local EVM contracts project (deploy + deposit/withdraw/transfer
# surface) with or without the Nox mixnet in the path. Orchestrates Anvil, optionally a Nox
# mesh, and runs the integration test suite.
#
# This test requires an external EVM contracts project that is NOT part of this public SDK.
# You provide the path to your contracts repo via CONTRACTS_DIR. The test expects:
#   - A Hardhat project rooted at $CONTRACTS_DIR
#   - A deploy script at scripts/deploy.ts invoked via `npx hardhat run scripts/deploy.ts`
#   - The deploy script emits lines matching "DarkPool:|Staking|COMPLETE"
#
# Requires:
#   CONTRACTS_DIR  Path to the Hardhat EVM contracts project. No default; must be set.
#   NOX_REPO       Path to a Nox server checkout (https://github.com/hisoka-io/nox).
#                  Only required in --mixnet mode. Defaults to a sibling at ../../../../../nox.
#   anvil          Installed and on PATH.
#   node, npx      For Hardhat and the test runner.
#
# Usage:
#   CONTRACTS_DIR=/path/to/evm-contracts bash tests/internal/run_defi_e2e.sh             # direct mode
#   CONTRACTS_DIR=/path/to/evm-contracts NOX_REPO=/path/to/nox \
#     bash tests/internal/run_defi_e2e.sh --mixnet                                        # full mixnet

set -euo pipefail

if [ -z "${CONTRACTS_DIR:-}" ]; then
    cat >&2 <<EOF
skip: CONTRACTS_DIR is not set.

This integration test requires an external EVM contracts project. Set
CONTRACTS_DIR to the root of a Hardhat project with a scripts/deploy.ts
and re-run:

    CONTRACTS_DIR=/path/to/evm-contracts bash tests/internal/run_defi_e2e.sh
EOF
    exit 0
fi

if [ ! -d "$CONTRACTS_DIR" ]; then
    echo "error: CONTRACTS_DIR does not exist: $CONTRACTS_DIR" >&2
    exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
USE_MIXNET=false
ANVIL_PID=""
MESH_PID=""

if [ "${1:-}" = "--mixnet" ]; then
    USE_MIXNET=true
    NOX_REPO="${NOX_REPO:-$(cd "$SCRIPT_DIR/../../../../.." 2>/dev/null && pwd)/nox}"
    if [ ! -d "$NOX_REPO/crates" ]; then
        cat >&2 <<EOF
error: --mixnet requires a Nox server checkout at NOX_REPO.

Set NOX_REPO to a clone of https://github.com/hisoka-io/nox, or place the
repo as a sibling directory to nox-sdk:

    git clone https://github.com/hisoka-io/nox.git
    NOX_REPO=\$(pwd)/nox bash tests/internal/run_defi_e2e.sh --mixnet
EOF
        exit 2
    fi
fi

echo "=== DeFi E2E Test Runner ($([ "$USE_MIXNET" = true ] && echo MIXNET || echo DIRECT)) ==="
echo ""

cleanup() {
    echo ""
    echo "[cleanup] Stopping processes..."
    [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true
    [ -n "$MESH_PID" ] && kill "$MESH_PID" 2>/dev/null || true
    pkill -f "nox.*14000" 2>/dev/null || true
}
trap cleanup EXIT

# 1. Start fresh Anvil
echo "[1/5] Starting fresh Anvil..."
pkill -f "anvil.*8545" 2>/dev/null || true
pkill -f "nox.*14000" 2>/dev/null || true
sleep 1
rm -rf /tmp/nox_mesh /tmp/nox_e2e_logs
mkdir -p /tmp/nox_mesh /tmp/nox_e2e_logs

anvil --port 8545 --silent &
ANVIL_PID=$!
sleep 2

if ! curl -s -X POST http://127.0.0.1:8545 -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' | grep -q "0x7a69"; then
    echo "ERROR: Anvil failed to start"
    exit 1
fi
echo "  Anvil running (PID $ANVIL_PID)"

# 2. Deploy contracts via Hardhat
echo "[2/5] Deploying contracts from $CONTRACTS_DIR..."
cd "$CONTRACTS_DIR"
NODE_OPTIONS="--import tsx" npx hardhat run scripts/deploy.ts --network localhost 2>&1 | \
    grep -E "DarkPool:|Staking|COMPLETE" | head -5
echo "  Contracts deployed"

# 3. Start Nox mesh (mixnet mode only)
if [ "$USE_MIXNET" = true ]; then
    echo "[3/5] Starting 5-node Nox mesh from $NOX_REPO..."
    cd "$NOX_REPO"
    NOX_KEEP_LOGS=1 cargo run -p nox-sim --bin nox_mesh_server --features dev-node --release -- \
        --nodes 5 --data-dir /tmp/nox_mesh --base-port 14000 --anvil-port 8545 --mix-delay-ms 0 \
        > /tmp/nox_e2e_logs/mesh_stdout.log 2> /tmp/nox_e2e_logs/mesh_server.log &
    MESH_PID=$!

    for i in $(seq 1 90); do
        [ -f /tmp/nox_mesh/mesh_info.json ] && echo "  Mesh ready (${i}s)" && break
        sleep 1
    done
    sleep 3
    curl -s http://127.0.0.1:14002/health > /dev/null \
        && echo "  Ingress OK" \
        || echo "  WARNING: Ingress not ready"
else
    echo "[3/5] Skipping mesh (direct mode)"
fi

# 4. Run the DeFi E2E test
echo "[4/5] Running DeFi E2E test..."
cd "$SCRIPT_DIR/.."
EXIT_CODE=0

if [ "$USE_MIXNET" = true ]; then
    MESH_INFO_PATH=/tmp/nox_mesh/mesh_info.json npx tsx tests/internal/defi_e2e.ts 2>&1 || EXIT_CODE=$?
else
    npx tsx tests/internal/defi_e2e.ts 2>&1 || EXIT_CODE=$?
fi

# 5. Report
echo ""
echo "[5/5] Done."
if [ $EXIT_CODE -eq 0 ]; then
    echo "=== DeFi E2E: ALL PASSED ==="
else
    echo "=== DeFi E2E: FAILED (exit code $EXIT_CODE) ==="
fi
exit $EXIT_CODE
