#!/usr/bin/env bash
# Build the Nox anon-rpc worker: nox-wasm from source, then the bundle and its
# provenance (ARCHITECTURE §7.2). Run it from a clone of nox-sdk after
# `corepack enable && pnpm install --frozen-lockfile`.
#
# Usage: packages/anon-rpc-worker/scripts/build-worker.sh [--release] [--stage all|wasm|js]
#                                                         [--source-commit <sha>]
#
#   --release        refuse a dirty git tree, require the pinned toolchain
#                    (scripts/toolchain.env) for the WASM stage and the pinned
#                    pnpm (root package.json) and esbuild (package.json) for
#                    the JS stage; a Node version other than NODE_VERSION is
#                    reported (the bundle bytes do not depend on it, the
#                    provenance records it)
#   --stage wasm     only build packages/nox-wasm/pkg-web (needs Rust tools)
#   --stage js       only bundle (needs Node and an existing pkg-web)
#   --source-commit  commit id for the provenance when the tree has no .git
#                    (inside a checkout it must be the clean HEAD)
#
# The release gate for the pinned snapshot is a separate step before any
# publication: node scripts/verify-snapshot.mjs --rpc <a> --rpc <b> --release
#
# Output: packages/anon-rpc-worker/dist/anon-rpc-worker.js, its .keccak256,
# build-record.json and anon-rpc-worker.provenance.json.
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=toolchain.env
source "$SCRIPTS_DIR/toolchain.env"
PACKAGE_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
REPO_DIR="$(cd "$PACKAGE_DIR/../.." && pwd)"
WASM_RECORD="$PACKAGE_DIR/.build/wasm-toolchain.json"

release=0
stage="all"
source_commit=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) release=1; shift ;;
    --stage) stage="${2:?--stage needs all, wasm or js}"; shift 2 ;;
    --source-commit) source_commit="${2:?--source-commit needs a commit id}"; shift 2 ;;
    *) echo "build-worker.sh: unknown option $1 (see the header for usage)" >&2; exit 2 ;;
  esac
done
case "$stage" in all|wasm|js) ;; *) echo "build-worker.sh: --stage must be all, wasm or js" >&2; exit 2 ;; esac

if [[ "$release" -eq 1 && -z "$source_commit" ]]; then
  dirty="$(git -C "$REPO_DIR" status --porcelain)"
  if [[ -n "$dirty" ]]; then
    echo "build-worker.sh: --release refuses a dirty tree; commit or remove these first:" >&2
    echo "$dirty" >&2
    exit 1
  fi
fi

if [[ "$stage" == "all" || "$stage" == "wasm" ]]; then
  wasm_args=(--record "$WASM_RECORD")
  [[ "$release" -eq 1 ]] && wasm_args+=(--check-pins)
  bash "$SCRIPTS_DIR/build-wasm.sh" "${wasm_args[@]}"
fi

check_js_pins() {
  local expected_pnpm found_pnpm expected_esbuild found_esbuild found_node
  expected_pnpm="$(node -p 'require(process.argv[1]).packageManager.replace(/^pnpm@/, "")' "$REPO_DIR/package.json")"
  found_pnpm="$(pnpm --version)"
  if [[ "$found_pnpm" != "$expected_pnpm" ]]; then
    echo "build-worker.sh: --release needs pnpm $expected_pnpm (root package.json packageManager), found $found_pnpm; run corepack enable" >&2
    exit 1
  fi
  expected_esbuild="$(node -p 'require(process.argv[1]).devDependencies.esbuild' "$PACKAGE_DIR/package.json")"
  found_esbuild="$(cd "$PACKAGE_DIR" && node --input-type=module -e 'const { version } = await import("esbuild"); process.stdout.write(version)')"
  if [[ "$found_esbuild" != "$expected_esbuild" ]]; then
    echo "build-worker.sh: --release needs esbuild $expected_esbuild (package.json), found $found_esbuild; run pnpm install --frozen-lockfile" >&2
    exit 1
  fi
  found_node="$(node --version)"
  if [[ "$found_node" != "v$NODE_VERSION" ]]; then
    echo "build-worker.sh: note: Node $found_node, the canonical build uses v$NODE_VERSION (scripts/toolchain.env); the bundle bytes do not depend on it and the provenance records it" >&2
  fi
}

if [[ "$stage" == "all" || "$stage" == "js" ]]; then
  [[ "$release" -eq 1 ]] && check_js_pins
  cd "$REPO_DIR"
  # verify-snapshot loads the SDK's built entry; the bundle itself is built
  # from the SDK sources (scripts/build.mjs).
  pnpm --filter @hisoka-io/nox-client build >/dev/null
  cd "$PACKAGE_DIR"
  node scripts/verify-snapshot.mjs --offline
  node scripts/build.mjs
  provenance_args=()
  [[ -n "$source_commit" ]] && provenance_args+=(--source-commit "$source_commit")
  node scripts/provenance.mjs ${provenance_args[@]+"${provenance_args[@]}"}
fi
