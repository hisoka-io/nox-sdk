import { keccak256 as ethersKeccak } from "ethers";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkHashFile,
  digestFile,
  formatHashLine,
  keccak256Hex,
  main,
  parseHashLine,
  writeHashFile,
} from "../scripts/hash.mjs";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nox-hash-test-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("keccak256Hex", () => {
  it("is Ethereum Keccak-256, not FIPS-202 SHA3-256", () => {
    const empty = new Uint8Array();
    expect(keccak256Hex(empty)).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    const sha3 = createHash("sha3-256").update(empty).digest("hex");
    expect(sha3).toBe("a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a");
    expect(keccak256Hex(empty)).not.toBe(`0x${sha3}`);
  });

  it("agrees with ethers.keccak256 on arbitrary bytes", () => {
    for (const length of [1, 31, 32, 135, 136, 137, 4096]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 131 + length) & 0xff);
      expect(keccak256Hex(bytes)).toBe(ethersKeccak(bytes));
    }
  });
});

describe("file digests", () => {
  it("streams a file into keccak-256, sha256 and size", async () => {
    const file = join(dir, "bundle.js");
    const bytes = Buffer.alloc(300_000, 0x5a);
    writeFileSync(file, bytes);
    const digest = await digestFile(file);
    expect(digest.bytes).toBe(bytes.length);
    expect(digest.keccak256).toBe(ethersKeccak(bytes));
    expect(digest.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("writes a record that checks out, and catches a changed file", async () => {
    const file = join(dir, "bundle.js");
    writeFileSync(file, "one");
    const digest = await writeHashFile(file);
    expect((await checkHashFile(`${file}.keccak256`)).ok).toBe(true);
    writeFileSync(file, "two");
    const result = await checkHashFile(`${file}.keccak256`);
    expect(result.ok).toBe(false);
    expect(result.expected).toBe(digest.keccak256);
  });

  it("parses only well-formed records naming a sibling file", async () => {
    const line = formatHashLine(`0x${"ab".repeat(32)}`, "a.js");
    expect(parseHashLine(line)).toEqual({ keccak256: `0x${"ab".repeat(32)}`, name: "a.js" });
    expect(() => parseHashLine(`0x${"AB".repeat(32)}  a.js\n`)).toThrow(/malformed keccak256 record/u);
    expect(() => parseHashLine(`${"ab".repeat(32)}  a.js\n`)).toThrow(/malformed keccak256 record/u);
    const record = join(dir, "x.keccak256");
    writeFileSync(record, formatHashLine(`0x${"ab".repeat(32)}`, "../a.js"));
    await expect(checkHashFile(record)).rejects.toThrow(/records name a file in their own directory/u);
  });

  it("exits 1 from --check on a mismatch", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const file = join(dir, "bundle.js");
    writeFileSync(file, "one");
    await writeHashFile(file);
    expect(await main(["--check", `${file}.keccak256`])).toBe(0);
    writeFileSync(file, "changed");
    expect(await main(["--check", `${file}.keccak256`])).toBe(1);
  });
});
