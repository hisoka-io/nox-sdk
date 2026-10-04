#!/usr/bin/env node
// @ts-check
/**
 * Generate the pinned NoxRegistry snapshot the worker bundles
 * (ARCHITECTURE §5.2, task BLD-404).
 *
 * Reads the registry at one block through one or more RPC endpoints given at
 * build time (the worker itself never contacts an RPC endpoint) and writes:
 *   snapshot/nox-snapshot.json            format nox-anon-rpc-snapshot/1 in canonical bytes
 *   snapshot/nox-snapshot.json.keccak256  keccak-256 of those exact bytes
 * With two or more --rpc endpoints every endpoint must return the same state.
 * See scripts/lib/registry.mjs for how membership is read and cross-checked.
 *
 * Usage:
 *   node scripts/make-snapshot.mjs --rpc <url> [--rpc <url>] [--network arbitrum-sepolia]
 *        [--block finalized|safe|latest|<n>] [--out snapshot/nox-snapshot.json]
 *        [--capabilities snapshot/capabilities.json]
 *        [--networks scripts/networks.json] [--allow-unsafe-block]
 *        [--log-chunk-blocks <n>] [--min-log-chunk-blocks <n>]
 *        [--timeout-ms <n>] [--retries <n>] [--batch-size <n>]
 *
 * The release inputs that are not on chain come from committed files, so
 * anyone regenerating at the same block gets the same bytes: powDifficulty
 * from scripts/networks.json, capability hints from snapshot/capabilities.json.
 * The RPC URL can also come from NOX_SNAPSHOT_RPC_URL, which keeps keyed URLs
 * out of shell history. Only endpoint origins are ever printed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { writeHashFile } from "./hash.mjs";
import { isMain, runMain } from "./lib/cli.mjs";
import { CAPABILITIES_PATH, NETWORKS_PATH, SNAPSHOT_PATH } from "./lib/paths.mjs";
import {
  BLOCK_TAGS,
  buildSnapshot,
  collectRegistryState,
  loadCapabilities,
  loadNetwork,
  resolveBlock,
  SCAN_DEFAULTS,
} from "./lib/registry.mjs";
import { createRpcClient, RPC_DEFAULTS } from "./lib/rpc.mjs";
import { canonicalJson, serializeSnapshot, SnapshotError, validateSnapshotDocument } from "./lib/snapshot-format.mjs";

export const DEFAULT_NETWORK = "arbitrum-sepolia";
export const RPC_URL_ENV = "NOX_SNAPSHOT_RPC_URL";

/** Option schema shared by make-snapshot.mjs and verify-snapshot.mjs. */
export const CHAIN_OPTIONS = /** @type {const} */ ({
  rpc: { type: "string", multiple: true },
  network: { type: "string", default: DEFAULT_NETWORK },
  networks: { type: "string" },
  "log-chunk-blocks": { type: "string" },
  "min-log-chunk-blocks": { type: "string" },
  "timeout-ms": { type: "string" },
  retries: { type: "string" },
  "batch-size": { type: "string" },
});

/**
 * @typedef {object} ChainArgs
 * @property {string[] | undefined} [rpc]
 * @property {string | undefined} [log-chunk-blocks]
 * @property {string | undefined} [min-log-chunk-blocks]
 * @property {string | undefined} [timeout-ms]
 * @property {string | undefined} [retries]
 * @property {string | undefined} [batch-size]
 */

/**
 * RPC clients and scan tunables from parsed CHAIN_OPTIONS.
 * @param {ChainArgs} values
 * @returns {{ rpcs: import("./lib/rpc.mjs").RpcClient[], scan: { logChunkBlocks: number, minLogChunkBlocks: number } }}
 */
export function chainAccessFromArgs(values) {
  const fromEnv = process.env[RPC_URL_ENV];
  const urls = values.rpc ?? (fromEnv === undefined || fromEnv === "" ? [] : [fromEnv]);
  if (urls.length === 0) {
    throw new SnapshotError(`an RPC endpoint is required: pass --rpc <url> or set ${RPC_URL_ENV}`, "config");
  }
  const rpcs = urls.map((url) =>
    createRpcClient({
      url,
      timeoutMs: integerArg(values["timeout-ms"], "timeout-ms", RPC_DEFAULTS.timeoutMs),
      retries: integerArg(values.retries, "retries", RPC_DEFAULTS.retries),
      batchSize: integerArg(values["batch-size"], "batch-size", RPC_DEFAULTS.batchSize),
    }),
  );
  return {
    rpcs,
    scan: {
      logChunkBlocks: integerArg(values["log-chunk-blocks"], "log-chunk-blocks", SCAN_DEFAULTS.logChunkBlocks),
      minLogChunkBlocks: integerArg(values["min-log-chunk-blocks"], "min-log-chunk-blocks", SCAN_DEFAULTS.minLogChunkBlocks),
    },
  };
}

/**
 * @param {string | undefined} raw
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
export function integerArg(raw, name, fallback) {
  if (raw === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new SnapshotError(`--${name} must be a non-negative integer, got ${raw}`, "config");
  }
  return Number(raw);
}

/**
 * @param {string | undefined} raw
 * @returns {number | "finalized" | "safe" | "latest"}
 */
function blockArg(raw) {
  if (raw === undefined) return "finalized";
  if (/^(?:0|[1-9][0-9]*)$/u.test(raw)) return Number(raw);
  const tag = BLOCK_TAGS.find((candidate) => candidate === raw);
  if (tag === undefined) {
    throw new SnapshotError(`--block must be a block number or one of ${BLOCK_TAGS.join(", ")}, got "${raw}"`, "config");
  }
  return /** @type {"finalized" | "safe" | "latest"} */ (tag);
}

/**
 * Read the registry through every endpoint at one block and require them to agree.
 * @param {{ rpcs: import("./lib/rpc.mjs").RpcClient[], network: import("./lib/registry.mjs").NetworkConfig,
 *           block: number | "finalized" | "safe" | "latest", requireSafe: boolean,
 *           scan: { logChunkBlocks: number, minLogChunkBlocks: number } }} options
 * @returns {Promise<import("./lib/registry.mjs").RegistryState>}
 */
export async function collectAgreed(options) {
  const [first, ...others] = options.rpcs;
  if (first === undefined) throw new SnapshotError("an RPC endpoint is required", "config");
  // Tags resolve once, on the first endpoint; every endpoint then reads that number.
  const blockNumber = typeof options.block === "number" ? options.block : (await resolveBlock(first, options.block)).number;
  const states = [];
  for (const rpc of [first, ...others]) {
    process.stderr.write(`snapshot: reading ${options.network.name} registry ${options.network.registry} at block ${blockNumber} through ${rpc.origin}\n`);
    states.push(
      await collectRegistryState({
        rpc,
        network: options.network,
        block: blockNumber,
        requireSafe: options.requireSafe,
        logChunkBlocks: options.scan.logChunkBlocks,
        minLogChunkBlocks: options.scan.minLogChunkBlocks,
      }),
    );
  }
  const reference = canonicalJson(states[0]);
  states.forEach((state, index) => {
    if (canonicalJson(state) !== reference) {
      throw new SnapshotError(
        `${options.rpcs[index]?.origin} and ${first.origin} return different registry state at block ${blockNumber}; ` +
          "do not release from disagreeing providers",
        "providers-disagree",
      );
    }
  });
  return /** @type {import("./lib/registry.mjs").RegistryState} */ (states[0]);
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
      block: { type: "string" },
      out: { type: "string" },
      capabilities: { type: "string" },
      "allow-unsafe-block": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(
      "usage: make-snapshot.mjs --rpc <url> [--rpc <url>] [--network arbitrum-sepolia] [--block finalized|safe|latest|<n>]\n" +
        "                         [--out <file>] [--capabilities <file>] [--networks <file>]\n",
    );
    return 0;
  }
  const { rpcs, scan } = chainAccessFromArgs(values);
  const network = loadNetwork(values.network, values.networks ?? NETWORKS_PATH);
  const capabilities = loadCapabilities(values.capabilities ?? CAPABILITIES_PATH);

  const state = await collectAgreed({
    rpcs,
    network,
    block: blockArg(values.block),
    requireSafe: !values["allow-unsafe-block"],
    scan,
  });
  const snapshot = validateSnapshotDocument(buildSnapshot(state, { powDifficulty: network.pow_difficulty, capabilities }));

  const outPath = values.out === undefined ? SNAPSHOT_PATH : resolve(values.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, serializeSnapshot(snapshot));
  const digest = await writeHashFile(outPath);

  const withoutKps = snapshot.members.filter((member) => state.kps[member.address]?.endpoint == null);
  /** @type {string[]} */
  const lines = [
    `snapshot: ${outPath}`,
    `  block        ${snapshot.blockNumber} (${snapshot.blockHash})`,
    `  members      ${snapshot.members.length} (${state.eligible.length} eligible for routing, ` +
      `${snapshot.members.length - withoutKps.length} with a KPS endpoint)`,
    `  fingerprint  0x${snapshot.fingerprint}`,
    `  scan         ${state.scan.registrationEvents} registration events from block ${state.scan.fromBlock}, ${state.scan.candidates} candidates`,
    `  providers    ${rpcs.map((rpc) => rpc.origin).join(", ")}${rpcs.length > 1 ? " (all agree)" : ""}`,
    `  keccak256    ${digest.keccak256}`,
  ];
  for (const member of withoutKps) {
    const reason = state.kps[member.address]?.reason;
    lines.push(`  no KPS endpoint: ${member.address}${reason === null || reason === undefined ? "" : ` (metadataUrl starts with "kps:" but ${reason})`}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

if (isMain(import.meta.url)) runMain("make-snapshot.mjs", main);
