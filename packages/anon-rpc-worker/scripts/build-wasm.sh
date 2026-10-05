#!/usr/bin/env bash
# Build the nox-wasm web module (packages/nox-wasm/pkg-web) reproducibly.
#
# Usage: scripts/build-wasm.sh [--check-pins] [--record <file>]
#
#   --check-pins   require rustc, wasm-pack, wasm-bindgen and wasm-opt to match
#                  scripts/toolchain.env exactly (release and container builds)
#   --record FILE  write the toolchain versions and module digest as JSON
#                  (scripts/provenance.mjs reads it)
#
# Mirrors ethereum/tor-js scripts/build.sh: per-machine paths are remapped
# (RUSTFLAGS is set, not appended, so ambient flags cannot leak in), cargo's
# host-dependent -C metadata is normalised by scripts/reproducible-rustc.sh
# (this also bypasses sccache, which release builds must not use), the lock
# file is enforced with --locked, and wasm-opt must be on PATH so wasm-pack
# does not download an optimizer of its own choosing.
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPTS_DIR/../../.." && pwd)"
# shellcheck source=toolchain.env
source "$SCRIPTS_DIR/toolchain.env"

check_pins=0
record=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-pins) check_pins=1; shift ;;
    --record) record="$(realpath -m "${2:?--record needs a file}")"; shift 2 ;;
    *) echo "build-wasm.sh: unknown option $1 (see the header for usage)" >&2; exit 2 ;;
  esac
done

version_of() {
  # The version token of each tool's --version line; empty when the tool is missing.
  command -v "$1" >/dev/null 2>&1 || return 0
  case "$1" in
    rustc|wasm-pack|wasm-bindgen) { "$1" --version 2>/dev/null || true; } | awk 'NR == 1 {print $2}' ;;
    # "wasm-opt version 117 (version_117)"
    wasm-opt) { wasm-opt --version 2>/dev/null || true; } | awk 'NR == 1 {print $3}' ;;
  esac
}

found_rustc="$(version_of rustc)"
found_wasm_pack="$(version_of wasm-pack)"
found_wasm_bindgen="$(version_of wasm-bindgen)"
found_wasm_opt="$(version_of wasm-opt)"

if [[ -z "$found_wasm_opt" ]]; then
  echo "build-wasm.sh: wasm-opt (binaryen $BINARYEN_VERSION) must be on PATH; without it wasm-pack downloads its own optimizer and every byte changes" >&2
  exit 1
fi
if [[ "$check_pins" -eq 1 ]]; then
  mismatch=0
  for pair in "rustc:$RUST_TOOLCHAIN:$found_rustc" "wasm-pack:$WASM_PACK_VERSION:$found_wasm_pack" \
              "wasm-bindgen:$WASM_BINDGEN_VERSION:$found_wasm_bindgen" "wasm-opt:$BINARYEN_VERSION:$found_wasm_opt"; do
    IFS=: read -r tool expected found <<<"$pair"
    if [[ "$expected" != "$found" ]]; then
      echo "build-wasm.sh: $tool $expected required by scripts/toolchain.env, found ${found:-none}" >&2
      mismatch=1
    fi
  done
  [[ "$mismatch" -eq 0 ]] || exit 1
fi

RUST_SYSROOT="$(rustc --print sysroot)"
RUSTC_COMMIT="$(rustc -vV | sed -ne 's/^commit-hash: //p')"
# The checkout path is remapped too: panic locations of workspace crates
# otherwise carry it, and two checkouts at different paths gave different WASM.
export RUSTFLAGS="--remap-path-prefix=$REPO_DIR=/nox-sdk --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo-home --remap-path-prefix=$RUST_SYSROOT/lib/rustlib/src/rust=/rustc/$RUSTC_COMMIT"
export NOX_WORKSPACE_ROOT="$REPO_DIR"
export RUSTC_WRAPPER="$SCRIPTS_DIR/reproducible-rustc.sh"
unset CARGO_BUILD_RUSTC_WRAPPER CARGO_ENCODED_RUSTFLAGS

cd "$REPO_DIR"
rm -rf packages/nox-wasm/pkg-web
wasm-pack build packages/nox-wasm --target web --out-dir pkg-web --release -- --locked

wasm="packages/nox-wasm/pkg-web/nox_wasm_bg.wasm"
wasm_sha256="$(sha256sum "$wasm" | awk '{print $1}')"
glue_sha256="$(sha256sum packages/nox-wasm/pkg-web/nox_wasm.js | awk '{print $1}')"
echo "nox-wasm: $wasm ($(wc -c <"$wasm") bytes)"
echo "  sha256 $wasm_sha256"
echo "  rustc $found_rustc, wasm-pack $found_wasm_pack, wasm-bindgen ${found_wasm_bindgen:-downloaded by wasm-pack}, wasm-opt $found_wasm_opt"

if [[ -n "$record" ]]; then
  mkdir -p "$(dirname "$record")"
  cat >"$record" <<JSON
{
  "glueSha256": "$glue_sha256",
  "pinsChecked": $([[ "$check_pins" -eq 1 ]] && echo true || echo false),
  "rustc": "$(rustc --version)",
  "wasmBindgen": "${found_wasm_bindgen}",
  "wasmOpt": "${found_wasm_opt}",
  "wasmPack": "${found_wasm_pack}",
  "wasmSha256": "$wasm_sha256"
}
JSON
fi
