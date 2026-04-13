/**
 * SurbPool unit tests.
 *
 * WASM is mocked — these tests verify the pool's registry logic, not crypto.
 */
import { describe, it, expect, vi } from "vitest";
import { SurbPool } from "../src/surb_pool.js";
import type { PathHop } from "../src/types.js";

// ── mock WASM helpers ──────────────────────────────────────────────────────

/** Counter for unique SURB IDs in tests (deterministic). */
let surbIdCounter = 0;

function makeMockWasm(opts?: {
  decryptResult?: Uint8Array;
  decryptThrows?: boolean;
}) {
  const decryptResult = opts?.decryptResult ?? new Uint8Array([0x01, 0x42, 0x43]);
  const decryptThrows = opts?.decryptThrows ?? false;

  return {
    JsPathHop: class {
      constructor(public pubKeyHex: string, public address: string) {}
    },
    create_surb: (_path: unknown[], _idHex: string, _pow: number) => {
      const id = (surbIdCounter++).toString(16).padStart(32, "0");
      return {
        surb_bytes: new Uint8Array([0x53, 0x55]),
        recovery: {
          to_json() {
            return JSON.stringify({ id, keys: [1, 2, 3] });
          },
        },
      };
    },
    JsSurbRecovery: {
      from_json(json: string) {
        return { _data: json };
      },
    },
    decrypt_surb_response: (_recovery: unknown, _data: Uint8Array) => {
      if (decryptThrows) throw new Error("decryption failed");
      return decryptResult;
    },
  };
}

const testReturnPath: PathHop[] = [
  { pubKeyHex: "aa".repeat(32), address: "/ip4/127.0.0.1/tcp/9001" },
  { pubKeyHex: "bb".repeat(32), address: "/ip4/127.0.0.1/tcp/9000" },
];

// ── generate ───────────────────────────────────────────────────────────────

describe("SurbPool.generate", () => {
  it("populates registry with correct count", () => {
    const pool = new SurbPool();
    const wasm = makeMockWasm();
    pool.generate(wasm, testReturnPath, 1n, 5);
    expect(pool.size).toBe(5);
  });

  it("returns SURB blobs array of correct length", () => {
    const pool = new SurbPool();
    const wasm = makeMockWasm();
    const blobs = pool.generate(wasm, testReturnPath, 1n, 3);
    expect(blobs).toHaveLength(3);
  });

  it("each SURB gets unique ID", () => {
    const pool = new SurbPool();
    const wasm = makeMockWasm();
    pool.generate(wasm, testReturnPath, 1n, 10);
    expect(pool.registry.size).toBe(10);
  });

  it("stores requestId in registry entries", () => {
    const pool = new SurbPool();
    const wasm = makeMockWasm();
    pool.generate(wasm, testReturnPath, 42n, 2);
    for (const entry of pool.registry.values()) {
      expect(entry.requestId).toBe(42n);
    }
  });

  it("stores recoveryJson in registry entries", () => {
    const pool = new SurbPool();
    const wasm = makeMockWasm();
    pool.generate(wasm, testReturnPath, 1n, 1);
    const entry = pool.registry.values().next().value!;
    expect(entry.recoveryJson).toBeTruthy();
    const parsed = JSON.parse(entry.recoveryJson);
    expect(parsed).toHaveProperty("keys");
  });
});

// ── decryptById ────────────────────────────────────────────────────────────

describe("SurbPool.decryptById", () => {
  it("returns plaintext for known ID", () => {
    const pool = new SurbPool();
    const wasm = makeMockWasm({ decryptResult: new Uint8Array([0x01, 0xAA]) });
    pool.generate(wasm, testReturnPath, 1n, 1);
    const idHex = pool.registry.keys().next().value!;

    const result = pool.decryptById(wasm, idHex, new Uint8Array([0xFF]));
    expect(result).not.toBeNull();
    expect(result!.requestId).toBe(1n);
    expect(result!.plaintext[0]).toBe(0x01);
  });

  it("returns null for unknown ID", () => {
    const pool = new SurbPool();
    const wasm = makeMockWasm();
    const result = pool.decryptById(wasm, "unknown_id_0000000000000000", new Uint8Array([0xFF]));
    expect(result).toBeNull();
  });

  it("consumes SURB on successful decrypt (cannot decrypt twice)", () => {
    const pool = new SurbPool();
    const wasm = makeMockWasm({ decryptResult: new Uint8Array([0x01, 0xBB]) });
    pool.generate(wasm, testReturnPath, 1n, 1);
    const idHex = pool.registry.keys().next().value!;

    const first = pool.decryptById(wasm, idHex, new Uint8Array([0xFF]));
    expect(first).not.toBeNull();
    expect(pool.size).toBe(0);

    const second = pool.decryptById(wasm, idHex, new Uint8Array([0xFF]));
    expect(second).toBeNull();
  });

  it("returns null when version byte is not 0x01", () => {
    const pool = new SurbPool();
    const wasm = makeMockWasm({ decryptResult: new Uint8Array([0x02, 0xAA]) });
    pool.generate(wasm, testReturnPath, 1n, 1);
    const idHex = pool.registry.keys().next().value!;

    const result = pool.decryptById(wasm, idHex, new Uint8Array([0xFF]));
    expect(result).toBeNull();
    // SURB is NOT consumed on version byte failure
    expect(pool.size).toBe(1);
  });

  it("returns null when decrypt throws", () => {
    const pool = new SurbPool();
    const generateWasm = makeMockWasm();
    pool.generate(generateWasm, testReturnPath, 1n, 1);
    const idHex = pool.registry.keys().next().value!;

    const decryptWasm = makeMockWasm({ decryptThrows: true });
    const result = pool.decryptById(decryptWasm, idHex, new Uint8Array([0xFF]));
    expect(result).toBeNull();
  });
});

// ── matchAndDecrypt ────────────────────────────────────────────────────────

describe("SurbPool.matchAndDecrypt", () => {
  it("finds and decrypts the matching SURB", () => {
    const pool = new SurbPool();
    const wasm = makeMockWasm({ decryptResult: new Uint8Array([0x01, 0xCC]) });
    pool.generate(wasm, testReturnPath, 1n, 3);

    const result = pool.matchAndDecrypt(wasm, new Uint8Array([0xEE]));
    expect(result).not.toBeNull();
    expect(result!.requestId).toBe(1n);
  });

  it("consumes only the matched SURB, others remain", () => {
    const pool = new SurbPool();
    const wasm = makeMockWasm({ decryptResult: new Uint8Array([0x01, 0xDD]) });
    pool.generate(wasm, testReturnPath, 1n, 5);

    pool.matchAndDecrypt(wasm, new Uint8Array([0xEE]));
    expect(pool.size).toBe(4);
  });

  it("returns null when all decryptions fail", () => {
    const pool = new SurbPool();
    const generateWasm = makeMockWasm();
    pool.generate(generateWasm, testReturnPath, 1n, 3);

    const failWasm = makeMockWasm({ decryptThrows: true });
    const result = pool.matchAndDecrypt(failWasm, new Uint8Array([0xFF]));
    expect(result).toBeNull();
    expect(pool.size).toBe(3); // nothing consumed
  });

  it("skips entries with wrong version byte", () => {
    const pool = new SurbPool();
    const wasm = makeMockWasm({ decryptResult: new Uint8Array([0x00, 0xFF]) });
    pool.generate(wasm, testReturnPath, 1n, 2);

    const result = pool.matchAndDecrypt(wasm, new Uint8Array([0xFF]));
    expect(result).toBeNull();
    expect(pool.size).toBe(2); // nothing consumed
  });
});

// ── cleanup ────────────────────────────────────────────────────────────────

describe("SurbPool.cleanup", () => {
  it("removes all entries for a requestId", () => {
    const pool = new SurbPool();
    const wasm = makeMockWasm();
    pool.generate(wasm, testReturnPath, 10n, 3);
    pool.generate(wasm, testReturnPath, 20n, 2);
    expect(pool.size).toBe(5);

    pool.cleanup(10n);
    expect(pool.size).toBe(2);
  });

  it("leaves other requestIds untouched", () => {
    const pool = new SurbPool();
    const wasm = makeMockWasm();
    pool.generate(wasm, testReturnPath, 10n, 2);
    pool.generate(wasm, testReturnPath, 20n, 3);

    pool.cleanup(10n);
    for (const entry of pool.registry.values()) {
      expect(entry.requestId).toBe(20n);
    }
  });

  it("no-op when requestId not found", () => {
    const pool = new SurbPool();
    const wasm = makeMockWasm();
    pool.generate(wasm, testReturnPath, 1n, 2);

    pool.cleanup(999n); // doesn't exist
    expect(pool.size).toBe(2);
  });
});

// ── size ───────────────────────────────────────────────────────────────────

describe("SurbPool.size", () => {
  it("returns 0 initially", () => {
    expect(new SurbPool().size).toBe(0);
  });

  it("increments with generate", () => {
    const pool = new SurbPool();
    const wasm = makeMockWasm();
    pool.generate(wasm, testReturnPath, 1n, 3);
    expect(pool.size).toBe(3);
  });

  it("decrements with cleanup", () => {
    const pool = new SurbPool();
    const wasm = makeMockWasm();
    pool.generate(wasm, testReturnPath, 1n, 5);
    pool.cleanup(1n);
    expect(pool.size).toBe(0);
  });
});
