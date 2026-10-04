#!/usr/bin/env node
// @ts-check
/**
 * Provenance of a worker build (ARCHITECTURE §7.3), written next to the
 * bundle and outside the hashed bytes:
 *
 *   dist/anon-rpc-worker.provenance.json
 *   { package, version, gitCommit, gitTreeClean,
 *     toolchain: { rustc, wasmPack, wasmBindgen, wasmOpt, wasmPinsChecked, node, pnpm, esbuild, pins },
 *     inputs: { snapshotKeccak, snapshotBlock, wasmSha256, wasmKeccak, lockfileSha256 },
 *     output: { bytes, sha256, keccak256 },
 *     builder: { os, arch } }
 *
 * The file is canonical JSON with no timestamps, so two builds of one commit
 * on one platform give identical provenance bytes as well. Sources:
 * dist/build-record.json (scripts/build.mjs), the WASM toolchain record of
 * scripts/build-wasm.sh (.build/wasm-toolchain.json), scripts/toolchain.env,
 * the pinned snapshot, the pnpm lockfile and git. Every digest is recomputed
 * from the files on disk and must agree with the records.
 *
 * Usage:
 *   node scripts/provenance.mjs [--dist dist] [--wasm-record .build/wasm-toolchain.json]
 *                               [--source-commit <sha>]
 * --source-commit names the commit when the tree is an export without .git
 * (the container builds of scripts/verify-reproducible.sh).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BUILD_RECORD_NAME } from "./build.mjs";
import { keccak256Hex, sha256Hex } from "./hash.mjs";
import { errorMessage, isMain, runMain } from "./lib/cli.mjs";
import { PACKAGE_DIR, REPO_DIR, SNAPSHOT_PATH, TOOLCHAIN_PATH } from "./lib/paths.mjs";
import { canonicalJson, isRecord } from "./lib/snapshot-format.mjs";

export const PROVENANCE_NAME = "anon-rpc-worker.provenance.json";
export const DEFAULT_WASM_RECORD = ".build/wasm-toolchain.json";

/** Typed provenance failure. */
export class ProvenanceError extends Error {
  /**
   * @param {string} message
   * @param {"missing-input" | "inconsistent" | "usage"} code
   */
  constructor(message, code) {
    super(message);
    this.name = "ProvenanceError";
    this.code = code;
  }
}

/**
 * KEY=VALUE pairs of scripts/toolchain.env (comments and blank lines skipped).
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseToolchainEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const match = /^([A-Z][A-Z0-9_]*)=([^\s"'$`]+)$/u.exec(trimmed);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new ProvenanceError(`toolchain.env line ${index + 1} is not a plain KEY=VALUE pair: ${JSON.stringify(trimmed)}`, "usage");
    }
    out[match[1]] = match[2];
  });
  return out;
}

/**
 * @param {string} path
 * @param {string} what
 * @returns {Record<string, unknown>}
 */
function readJsonObject(path, what) {
  if (!existsSync(path)) throw new ProvenanceError(`${what} not found at ${path}`, "missing-input");
  /** @type {unknown} */
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) throw new ProvenanceError(`${what} at ${path} is not a JSON object`, "missing-input");
  return value;
}

/**
 * @param {Record<string, unknown>} object
 * @param {string} key
 * @param {string} what
 * @returns {Record<string, unknown>}
 */
function objectField(object, key, what) {
  const value = object[key];
  if (!isRecord(value)) throw new ProvenanceError(`${what}: "${key}" is missing or not an object`, "missing-input");
  return value;
}

/**
 * Commit and cleanliness of the source tree, or nulls outside a git checkout.
 * @param {string} repoDir
 * @param {string | undefined} sourceCommit
 * @returns {{ gitCommit: string | null, gitTreeClean: boolean | null }}
 */
export function gitState(repoDir, sourceCommit) {
  if (sourceCommit !== undefined) {
    if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
      throw new ProvenanceError(`--source-commit must be a full 40-character lowercase commit id, got ${sourceCommit}`, "usage");
    }
    // An export of one commit (git archive) is clean by construction.
    return { gitCommit: sourceCommit, gitTreeClean: true };
  }
  try {
    const gitCommit = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const status = execFileSync("git", ["-C", repoDir, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { gitCommit, gitTreeClean: status.trim() === "" };
  } catch {
    return { gitCommit: null, gitTreeClean: null };
  }
}

/**
 * Build the provenance document.
 * @param {{ distDir: string, wasmRecordPath: string, sourceCommit?: string | undefined,
 *           packageDir?: string, repoDir?: string, snapshotPath?: string, toolchainPath?: string }} options
 * @returns {Record<string, unknown>}
 */
export function makeProvenance(options) {
  const packageDir = options.packageDir ?? PACKAGE_DIR;
  const repoDir = options.repoDir ?? REPO_DIR;
  const record = readJsonObject(join(options.distDir, BUILD_RECORD_NAME), "build record (run scripts/build.mjs first)");
  const artifact = objectField(record, "artifact", "build record");
  const wasm = objectField(record, "wasm", "build record");
  const esbuild = objectField(record, "esbuild", "build record");

  const bundlePath = join(packageDir, String(artifact["path"]));
  if (!existsSync(bundlePath)) throw new ProvenanceError(`bundle ${bundlePath} named by the build record is missing`, "missing-input");
  const bundle = readFileSync(bundlePath);
  const output = { bytes: bundle.byteLength, sha256: sha256Hex(bundle), keccak256: keccak256Hex(bundle) };
  if (output.keccak256 !== artifact["keccak256"] || output.bytes !== artifact["bytes"]) {
    throw new ProvenanceError(
      `${bundlePath} (keccak256 ${output.keccak256}) is not the bundle the build record describes (${String(artifact["keccak256"])}); rebuild`,
      "inconsistent",
    );
  }

  /** @type {Record<string, unknown> | null} */
  let wasmToolchain = null;
  if (existsSync(options.wasmRecordPath)) {
    wasmToolchain = readJsonObject(options.wasmRecordPath, "WASM toolchain record");
    if (wasmToolchain["wasmSha256"] !== wasm["sha256"]) {
      throw new ProvenanceError(
        `the embedded nox-wasm module (sha256 ${String(wasm["sha256"])}) is not the one ${options.wasmRecordPath} describes ` +
          `(${String(wasmToolchain["wasmSha256"])}); run scripts/build-wasm.sh and scripts/build.mjs again`,
        "inconsistent",
      );
    }
  }
  /**
   * @param {string} key
   * @returns {string | null}
   */
  const wasmTool = (key) => (wasmToolchain !== null && typeof wasmToolchain[key] === "string" ? wasmToolchain[key] : null);

  const rootManifest = readJsonObject(join(repoDir, "package.json"), "repository package.json");
  const packageManager = typeof rootManifest["packageManager"] === "string" ? rootManifest["packageManager"] : "";
  const pnpm = /^pnpm@(.+)$/u.exec(packageManager)?.[1] ?? null;
  const manifest = readJsonObject(join(packageDir, "package.json"), "package.json");

  const snapshotPath = options.snapshotPath ?? SNAPSHOT_PATH;
  const snapshotBytes = readFileSync(snapshotPath);
  /** @type {unknown} */
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  const snapshotBlock = isRecord(snapshot) && typeof snapshot["blockNumber"] === "number" ? snapshot["blockNumber"] : null;

  const toolchainText = readFileSync(options.toolchainPath ?? TOOLCHAIN_PATH, "utf8");

  return {
    package: manifest["name"],
    version: manifest["version"],
    ...gitState(repoDir, options.sourceCommit),
    toolchain: {
      rustc: wasmTool("rustc"),
      wasmPack: wasmTool("wasmPack"),
      wasmBindgen: wasmTool("wasmBindgen"),
      wasmOpt: wasmTool("wasmOpt"),
      wasmPinsChecked: wasmToolchain === null ? null : wasmToolchain["pinsChecked"] === true,
      node: process.version,
      pnpm,
      esbuild: esbuild["version"],
      pins: parseToolchainEnv(toolchainText),
    },
    inputs: {
      snapshotKeccak: keccak256Hex(snapshotBytes),
      snapshotBlock,
      wasmSha256: wasm["sha256"],
      wasmKeccak: wasm["keccak256"],
      lockfileSha256: sha256Hex(readFileSync(join(repoDir, "pnpm-lock.yaml"))),
    },
    output,
    builder: { os: process.platform, arch: process.arch },
  };
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dist: { type: "string", default: "dist" },
      "wasm-record": { type: "string", default: DEFAULT_WASM_RECORD },
      "source-commit": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write("usage: provenance.mjs [--dist dist] [--wasm-record <file>] [--source-commit <sha>]\n");
    return 0;
  }
  const distDir = resolve(PACKAGE_DIR, values.dist);
  /** @type {Record<string, unknown>} */
  let provenance;
  try {
    provenance = makeProvenance({
      distDir,
      wasmRecordPath: resolve(PACKAGE_DIR, values["wasm-record"]),
      sourceCommit: values["source-commit"],
    });
  } catch (error) {
    if (error instanceof ProvenanceError) throw error;
    throw new ProvenanceError(`cannot assemble provenance: ${errorMessage(error)}`, "missing-input");
  }
  const outPath = join(distDir, PROVENANCE_NAME);
  writeFileSync(outPath, canonicalJson(provenance));
  const output = /** @type {{ keccak256: string }} */ (provenance["output"]);
  process.stdout.write(`provenance: ${outPath}\n  worker keccak256 ${output.keccak256}\n  commit ${String(provenance["gitCommit"])} (clean: ${String(provenance["gitTreeClean"])})\n`);
  return 0;
}

if (isMain(import.meta.url)) runMain("provenance.mjs", main);
