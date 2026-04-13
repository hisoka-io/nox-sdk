/**
 * ReplenishmentManager + buildReturnPath unit tests.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ReplenishmentManager, buildReturnPath } from "../src/replenishment.js";
import type { PathHop } from "../src/types.js";
import { NoxClientError } from "../src/types.js";

// ── buildReturnPath ────────────────────────────────────────────────────────

describe("buildReturnPath", () => {
  it("[Entry, Mix, Exit] → [Mix, Entry]", () => {
    const forward: PathHop[] = [
      { pubKeyHex: "aa".repeat(32), address: "entry" },
      { pubKeyHex: "bb".repeat(32), address: "mix" },
      { pubKeyHex: "cc".repeat(32), address: "exit" },
    ];
    const rp = buildReturnPath(forward);
    expect(rp).toHaveLength(2);
    expect(rp[0]!.address).toBe("mix");
    expect(rp[1]!.address).toBe("entry");
  });

  it("[Entry, Exit] → [Entry]", () => {
    const forward: PathHop[] = [
      { pubKeyHex: "aa".repeat(32), address: "entry" },
      { pubKeyHex: "cc".repeat(32), address: "exit" },
    ];
    const rp = buildReturnPath(forward);
    expect(rp).toHaveLength(1);
    expect(rp[0]!.address).toBe("entry");
  });

  it("single hop → [same hop]", () => {
    const forward: PathHop[] = [
      { pubKeyHex: "aa".repeat(32), address: "only" },
    ];
    const rp = buildReturnPath(forward);
    expect(rp).toHaveLength(1);
    expect(rp[0]!.address).toBe("only");
  });

  it("empty path → empty", () => {
    expect(buildReturnPath([])).toEqual([]);
  });

  it("does not mutate original path", () => {
    const forward: PathHop[] = [
      { pubKeyHex: "aa".repeat(32), address: "a" },
      { pubKeyHex: "bb".repeat(32), address: "b" },
      { pubKeyHex: "cc".repeat(32), address: "c" },
    ];
    const original = [...forward];
    buildReturnPath(forward);
    expect(forward).toEqual(original);
  });
});

// ── ReplenishmentManager path stash ────────────────────────────────────────

describe("ReplenishmentManager path stash", () => {
  const path: PathHop[] = [
    { pubKeyHex: "aa".repeat(32), address: "entry" },
    { pubKeyHex: "bb".repeat(32), address: "exit" },
  ];

  it("stashPath stores and hasPendingPath returns true", () => {
    const mgr = new ReplenishmentManager();
    mgr.stashPath(1n, path);
    expect(mgr.hasPendingPath(1n)).toBe(true);
  });

  it("hasPendingPath returns false for unknown requestId", () => {
    const mgr = new ReplenishmentManager();
    expect(mgr.hasPendingPath(999n)).toBe(false);
  });

  it("clearPath removes the stashed path", () => {
    const mgr = new ReplenishmentManager();
    mgr.stashPath(1n, path);
    mgr.clearPath(1n);
    expect(mgr.hasPendingPath(1n)).toBe(false);
  });

  it("clearPath is idempotent", () => {
    const mgr = new ReplenishmentManager();
    mgr.stashPath(1n, path);
    mgr.clearPath(1n);
    mgr.clearPath(1n); // no throw
    expect(mgr.hasPendingPath(1n)).toBe(false);
  });

  it("supports multiple concurrent requests", () => {
    const mgr = new ReplenishmentManager();
    mgr.stashPath(1n, path);
    mgr.stashPath(2n, path);
    mgr.stashPath(3n, path);
    expect(mgr.paths.size).toBe(3);

    mgr.clearPath(2n);
    expect(mgr.hasPendingPath(1n)).toBe(true);
    expect(mgr.hasPendingPath(2n)).toBe(false);
    expect(mgr.hasPendingPath(3n)).toBe(true);
  });
});

// ── handleNeedMoreSurbs ────────────────────────────────────────────────────

describe("ReplenishmentManager.handleNeedMoreSurbs", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("throws when no stashed path exists", async () => {
    const mgr = new ReplenishmentManager();
    const wasm = makeMockWasm();

    await expect(
      mgr.handleNeedMoreSurbs({
        wasm,
        clientRequestId: 999n,
        serverRequestId: 1n,
        fragmentsRemaining: 5,
        surbPool: makeMockSurbPool(),
        entryUrl: "http://entry.test",
        powDifficulty: 0,
      }),
    ).rejects.toThrow("no stashed path");
  });
});

// ── mock helpers ───────────────────────────────────────────────────────────

function makeMockWasm() {
  return {
    JsPathHop: class {
      constructor(public pubKeyHex: string, public address: string) {}
    },
    create_surb: () => ({
      surb_bytes: new Uint8Array(100),
      recovery: { to_json: () => '{"test":true}' },
    }),
    JsSurbRecovery: {
      from_json: (j: string) => ({ _data: j }),
    },
    decrypt_surb_response: () => new Uint8Array([0x01, 0x42]),
    build_sphinx_packet: () => new Uint8Array(32768),
  };
}

function makeMockSurbPool() {
  return {
    registry: new Map(),
    size: 0,
    generate: vi.fn().mockReturnValue([new Uint8Array(100)]),
    decryptById: vi.fn().mockReturnValue(null),
    matchAndDecrypt: vi.fn().mockReturnValue(null),
    cleanup: vi.fn(),
  };
}
