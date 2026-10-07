#!/usr/bin/env bash
# Build the worker's two WebAssembly modules reproducibly: nox-wasm (Sphinx,
# packages/nox-wasm/pkg-web) and nox-tls (the TLS client,
# packages/nox-tls/pkg-web).
#
# Usage: scripts/build-wasm.sh [--check-pins] [--record <file>]
#
#   --check-pins   require rustc, wasm-pack, wasm-bindgen, wasm-opt and clang
#                  to match scripts/toolchain.env exactly (release and
#                  container builds)
#   --record FILE  write the toolchain versions and module digests as JSON
#                  (scripts/provenance.mjs reads it)
#
# Env: NOX_WASM_CC and NOX_WASM_AR name the clang and llvm-ar that compile
# ring's C sources for wasm32 (default clang-<major> and llvm-ar-<major> of
# CLANG_VERSION); --check-pins refuses any other clang version.
#
# Mirrors ethereum/tor-js scripts/build.sh: per-machine paths are remapped
# (RUSTFLAGS is set, not appended, so ambient flags cannot leak in; the C
# compiler gets the same maps through CFLAGS), cargo's host-dependent
# -C metadata is normalised by scripts/reproducible-rustc.sh (this also
# bypasses sccache, which release builds must not use), the lock file is
# enforced with --locked, and wasm-opt must be on PATH so wasm-pack does not
# download an optimizer of its own choosing.
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

clang_major="${CLANG_VERSION%%.*}"
wasm_cc="${NOX_WASM_CC:-clang-$clang_major}"
wasm_ar="${NOX_WASM_AR:-llvm-ar-$clang_major}"

version_of() {
  # The version token of each tool's --version line; empty when the tool is missing.
  command -v "$1" >/dev/null 2>&1 || return 0
  case "$1" in
    rustc|wasm-pack|wasm-bindgen) { "$1" --version 2>/dev/null || true; } | awk 'NR == 1 {print $2}' ;;
    # "wasm-opt version 117 (version_117)"
    wasm-opt) { wasm-opt --version 2>/dev/null || true; } | awk 'NR == 1 {print $3}' ;;
    # "Debian clang version 19.1.7 (3~deb12u1)", "Ubuntu clang version 18.1.3 (1ubuntu1)"
    *) { "$1" --version 2>/dev/null || true; } | sed -n '1s/.*clang version \([0-9][0-9.]*\).*/\1/p' ;;
  esac
}

found_rustc="$(version_of rustc)"
found_wasm_pack="$(version_of wasm-pack)"
found_wasm_bindgen="$(version_of wasm-bindgen)"
found_wasm_opt="$(version_of wasm-opt)"
found_clang="$(version_of "$wasm_cc")"

if [[ -z "$found_wasm_opt" ]]; then
  echo "build-wasm.sh: wasm-opt (binaryen $BINARYEN_VERSION) must be on PATH; without it wasm-pack downloads its own optimizer and every byte changes" >&2
  exit 1
fi
if [[ "$check_pins" -eq 1 ]]; then
  mismatch=0
  for pair in "rustc:$RUST_TOOLCHAIN:$found_rustc" "wasm-pack:$WASM_PACK_VERSION:$found_wasm_pack" \
              "wasm-bindgen:$WASM_BINDGEN_VERSION:$found_wasm_bindgen" "wasm-opt:$BINARYEN_VERSION:$found_wasm_opt" \
              "clang:$CLANG_VERSION:$found_clang"; do
    IFS=: read -r tool expected found <<<"$pair"
    if [[ "$expected" != "$found" ]]; then
      echo "build-wasm.sh: $tool $expected required by scripts/toolchain.env, found ${found:-none}" >&2
      mismatch=1
    fi
  done
  [[ "$mismatch" -eq 0 ]] || exit 1
fi
if [[ -z "$found_clang" ]] || ! command -v "$wasm_ar" >/dev/null 2>&1; then
  echo "build-wasm.sh: nox-tls needs clang and llvm-ar for wasm32 ($wasm_cc and $wasm_ar not found; set NOX_WASM_CC and NOX_WASM_AR, or install clang $CLANG_VERSION)" >&2
  exit 1
fi

CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
RUST_SYSROOT="$(rustc --print sysroot)"
RUSTC_COMMIT="$(rustc -vV | sed -ne 's/^commit-hash: //p')"
export RUSTFLAGS="--remap-path-prefix=$CARGO_HOME_DIR=/cargo-home --remap-path-prefix=$RUST_SYSROOT/lib/rustlib/src/rust=/rustc/$RUSTC_COMMIT"
export CC_wasm32_unknown_unknown="$wasm_cc"
export AR_wasm32_unknown_unknown="$wasm_ar"
export CFLAGS_wasm32_unknown_unknown="-ffile-prefix-map=$CARGO_HOME_DIR=/cargo-home -ffile-prefix-map=$REPO_DIR=."
export NOX_WORKSPACE_ROOT="$REPO_DIR"
export RUSTC_WRAPPER="$SCRIPTS_DIR/reproducible-rustc.sh"
unset CARGO_BUILD_RUSTC_WRAPPER CARGO_ENCODED_RUSTFLAGS

cd "$REPO_DIR"
declare -A wasm_sha256 glue_sha256
for crate in nox-wasm nox-tls; do
  module="${crate//-/_}"
  rm -rf "packages/$crate/pkg-web"
  wasm-pack build "packages/$crate" --target web --out-dir pkg-web --release -- --locked
  wasm="packages/$crate/pkg-web/${module}_bg.wasm"
  wasm_sha256[$crate]="$(sha256sum "$wasm" | awk '{print $1}')"
  glue_sha256[$crate]="$(sha256sum "packages/$crate/pkg-web/$module.js" | awk '{print $1}')"
  echo "$crate: $wasm ($(wc -c <"$wasm") bytes)"
  echo "  sha256 ${wasm_sha256[$crate]}"
done
echo "  rustc $found_rustc, wasm-pack $found_wasm_pack, wasm-bindgen ${found_wasm_bindgen:-downloaded by wasm-pack}, wasm-opt $found_wasm_opt, clang $found_clang"

if [[ -n "$record" ]]; then
  mkdir -p "$(dirname "$record")"
  cat >"$record" <<JSON
{
  "clang": "${found_clang}",
  "glueSha256": "${glue_sha256[nox-wasm]}",
  "pinsChecked": $([[ "$check_pins" -eq 1 ]] && echo true || echo false),
  "rustc": "$(rustc --version)",
  "tlsGlueSha256": "${glue_sha256[nox-tls]}",
  "tlsWasmSha256": "${wasm_sha256[nox-tls]}",
  "wasmBindgen": "${found_wasm_bindgen}",
  "wasmOpt": "${found_wasm_opt}",
  "wasmPack": "${found_wasm_pack}",
  "wasmSha256": "${wasm_sha256[nox-wasm]}"
}
JSON
fi
