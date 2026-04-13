import type { PathHop } from "./types.js";
import { getCrypto } from "./utils.js";

export interface SurbEntry {
  requestId: bigint;
  recoveryJson: string;
}

/** SURB pre-generation and response decryption. SURBs are single-use and consumed on match. */
export class SurbPool {
  readonly registry = new Map<string, SurbEntry>();

  activeSurbIds(): string[] {
    return [...this.registry.keys()];
  }

  /** Pre-generate `count` SURBs for the return path and register their recoveries. */
  generate(
    wasm: Record<string, unknown>,
    returnPath: PathHop[],
    requestId: bigint,
    count: number,
  ): Uint8Array[] {
    const JsPathHop = wasm["JsPathHop"] as new (
      pubKeyHex: string,
      address: string,
    ) => unknown;
    const createSurb = wasm["create_surb"] as (
      path: unknown[],
      idHex: string,
      pow: number,
    ) => { surb_bytes: Uint8Array; recovery: { to_json(): string } };

    const surbBlobs: Uint8Array[] = [];

    for (let i = 0; i < count; i++) {
      const idHex = randomIdHex();
      const wasmPath = returnPath.map(
        (hop) => new JsPathHop(hop.pubKeyHex, hop.address),
      );
      const result = createSurb(wasmPath, idHex, 0);
      // Must read surb_bytes before recovery - recovery getter consumes the wasm object
      const surbBytes = result.surb_bytes;
      const recoveryJson = result.recovery.to_json();
      this.registry.set(idHex, { requestId, recoveryJson });
      surbBlobs.push(surbBytes);
    }

    return surbBlobs;
  }

  /** O(1) decrypt by known SURB ID. Returns null if not found or decryption fails. */
  decryptById(
    wasm: Record<string, unknown>,
    idHex: string,
    encryptedBody: Uint8Array,
  ): { requestId: bigint; plaintext: Uint8Array } | null {
    const entry = this.registry.get(idHex);
    if (entry === undefined) return null;

    const fromJson = (wasm["JsSurbRecovery"] as { from_json(j: string): unknown }).from_json.bind(
      wasm["JsSurbRecovery"],
    );
    const decryptFn = wasm["decrypt_surb_response"] as (
      recovery: unknown,
      data: Uint8Array,
    ) => Uint8Array;

    try {
      const recovery = fromJson(entry.recoveryJson);
      const plaintext = decryptFn(recovery, encryptedBody);
      if (plaintext.length === 0 || plaintext[0] !== 0x01) {
        return null;
      }
      this.registry.delete(idHex);
      return { requestId: entry.requestId, plaintext };
    } catch {
      return null;
    }
  }

  /** Trial-decrypt against all registered SURBs. Returns first match or null. */
  matchAndDecrypt(
    wasm: Record<string, unknown>,
    encryptedBody: Uint8Array,
  ): { requestId: bigint; plaintext: Uint8Array } | null {
    const fromJson = (wasm["JsSurbRecovery"] as { from_json(j: string): unknown }).from_json.bind(
      wasm["JsSurbRecovery"],
    );
    const decryptFn = wasm["decrypt_surb_response"] as (
      recovery: unknown,
      data: Uint8Array,
    ) => Uint8Array;

    for (const [idHex, entry] of this.registry) {
      try {
        const recovery = fromJson(entry.recoveryJson);
        const plaintext = decryptFn(recovery, encryptedBody);
        // Version byte 0x01 check filters ~1/256 false positives from unauthenticated Lioness
        if (plaintext.length === 0 || plaintext[0] !== 0x01) {
          continue;
        }
        this.registry.delete(idHex);
        return { requestId: entry.requestId, plaintext };
      } catch {
        // Wrong SURB — try next
      }
    }
    return null;
  }

  /** Remove all SURBs for a completed/failed request. */
  cleanup(requestId: bigint): void {
    for (const [idHex, entry] of this.registry) {
      if (entry.requestId === requestId) {
        this.registry.delete(idHex);
      }
    }
  }

  get size(): number {
    return this.registry.size;
  }
}

function randomIdHex(): string {
  const bytes = new Uint8Array(16);
  getCrypto().getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
