#!/usr/bin/env bash
# Live-network browser checks used by .github/workflows/webkit.yml.
#
#   bash scripts/live-webkit.sh kps  <chromium|webkit>   KPS-only dial repro on every bootstrap anchor
#   bash scripts/live-webkit.sh boot <chromium|webkit>   worker boot from the stable specifier, then RPC calls
#
# Results land in .run/kps-repro and .run/live-boot; a summary goes to
# $GITHUB_STEP_SUMMARY when set. Exits 1 when any check failed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"
BROWSER="${2:-}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
export SUMMARY_FILE="$SUMMARY"
cd "$HERE"

case "$BROWSER" in
    chromium|webkit) ;;
    *) echo "usage: $0 <kps|boot> <chromium|webkit>" >&2; exit 2 ;;
esac

case "$MODE" in
    kps)
        out="$HERE/.run/kps-repro"
        mkdir -p "$out"
        mapfile -t anchors < <(node -p 'require("../snapshot/nox-bootstrap.json").anchors.join("\n")')
        failed=0
        echo "### KPS dial repro: $BROWSER" >>"$SUMMARY"
        echo "" >>"$SUMMARY"
        for i in "${!anchors[@]}"; do
            json="$out/$BROWSER-anchor$i.json"
            log="$out/$BROWSER-anchor$i.log"
            status=ok
            node tools/kps-repro/run.mjs "$BROWSER" "${anchors[$i]}" >"$json" 2>"$log" || status=FAILED
            [ "$status" = ok ] || failed=1
            echo "anchor $i: $status"
            cat "$json" "$log"
            node -e '
                const fs = require("node:fs");
                const [file, i, status] = process.argv.slice(1);
                let r;
                try { r = JSON.parse(fs.readFileSync(file, "utf8")); } catch { r = undefined; }
                const lines = [`- anchor ${i}: ${status}`];
                if (r === undefined) lines.push("  - no result (see the .log file)");
                else {
                  if (r.timedOut) lines.push("  - timed out waiting for the page");
                  for (const s of r.steps ?? []) lines.push(`  - ${s.ok ? "ok" : "FAILED"} ${s.name} (${s.ms} ms) ${s.detail}`);
                  for (const p of r.pcStates ?? []) lines.push(`  - pc ${p}`);
                }
                fs.appendFileSync(process.env.SUMMARY_FILE, lines.join("\n") + "\n");
            ' "$json" "$i" "$status"
        done
        exit "$failed"
        ;;
    boot)
        set +e
        npx tsx tools/live-boot/run.ts "$BROWSER" | tee "$HERE/.run/live-boot-$BROWSER.log"
        code="${PIPESTATUS[0]}"
        set -e
        mkdir -p "$HERE/.run/live-boot"
        mv "$HERE/.run/live-boot-$BROWSER.log" "$HERE/.run/live-boot/stdout-$BROWSER.log"
        sed -n '1,/^Worker log/p' "$HERE/.run/live-boot/stdout-$BROWSER.log" >>"$SUMMARY"
        echo "" >>"$SUMMARY"
        exit "$code"
        ;;
    *) echo "usage: $0 <kps|boot> <chromium|webkit>" >&2; exit 2 ;;
esac
