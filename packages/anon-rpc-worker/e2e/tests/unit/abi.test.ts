import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  decodeBytes32,
  decodeStringArray,
  encodeSetWorker,
  encodeWorkerArgs,
  hexToBytes,
  keccakHex,
  selector,
} from "../../src/abi.js";
import { TestbedError } from "../../src/errors.js";

const HASH = `0x${"ab".repeat(32)}`;

/** ABI return data of a single string[] built from the (bytes32, string[]) argument encoding. */
function stringArrayReturn(values: readonly string[]): string {
  const args = encodeWorkerArgs(HASH, values).slice(2);
  // args = bytes32 | offset(0x40) | array body; a lone string[] return is offset(0x20) | array body.
  return `0x${"0".repeat(62)}20${args.slice(128)}`;
}

describe("abi", () => {
  it("computes the selectors the reference WorkerSpecifier exposes", () => {
    expect(selector("transfer(address,uint256)")).toBe("0xa9059cbb");
    expect(selector("workerHash()")).toMatch(/^0x[0-9a-f]{8}$/u);
    expect(encodeSetWorker(HASH, []).startsWith(selector("setWorker(bytes32,string[])"))).toBe(true);
  });

  it("keccak256 matches the empty-input test vector", () => {
    expect(keccakHex(new Uint8Array(0))).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  });

  it("round-trips hex", () => {
    const bytes = new Uint8Array([0, 1, 254, 255]);
    expect(bytesToHex(bytes)).toBe("0001feff");
    expect(hexToBytes("0x0001FEFF")).toEqual(bytes);
    expect(() => hexToBytes("0x123")).toThrow(TestbedError);
    expect(() => hexToBytes("0xzz")).toThrow(TestbedError);
  });

  it("encodes the worker arguments in canonical ABI layout", () => {
    const encoded = encodeWorkerArgs(HASH, ["ab"]).slice(2);
    const words = encoded.match(/.{64}/gu) ?? [];
    expect(words[0]).toBe("ab".repeat(32));
    expect(BigInt(`0x${words[1] ?? ""}`)).toBe(64n); // offset of the string[]
    expect(BigInt(`0x${words[2] ?? ""}`)).toBe(1n); // array length
    expect(BigInt(`0x${words[3] ?? ""}`)).toBe(32n); // offset of item 0 (relative to after the length)
    expect(BigInt(`0x${words[4] ?? ""}`)).toBe(2n); // string length
    expect(words[5]).toBe(`6162${"0".repeat(60)}`);
    expect(words.length).toBe(6);
  });

  it("round-trips string[] through decodeStringArray", () => {
    const values = ["", "https://example.org/keccak/ab/cd", "x".repeat(70), "kps:1.2.3.4:15005:uEiA/keccak"];
    expect(decodeStringArray(stringArrayReturn(values))).toEqual(values);
    expect(decodeStringArray(stringArrayReturn([]))).toEqual([]);
  });

  it("rejects string[] data whose offsets overrun the buffer", () => {
    const good = stringArrayReturn(["hello"]);
    expect(() => decodeStringArray(good.slice(0, good.length - 64))).toThrow(/overruns/u);
    expect(() => decodeStringArray(`0x${"f".repeat(64)}`)).toThrow(TestbedError);
  });

  it("decodes bytes32 and refuses short data", () => {
    expect(decodeBytes32(`${HASH}${"00".repeat(4)}`)).toBe(HASH);
    expect(() => decodeBytes32("0x1234")).toThrow(/bytes32 return/u);
    expect(() => encodeWorkerArgs("0x1234", [])).toThrow(/32 bytes/u);
  });
});
