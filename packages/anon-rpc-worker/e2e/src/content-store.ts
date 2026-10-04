// Content-addressed bundle store with the GitHub `keccak` branch layout that
// anon-rpc resolvers use: /keccak/<first 2 hex chars>/<remaining 62>.

import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "./abi.js";
import { TestbedError } from "./errors.js";

/** Lowercase 64-char keccak256 hex (no 0x) of `bytes`. */
export function keccakName(bytes: Uint8Array): string {
  return bytesToHex(keccak_256(bytes));
}

/** The resolver path of a bundle: /keccak/<hh>/<62 hex>. */
export function keccakPath(hash: string): string {
  const name = normalizeHash(hash);
  return `/keccak/${name.slice(0, 2)}/${name.slice(2)}`;
}

/** The 64-hex name a resolver path refers to, or undefined if it is not one. */
export function parseKeccakPath(path: string): string | undefined {
  const match = /^\/keccak\/([0-9a-f]{2})\/([0-9a-f]{62})$/u.exec(path);
  return match === null ? undefined : `${match[1] ?? ""}${match[2] ?? ""}`;
}

export function normalizeHash(hash: string): string {
  const name = (hash.startsWith("0x") ? hash.slice(2) : hash).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(name)) {
    throw new TestbedError("resolver", `not a 32-byte keccak256 hex hash: ${hash}`);
  }
  return name;
}

export class ContentStore {
  readonly #items = new Map<string, Uint8Array>();

  /** Store `bytes` under keccak256(bytes); returns the 0x-prefixed hash. */
  put(bytes: Uint8Array): string {
    const name = keccakName(bytes);
    this.#items.set(name, bytes.slice());
    return `0x${name}`;
  }

  /**
   * Store `bytes` under a name that is NOT its hash. Used only by negative
   * tests that need a resolver serving wrong bytes for a pinned hash.
   */
  putMismatched(hash: string, bytes: Uint8Array): void {
    const name = normalizeHash(hash);
    if (name === keccakName(bytes)) {
      throw new TestbedError("resolver", "putMismatched was given bytes that do match the hash");
    }
    this.#items.set(name, bytes.slice());
  }

  get(hash: string): Uint8Array | undefined {
    return this.#items.get(normalizeHash(hash));
  }

  has(hash: string): boolean {
    return this.#items.has(normalizeHash(hash));
  }
}
