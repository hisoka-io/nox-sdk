#!/usr/bin/env node
// @ts-check
/**
 * Verify the pinned NoxRegistry snapshot (ARCHITECTURE §5.2, task BLD-405).
 *
 *   --offline        no network. The .keccak256 record matches the file; the
 *                    document has the exact schema and canonical bytes; the SDK
 *                    agrees with every derived field (fingerprint, layers,
 *                    order); chain, registry, powDifficulty and capabilities
 *                    equal the committed inputs (scripts/networks.json,
 *                    snapshot/capabilities.json). The package build runs this.
 *   --rpc <url>...   everything above, then, per endpoint, read the chain again
 *                    at the recorded block with the same code path as
 *                    make-snapshot.mjs and require the regenerated document to
 *                    equal the committed bytes. Differences are printed per
 *                    member and field. When an endpoint says it keeps no state
 *                    for that block (a missing-state JSON-RPC error; any other
 *                    error fails), it checks instead that the recorded block
 *                    exists at or below the endpoint's safe block with the
 *                    recorded blockHash, that the state at its latest block
 *                    equals the snapshot, and that the registry emitted no
 *                    event after the snapshot block.
 *   --release        also apply the release gate: the snapshot is of the
 *                    configured release network, and every member publishes a
 *                    KPS address in its metadataUrl, except the addresses given
 *                    with --allow-missing-kps (named in the release notes).
 *                    With --offline this checks the document only (the
 *                    output says so): metadataUrl values are taken as
 *                    committed, so a canary overlay would pass. A release
 *                    snapshot passes the gate with two --rpc providers.
 *
 * Usage:
 *   node scripts/verify-snapshot.mjs [--snapshot snapshot/nox-snapshot.json] --offline
 *   node scripts/verify-snapshot.mjs [--snapshot <file>] --rpc <a> [--rpc <b>] [--release]
 *        [--allow-missing-kps <address,address>] [--network arbitrum-sepolia] [--networks <file>]
 *        [--capabilities <file>]
 * The RPC URL can also come from NOX_SNAPSHOT_RPC_URL.
 */
import { readFileSync } from "node:fs";
/** Independent RPC providers a release snapshot is re-read through (ARCHITECTURE §5.2). */
export const RELEASE_MIN_PROVIDERS = 2;
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkHashFile, KECCAK_FILE_SUFFIX } from "./hash.mjs";
import { errorMessage, isMain, runMain } from "./lib/cli.mjs";
import { kpsAddrFromMetadataUrl } from "./lib/kps-address.mjs";
import { CAPABILITIES_PATH, NETWORKS_PATH, SNAPSHOT_PATH } from "./lib/paths.mjs";
import {
  buildSnapshot,
  chainDifferences,
  collectRegistryState,
  loadCapabilities,
  loadNetwork,
  registryEventsAfter,
  resolveBlock,
} from "./lib/registry.mjs";
import { serializeSnapshot, SnapshotError, validateSnapshotDocument } from "./lib/snapshot-format.mjs";
import { CHAIN_OPTIONS, chainAccessFromArgs, RPC_URL_ENV } from "./make-snapshot.mjs";

/**
 * @typedef {import("./lib/snapshot-format.mjs").NoxAnonRpcSnapshot} NoxAnonRpcSnapshot
 * @typedef {import("./lib/registry.mjs").NetworkConfig} NetworkConfig
 */

/**
 * Offline checks. Returns the validated snapshot and its exact text; throws
 * SnapshotError("invalid-document") listing every problem found.
 * @param {{ path: string, network: NetworkConfig, capabilities: Map<string, string[]> }} options
 * @returns {Promise<{ snapshot: NoxAnonRpcSnapshot, text: string, keccak256: string }>}
 */
export async function verifyOffline({ path, network, capabilities }) {
  /** @type {string[]} */
  const problems = [];
  const record = await checkHashFile(`${path}${KECCAK_FILE_SUFFIX}`);
  if (!record.ok) {
    problems.push(
      `the file does not match its ${KECCAK_FILE_SUFFIX} record (recorded ${record.expected}, computed ${record.actual.keccak256}); ` +
        "regenerate it with scripts/make-snapshot.mjs instead of editing it",
    );
  }
  const text = readFileSync(path, "utf8");
  /** @type {unknown} */
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new SnapshotError(`${path} is not JSON: ${errorMessage(error)}`, "invalid-document");
  }
  const snapshot = validateSnapshotDocument(doc);
  if (serializeSnapshot(snapshot) !== text) {
    problems.push("the file is not in canonical form (sorted keys, 2-space indent, LF, one trailing newline)");
  }
  problems.push(...inputDifferences(snapshot, network, capabilities));
  if (problems.length > 0) {
    throw new SnapshotError(`${path} fails the offline checks:\n  - ${problems.join("\n  - ")}`, "invalid-document");
  }
  return { snapshot, text, keccak256: record.actual.keccak256 };
}

/**
 * Differences between a snapshot and the committed release inputs.
 * @param {NoxAnonRpcSnapshot} snapshot
 * @param {NetworkConfig} network
 * @param {Map<string, string[]>} capabilities
 * @returns {string[]}
 */
export function inputDifferences(snapshot, network, capabilities) {
  /** @type {string[]} */
  const out = [];
  if (snapshot.chainId !== network.chain_id) out.push(`chainId ${snapshot.chainId} is not ${network.name} (chain ${network.chain_id})`);
  if (snapshot.registry !== network.registry) out.push(`registry ${snapshot.registry} is not the ${network.name} registry ${network.registry}`);
  if (snapshot.blockNumber < network.from_block) out.push(`blockNumber ${snapshot.blockNumber} is before the registry deployment block ${network.from_block}`);
  if (snapshot.powDifficulty !== network.pow_difficulty) {
    out.push(`powDifficulty ${snapshot.powDifficulty} differs from the ${network.name} release input ${network.pow_difficulty}`);
  }
  const members = new Set(snapshot.members.map((member) => member.address));
  for (const member of snapshot.members) {
    const expected = capabilities.get(member.address) ?? [];
    if (JSON.stringify(expected) !== JSON.stringify(member.capabilities)) {
      out.push(`member ${member.address}.capabilities ${JSON.stringify(member.capabilities)} differ from the reviewed hints ${JSON.stringify(expected)}`);
    }
  }
  for (const address of capabilities.keys()) {
    if (!members.has(address)) out.push(`the reviewed hints name ${address}, which is not a snapshot member`);
  }
  return out;
}

/**
 * Release gate (ARCHITECTURE §5.1): every member publishes a KPS address,
 * except the ones the release notes name.
 * @param {NoxAnonRpcSnapshot} snapshot
 * @param {Set<string>} allowMissing
 * @returns {string[]}
 */
export function releaseGateProblems(snapshot, allowMissing) {
  /** @type {string[]} */
  const out = [];
  const members = new Set(snapshot.members.map((member) => member.address));
  for (const address of allowMissing) {
    if (!members.has(address)) out.push(`--allow-missing-kps names ${address}, which is not a snapshot member`);
  }
  for (const member of snapshot.members) {
    const parsed = kpsAddrFromMetadataUrl(member.metadataUrl);
    if (parsed.endpoint !== null || allowMissing.has(member.address)) continue;
    out.push(
      `member ${member.address} publishes no KPS address in its metadataUrl ` +
        `(${member.metadataUrl === "" ? "empty" : JSON.stringify(member.metadataUrl)}${parsed.reason === null ? "" : `: ${parsed.reason}`})`,
    );
  }
  return out;
}

/**
 * Re-read the chain through one endpoint and compare.
 * @param {{ rpc: import("./lib/rpc.mjs").RpcClient, snapshot: NoxAnonRpcSnapshot, text: string, network: NetworkConfig,
 *           capabilities: Map<string, string[]>, scan: { logChunkBlocks: number, minLogChunkBlocks: number } }} options
 * @returns {Promise<{ ok: boolean, lines: string[] }>}
 */
export async function verifyAgainstChain({ rpc, snapshot, text, network, capabilities, scan }) {
  const common = { rpc, network, logChunkBlocks: scan.logChunkBlocks, minLogChunkBlocks: scan.minLogChunkBlocks };
  try {
    const state = await collectRegistryState({ ...common, block: snapshot.blockNumber });
    const regenerated = serializeSnapshot(buildSnapshot(state, { powDifficulty: network.pow_difficulty, capabilities }));
    if (regenerated === text) {
      return { ok: true, lines: [`${rpc.origin}: MATCH, the chain at block ${snapshot.blockNumber} gives these exact bytes`] };
    }
    const differences = chainDifferences(snapshot, state);
    return {
      ok: false,
      lines: [
        `${rpc.origin}: MISMATCH against the chain at block ${snapshot.blockNumber}`,
        ...(differences.length > 0 ? differences : ["the bytes differ outside the chain fields; run --offline for the input checks"]).map(
          (line) => `  ${line}`,
        ),
      ],
    };
  } catch (error) {
    if (!(error instanceof SnapshotError) || error.code !== "block-unavailable") throw error;
    // The endpoint keeps no state for that block. Headers outlive state on
    // pruning nodes, so first require the recorded block to exist at or below
    // the safe block with the recorded hash; then compare with the latest
    // state and require that the registry emitted nothing since.
    const header = await recordedBlockProblems(rpc, snapshot);
    if (header.problems.length > 0) {
      return {
        ok: false,
        lines: [
          `${rpc.origin}: MISMATCH, the recorded block fails the header checks (no state at block ${snapshot.blockNumber} on this endpoint)`,
          ...header.problems.map((line) => `  ${line}`),
        ],
      };
    }
    const latest = header.latest;
    /** @type {import("./lib/registry.mjs").RegistryState} */
    let state;
    try {
      state = await collectRegistryState({ ...common, block: latest.number, requireSafe: false });
    } catch (fallbackError) {
      if (!(fallbackError instanceof SnapshotError) || fallbackError.code !== "block-unavailable") throw fallbackError;
      return {
        ok: false,
        lines: [
          `${rpc.origin}: UNAVAILABLE, it serves registry state neither at block ${snapshot.blockNumber} nor at its latest block ` +
            `${latest.number} (${fallbackError.message}); use an archive endpoint`,
        ],
      };
    }
    const differences = chainDifferences(snapshot, state).filter(
      (line) => !line.startsWith("blockNumber:") && !line.startsWith("blockHash:"),
    );
    const events = await registryEventsAfter(rpc, network.registry, snapshot.blockNumber, latest.number, scan);
    const ok = differences.length === 0 && events === 0;
    return {
      ok,
      lines: [
        `${rpc.origin}: ${ok ? "MATCH" : "MISMATCH"} (fallback: no state at block ${snapshot.blockNumber} on this endpoint; ` +
          `its header there has the recorded hash and is at or below the safe block ${header.safe.number}; ` +
          `compared with block ${latest.number}, ${events} registry event(s) since the snapshot block)`,
        ...differences.map((line) => `  ${line}`),
      ],
    };
  }
}

/**
 * Header checks for the fallback: the recorded block exists on the endpoint's
 * chain, is at or below its latest and safe blocks, and has the recorded
 * hash. Returns one line per problem, naming the field.
 * @param {import("./lib/rpc.mjs").RpcClient} rpc
 * @param {NoxAnonRpcSnapshot} snapshot
 * @returns {Promise<{ problems: string[], latest: { number: number, hash: string }, safe: { number: number, hash: string } }>}
 */
export async function recordedBlockProblems(rpc, snapshot) {
  const latest = await resolveBlock(rpc, "latest");
  const safe = await resolveBlock(rpc, "safe");
  /** @type {string[]} */
  const problems = [];
  if (snapshot.blockNumber > latest.number) {
    problems.push(`blockNumber: snapshot ${snapshot.blockNumber} is above the chain's latest block ${latest.number}`);
    return { problems, latest, safe };
  }
  if (snapshot.blockNumber > safe.number) {
    problems.push(
      `blockNumber: snapshot ${snapshot.blockNumber} is above the chain's safe block ${safe.number}, so a reorg can still replace it`,
    );
  }
  /** @type {{ number: number, hash: string }} */
  let recorded;
  try {
    recorded = await resolveBlock(rpc, snapshot.blockNumber);
  } catch (error) {
    if (!(error instanceof SnapshotError) || error.code !== "block-unavailable") throw error;
    problems.push(`blockHash: the endpoint returns no usable header for block ${snapshot.blockNumber} (${error.message}), so the recorded hash cannot be confirmed`);
    return { problems, latest, safe };
  }
  if (recorded.hash !== snapshot.blockHash) {
    problems.push(`blockHash: snapshot ${JSON.stringify(snapshot.blockHash)}, chain ${JSON.stringify(recorded.hash)} at block ${snapshot.blockNumber}`);
  }
  return { problems, latest, safe };
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...CHAIN_OPTIONS,
      snapshot: { type: "string" },
      capabilities: { type: "string" },
      offline: { type: "boolean", default: false },
      release: { type: "boolean", default: false },
      "allow-missing-kps": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(
      "usage: verify-snapshot.mjs [--snapshot <file>] (--offline | --rpc <url> [--rpc <url>]) [--release [--allow-missing-kps <a,b>]]\n",
    );
    return 0;
  }
  const path = values.snapshot === undefined ? SNAPSHOT_PATH : resolve(values.snapshot);
  const hasRpc = values.rpc !== undefined || (process.env[RPC_URL_ENV] ?? "") !== "";
  if (!values.offline && !hasRpc) {
    throw new SnapshotError(`choose --offline, or give an RPC endpoint with --rpc <url> or ${RPC_URL_ENV}`, "config");
  }
  const network = loadNetwork(values.network, values.networks ?? NETWORKS_PATH);
  const capabilities = loadCapabilities(values.capabilities ?? CAPABILITIES_PATH);

  const { snapshot, text, keccak256 } = await verifyOffline({ path, network, capabilities });
  process.stdout.write(
    `snapshot ${path}: offline checks pass (block ${snapshot.blockNumber}, ${snapshot.members.length} members, keccak256 ${keccak256})\n`,
  );

  let failed = false;
  if (values.release) {
    const allowMissing = new Set(
      (values["allow-missing-kps"] ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== ""),
    );
    const problems = releaseGateProblems(snapshot, allowMissing);
    const scope = values.offline ? " (document only, the chain was not read)" : "";
    if (problems.length === 0) {
      process.stdout.write(
        `release gate${scope}: pass (${network.name}, every member publishes a KPS address or is named in --allow-missing-kps)\n`,
      );
    } else {
      failed = true;
      process.stdout.write(`release gate${scope}: FAIL\n${problems.map((line) => `  ${line}`).join("\n")}\n`);
    }
    const providers = values.rpc?.length ?? (hasRpc ? 1 : 0);
    if (!values.offline && providers < RELEASE_MIN_PROVIDERS) {
      failed = true;
      process.stdout.write(
        `release gate: FAIL, the chain was read through ${providers} provider(s); a release snapshot needs ${RELEASE_MIN_PROVIDERS} (--rpc <a> --rpc <b>)\n`,
      );
    }
  }
  if (values.offline) return failed ? 1 : 0;

  const { rpcs, scan } = chainAccessFromArgs(values);
  for (const rpc of rpcs) {
    process.stderr.write(`verify-snapshot: re-reading ${network.name} at block ${snapshot.blockNumber} through ${rpc.origin}\n`);
    const result = await verifyAgainstChain({ rpc, snapshot, text, network, capabilities, scan });
    process.stdout.write(`${result.lines.join("\n")}\n`);
    if (!result.ok) failed = true;
  }
  return failed ? 1 : 0;
}

if (isMain(import.meta.url)) runMain("verify-snapshot.mjs", main);
