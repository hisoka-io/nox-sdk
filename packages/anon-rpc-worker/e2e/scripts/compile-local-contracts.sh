#!/usr/bin/env bash
# Regenerates the contract artifacts the local chain bed deploys (ABI + creation bytecode):
#   contracts/E2eLogEmitter.json  from contracts/E2eLogEmitter.sol (this package)
#   contracts/NoxRegistry.json    NoxRegistry implementation, from a hisoka-io/darkpool checkout
#   contracts/ERC1967Proxy.json   OpenZeppelin ERC1967Proxy the registry is deployed behind
# with solc 0.8.28 and the darkpool hardhat settings for NoxRegistry (optimizer runs 1,
# evm cancun). `--metadata-hash none` and repository-relative source names keep the
# bytecode independent of the checkout location.
#
# Env: SOLC           path to solc 0.8.28 (default: `solc` on PATH, then ~/.solcx/solc-v0.8.28)
#      DARKPOOL_REPO  hisoka-io/darkpool checkout with packages/evm-contracts/node_modules
#                     installed (default: ../darkpool-v2 next to this nox-sdk checkout)
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SDK_ROOT="$(cd "$HERE/../../.." && pwd)"
WANT="0.8.28"
DARKPOOL_REPO="${DARKPOOL_REPO:-$SDK_ROOT/../darkpool-v2}"
EVM="$DARKPOOL_REPO/packages/evm-contracts"
REGISTRY_SRC="contracts/nox/NoxRegistry.sol"

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
[ -f "$EVM/$REGISTRY_SRC" ] && [ -d "$EVM/node_modules/@openzeppelin/contracts-upgradeable" ] || {
    echo "set DARKPOOL_REPO to a hisoka-io/darkpool checkout with packages/evm-contracts dependencies installed" >&2
    exit 2
}
VERSION="$("$SOLC_BIN" --version | sed -ne 's/^Version: //p')"
DARKPOOL_COMMIT="$(git -C "$DARKPOOL_REPO" rev-parse HEAD)"
OZ_VERSION="$(node -p "require('$EVM/node_modules/@openzeppelin/contracts/package.json').version")"
REGISTRY_SHA256="$(sha256sum "$EVM/$REGISTRY_SRC" | cut -d' ' -f1)"
EMITTER_SHA256="$(sha256sum "$HERE/contracts/E2eLogEmitter.sol" | cut -d' ' -f1)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

(cd "$HERE/contracts" && "$SOLC_BIN" --optimize --optimize-runs 200 --evm-version cancun --metadata-hash none \
    --combined-json abi,bin E2eLogEmitter.sol) >"$TMP/emitter.json"
cat >"$TMP/Proxy.sol" <<'SOL'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
SOL
(cd "$EVM" && "$SOLC_BIN" --optimize --optimize-runs 1 --evm-version cancun --metadata-hash none \
    --base-path . --include-path node_modules --include-path "$TMP" --allow-paths "$DARKPOOL_REPO" \
    --combined-json abi,bin "$REGISTRY_SRC" "$TMP/Proxy.sol") >"$TMP/registry.json"

node --input-type=module - "$HERE/contracts" "$VERSION" "$TMP" "$DARKPOOL_COMMIT" "$OZ_VERSION" \
    "$REGISTRY_SHA256" "$EMITTER_SHA256" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [outDir, version, tmp, darkpoolCommit, ozVersion, registrySha, emitterSha] = process.argv.slice(2);
function pick(file, name) {
  const combined = JSON.parse(readFileSync(join(tmp, file), "utf8"));
  const key = Object.keys(combined.contracts).find((k) => k.endsWith(`:${name}`));
  if (key === undefined) throw new Error(`${name} not found in solc output`);
  const contract = combined.contracts[key];
  return { abi: typeof contract.abi === "string" ? JSON.parse(contract.abi) : contract.abi, bytecode: `0x${contract.bin}` };
}
const write = (name, artifact) => {
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`wrote contracts/${name}.json (${(artifact.bytecode.length - 2) / 2} bytes of creation code, solc ${version})`);
};
write("E2eLogEmitter", {
  contractName: "E2eLogEmitter",
  source: { path: "contracts/E2eLogEmitter.sol", sha256: emitterSha },
  compiler: { solc: version, settings: "--optimize --optimize-runs 200 --evm-version cancun --metadata-hash none" },
  ...pick("emitter.json", "E2eLogEmitter"),
});
const darkpool = { repository: "https://github.com/hisoka-io/darkpool", commit: darkpoolCommit };
write("NoxRegistry", {
  contractName: "NoxRegistry",
  source: { ...darkpool, path: "packages/evm-contracts/contracts/nox/NoxRegistry.sol", sha256: registrySha, openzeppelin: ozVersion },
  compiler: { solc: version, settings: "--optimize --optimize-runs 1 --evm-version cancun --metadata-hash none" },
  ...pick("registry.json", "NoxRegistry"),
});
write("ERC1967Proxy", {
  contractName: "ERC1967Proxy",
  source: { package: "@openzeppelin/contracts", version: ozVersion, path: "proxy/ERC1967/ERC1967Proxy.sol" },
  compiler: { solc: version, settings: "--optimize --optimize-runs 1 --evm-version cancun --metadata-hash none" },
  ...pick("registry.json", "ERC1967Proxy"),
});
JS
