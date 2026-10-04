#!/usr/bin/env bash
# Adds the e2e loopback IP filter to a kps checkout's WebRTC listener
# (libs/rust/kps/src/listener.rs): ICE gathering pinned to 127.0.0.1 and ::1.
# Diagnostic builds only, for hosts whose `lo` carries more than one address
# per family (WSL2 adds 10.255.255.254/32); never for a node. Idempotent.
#
# Usage: patch-kps-loopback-filter.sh <kps checkout>
set -euo pipefail

LISTENER="${1:?usage: $0 <kps checkout>}/libs/rust/kps/src/listener.rs"
ANCHOR='    se.set_include_loopback_candidate(true);'
[ -f "$LISTENER" ] || { echo "$LISTENER not found" >&2; exit 2; }
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
