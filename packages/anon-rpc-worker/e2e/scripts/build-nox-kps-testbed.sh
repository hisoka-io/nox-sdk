#!/usr/bin/env bash
# Builds nox-kps for the local test bed from a checkout (read-only): the nox
# repository, where nox-kps is the workspace member crates/nox-kps (D-09), or a
# standalone nox-kps checkout.
#
#   stock (default)   cargo build --locked in a copy of the checkout, with the
#                     release-kps profile when the workspace defines it (the
#                     profile nox-kps ships with), else --release
#   --ipfilter        same, with the `kps` crate replaced by the exact revision
#                     the checkout's Cargo.lock pins plus the e2e loopback IP
#                     filter (scripts/patch-kps-loopback-filter.sh). Diagnostic
#                     build for hosts whose `lo` carries more than one address
#                     per family (WSL2); never for a node.
#
# The checkout is copied (without target/ and .git) into the cache, so the
# source tree and its target directory stay untouched. Output: .cache/bin/nox-kps
# or .cache/bin/nox-kps-ipfilter.
#
# Env: NOX_KPS_REPO (default: ../nox-kps next to the nox-sdk checkout),
#      KPS_REPO_URL (default https://github.com/ethereum/kps.git),
#      E2E_CACHE_DIR, CARGO_TARGET_DIR (default <cache>/nox-kps-target).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SDK_ROOT="$(cd "$HERE/../../.." && pwd)"
CACHE="${E2E_CACHE_DIR:-$HERE/.cache}"
BIN_DIR="$CACHE/bin"
KPS_REPO_URL="${KPS_REPO_URL:-https://github.com/ethereum/kps.git}"
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
    echo "set NOX_KPS_REPO to a nox checkout (crates/nox-kps) or a nox-kps checkout" >&2
    exit 2
}

SRC="$CACHE/nox-kps-src-$MODE"
rm -rf "$SRC"
mkdir -p "$SRC" "$BIN_DIR"
tar -C "$NOX_KPS_REPO" --exclude=./target --exclude=./.git --exclude=./.claude --exclude=./no-commit -cf - . \
    | tar -C "$SRC" -xf -
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$CACHE/nox-kps-target}"
LOCKED="--locked"
PROFILE_ARGS=(--release)
PROFILE_DIR="release"
if grep -q '^\[profile\.release-kps\]' "$SRC/Cargo.toml"; then
    PROFILE_ARGS=(--profile release-kps)
    PROFILE_DIR="release-kps"
fi

if [ "$MODE" = "ipfilter" ]; then
    # The kps revision the lockfile pins, e.g. git+https://github.com/ethereum/kps?tag=...#<40 hex>.
    KPS_REV="$(awk '/^name = "kps"$/ { found = 1; next } found && /^source = / { print; exit }' "$SRC/Cargo.lock" \
        | sed -nE 's/.*#([0-9a-f]{40})".*/\1/p')"
    [ -n "$KPS_REV" ] || { echo "cannot find the kps git revision in $SRC/Cargo.lock" >&2; exit 1; }
    KPS_CLONE="$CACHE/kps"
    if [ ! -d "$KPS_CLONE/.git" ]; then
        git clone --quiet "$KPS_REPO_URL" "$KPS_CLONE"
    fi
    git -C "$KPS_CLONE" cat-file -e "$KPS_REV^{commit}" 2>/dev/null || git -C "$KPS_CLONE" fetch --quiet origin "$KPS_REV"
    KPS_PATCHED="$CACHE/kps-ipfilter-$KPS_REV"
    if [ ! -d "$KPS_PATCHED" ]; then
        git -C "$KPS_CLONE" worktree add --quiet --detach "$KPS_PATCHED" "$KPS_REV"
    fi
    git -C "$KPS_PATCHED" checkout --quiet --force "$KPS_REV"
    bash "$HERE/scripts/patch-kps-loopback-filter.sh" "$KPS_PATCHED"
    # The lockfile pins the git source of kps; the path override changes it.
    LOCKED=""
    cat >>"$SRC/Cargo.toml" <<TOML

# e2e diagnostic build only: kps $KPS_REV with the loopback IP filter.
[patch."https://github.com/ethereum/kps"]
kps = { path = "$KPS_PATCHED/libs/rust/kps" }
TOML
fi

echo "[nox-kps] building $MODE (${PROFILE_ARGS[*]}) from $NOX_KPS_REPO"
(cd "$SRC" && cargo build "${PROFILE_ARGS[@]}" $LOCKED -p nox-kps --bin nox-kps)
OUT="$BIN_DIR/nox-kps"
[ "$MODE" = "ipfilter" ] && OUT="$BIN_DIR/nox-kps-ipfilter"
install -m 0755 "$CARGO_TARGET_DIR/$PROFILE_DIR/nox-kps" "$OUT"
echo "[nox-kps] built $OUT"
