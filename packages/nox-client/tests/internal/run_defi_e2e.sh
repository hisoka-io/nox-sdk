#!/bin/bash
# DeFi E2E Integration Test Runner
# Starts fresh Anvil, deploys contracts, optionally starts NOX mesh, runs the test
#
# Usage:
#   ./run_defi_e2e.sh              # Direct mode (no mixnet)
#   ./run_defi_e2e.sh --mixnet     # Full mixnet mode (5-node mesh)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DARKPOOL_DIR="$(cd "$SCRIPT_DIR/../../../../../darkpool-v2/packages/evm-contracts" && pwd)"
NOX_DIR="$(cd "$SCRIPT_DIR/../../../../../nox" && pwd)"
USE_MIXNET=false
MESH_PID=""

if [[ "$1" == "--mixnet" ]]; then
  USE_MIXNET=true
fi

echo "=== DeFi E2E Test Runner (${USE_MIXNET:+MIXNET}${USE_MIXNET:-DIRECT}) ==="
echo ""

cleanup() {
  echo ""
  echo "[cleanup] Stopping processes..."
  [ -n "$ANVIL_PID" ] && kill $ANVIL_PID 2>/dev/null || true
  [ -n "$MESH_PID" ] && kill $MESH_PID 2>/dev/null || true
  # Kill child nox processes spawned by mesh server
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

# 2. Deploy contracts via hardhat
echo "[2/5] Deploying contracts..."
cd "$DARKPOOL_DIR"
NODE_OPTIONS="--import tsx" npx hardhat run scripts/deploy.ts --network localhost 2>&1 | \
  grep -E "DarkPool:|Staking|COMPLETE" | head -5
echo "  Contracts deployed"

# 3. Start NOX mesh (if mixnet mode)
if $USE_MIXNET; then
  echo "[3/5] Starting 5-node NOX mesh..."
  cd "$NOX_DIR"
  NOX_KEEP_LOGS=1 cargo run -p nox-sim --bin nox_mesh_server --features dev-node --release -- \
    --nodes 5 --data-dir /tmp/nox_mesh --base-port 14000 --anvil-port 8545 --mix-delay-ms 0 \
    > /tmp/nox_e2e_logs/mesh_stdout.log 2> /tmp/nox_e2e_logs/mesh_server.log &
  MESH_PID=$!

  for i in $(seq 1 90); do
    [ -f /tmp/nox_mesh/mesh_info.json ] && echo "  Mesh ready (${i}s)" && break
    sleep 1
  done
  sleep 3
  curl -s http://127.0.0.1:14002/health > /dev/null && echo "  Ingress OK" || echo "  WARNING: Ingress not ready"
else
  echo "[3/5] Skipping mesh (direct mode)"
fi

# 4. Run the DeFi E2E test
echo "[4/5] Running DeFi E2E test..."
cd "$SCRIPT_DIR/.."
EXIT_CODE=0

if $USE_MIXNET; then
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
