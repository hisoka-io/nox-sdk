#!/usr/bin/env bash
# One command for the whole local e2e bed (bed L):
#   1. builds what is missing: nox + nox_mesh_server (NOX_REPO), the reference
#      KPS servers and the bulk-response server, the SDK (nox-wasm pkg-node +
#      nox-client dist), Playwright's Chromium;
#   2. runs typecheck and unit tests;
#   3. runs every Playwright spec: harness passthrough, egress-check controls,
#      WebRTC-KPS probe,
#      classic SDK path through the mesh, and the Nox worker spec (skipped
#      until NOX_KPS_CMD and a worker bundle are available).
#
# Env (all optional; see README for the full list):
#   NOX_REPO        nox checkout with the simulation binaries (default: ../nox-e2e
#                   next to this nox-sdk checkout, then ../nox, then ../nox-clean)
#   E2E_SKIP_BUILD  1 = do not build anything, fail on missing prerequisites
#   E2E_ONLY        a Playwright file filter, e.g. "classic-sdk" or "kps-webrtc"
#   NOX_KPS_REPO    a nox-kps checkout: builds it (scripts/build-nox-kps-testbed.sh;
#                   the loopback-filter variant when `lo` carries more than one
#                   IPv4 address) and runs one sidecar per mesh node, unless
#                   NOX_KPS_CMD is already set
#   RUSTC_WRAPPER   honoured by cargo (sccache recommended)
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SDK_ROOT="$(cd "$HERE/../../.." && pwd)"
LOG_DIR="$HERE/.run/run-all"
mkdir -p "$LOG_DIR"

if [ -z "${NOX_REPO:-}" ]; then
    for candidate in "$SDK_ROOT/../nox-e2e" "$SDK_ROOT/../nox" "$SDK_ROOT/../nox-clean"; do
        if [ -d "$candidate/crates" ]; then NOX_REPO="$(cd "$candidate" && pwd)"; break; fi
    done
fi
if [ -z "${NOX_REPO:-}" ] || [ ! -d "$NOX_REPO/crates" ]; then
    echo "[e2e] set NOX_REPO to a checkout of https://github.com/hisoka-io/nox" >&2
    exit 2
fi
export NOX_REPO

step() { echo; echo "[e2e] $*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "[e2e] $1 not found on PATH: $2" >&2; exit 2; }; }
need anvil "install foundry (anvil 1.3.2 is what CI uses)"
need node "Node 20 or newer"
need pnpm "pnpm 10"

if [ "${E2E_SKIP_BUILD:-0}" != "1" ]; then
    if [ ! -x "$NOX_REPO/target/release/nox" ] || [ ! -x "$NOX_REPO/target/release/nox_mesh_server" ]; then
        need cargo "Rust toolchain"
        step "building nox and nox_mesh_server in $NOX_REPO (log: $LOG_DIR/nox-build.log)"
        (cd "$NOX_REPO" \
            && cargo build --release --locked --bin nox \
            && cargo build --release --locked -p nox-sim --bin nox_mesh_server --features dev-node) \
            >"$LOG_DIR/nox-build.log" 2>&1
    fi
    if [ ! -x "$HERE/.cache/bin/kps-go-server" ] || [ ! -x "$HERE/.cache/bin/kps-rust-server" ] \
        || [ ! -x "$HERE/.cache/bin/kps-go-bulk-server" ]; then
        step "building KPS reference servers (log: $LOG_DIR/kps-build.log)"
        bash "$HERE/scripts/build-kps-servers.sh" >"$LOG_DIR/kps-build.log" 2>&1
    fi
    if [ ! -x "$HERE/.cache/bin/kps-rust-server-ipfilter" ]; then
        step "building the loopback-filter KPS diagnostic server (log: $LOG_DIR/kps-ipfilter-build.log)"
        bash "$HERE/scripts/build-kps-ipfilter-probe.sh" >"$LOG_DIR/kps-ipfilter-build.log" 2>&1
    fi
    if [ ! -f "$SDK_ROOT/packages/nox-wasm/pkg-node/nox_wasm.js" ] || [ ! -f "$SDK_ROOT/packages/nox-client/dist/index.js" ]; then
        step "building the SDK (log: $LOG_DIR/sdk-build.log)"
        (cd "$SDK_ROOT" && pnpm install --frozen-lockfile \
            && pnpm --filter @hisoka-io/nox-wasm build:node \
            && pnpm --filter @hisoka-io/nox-client build) >"$LOG_DIR/sdk-build.log" 2>&1
    fi
    if [ ! -d "$HERE/node_modules" ]; then
        step "installing e2e dependencies"
        (cd "$HERE" && pnpm install --frozen-lockfile --ignore-workspace)
    fi
    (cd "$HERE" && npx playwright install --only-shell chromium >"$LOG_DIR/playwright-install.log" 2>&1)
fi

if [ -n "${NOX_KPS_REPO:-}" ] && [ -z "${NOX_KPS_CMD:-}" ]; then
    KPS_VARIANT=""
    KPS_BIN="$HERE/.cache/bin/nox-kps"
    if [ "$(ip -4 -o addr show dev lo 2>/dev/null | wc -l)" -gt 1 ]; then
        KPS_VARIANT="--ipfilter"
        KPS_BIN="$HERE/.cache/bin/nox-kps-ipfilter"
    fi
    if [ "${E2E_SKIP_BUILD:-0}" != "1" ]; then
        step "building nox-kps ${KPS_VARIANT:-stock} from $NOX_KPS_REPO (log: $LOG_DIR/nox-kps-build.log)"
        if [ -n "$KPS_VARIANT" ] && [ ! -d "$HERE/.cache/kps-ipfilter-probe" ]; then
            bash "$HERE/scripts/build-kps-ipfilter-probe.sh" >"$LOG_DIR/kps-ipfilter-build.log" 2>&1
        fi
        NOX_KPS_REPO="$NOX_KPS_REPO" bash "$HERE/scripts/build-nox-kps-testbed.sh" $KPS_VARIANT >"$LOG_DIR/nox-kps-build.log" 2>&1
    fi
    export NOX_KPS_CONFIG_TEMPLATE="$HERE/fixtures/nox-kps.toml.tmpl"
    export NOX_KPS_INIT_CMD="$KPS_BIN --config {config_file} init"
    export NOX_KPS_CMD="$KPS_BIN --config {config_file} run"
fi

cd "$HERE"
step "typecheck"
pnpm run typecheck
step "unit tests"
pnpm test
step "Playwright e2e (reports: $HERE/.run/reports, run dirs: $HERE/.run)"
if [ -n "${E2E_ONLY:-}" ]; then
    npx playwright test "$E2E_ONLY"
else
    npx playwright test
fi
step "done; latest run directory: $(cat "$HERE/.run/latest-run.txt" 2>/dev/null || echo none)"
