#!/usr/bin/env bash
# Diagnostic variant of the Rust KPS echo server (NOT for production use).
#
# The kps crate's WebRTC listener pins ICE gathering to interfaces whose name
# starts with "lo" (libs/rust/kps/src/listener.rs, set_interface_filter), so
# that exactly one host candidate per address family exists. A host whose
# loopback interface carries more than one IPv4 address (WSL2 adds
# 10.255.255.254/32 to `lo` for DNS tunnelling) still yields two candidates,
# and the listener logs "CONCURRENT inbox readers" (KPS_DEBUG=1) and never
# completes ICE, so browsers see "kps: HELLO timeout".
#
# This script builds the same kps-server with one extra line that also pins
# gathering to the exact loopback addresses (127.0.0.1 and ::1), to confirm
# that diagnosis. The patch lives only in a throwaway git worktree of the
# cached kps clone; nothing is pushed or published.
#
# Env: same as build-kps-servers.sh (E2E_CACHE_DIR, KPS_REPO_DIR, KPS_REV).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${E2E_CACHE_DIR:-$HERE/.cache}"
KPS_REV="${KPS_REV:-d14dc5989dabb5b01e8c4e430933cc8a7767547c}"
KPS_REPO_DIR="${KPS_REPO_DIR:-$CACHE/kps}"
PROBE_DIR="$CACHE/kps-ipfilter-probe"
BIN_DIR="$CACHE/bin"

[ -d "$KPS_REPO_DIR/.git" ] || { echo "run scripts/build-kps-servers.sh first" >&2; exit 2; }
mkdir -p "$BIN_DIR"

if [ ! -d "$PROBE_DIR" ]; then
    git -C "$KPS_REPO_DIR" worktree add --quiet --detach "$PROBE_DIR" "$KPS_REV"
fi
git -C "$PROBE_DIR" checkout --quiet --force "$KPS_REV"

LISTENER="$PROBE_DIR/libs/rust/kps/src/listener.rs"
ANCHOR='    se.set_include_loopback_candidate(true);'
grep -qF "$ANCHOR" "$LISTENER" || { echo "patch anchor not found in $LISTENER" >&2; exit 1; }
python3 - "$LISTENER" "$ANCHOR" <<'PY'
import sys
path, anchor = sys.argv[1], sys.argv[2]
src = open(path, encoding="utf-8").read()
extra = (
    anchor + "\n"
    "    // e2e diagnostic: exactly one loopback address per family.\n"
    "    se.set_ip_filter(Box::new(|ip: IpAddr| {\n"
    "        ip == IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)\n"
    "            || ip == IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)\n"
    "    }));"
)
if "e2e diagnostic: exactly one loopback address" not in src:
    src = src.replace(anchor, extra, 1)
open(path, "w", encoding="utf-8").write(src)
PY

echo "[kps-probe] building kps-server with the loopback IP filter"
(cd "$PROBE_DIR/libs/rust" && cargo build --release --locked -p kps-server)
install -m 0755 "$PROBE_DIR/libs/rust/target/release/kps-server" "$BIN_DIR/kps-rust-server-ipfilter"
echo "[kps-probe] built $BIN_DIR/kps-rust-server-ipfilter"
