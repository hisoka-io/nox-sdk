#!/usr/bin/env bash
# Builds nox-kps for the local test bed from a nox-kps checkout (read-only).
#
#   stock (default)   cargo build --release --locked in a copy of the checkout
#   --ipfilter        same, with the kps crate replaced by the loopback IP filter
#                     build of scripts/build-kps-ipfilter-probe.sh. Diagnostic
#                     build for hosts whose `lo` carries more than one address
#                     per family (WSL2); never for a node.
#
# The checkout is copied (without target/) into the cache, so the source tree
# and its target directory stay untouched. Output: .cache/bin/nox-kps or
# .cache/bin/nox-kps-ipfilter.
#
# Env: NOX_KPS_REPO (default ../nox-kps next to the nox-sdk checkout),
#      E2E_CACHE_DIR, CARGO_TARGET_DIR (default <cache>/nox-kps-target).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SDK_ROOT="$(cd "$HERE/../../.." && pwd)"
CACHE="${E2E_CACHE_DIR:-$HERE/.cache}"
BIN_DIR="$CACHE/bin"
MODE="stock"
case "${1:-}" in
    "") ;;
    --ipfilter) MODE="ipfilter" ;;
    *) echo "usage: $0 [--ipfilter]" >&2; exit 2 ;;
esac

if [ -z "${NOX_KPS_REPO:-}" ]; then
    for candidate in "$SDK_ROOT/../nox-kps" "$SDK_ROOT/../../nox-kps"; do
        if [ -f "$candidate/Cargo.toml" ]; then NOX_KPS_REPO="$(cd "$candidate" && pwd)"; break; fi
    done
fi
[ -n "${NOX_KPS_REPO:-}" ] && [ -f "$NOX_KPS_REPO/Cargo.toml" ] || {
    echo "set NOX_KPS_REPO to a nox-kps checkout" >&2
    exit 2
}

SRC="$CACHE/nox-kps-src-$MODE"
rm -rf "$SRC"
mkdir -p "$SRC" "$BIN_DIR"
tar -C "$NOX_KPS_REPO" --exclude=./target --exclude=./.git -cf - . | tar -C "$SRC" -xf -
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$CACHE/nox-kps-target}"
LOCKED="--locked"

if [ "$MODE" = "ipfilter" ]; then
    KPS_CRATE="$CACHE/kps-ipfilter-probe/libs/rust/kps"
    [ -f "$KPS_CRATE/Cargo.toml" ] || { echo "run scripts/build-kps-ipfilter-probe.sh first" >&2; exit 2; }
    grep -q 'e2e diagnostic: exactly one loopback address' "$KPS_CRATE/src/listener.rs" || {
        echo "$KPS_CRATE is missing the loopback filter patch" >&2
        exit 1
    }
    # The lockfile pins the git source of kps; the path override changes it.
    LOCKED=""
    cat >>"$SRC/Cargo.toml" <<TOML

# e2e diagnostic build only: kps with the loopback IP filter.
[patch."https://github.com/ethereum/kps"]
kps = { path = "$KPS_CRATE" }
TOML
fi

echo "[nox-kps] building $MODE from $NOX_KPS_REPO"
(cd "$SRC" && cargo build --release $LOCKED --bin nox-kps)
OUT="$BIN_DIR/nox-kps"
[ "$MODE" = "ipfilter" ] && OUT="$BIN_DIR/nox-kps-ipfilter"
install -m 0755 "$CARGO_TARGET_DIR/release/nox-kps" "$OUT"
echo "[nox-kps] built $OUT"
