import { beforeAll, describe, expect, it } from "vitest";
import { loadArtifact, type Artifact } from "./artifacts.ts";
import { bytesToHex, CodeError, executableEnd, fillImmutables, hexToBytes, stateChangingOpcodes } from "./evm.ts";

const TRAILER = "a1000002";

let immutable: Artifact;
let reference: Artifact;

beforeAll(async () => {
  immutable = await loadArtifact("immutable");
  reference = await loadArtifact("reference");
});

describe("stateChangingOpcodes", () => {
  it("finds instructions and skips PUSH immediates and metadata (same cases as test/RuntimeCode.t.sol)", () => {
    expect(stateChangingOpcodes(hexToBytes(`600160005500fe${TRAILER}`))).toEqual(["SSTORE"]);
    expect(stateChangingOpcodes(hexToBytes(`555da0a1a2a3a4f0f1f2f4f5ff${TRAILER}`))).toHaveLength(13);
    expect(stateChangingOpcodes(hexToBytes(`605561f1ff7f${"55".repeat(32)}00${TRAILER}`))).toEqual([]);
    expect(stateChangingOpcodes(hexToBytes("00a25555ff0004"))).toEqual([]);
    expect(() => stateChangingOpcodes(hexToBytes("005500"))).toThrow(CodeError);
  });

  it("finds nothing in the ImmutableWorkerSpecifier runtime code, and the setters in the reference", () => {
    expect(stateChangingOpcodes(hexToBytes(immutable.deployedBytecode))).toEqual([]);
    expect(stateChangingOpcodes(hexToBytes(reference.deployedBytecode))).toEqual(
      expect.arrayContaining(["SSTORE", "LOG1", "LOG3"]),
    );
  });
});

describe("fillImmutables", () => {
  it("writes the worker hash into every immutable slot of the runtime code", () => {
    expect(immutable.immutableRanges.length).toBeGreaterThan(0);
    const hash = hexToBytes(`0x${"5a".repeat(32)}`);
    const filled = fillImmutables(hexToBytes(immutable.deployedBytecode), immutable.immutableRanges, hash);
    for (const { start, length } of immutable.immutableRanges) {
      expect(bytesToHex(filled.slice(start, start + length))).toBe(`0x${"5a".repeat(32)}`);
    }
    expect(executableEnd(filled)).toBe(executableEnd(hexToBytes(immutable.deployedBytecode)));
  });

  it("rejects values that do not fit the slot", () => {
    expect(() =>
      fillImmutables(hexToBytes(immutable.deployedBytecode), immutable.immutableRanges, new Uint8Array(31)),
    ).toThrow(CodeError);
  });

  it("has nothing to fill in the reference contract", () => {
    expect(reference.immutableRanges).toEqual([]);
  });
});

describe("hex helpers", () => {
  it("round-trips and rejects odd or non-hex input", () => {
    expect(bytesToHex(hexToBytes("0x00ff10"))).toBe("0x00ff10");
    expect(() => hexToBytes("0x0")).toThrow(CodeError);
    expect(() => hexToBytes("0xzz")).toThrow(CodeError);
  });
});
