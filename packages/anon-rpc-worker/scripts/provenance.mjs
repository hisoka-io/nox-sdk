#!/usr/bin/env node
// @ts-check
/**
 * Provenance of a worker build (ARCHITECTURE §7.3), written next to the
 * bundle and outside the hashed bytes:
 *
 *   dist/anon-rpc-worker.provenance.json
 *   { package, version, gitCommit, gitTreeClean,
 *     toolchain: { rustc, wasmPack, wasmBindgen, wasmOpt, clang, wasmPinsChecked, node, pnpm, esbuild, pins },
 *     inputs: { snapshotKeccak, snapshotBlock, bootstrapKeccak, wasmSha256, wasmKeccak,
 *               tlsWasmSha256, tlsWasmKeccak, lockfileSha256 },
 *     tls: { webpkiRoots, webpkiRootsReleased, extraRoots },
 *     output: { bytes, sha256, keccak256 },
 *     builder: { os, arch } }
 *
 * The file is canonical JSON with no timestamps, so two builds of one commit
 * on one platform give identical provenance bytes as well. Sources:
 * dist/build-record.json (scripts/build.mjs), the WASM toolchain record of
 * scripts/build-wasm.sh (.build/wasm-toolchain.json), scripts/toolchain.env,
 * the pinned snapshot, the pnpm lockfile, Cargo.lock and the nox-tls
 * manifest (the compiled-in Mozilla root store and its release date), and git.
 * `tls.extraRoots` counts test-bed roots embedded next to the Mozilla ones; a
 * release has 0. Every digest is recomputed
 * from the files on disk and must agree with the records.
 *
 * Usage:
 *   node scripts/provenance.mjs [--dist dist] [--wasm-record .build/wasm-toolchain.json]
 *                               [--source-commit <sha>] [--release]
 * --source-commit names the commit when the tree is an export without .git
 * (the container builds of scripts/verify-reproducible.sh). --release
 * (scripts/build-worker.sh --release) refuses a bundle with extra roots.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BUILD_RECORD_NAME } from "./build.mjs";
import { keccak256Hex, sha256Hex } from "./hash.mjs";
import { errorMessage, isMain, runMain } from "./lib/cli.mjs";
import { PACKAGE_DIR, REPO_DIR, TOOLCHAIN_PATH } from "./lib/paths.mjs";
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
  const checkout = gitCheckoutState(repoDir);
  if (sourceCommit !== undefined) {
    if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
      throw new ProvenanceError(`--source-commit must be a full 40-character lowercase commit id, got ${sourceCommit}`, "usage");
    }
    // --source-commit names the commit of a tree without .git (a git archive
    // export, clean by construction). Inside a checkout git itself is the
    // record, so the flag must agree with it.
    if (checkout !== null) {
      if (checkout.gitCommit !== sourceCommit || !checkout.gitTreeClean) {
        throw new ProvenanceError(
          `--source-commit ${sourceCommit} is for exported trees; this is a git checkout at ${checkout.gitCommit}` +
            `${checkout.gitTreeClean ? "" : " with uncommitted changes"}. Drop the flag, or commit and pass HEAD`,
          "inconsistent",
        );
      }
      return checkout;
    }
    return { gitCommit: sourceCommit, gitTreeClean: true };
  }
  return checkout ?? { gitCommit: null, gitTreeClean: null };
}

/**
 * HEAD and cleanliness when `repoDir` is the top level of a git checkout,
 * else `null` (an export, or a directory inside some other repository).
 * @param {string} repoDir
 * @returns {{ gitCommit: string, gitTreeClean: boolean } | null}
 */
function gitCheckoutState(repoDir) {
  /** @param {string[]} args */
  const git = (args) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    if (realpathSync(git(["rev-parse", "--show-toplevel"]).trim()) !== realpathSync(repoDir)) return null;
    return { gitCommit: git(["rev-parse", "HEAD"]).trim(), gitTreeClean: git(["status", "--porcelain"]).trim() === "" };
  } catch {
    return null;
  }
}

/**
 * The Mozilla root store nox-tls compiles in: the webpki-roots version
 * Cargo.lock resolves, and the release date packages/nox-tls/Cargo.toml
 * records for that version (`[package.metadata.webpki-roots]`). A lock that
 * moved to another version without the manifest following is an error.
 * @param {string} repoDir
 * @returns {{ webpkiRoots: string, webpkiRootsReleased: string }}
 */
export function webpkiRoots(repoDir) {
  const lock = readFileSync(join(repoDir, "Cargo.lock"), "utf8");
  const locked = [...lock.matchAll(/\[\[package\]\]\nname = "webpki-roots"\nversion = "([^"]+)"/gu)].map((match) => match[1]);
  const manifest = readFileSync(join(repoDir, "packages", "nox-tls", "Cargo.toml"), "utf8");
  const section = /\[package\.metadata\.webpki-roots\]\nversion = "([^"]+)"\nreleased = "(\d{4}-\d{2}-\d{2})"/u.exec(manifest);
  if (section === null || section[1] === undefined || section[2] === undefined) {
    throw new ProvenanceError("packages/nox-tls/Cargo.toml has no [package.metadata.webpki-roots] version and released date", "missing-input");
  }
  if (locked.length !== 1 || locked[0] !== section[1]) {
    throw new ProvenanceError(
      `Cargo.lock resolves webpki-roots ${locked.join(", ") || "nowhere"} but packages/nox-tls/Cargo.toml records ${section[1]}; ` +
        "update [package.metadata.webpki-roots] with the new version and its release date",
      "inconsistent",
    );
  }
  return { webpkiRoots: section[1], webpkiRootsReleased: section[2] };
}

/**
 * Build the provenance document.
 * @param {{ distDir: string, wasmRecordPath: string, sourceCommit?: string | undefined, release?: boolean,
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
    const recordedTls = record["tls"];
    if (isRecord(recordedTls) && wasmToolchain["tlsWasmSha256"] !== recordedTls["sha256"]) {
      throw new ProvenanceError(
        `the embedded nox-tls module (sha256 ${String(recordedTls["sha256"])}) is not the one ${options.wasmRecordPath} describes ` +
          `(${String(wasmToolchain["tlsWasmSha256"])}); run scripts/build-wasm.sh and scripts/build.mjs again`,
        "inconsistent",
      );
    }
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

  // The snapshot the build embedded (build record), checked against the file.
  const recordedSnapshot = objectField(record, "snapshot", "build record");
  const snapshotPath = options.snapshotPath ?? join(packageDir, String(recordedSnapshot["path"]));
  const snapshotBytes = readFileSync(snapshotPath);
  if (keccak256Hex(snapshotBytes) !== recordedSnapshot["keccak256"]) {
    throw new ProvenanceError(
      `${snapshotPath} (keccak256 ${keccak256Hex(snapshotBytes)}) is not the snapshot the bundle embeds (${String(recordedSnapshot["keccak256"])}); rebuild`,
      "inconsistent",
    );
  }
  /** @type {unknown} */
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  const snapshotBlock = isRecord(snapshot) && typeof snapshot["blockNumber"] === "number" ? snapshot["blockNumber"] : null;

  // The bootstrap the build embedded, when it embedded one, checked against the file.
  const recordedBootstrap = record["bootstrap"];
  let bootstrapKeccak = null;
  if (isRecord(recordedBootstrap)) {
    const bootstrapPath = join(packageDir, String(recordedBootstrap["path"]));
    const bootstrapBytes = readFileSync(bootstrapPath);
    bootstrapKeccak = keccak256Hex(bootstrapBytes);
    if (bootstrapKeccak !== recordedBootstrap["keccak256"]) {
      throw new ProvenanceError(
        `${bootstrapPath} (keccak256 ${bootstrapKeccak}) is not the bootstrap the bundle embeds (${String(recordedBootstrap["keccak256"])}); rebuild`,
        "inconsistent",
      );
    }
  }

  const toolchainText = readFileSync(options.toolchainPath ?? TOOLCHAIN_PATH, "utf8");
  const tls = isRecord(record["tls"]) ? record["tls"] : null;
  const extraRoots = typeof record["extraRoots"] === "number" ? record["extraRoots"] : 0;
  if (options.release === true && extraRoots !== 0) {
    throw new ProvenanceError(
      `the bundle trusts ${extraRoots} extra root(s) next to the Mozilla ones (build.mjs --extra-root); a release build embeds none`,
      "inconsistent",
    );
  }

  return {
    package: manifest["name"],
    version: manifest["version"],
    ...gitState(repoDir, options.sourceCommit),
    toolchain: {
      rustc: wasmTool("rustc"),
      wasmPack: wasmTool("wasmPack"),
      wasmBindgen: wasmTool("wasmBindgen"),
      wasmOpt: wasmTool("wasmOpt"),
      clang: wasmTool("clang"),
      wasmPinsChecked: wasmToolchain === null ? null : wasmToolchain["pinsChecked"] === true,
      node: process.version,
      pnpm,
      esbuild: esbuild["version"],
      pins: parseToolchainEnv(toolchainText),
    },
    inputs: {
      snapshotKeccak: keccak256Hex(snapshotBytes),
      snapshotBlock,
      bootstrapKeccak,
      wasmSha256: wasm["sha256"],
      wasmKeccak: wasm["keccak256"],
      tlsWasmSha256: tls === null ? null : tls["sha256"],
      tlsWasmKeccak: tls === null ? null : tls["keccak256"],
      lockfileSha256: sha256Hex(readFileSync(join(repoDir, "pnpm-lock.yaml"))),
    },
    tls: tls === null
      ? null
      : { ...webpkiRoots(repoDir), extraRoots },
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
      release: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write("usage: provenance.mjs [--dist dist] [--wasm-record <file>] [--source-commit <sha>] [--release]\n");
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
      release: values.release,
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
