#!/usr/bin/env bash
# Build the worker twice from clean exports of one commit and compare bytes.
#
# Usage: packages/anon-rpc-worker/scripts/verify-reproducible.sh [--ref <git-ref>]
#          [--runtime docker|podman] [--local [--allow-unpinned]] [--keep]
#
# Default (containers): each build is a fresh `git archive` of the commit,
# built in fresh containers from the digest-pinned images in
# scripts/toolchain.env: the Rust image builds nox-wasm with the pinned
# wasm-pack, wasm-bindgen and binaryen (downloaded once on the host, checked
# against the pinned sha256 digests, mounted read-only), then the Node image
# installs with the frozen lockfile and bundles. The second build runs at a
# different absolute path inside its containers, so path leaks show up too.
#
# --local          the same two clean exports, built with the host's tools at
#                  two different host paths (no containers). The tools must
#                  match scripts/toolchain.env unless --allow-unpinned is
#                  given, in which case only the two local builds are compared.
# --keep           keep the build directories for inspection.
#
# Prints, for both builds: nox_wasm_bg.wasm sha256, worker keccak256 and
# sha256, provenance sha256. Exits 1 on any difference.
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
REPO_DIR="$(cd "$PACKAGE_DIR/../.." && pwd)"
PACKAGE_REL="packages/anon-rpc-worker"
# shellcheck source=toolchain.env
source "$SCRIPTS_DIR/toolchain.env"

ref="HEAD"
runtime="docker"
mode="container"
allow_unpinned=0
keep=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) ref="${2:?--ref needs a git ref}"; shift 2 ;;
    --runtime) runtime="${2:?--runtime needs docker or podman}"; shift 2 ;;
    --local) mode="local"; shift ;;
    --allow-unpinned) allow_unpinned=1; shift ;;
    --keep) keep=1; shift ;;
    *) echo "verify-reproducible.sh: unknown option $1 (see the header for usage)" >&2; exit 2 ;;
  esac
done

fail() { echo "verify-reproducible.sh: $*" >&2; exit 1; }

commit="$(git -C "$REPO_DIR" rev-parse --verify "$ref^{commit}")" || fail "cannot resolve $ref to a commit"
if [[ -n "$(git -C "$REPO_DIR" status --porcelain)" && "$ref" == "HEAD" ]]; then
  echo "note: the working tree has uncommitted changes; this builds the committed tree $commit only" >&2
fi

case "$(uname -m)" in
  x86_64|amd64) arch="x86_64" ;;
  aarch64|arm64) arch="aarch64" ;;
  *) fail "unsupported host architecture $(uname -m) (x86_64 and aarch64 are pinned)" ;;
esac

work_root="$(mktemp -d "${TMPDIR:-/tmp}/nox-worker-repro.XXXXXX")"
cleanup() {
  if [[ "$keep" -eq 1 ]]; then
    echo "kept build directories under $work_root"
  else
    rm -rf "$work_root"
  fi
}
trap cleanup EXIT

# Fetch the pinned WASM tools once, verify their digests, unpack them into
# $1/bin (wasm-pack, wasm-bindgen) and $1/binaryen.
fetch_tools() {
  local dest="$1" pack_sha bindgen_sha binaryen_sha
  if [[ "$arch" == "x86_64" ]]; then
    pack_sha="$WASM_PACK_SHA256_X86_64"; bindgen_sha="$WASM_BINDGEN_SHA256_X86_64"; binaryen_sha="$BINARYEN_SHA256_X86_64"
  else
    pack_sha="$WASM_PACK_SHA256_AARCH64"; bindgen_sha="$WASM_BINDGEN_SHA256_AARCH64"; binaryen_sha="$BINARYEN_SHA256_AARCH64"
  fi
  local pack_name="wasm-pack-v${WASM_PACK_VERSION}-${arch}-unknown-linux-musl"
  local bindgen_name="wasm-bindgen-${WASM_BINDGEN_VERSION}-${arch}-unknown-linux-musl"
  local binaryen_name="binaryen-version_${BINARYEN_VERSION}"
  local downloads="$dest/downloads"
  mkdir -p "$downloads" "$dest/bin"
  fetch_one "https://github.com/rustwasm/wasm-pack/releases/download/v${WASM_PACK_VERSION}/${pack_name}.tar.gz" "$pack_sha" "$downloads/${pack_name}.tar.gz"
  fetch_one "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${WASM_BINDGEN_VERSION}/${bindgen_name}.tar.gz" "$bindgen_sha" "$downloads/${bindgen_name}.tar.gz"
  fetch_one "https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/${binaryen_name}-${arch}-linux.tar.gz" "$binaryen_sha" "$downloads/${binaryen_name}.tar.gz"
  tar -xzf "$downloads/${pack_name}.tar.gz" -C "$dest"
  tar -xzf "$downloads/${bindgen_name}.tar.gz" -C "$dest"
  tar -xzf "$downloads/${binaryen_name}.tar.gz" -C "$dest"
  install -m 0755 "$dest/${pack_name}/wasm-pack" "$dest/bin/wasm-pack"
  install -m 0755 "$dest/${bindgen_name}/wasm-bindgen" "$dest/bin/wasm-bindgen"
  rm -rf "$dest/binaryen"
  mv "$dest/${binaryen_name}" "$dest/binaryen"
}

fetch_one() {
  local url="$1" expected="$2" out="$3" found
  if [[ ! -f "$out" ]]; then
    curl -sSfL --retry 3 -o "$out.part" "$url" || fail "download failed: $url"
    mv "$out.part" "$out"
  fi
  found="$(sha256sum "$out" | awk '{print $1}')"
  [[ "$found" == "$expected" ]] || fail "$(basename "$out"): sha256 $found, scripts/toolchain.env pins $expected"
}

# Export the commit into $1/src.
export_tree() {
  mkdir -p "$1/src"
  git -C "$REPO_DIR" archive --format=tar "$commit" | tar -x -C "$1/src"
}

container_build() {
  local dir="$1" inner="$2" tools="$3"
  local uid gid
  uid="$(id -u)"; gid="$(id -g)"
  # Stage 1: nox-wasm in the pinned Rust image. Runs as root (rustup adds the
  # wasm target to the image's toolchain) and hands the tree back to the caller.
  "$runtime" run --rm --network host \
    -v "$dir/src:$inner" -v "$tools:/opt/nox-tools:ro" -w "$inner" \
    -e "PATH=/opt/nox-tools/bin:/opt/nox-tools/binaryen/bin:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$RUST_IMAGE" bash -euo pipefail -c "
      trap 'chown -R $uid:$gid $inner' EXIT
      rustup target add wasm32-unknown-unknown >/dev/null
      bash $PACKAGE_REL/scripts/build-worker.sh --release --stage wasm --source-commit $commit"
  # Stage 2: install with the frozen lockfile and bundle in the pinned Node image.
  "$runtime" run --rm --network host \
    -v "$dir/src:$inner" -w "$inner" -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    "$NODE_IMAGE" bash -euo pipefail -c "
      trap 'chown -R $uid:$gid $inner' EXIT
      corepack enable
      pnpm install --frozen-lockfile >/dev/null
      bash $PACKAGE_REL/scripts/build-worker.sh --release --stage js --source-commit $commit"
}

local_build() {
  local dir="$1"
  local release_args=(--release)
  [[ "$allow_unpinned" -eq 1 ]] && release_args=()
  (
    cd "$dir/src"
    pnpm install --frozen-lockfile --prefer-offline >/dev/null
    bash "$PACKAGE_REL/scripts/build-worker.sh" ${release_args[@]+"${release_args[@]}"} --source-commit "$commit"
  )
}

# Print and return the digests of one build as "wasm worker_keccak worker_sha provenance_sha".
digests() {
  local src="$1/src" wasm_sha worker_keccak worker_sha provenance_sha
  wasm_sha="$(sha256sum "$src/packages/nox-wasm/pkg-web/nox_wasm_bg.wasm" | awk '{print $1}')"
  worker_keccak="$(awk '{print $1}' "$src/$PACKAGE_REL/dist/anon-rpc-worker.js.keccak256")"
  worker_sha="$(sha256sum "$src/$PACKAGE_REL/dist/anon-rpc-worker.js" | awk '{print $1}')"
  provenance_sha="$(sha256sum "$src/$PACKAGE_REL/dist/anon-rpc-worker.provenance.json" | awk '{print $1}')"
  echo "$wasm_sha $worker_keccak $worker_sha $provenance_sha"
}

echo "verify-reproducible: commit $commit, mode $mode, host $arch"
if [[ "$mode" == "container" ]]; then
  command -v "$runtime" >/dev/null || fail "$runtime is not installed; install it or use --local"
  tools_dir="${XDG_CACHE_HOME:-$HOME/.cache}/nox-anon-rpc-worker/tools-$arch"
  fetch_tools "$tools_dir"
  build_paths=(/src /work/second-build/nox-sdk)
else
  build_paths=("" "")
fi

results=()
for index in 0 1; do
  dir="$work_root/build-$((index + 1))"
  [[ "$index" -eq 1 ]] && dir="$work_root/second/nested/build-2"
  mkdir -p "$dir"
  export_tree "$dir"
  echo "--- build $((index + 1)) in $dir/src${build_paths[$index]:+ (container path ${build_paths[$index]})}"
  if [[ "$mode" == "container" ]]; then
    container_build "$dir" "${build_paths[$index]}" "$tools_dir"
  else
    local_build "$dir"
  fi
  results+=("$(digests "$dir")")
done

read -r wasm1 keccak1 sha1 prov1 <<<"${results[0]}"
read -r wasm2 keccak2 sha2 prov2 <<<"${results[1]}"
printf '\n%-24s %-66s %s\n' "artifact" "build 1" "build 2"
printf '%-24s %-66s %s\n' "nox_wasm_bg.wasm sha256" "$wasm1" "$wasm2"
printf '%-24s %-66s %s\n' "worker keccak256" "$keccak1" "$keccak2"
printf '%-24s %-66s %s\n' "worker sha256" "$sha1" "$sha2"
printf '%-24s %-66s %s\n' "provenance sha256" "$prov1" "$prov2"

if [[ "${results[0]}" == "${results[1]}" ]]; then
  echo "REPRODUCIBLE: both builds of $commit give worker keccak256 $keccak1"
  exit 0
fi
echo "NOT REPRODUCIBLE: the builds of $commit differ (rerun with --keep and diff the two trees)" >&2
exit 1
