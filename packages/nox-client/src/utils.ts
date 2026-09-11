import { NoxClientError, NoxClientErrorCode } from "./types.js";
import type { PathHop } from "./types.js";

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:0x)?(?:[0-9a-fA-F]{2})*$/u.test(hex)) {
    throw new NoxClientError(
      "Hex input must contain an even number of hexadecimal digits with an optional lowercase 0x prefix",
      NoxClientErrorCode.InvalidConfig,
    );
  }
  const clean = hex.replace(/^0x/u, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function getCrypto(): Crypto {
  if (typeof globalThis.crypto !== "undefined") return globalThis.crypto;
  throw new NoxClientError(
    "Web Crypto API is required by @hisoka-io/nox-client",
    NoxClientErrorCode.InvalidConfig,
  );
}

export type RandomFill = (target: Uint32Array) => Uint32Array;

export function secureRandomIndex(
  length: number,
  fill: RandomFill = fillSecureRandom,
): number {
  if (!Number.isSafeInteger(length) || length <= 0 || length > 2 ** 32) {
    throw new NoxClientError(
      "Secure random index length must be an integer in 1..=2^32",
      NoxClientErrorCode.InvalidConfig,
    );
  }
  const range = 2 ** 32;
  const acceptanceLimit = Math.floor(range / length) * length;
  const sample = new Uint32Array(1);
  do {
    fill(sample);
  } while (sample[0]! >= acceptanceLimit);
  return sample[0]! % length;
}

export function secureRandomUnit(fill: RandomFill = fillSecureRandom): number {
  const sample = new Uint32Array(2);
  fill(sample);
  const high = sample[0]! >>> 5;
  const low = sample[1]! >>> 6;
  const significand = high * 2 ** 26 + low;
  return (significand + 0.5) / 2 ** 53;
}

function fillSecureRandom(target: Uint32Array): Uint32Array {
  return getCrypto().getRandomValues(target);
}

export function buildSphinxPacket(
  wasm: Record<string, unknown>,
  forwardPath: PathHop[],
  payload: Uint8Array,
  powDifficulty: number,
): Uint8Array {
  const JsPathHop = wasm["JsPathHop"] as new (
    pubKeyHex: string,
    address: string,
  ) => unknown;
  const buildFn = wasm["build_sphinx_packet"] as (
    hops: unknown[],
    payload: Uint8Array,
    pow: number,
  ) => Uint8Array;

  const wasmHops = forwardPath.map(
    (hop) => new JsPathHop(hop.pubKeyHex, hop.address),
  );

  try {
    return buildFn(wasmHops, payload, powDifficulty);
  } catch (err) {
    throw new NoxClientError(
      `Sphinx packet build failed: ${String(err)}`,
      NoxClientErrorCode.PacketBuildFailed,
      err,
    );
  }
}
