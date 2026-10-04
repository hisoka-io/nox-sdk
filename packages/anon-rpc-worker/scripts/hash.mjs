#!/usr/bin/env node
// @ts-check
/**
 * keccak-256 of exact file bytes: the value an anon-rpc specifier pins as
 * `workerHash()` (anon-rpc SPEC §4).
 *
 * This is Ethereum Keccak-256 (original Keccak padding), the function behind
 * Solidity's `keccak256` and `@noble/hashes` `keccak_256`, which the reference
 * browser harness uses to admit a bundle. It is NOT FIPS-202 SHA3-256: the two
 * differ in one padding byte and give unrelated digests.
 *
 * Usage:
 *   node scripts/hash.mjs <file>...            print "0x<keccak256>  <file>" per file
 *   node scripts/hash.mjs --json <file>...     print keccak256, sha256 and size as JSON
 *   node scripts/hash.mjs --write <file>...    also write "<file>.keccak256" next to each file
 *   node scripts/hash.mjs --check <file>.keccak256...
 *                                              recompute and compare; exit 1 on any mismatch
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { errorMessage, isMain, runMain } from "./lib/cli.mjs";

/** Suffix of the file that records a file's keccak-256. */
export const KECCAK_FILE_SUFFIX = ".keccak256";

/**
 * @typedef {object} FileDigest
 * @property {string} file       path as given
 * @property {number} bytes      exact byte length
 * @property {string} keccak256  0x-prefixed lowercase hex, Ethereum Keccak-256
 * @property {string} sha256     lowercase hex, informational build fingerprint
 */

/**
 * keccak-256 of bytes as 0x-prefixed lowercase hex.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function keccak256Hex(bytes) {
  return `0x${Buffer.from(keccak_256(bytes)).toString("hex")}`;
}

/**
 * SHA-256 of bytes as lowercase hex (no prefix).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Stream a file once and return both digests and its size.
 * @param {string} file
 * @returns {Promise<FileDigest>}
 */
export async function digestFile(file) {
  const keccak = keccak_256.create();
  const sha = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream(file);
  try {
    for await (const chunk of stream) {
      const view = /** @type {Buffer} */ (chunk);
      keccak.update(view);
      sha.update(view);
      bytes += view.byteLength;
    }
  } catch (error) {
    throw new HashError(`cannot read ${file}: ${errorMessage(error)}`, "read-failed");
  }
  return {
    file,
    bytes,
    keccak256: `0x${Buffer.from(keccak.digest()).toString("hex")}`,
    sha256: sha.digest("hex"),
  };
}

/**
 * The line stored in a `.keccak256` file and printed by the CLI.
 * @param {string} keccak256 0x-prefixed hex digest
 * @param {string} name      file name the digest belongs to
 * @returns {string}
 */
export function formatHashLine(keccak256, name) {
  return `${keccak256}  ${name}\n`;
}

/**
 * Parse one `.keccak256` line back into its digest and file name.
 * @param {string} text
 * @returns {{ keccak256: string, name: string }}
 */
export function parseHashLine(text) {
  const match = /^(0x[0-9a-f]{64}) {2}(\S(?:.*\S)?)\n?$/u.exec(text);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new HashError(
      `malformed keccak256 record (expected "0x<64 lowercase hex>  <file name>"): ${JSON.stringify(text.slice(0, 120))}`,
      "malformed-record",
    );
  }
  return { keccak256: match[1], name: match[2] };
}

/**
 * Write `<file>.keccak256` for a file and return its digest.
 * @param {string} file
 * @returns {Promise<FileDigest>}
 */
export async function writeHashFile(file) {
  const digest = await digestFile(file);
  writeFileSync(`${file}${KECCAK_FILE_SUFFIX}`, formatHashLine(digest.keccak256, basename(file)));
  return digest;
}

/**
 * Check a `.keccak256` record against the file it names (resolved next to it).
 * @param {string} recordPath
 * @returns {Promise<{ ok: boolean, expected: string, actual: FileDigest }>}
 */
export async function checkHashFile(recordPath) {
  let text;
  try {
    text = readFileSync(recordPath, "utf8");
  } catch (error) {
    throw new HashError(`cannot read ${recordPath}: ${errorMessage(error)}`, "read-failed");
  }
  const record = parseHashLine(text);
  if (record.name.includes("/") || record.name.includes("\\")) {
    throw new HashError(
      `keccak256 record ${recordPath} names "${record.name}"; records name a file in their own directory`,
      "malformed-record",
    );
  }
  const actual = await digestFile(join(dirname(recordPath), record.name));
  return { ok: actual.keccak256 === record.keccak256, expected: record.keccak256, actual };
}

/** Typed failure of the hash tool. */
export class HashError extends Error {
  /**
   * @param {string} message
   * @param {"read-failed" | "malformed-record" | "usage"} code
   */
  constructor(message, code) {
    super(message);
    this.name = "HashError";
    this.code = code;
  }
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      write: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(
      "usage: hash.mjs [--json] [--write] <file>...\n       hash.mjs --check <file>.keccak256...\n",
    );
    return values.help ? 0 : 2;
  }
  if (values.check) {
    let failures = 0;
    for (const record of positionals) {
      const result = await checkHashFile(record);
      if (result.ok) {
        process.stdout.write(`OK        ${result.actual.keccak256}  ${result.actual.file}\n`);
      } else {
        failures += 1;
        process.stdout.write(
          `MISMATCH  ${result.actual.file}: recorded ${result.expected}, computed ${result.actual.keccak256}\n`,
        );
      }
    }
    return failures === 0 ? 0 : 1;
  }
  /** @type {FileDigest[]} */
  const digests = [];
  for (const file of positionals) {
    digests.push(values.write ? await writeHashFile(file) : await digestFile(file));
  }
  if (values.json) {
    process.stdout.write(`${JSON.stringify(digests, null, 2)}\n`);
  } else {
    for (const digest of digests) process.stdout.write(formatHashLine(digest.keccak256, digest.file));
  }
  return 0;
}

if (isMain(import.meta.url)) runMain("hash.mjs", main);
