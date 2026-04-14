#!/usr/bin/env bash
# Nox SDK E2E test orchestrator.
#
# Builds the SDK, starts Anvil + a local Nox mesh, runs the E2E tests, cleans up.
# Service logs go to /tmp/nox_e2e_logs/ for post-mortem debugging.
#
# Requires:
#   NOX_REPO    Path to a checkout of the Nox server repo (https://github.com/hisoka-io/nox).
#               Defaults to a sibling directory at ../../../../../nox if not set.
#   anvil       Installed and on PATH (https://book.getfoundry.sh/).
#   node, pnpm  For the SDK build.
#
# Usage:
#   NOX_REPO=/path/to/nox bash tests/internal/run_e2e.sh
#   RUN_LARGE_DOWNLOADS=1 bash tests/internal/run_e2e.sh  # include 10MB + 100MB (~15 min)
#   DEBUG_POLL=1 bash tests/internal/run_e2e.sh           # verbose SURB polling

set -euo pipefail

# ============================================================================
# Config
# ============================================================================

NOX_REPO="${NOX_REPO:-$(cd "$(dirname "$0")/../../../../.." 2>/dev/null && pwd)/nox}"
if [ ! -d "$NOX_REPO/crates" ]; then
    cat >&2 <<EOF
error: NOX_REPO does not point to a valid Nox checkout: $NOX_REPO

Set NOX_REPO to a clone of https://github.com/hisoka-io/nox, or place the repo
as a sibling directory to nox-sdk.

Example:
    git clone https://github.com/hisoka-io/nox.git
    NOX_REPO=\$(pwd)/nox bash tests/internal/run_e2e.sh
EOF
    exit 2
fi

SDK_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MESH_NODES="${MESH_NODES:-10}"
LOG_DIR="/tmp/nox_e2e_logs"
MESH_DATA="/tmp/nox_mesh"
ANVIL_PORT="${ANVIL_PORT:-8545}"
BASE_PORT="${BASE_PORT:-14000}"

# PIDs for cleanup
ANVIL_PID=""
MESH_PID=""

cleanup() {
    echo "[e2e] Cleaning up..."
    [ -n "$MESH_PID" ] && kill "$MESH_PID" 2>/dev/null && wait "$MESH_PID" 2>/dev/null || true
    [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null && wait "$ANVIL_PID" 2>/dev/null || true
    echo ""
    echo "=== Log files for debugging ==="
    echo "  Anvil:        $LOG_DIR/anvil.log"
    echo "  Mesh server:  $LOG_DIR/mesh_server.log"
    echo "  Node logs:    $MESH_DATA/node_*/node.log"
    echo "  Test output:  $LOG_DIR/test.log"
    echo ""
    echo "Grep examples:"
    echo "  grep 'ERROR\\|panic\\|FAIL' $LOG_DIR/mesh_server.log"
    echo "  grep 'Exit:\\|HttpRequest\\|RpcRequest' $MESH_DATA/node_*/node.log | tail -30"
    echo "  grep 'PASS\\|FAIL' $LOG_DIR/test.log"
}
trap cleanup EXIT

# ============================================================================
# 1. Prepare directories
# ============================================================================

echo "[e2e] Preparing directories..."
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

# ============================================================================
# 2. Check prerequisites
# ============================================================================

echo "[e2e] Checking prerequisites..."

if ! command -v anvil &>/dev/null; then
    echo "ERROR: anvil not found. Install foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup"
    exit 1
fi

if ! command -v cargo &>/dev/null; then
    echo "ERROR: cargo not found. Install Rust: https://rustup.rs/"
    exit 1
fi

if [ ! -d "$NOX_REPO" ]; then
    echo "ERROR: NOX repo not found at $NOX_REPO"
    echo "Set NOX_REPO to the nox workspace root."
    exit 1
fi

# ============================================================================
# 3. Build nox binary (release)
# ============================================================================

echo "[e2e] Building nox binary (release)..."
(cd "$NOX_REPO" && cargo build --release -p nox 2>"$LOG_DIR/nox_build.log") || {
    echo "ERROR: nox build failed. See $LOG_DIR/nox_build.log"
    exit 1
}
echo "[e2e] nox binary built."

# ============================================================================
# 4. Build nox-wasm (if not already built)
# ============================================================================

WASM_PKG="$SDK_DIR/../nox-wasm/pkg-node"
if [ ! -d "$WASM_PKG" ]; then
    echo "[e2e] Building nox-wasm..."
    (cd "$SDK_DIR/../nox-wasm" && pnpm build 2>"$LOG_DIR/wasm_build.log") || {
        echo "ERROR: nox-wasm build failed. See $LOG_DIR/wasm_build.log"
        exit 1
    }
    echo "[e2e] nox-wasm built."
else
    echo "[e2e] nox-wasm already built (pkg-node/ exists)."
fi

# ============================================================================
# 5. Start Anvil
# ============================================================================

echo "[e2e] Starting Anvil on port $ANVIL_PORT..."
anvil --port "$ANVIL_PORT" --silent >"$LOG_DIR/anvil.log" 2>&1 &
ANVIL_PID=$!
sleep 1

# Verify Anvil is running
if ! kill -0 "$ANVIL_PID" 2>/dev/null; then
    echo "ERROR: Anvil failed to start. See $LOG_DIR/anvil.log"
    exit 1
fi
echo "[e2e] Anvil running (PID=$ANVIL_PID)."

# ============================================================================
# 6. Start nox_mesh_server
# ============================================================================

echo "[e2e] Starting mesh server ($MESH_NODES nodes, base_port=$BASE_PORT)..."
NOX_KEEP_LOGS=1 cargo run -p nox-sim --bin nox_mesh_server --features dev-node --release -- \
    --nodes "$MESH_NODES" \
    --data-dir "$MESH_DATA" \
    --base-port "$BASE_PORT" \
    --anvil-port "$ANVIL_PORT" \
    --mix-delay-ms 0 \
    >"$LOG_DIR/mesh_stdout.log" \
    2>"$LOG_DIR/mesh_server.log" &
MESH_PID=$!

# ============================================================================
# 7. Wait for mesh to be ready
# ============================================================================

echo "[e2e] Waiting for mesh to be ready..."
WAITED=0
MAX_WAIT=120
while [ $WAITED -lt $MAX_WAIT ]; do
    if [ -f "$MESH_DATA/mesh_info.json" ]; then
        break
    fi
    if ! kill -0 "$MESH_PID" 2>/dev/null; then
        echo "ERROR: Mesh server exited prematurely. See $LOG_DIR/mesh_server.log"
        exit 1
    fi
    sleep 1
    WAITED=$((WAITED + 1))
done

if [ ! -f "$MESH_DATA/mesh_info.json" ]; then
    echo "ERROR: Mesh not ready after ${MAX_WAIT}s. See $LOG_DIR/mesh_server.log"
    exit 1
fi
echo "[e2e] Mesh ready (${WAITED}s)."

# ============================================================================
# 8. Run E2E tests
# ============================================================================

echo "[e2e] Running E2E tests..."
echo ""

export MESH_INFO_PATH="$MESH_DATA/mesh_info.json"
# RUN_LARGE_DOWNLOADS and DEBUG_POLL are inherited from parent env

cd "$SDK_DIR"
npx tsx tests/internal/e2e_mesh.ts 2>"$LOG_DIR/test.log"
TEST_EXIT=$?

echo ""
if [ $TEST_EXIT -eq 0 ]; then
    echo "[e2e] ALL TESTS PASSED"
else
    echo "[e2e] SOME TESTS FAILED (exit code $TEST_EXIT)"
fi

exit $TEST_EXIT
