#!/usr/bin/env bash
# Adapted from ethereum/tor-js scripts/reproducible-rustc.sh at commit 7ac2a600283acf1c5835f23186110a27ab73c181,
# Copyright 2019-2025, The Tor Project, Inc. Copyright 2026, Ethereum Foundation.
# Licensed under MIT or Apache-2.0 (https://github.com/ethereum/tor-js). Changes: the
# environment variables are named NOX_WORKSPACE_ROOT and NOX_RUSTC_KEYLOG.
#
# RUSTC_WRAPPER that makes `-C metadata` host-independent.
#
# Why: cargo derives each unit's `-C metadata` hash from inputs that include
# host-specific information, so the same target (e.g. wasm32-unknown-unknown)
# built from an x86_64 host and an aarch64 host gets different crate
# disambiguators. Those feed symbol mangling, and the mangled names influence
# codegen ordering and inlining decisions — so the *stripped* artifact differs
# too. See https://github.com/rust-lang/cargo/issues/8140.
#
# `-C metadata` accumulates rather than overrides, so RUSTFLAGS cannot fix this;
# a wrapper can, because it sees cargo's own argument and can rewrite it.
#
# The replacement must stay unique per compilation unit or rustc reports
# colliding StableCrateId values (this graph legitimately contains three
# getrandom versions, two rand_core versions, and host+target builds of the same
# proc-macro crates). It is therefore derived from the unit's identity —
# crate name, crate types, edition, target triple, cfgs, and the source path
# with machine-specific prefixes normalised away — all of which are identical
# across hosts but differ between units.
#
# Set NOX_RUSTC_KEYLOG=<path> to append `key<TAB>identity` per invocation,
# for auditing uniqueness.

set -euo pipefail

rustc_bin="$1"
shift

# Passthrough for probe invocations (`rustc -vV`, `--print` queries): they carry
# no -C metadata, and rewriting anything there would confuse cargo.
have_metadata=0
for a in "$@"; do
  case "$a" in
    metadata=*|-Cmetadata=*|--codegen=metadata=*) have_metadata=1; break ;;
  esac
done
if [ "$have_metadata" -eq 0 ]; then
  exec "$rustc_bin" "$@"
fi

# --- collect the unit's host-independent identity ---------------------------
crate_name=""
target_triple=""
edition=""
crate_types=()
cfgs=()
src=""

prev=""
for a in "$@"; do
  case "$prev" in
    --crate-name) crate_name="$a" ;;
    --target)     target_triple="$a" ;;
    --crate-type) crate_types+=("$a") ;;
    --cfg)        cfgs+=("$a") ;;
  esac
  case "$a" in
    --edition=*)    edition="${a#--edition=}" ;;
    --target=*)     target_triple="${a#--target=}" ;;
    --crate-type=*) crate_types+=("${a#--crate-type=}") ;;
    --cfg=*)        cfgs+=("${a#--cfg=}") ;;
    *.rs)           src="$a" ;;
  esac
  prev="$a"
done

# Normalise machine-specific prefixes out of the source path. Registry paths
# carry the crate version (…/getrandom-0.2.16/src/lib.rs), which is exactly the
# discriminator we need between multiple versions of one crate.
#
# Each prefix is stripped only at the start of the path and only at a path
# component boundary. A plain `${var//prefix/x}` would replace every
# occurrence anywhere in the path, so a checkout at /src rewrote the
# `/registry/src/` and `/src/lib.rs` parts of every dependency path, and the
# keys (and the WASM bytes) depended on the checkout path. Longest prefix
# wins: the first match ends the normalisation.
norm_src="$src"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
sysroot="$("$rustc_bin" --print sysroot 2>/dev/null || true)"
strip_prefix() {
  # $1 = prefix, $2 = replacement; prints nothing and fails when $norm_src
  # does not start with "$1/".
  local prefix="${1%/}"
  [ -n "$prefix" ] || return 1
  case "$norm_src" in
    "$prefix"/*) printf '%s%s' "$2" "${norm_src#"$prefix"}" ;;
    *) return 1 ;;
  esac
}
prefixes=()
while IFS=$'\t' read -r _len prefix replacement; do
  prefixes+=("$prefix" "$replacement")
done < <(
  for pair in "$cargo_home|/cargo-home" "$sysroot|/sysroot" "${NOX_WORKSPACE_ROOT:-}|/workspace"; do
    p="${pair%|*}"
    [ -n "$p" ] && printf '%d\t%s\t%s\n' "${#p}" "$p" "${pair##*|}"
  done | LC_ALL=C sort -t$'\t' -k1,1nr
)
i=0
while [ "$i" -lt "${#prefixes[@]}" ]; do
  if stripped="$(strip_prefix "${prefixes[$i]}" "${prefixes[$((i + 1))]}")"; then
    norm_src="$stripped"
    break
  fi
  i=$((i + 2))
done

# Sort cfgs: cargo's ordering is stable in practice, but this costs nothing and
# removes it as a variable.
sorted_cfgs="$(printf '%s\n' ${cfgs[@]+"${cfgs[@]}"} | LC_ALL=C sort | tr '\n' ',')"
identity="name=$crate_name|types=${crate_types[*]-}|edition=$edition|target=$target_triple|cfgs=$sorted_cfgs|src=$norm_src"
key="$(printf '%s' "$identity" | sha256sum | cut -c1-32)"

if [ -n "${NOX_RUSTC_KEYLOG:-}" ]; then
  printf '%s\t%s\n' "$key" "$identity" >> "$NOX_RUSTC_KEYLOG"
fi

# --- rewrite -C metadata to the derived key --------------------------------
# extra-filename is deliberately left alone: it only names output files, and
# those must stay distinct per unit for cargo's own bookkeeping.
args=()
for a in "$@"; do
  case "$a" in
    metadata=*)           args+=("metadata=$key") ;;
    -Cmetadata=*)         args+=("-Cmetadata=$key") ;;
    --codegen=metadata=*) args+=("--codegen=metadata=$key") ;;
    *)                    args+=("$a") ;;
  esac
done

exec "$rustc_bin" "${args[@]}"
