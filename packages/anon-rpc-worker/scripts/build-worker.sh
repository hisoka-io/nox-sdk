#!/usr/bin/env bash
# Build the Nox anon-rpc worker: nox-wasm from source, then the bundle and its
# provenance (ARCHITECTURE §7.2). Run it from a clone of nox-sdk after
# `corepack enable && pnpm install --frozen-lockfile`.
#
# Usage: packages/anon-rpc-worker/scripts/build-worker.sh [--release] [--stage all|wasm|js]
#                                                         [--source-commit <sha>]
#
#   --release        refuse a dirty git tree and require the pinned toolchain
#                    (scripts/toolchain.env) for the WASM stage
#   --stage wasm     only build packages/nox-wasm/pkg-web (needs Rust tools)
#   --stage js       only bundle (needs Node and an existing pkg-web)
#   --source-commit  commit id for the provenance when the tree has no .git
#
# Output: packages/anon-rpc-worker/dist/anon-rpc-worker.js, its .keccak256,
# build-record.json and anon-rpc-worker.provenance.json.
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

if [[ "$stage" == "all" || "$stage" == "js" ]]; then
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
