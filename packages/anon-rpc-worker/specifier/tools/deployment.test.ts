import { spawn } from "node:child_process";
import { getAddress } from "ethers";
import { describe, expect, it } from "vitest";
import { SAMPLE_HASH } from "../itest/sample.ts";
import { loadArtifact } from "./artifacts.ts";
import {
  constructorArguments,
  creationCode,
  decodeAddressWord,
  normalizeHash,
  PayloadError,
  setWorkerCalldata,
  transferOwnershipCalldata,
} from "./deployment.ts";

function cast(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("cast", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
    child.once("error", reject);
    // "close", not "exit": stdout may still hold data when the process exits.
    child.once("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`cast ${args[0]}: ${err}`))));
  });
}

// Entries without commas, quotes or brackets, which cast's array argument syntax cannot carry.
const PLAIN = ["https://cdn.jsdelivr.net/npm/x@1.0.0/w.js", "kps:203.0.113.10:15005:uEiB/keccak/ab/cd"];

describe("ABI payloads match Foundry's encoder", () => {
  it("constructor arguments", async () => {
    const expected = await cast(["abi-encode", "constructor(bytes32,string[])", SAMPLE_HASH, `[${PLAIN.join(",")}]`]);
    expect(constructorArguments(SAMPLE_HASH, PLAIN)).toBe(expected);
  });

  it("setWorker and transferOwnership calldata", async () => {
    expect(setWorkerCalldata(SAMPLE_HASH, PLAIN)).toBe(
      await cast(["calldata", "setWorker(bytes32,string[])", SAMPLE_HASH, `[${PLAIN.join(",")}]`]),
    );
    const owner = "0x000000000000000000000000000000000000bEEF";
    expect(transferOwnershipCalldata(owner)).toBe(await cast(["calldata", "transferOwnership(address)", owner]));
  });

  it("creation code is the artifact bytecode followed by the constructor arguments", async () => {
    const artifact = await loadArtifact("immutable");
    const code = creationCode(artifact, SAMPLE_HASH, PLAIN);
    expect(code.startsWith(artifact.bytecode)).toBe(true);
    expect(`0x${code.slice(artifact.bytecode.length)}`).toBe(constructorArguments(SAMPLE_HASH, PLAIN));
  });
});

describe("input normalisation", () => {
  it("accepts 32-byte hex hashes, lowercased, and rejects zero or malformed ones", () => {
    expect(normalizeHash(SAMPLE_HASH.toUpperCase().replace("0X", "0x"))).toBe(SAMPLE_HASH);
    expect(() => normalizeHash(`0x${"00".repeat(32)}`)).toThrow(PayloadError);
    expect(() => normalizeHash("0x1234")).toThrow(PayloadError);
    expect(() => normalizeHash(SAMPLE_HASH.slice(2))).toThrow(PayloadError);
  });

  it("decodes an address word and rejects anything else", () => {
    expect(decodeAddressWord(`0x${"00".repeat(12)}${"be".repeat(20)}`)).toBe(getAddress(`0x${"be".repeat(20)}`));
    expect(() => decodeAddressWord(`0x${"01".repeat(32)}`)).toThrow(PayloadError);
    expect(() => decodeAddressWord("0x")).toThrow(PayloadError);
  });
});
