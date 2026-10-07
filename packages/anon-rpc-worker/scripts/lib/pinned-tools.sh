# Pinned WASM tools of scripts/toolchain.env, sourced after it by
# scripts/verify-reproducible.sh and CI. The caller sets `arch` (x86_64 or
# aarch64) and defines `fail`.

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
