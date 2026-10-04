// Byte-level helpers for runtime code: hex conversion, an instruction walker that skips PUSH immediates and solc's
// CBOR metadata trailer (TypeScript twin of test/utils/RuntimeCode.sol), and immutable substitution.

import type { CodeRange } from "./artifacts.ts";

export const STATE_CHANGING_OPCODES: ReadonlyMap<number, string> = new Map([
  [0x55, "SSTORE"],
  [0x5d, "TSTORE"],
  [0xa0, "LOG0"],
  [0xa1, "LOG1"],
  [0xa2, "LOG2"],
  [0xa3, "LOG3"],
  [0xa4, "LOG4"],
  [0xf0, "CREATE"],
  [0xf1, "CALL"],
  [0xf2, "CALLCODE"],
  [0xf4, "DELEGATECALL"],
  [0xf5, "CREATE2"],
  [0xff, "SELFDESTRUCT"],
]);

const PUSH1 = 0x60;
const PUSH32 = 0x7f;

export class CodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeError";
  }
}

export function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new CodeError(`not an even-length hex string: ${hex.slice(0, 20)}…`);
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s as `0x${string}`;
}

function at(code: Uint8Array, index: number): number {
  const byte = code[index];
  if (byte === undefined) throw new CodeError(`code index ${index} out of range (length ${code.length})`);
  return byte;
}

/** Offset where executable code ends and the CBOR metadata trailer (length in the last two bytes) begins. */
export function executableEnd(code: Uint8Array): number {
  const n = code.length;
  if (n < 2) throw new CodeError(`code of ${n} bytes has no metadata trailer`);
  const metadataLength = (at(code, n - 2) << 8) | at(code, n - 1);
  if (metadataLength + 2 > n) throw new CodeError(`metadata length ${metadataLength} exceeds code length ${n}`);
  const end = n - 2 - metadataLength;
  const head = at(code, end);
  if (head < 0xa1 || head > 0xa5)
    throw new CodeError(`no CBOR map at metadata offset ${end} (byte 0x${head.toString(16)})`);
  return end;
}

/** Names of state-changing opcodes that occur as instructions, deduplicated, in first-seen order. */
export function stateChangingOpcodes(code: Uint8Array): string[] {
  const end = executableEnd(code);
  const found: string[] = [];
  for (let i = 0; i < end; i++) {
    const op = at(code, i);
    if (op >= PUSH1 && op <= PUSH32) {
      i += op - PUSH1 + 1;
      continue;
    }
    const name = STATE_CHANGING_OPCODES.get(op);
    if (name !== undefined && !found.includes(name)) found.push(name);
  }
  return found;
}

/** The runtime code a deployment produces: the artifact's runtime code with every immutable slot set to `word`. */
export function fillImmutables(deployed: Uint8Array, ranges: readonly CodeRange[], word: Uint8Array): Uint8Array {
  const out = deployed.slice();
  for (const { start, length } of ranges) {
    if (length !== word.length)
      throw new CodeError(`immutable slot of ${length} bytes cannot hold a ${word.length}-byte value`);
    if (start + length > out.length) throw new CodeError(`immutable slot ${start}+${length} lies outside the code`);
    out.set(word, start);
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
