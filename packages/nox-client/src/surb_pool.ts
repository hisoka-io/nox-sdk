import type { PathHop } from "./types.js";
import { NoxClientError, NoxClientErrorCode } from "./types.js";
import { getCrypto } from "./utils.js";

/** 1: reply block keyed by a client-chosen ID. 2: keyed by the delivery ID, reply MAC checked. */
export type SurbVersion = 1 | 2;

export interface SurbEntry {
  requestId: bigint;
  recoveryJson: string;
  /** Absent in entries created before 0.4.0; treated as 1. */
  version?: SurbVersion;
}

interface CreateResult {
  surb_bytes: Uint8Array;
  recovery: { to_json(): string; id_hex: string };
}

/** True when the loaded WASM module can build format v2 reply blocks. */
export function wasmSupportsSurbV2(wasm: Record<string, unknown> | null): boolean {
  return wasm !== null && typeof wasm["create_surb_v2"] === "function";
}

/** SURB pre-generation and response decryption. SURBs are single-use and consumed on match. */
export class SurbPool {
  readonly registry = new Map<string, SurbEntry>();

  activeSurbIds(): string[] {
    return [...this.registry.keys()];
  }

  /** SURB IDs registered for one request. */
  idsForRequest(requestId: bigint): string[] {
    const ids: string[] = [];
    for (const [idHex, entry] of this.registry) {
      if (entry.requestId === requestId) ids.push(idHex);
    }
    return ids;
  }

  /**
   * Pre-generate `count` SURBs for the return path and register their recoveries.
   * Version 2 SURBs are registered under their delivery ID, which the WASM
   * module derives; it is never sent anywhere.
   */
  generate(
    wasm: Record<string, unknown>,
    returnPath: PathHop[],
    requestId: bigint,
    count: number,
    version: SurbVersion = 1,
  ): Uint8Array[] {
    const JsPathHop = wasm["JsPathHop"] as new (
      pubKeyHex: string,
      address: string,
    ) => unknown;
    const createSurb = wasm["create_surb"] as (
      path: unknown[],
      idHex: string,
      pow: number,
    ) => CreateResult;
    const createSurbV2 = wasm["create_surb_v2"] as
      | ((path: unknown[], pow: number) => CreateResult)
      | undefined;
    if (version === 2 && typeof createSurbV2 !== "function") {
      throw new NoxClientError(
        "The loaded WASM module cannot build format v2 reply blocks",
        NoxClientErrorCode.SurbV2Unavailable,
      );
    }

    const surbBlobs: Uint8Array[] = [];

    for (let i = 0; i < count; i++) {
      const wasmPath = returnPath.map(
        (hop) => new JsPathHop(hop.pubKeyHex, hop.address),
      );
      const v1Id = version === 2 ? null : randomIdHex();
      const result = v1Id === null
        ? createSurbV2!(wasmPath, 0)
        : createSurb(wasmPath, v1Id, 0);
      // Must read surb_bytes before recovery - recovery getter consumes the wasm object
      const surbBytes = result.surb_bytes;
      const recovery = result.recovery;
      const idHex = v1Id ?? recovery.id_hex;
      const recoveryJson = recovery.to_json();
      this.registry.set(idHex, { requestId, recoveryJson, version });
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
      // Version 2 replies are only ever matched by delivery ID.
      if (entry.version === 2) continue;
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
