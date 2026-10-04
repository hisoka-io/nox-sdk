#!/usr/bin/env bash
# Regenerates contracts/WorkerSpecifier.json (ABI + creation bytecode) from the
# vendored reference contract with solc 0.8.28, the version the upstream
# anon-rpc specifier project pins (impl/specifier/foundry.toml).
#
# Env: SOLC  path to a solc 0.8.28 binary (default: `solc` on PATH, then ~/.solcx/solc-v0.8.28)
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HERE/contracts/WorkerSpecifier.sol"
OUT="$HERE/contracts/WorkerSpecifier.json"
WANT="0.8.28"

pick_solc() {
    for candidate in "${SOLC:-}" "$(command -v solc || true)" "$HOME/.solcx/solc-v$WANT"; do
        [ -n "$candidate" ] && [ -x "$candidate" ] || continue
        if "$candidate" --version | grep -q "Version: $WANT+"; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

SOLC_BIN="$(pick_solc)" || {
    echo "solc $WANT not found: set SOLC=/path/to/solc-$WANT (e.g. via 'svm install $WANT')" >&2
    exit 2
}
VERSION="$("$SOLC_BIN" --version | sed -ne 's/^Version: //p')"
SHA256="$(sha256sum "$SRC" | cut -d' ' -f1)"
COMBINED_FILE="$(mktemp)"
trap 'rm -f "$COMBINED_FILE"' EXIT
# Compile from the contracts directory so the source unit name carries no machine path.
(cd "$HERE/contracts" && "$SOLC_BIN" --combined-json abi,bin WorkerSpecifier.sol) >"$COMBINED_FILE"

node --input-type=module - "$OUT" "$VERSION" "$SHA256" "$COMBINED_FILE" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
const [out, version, sha256, combinedFile] = process.argv.slice(2);
const combined = JSON.parse(readFileSync(combinedFile, "utf8"));
const key = Object.keys(combined.contracts).find((name) => name.endsWith(":WorkerSpecifier"));
if (key === undefined) throw new Error("WorkerSpecifier not found in solc output");
const contract = combined.contracts[key];
const artifact = {
  contractName: "WorkerSpecifier",
  source: {
    repository: "https://github.com/ethereum/anon-rpc",
    path: "impl/specifier/src/WorkerSpecifier.sol",
    commit: "f2c8a758caaa555974a3c79769e8cb4a40ac1ae1",
    sha256,
  },
  compiler: { solc: version, settings: "solc --combined-json abi,bin (defaults, optimizer off)" },
  abi: typeof contract.abi === "string" ? JSON.parse(contract.abi) : contract.abi,
  bytecode: `0x${contract.bin}`,
};
writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`wrote ${out} (${contract.bin.length / 2} bytes of creation code, solc ${version})`);
JS
