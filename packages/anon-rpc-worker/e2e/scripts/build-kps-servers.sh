#!/usr/bin/env bash
# Builds the reference KPS echo servers used by the WebRTC-KPS probe:
#   - Rust `kps-server` from ethereum/kps libs/rust (the `kps` crate v0.2.2 that
#     the nox-kps sidecar is built on, with its vendored webrtc-rs patches)
#   - Go `cmd/server` from ethereum/kps libs/go (pion), as a comparison peer
#   - tools/kps-bulk-server (this package), built against the same libs/go: a
#     small request in, a large response out, the Nox KPS transport's shape
#
# The kps repository is cloned once into the cache directory at a pinned commit.
#
# Env:
#   KPS_REPO_URL   clone source (default https://github.com/ethereum/kps.git)
#   KPS_REV        pinned commit (default d14dc59, tag libs/rust/v0.2.2 era)
#   KPS_REPO_DIR   existing checkout to use instead of cloning
#   E2E_CACHE_DIR  cache root (default <e2e>/.cache)
#   KPS_SKIP_GO    set to 1 to skip the Go server
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${E2E_CACHE_DIR:-$HERE/.cache}"
KPS_REPO_URL="${KPS_REPO_URL:-https://github.com/ethereum/kps.git}"
KPS_REV="${KPS_REV:-d14dc5989dabb5b01e8c4e430933cc8a7767547c}"
KPS_REPO_DIR="${KPS_REPO_DIR:-$CACHE/kps}"
BIN_DIR="$CACHE/bin"

mkdir -p "$CACHE" "$BIN_DIR"

if [ ! -d "$KPS_REPO_DIR/.git" ]; then
    echo "[kps] cloning $KPS_REPO_URL into $KPS_REPO_DIR"
    git clone --quiet "$KPS_REPO_URL" "$KPS_REPO_DIR"
fi
head="$(git -C "$KPS_REPO_DIR" rev-parse HEAD)"
if [ "$head" != "$KPS_REV" ]; then
    echo "[kps] checking out $KPS_REV (was $head)"
    git -C "$KPS_REPO_DIR" fetch --quiet origin "$KPS_REV" 2>/dev/null || true
    git -C "$KPS_REPO_DIR" -c advice.detachedHead=false checkout --quiet "$KPS_REV"
fi

echo "[kps] building Rust kps-server (release, --locked)"
(cd "$KPS_REPO_DIR/libs/rust" && cargo build --release --locked -p kps-server)
install -m 0755 "$KPS_REPO_DIR/libs/rust/target/release/kps-server" "$BIN_DIR/kps-rust-server"

if [ "${KPS_SKIP_GO:-0}" != "1" ]; then
    if command -v go >/dev/null 2>&1; then
        echo "[kps] building Go cmd/server"
        (cd "$KPS_REPO_DIR/libs/go" && go build -o "$BIN_DIR/kps-go-server" ./cmd/server)
        echo "[kps] building Go bulk-response server (tools/kps-bulk-server)"
        BULK_DIR="$KPS_REPO_DIR/libs/go/cmd/e2e-bulk-server"
        mkdir -p "$BULK_DIR"
        install -m 0644 "$HERE/tools/kps-bulk-server/main.go" "$BULK_DIR/main.go"
        (cd "$KPS_REPO_DIR/libs/go" && go build -o "$BIN_DIR/kps-go-bulk-server" ./cmd/e2e-bulk-server)
    else
        echo "[kps] go not found; the Go comparison and bulk-response servers are skipped"
    fi
fi

echo "[kps] binaries in $BIN_DIR:"
ls -1 "$BIN_DIR"
