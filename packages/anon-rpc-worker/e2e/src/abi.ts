// The slice of the Solidity ABI the WorkerSpecifier needs: selectors, the
// (bytes32, string[]) argument tuple, and the bytes32 / string[] return values.
// Decoders bound-check every offset, like the reference harness does.

import { keccak_256 } from "@noble/hashes/sha3";
import { TestbedError } from "./errors.js";

const WORD = 32;
const encoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/u.test(body)) {
    throw new TestbedError("abi", `not an even-length hex string: ${hex.slice(0, 40)}`);
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** keccak256 of `bytes` as 0x-prefixed lowercase hex. */
export function keccakHex(bytes: Uint8Array): string {
  return `0x${bytesToHex(keccak_256(bytes))}`;
}

/** 4-byte function selector, e.g. selector("workerHash()") === "0x3898587d". */
export function selector(signature: string): string {
  return `0x${bytesToHex(keccak_256(encoder.encode(signature))).slice(0, 8)}`;
}

function uintWord(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TestbedError("abi", `cannot encode ${value} as uint256`);
  }
  const out = new Uint8Array(WORD);
  let rest = value;
  for (let i = WORD - 1; i >= 0 && rest > 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return out;
}

function padRight(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.max(WORD, Math.ceil(bytes.length / WORD) * WORD));
  out.set(bytes);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** ABI body of a string[]: length word, then the tuple of strings (heads relative to after the length). */
function encodeStringArrayBody(values: readonly string[]): Uint8Array {
  const items = values.map((value) => encoder.encode(value));
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let tailOffset = items.length * WORD;
  for (const item of items) {
    heads.push(uintWord(tailOffset));
    const tail = item.length === 0 ? uintWord(0) : concat([uintWord(item.length), padRight(item)]);
    tails.push(tail);
    tailOffset += tail.length;
  }
  return concat([uintWord(items.length), ...heads, ...tails]);
}

function bytes32(hash: string): Uint8Array {
  const bytes = hexToBytes(hash);
  if (bytes.length !== WORD) {
    throw new TestbedError("abi", `bytes32 must be 32 bytes, got ${bytes.length}: ${hash}`);
  }
  return bytes;
}

/** abi.encode(bytes32 hash, string[] resolvers) as 0x hex (constructor and setWorker arguments). */
export function encodeWorkerArgs(hash: string, resolvers: readonly string[]): string {
  return `0x${bytesToHex(concat([bytes32(hash), uintWord(2 * WORD), encodeStringArrayBody(resolvers)]))}`;
}

/** Calldata for setWorker(bytes32,string[]). */
export function encodeSetWorker(hash: string, resolvers: readonly string[]): string {
  return selector("setWorker(bytes32,string[])") + encodeWorkerArgs(hash, resolvers).slice(2);
}

function readWord(data: Uint8Array, at: number): number {
  if (at < 0 || at + WORD > data.length) {
    throw new TestbedError("abi", `word at ${at} is out of bounds (${data.length} bytes)`);
  }
  let value = 0;
  for (let i = at; i < at + WORD; i++) {
    value = value * 256 + (data[i] ?? 0);
    if (value > Number.MAX_SAFE_INTEGER) throw new TestbedError("abi", `word at ${at} is too large`);
  }
  return value;
}

/** Decode a bytes32 return value to 0x hex. */
export function decodeBytes32(returnData: string): string {
  const data = hexToBytes(returnData);
  if (data.length < WORD) throw new TestbedError("abi", `bytes32 return is ${data.length} bytes`);
  return `0x${bytesToHex(data.slice(0, WORD))}`;
}

/** Decode a single string[] return value. */
export function decodeStringArray(returnData: string): string[] {
  const data = hexToBytes(returnData);
  const base = readWord(data, 0);
  const length = readWord(data, base);
  const start = base + WORD;
  if (start + length * WORD > data.length) {
    throw new TestbedError("abi", `string[] of ${length} items overruns ${data.length} bytes`);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    const at = start + readWord(data, start + i * WORD);
    const size = readWord(data, at);
    if (at + WORD + size > data.length) {
      throw new TestbedError("abi", `string ${i} of ${size} bytes overruns ${data.length} bytes`);
    }
    out.push(decoder.decode(data.slice(at + WORD, at + WORD + size)));
  }
  return out;
}
