import { describe, expect, it } from "vitest";
import { decodeUintWord, encodeArgs, encodeCall } from "../../src/abi.js";
import { TestbedError } from "../../src/errors.js";

// Reference vectors produced with foundry's `cast calldata` / `cast abi-encode` (1.3.2).
const ADMIN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ADMIN_WORD = "000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const word = (n: number): string => n.toString(16).padStart(64, "0");

describe("encodeArgs / encodeCall", () => {
  it("encodes registerPrivileged(address,bytes32,string,string,string,uint8) like cast, empty string included", () => {
    const multiaddr = "/ip4/127.0.0.1/tcp/29000/p2p/12D3KooWEAZ7G2SyC6aFP3KdJ6Hbaets1sW7biY6P3u3oN77CRMK";
    const metadata = "kps:127.0.0.1:29005:uEiAabc/metadata.json";
    const data = encodeCall("registerPrivileged(address,bytes32,string,string,string,uint8)", [
      { type: "address", value: "0x0000000000000000000000000000000000b00003" },
      { type: "bytes32", value: "0x9ff0bc41023e6e2f6115eb12c23bef8e0c6560b5154ed8e6afc50e6ab9f8ca45" },
      { type: "string", value: multiaddr },
      { type: "string", value: "" },
      { type: "string", value: metadata },
      { type: "uint", value: 2 },
    ]);
    const hex = (s: string): string => Buffer.from(s, "utf8").toString("hex");
    const padded = (s: string): string => hex(s).padEnd(Math.ceil(hex(s).length / 64) * 64, "0");
    expect(data).toBe(
      "0x7d5dbd96" +
        word(0xb00003) +
        "9ff0bc41023e6e2f6115eb12c23bef8e0c6560b5154ed8e6afc50e6ab9f8ca45" +
        word(0xc0) + word(0x140) + word(0x160) + word(2) +
        word(multiaddr.length) + padded(multiaddr) +
        word(0) +
        word(metadata.length) + padded(metadata),
    );
  });

  it("encodes a static struct in place (NoxRegistry.initialize)", () => {
    const data = encodeCall(
      "initialize((uint48,address,address,uint256,uint256,uint256,address,address,address))",
      [
        { type: "uint", value: 0 },
        { type: "address", value: ADMIN },
        { type: "address", value: ADMIN },
        { type: "uint", value: 1 },
        { type: "uint", value: 86_400 },
        { type: "uint", value: 1 },
        { type: "address", value: ADMIN },
        { type: "address", value: ADMIN },
        { type: "address", value: ADMIN },
      ],
    );
    expect(data).toBe(
      "0x59266697" + word(0) + ADMIN_WORD + ADMIN_WORD + word(1) + word(86_400) + word(1) + ADMIN_WORD + ADMIN_WORD + ADMIN_WORD,
    );
  });

  it("encodes (address, bytes) constructor arguments like cast abi-encode", () => {
    expect(encodeArgs([
      { type: "address", value: "0x5fbdb2315678afecb367f032d93f642f64180aa3" },
      { type: "bytes", value: "0xdeadbeef" },
    ])).toBe(
      "0x0000000000000000000000005fbdb2315678afecb367f032d93f642f64180aa3" + word(0x40) + word(4) +
        "deadbeef".padEnd(64, "0"),
    );
  });

  it("encodes uint256 bigints across the full range and refuses out-of-range values", () => {
    expect(encodeArgs([{ type: "uint", value: (1n << 256n) - 1n }])).toBe(`0x${"f".repeat(64)}`);
    expect(() => encodeArgs([{ type: "uint", value: 1n << 256n }])).toThrow(TestbedError);
    expect(() => encodeArgs([{ type: "uint", value: -1 }])).toThrow(TestbedError);
    expect(() => encodeArgs([{ type: "address", value: "0x1234" }])).toThrow(TestbedError);
  });

  it("decodes uint256 words by index", () => {
    const data = `0x${word(7)}${"f".repeat(64)}`;
    expect(decodeUintWord(data)).toBe(7n);
    expect(decodeUintWord(data, 1)).toBe((1n << 256n) - 1n);
    expect(() => decodeUintWord(data, 2)).toThrow(TestbedError);
  });
});
