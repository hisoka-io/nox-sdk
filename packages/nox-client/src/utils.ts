import { NoxClientError, NoxClientErrorCode } from "./types.js";
import type { PathHop } from "./types.js";

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

let _nodeCrypto: Crypto | null = null;

export function getCrypto(): Crypto {
  if (typeof globalThis.crypto !== "undefined") return globalThis.crypto;
  if (_nodeCrypto !== null) return _nodeCrypto;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("node:crypto");
    _nodeCrypto = mod.webcrypto as Crypto;
    return _nodeCrypto;
  } catch {
    throw new Error("No crypto available — call initNodeCrypto() first or use Node.js 20+");
  }
}

export async function initNodeCrypto(): Promise<void> {
  if (typeof globalThis.crypto !== "undefined") return;
  const mod = await import("node:crypto");
  _nodeCrypto = mod.webcrypto as Crypto;
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
