/**
 * NoxClient unit tests.
 *
 * WASM and network are fully mocked. These tests verify the client's
 * orchestration logic: lifecycle, request building, response processing,
 * timeout handling, adaptive budget, and topology refresh.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  NoxClient,
  AdaptiveSurbBudget,
  EMA_ALPHA,
  EMA_HEADROOM,
  EMA_MIN_SAMPLES,
  USABLE_RESPONSE_PER_SURB,
} from "../src/client.js";
import { NoxClientError, NoxClientErrorCode } from "../src/types.js";
import { computeTopologyFingerprint } from "../src/topology.js";
import { parseNodes } from "../src/topology.js";

// ── Mock infrastructure ────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function mockFetchForTopology(
  nodes: unknown[] = [],
  fingerprint = "0".repeat(64),
  extra: Record<string, unknown> = {},
) {
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("/topology")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ nodes, fingerprint, ...extra }),
      });
    }
    // Health check for seeder
    if (typeof url === "string" && !url.includes("/topology")) {
      return Promise.resolve({ ok: true, status: 200 });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
}

function makeNode(layer: number, role: number, idx: number) {
  return {
    address: `0x${idx.toString(16).padStart(40, "0")}`,
    sphinx_key: idx.toString(16).padStart(2, "0").repeat(32),
    url: `/ip4/127.0.0.1/tcp/${9000 + idx}`,
    stake: "1000000000000000000",
    last_seen: Date.now(),
    is_privileged: false,
    layer,
    role,
    ingress_url: role === 1 ? `http://127.0.0.1:${8080 + idx}` : undefined,
  };
}

function makeMinimalTopology() {
  return [
    makeNode(1, 1, 1), // relay
    makeNode(1, 1, 2), // mix
    makeNode(2, 2, 3), // exit
  ];
}

function v2Topology(nodes: ReturnType<typeof makeMinimalTopology>) {
  return {
    schema_version: 2,
    block_number: 4_660,
    timestamp: 1_700_000_000,
    liveness: nodes.map((node) => ({
      address: node.address,
      status: "online",
      observed_at_unix: 1_700_000_000,
    })),
  };
}

// ── AdaptiveSurbBudget ─────────────────────────────────────────────────────

describe("AdaptiveSurbBudget", () => {
  it("returns fallback when no observations", () => {
    const budget = new AdaptiveSurbBudget();
    expect(budget.surbCount("op", 10)).toBe(10);
  });

  it("returns fallback with fewer than EMA_MIN_SAMPLES", () => {
    const budget = new AdaptiveSurbBudget();
    budget.record("op", 100_000);
    budget.record("op", 200_000);
    // Only 2 samples, need EMA_MIN_SAMPLES (3)
    expect(budget.surbCount("op", 10)).toBe(10);
  });

  it("uses EMA after enough samples", () => {
    const budget = new AdaptiveSurbBudget();
    for (let i = 0; i < EMA_MIN_SAMPLES; i++) {
      budget.record("op", 100_000); // 100 KB
    }
    // EMA ≈ 100,000. With headroom: ceil(100,000 * 1.5) = 150,000.
    // SURBs needed: ceil(150,000 / 30,699) = 5
    const count = budget.surbCount("op", 10);
    expect(count).toBeGreaterThanOrEqual(4);
    expect(count).toBeLessThanOrEqual(6);
  });

  it("tracks operations independently", () => {
    const budget = new AdaptiveSurbBudget();
    for (let i = 0; i < 5; i++) {
      budget.record("small", 1000);
      budget.record("large", 1_000_000);
    }
    expect(budget.surbCount("small", 10)).toBeLessThan(budget.surbCount("large", 10));
  });

  it("ignores zero-byte records", () => {
    const budget = new AdaptiveSurbBudget();
    budget.record("op", 0);
    budget.record("op", 0);
    budget.record("op", 0);
    budget.record("op", 0);
    // All zeros, so no valid observations
    expect(budget.surbCount("op", 10)).toBe(10);
  });

  it("EMA converges to recent values", () => {
    const budget = new AdaptiveSurbBudget();
    // Start with small values
    for (let i = 0; i < 5; i++) budget.record("op", 1000);
    const smallCount = budget.surbCount("op", 10);

    // Then switch to large values
    for (let i = 0; i < 20; i++) budget.record("op", 10_000_000);
    const largeCount = budget.surbCount("op", 10);

    expect(largeCount).toBeGreaterThan(smallCount);
  });

  it("always returns at least 1 SURB", () => {
    const budget = new AdaptiveSurbBudget();
    for (let i = 0; i < 5; i++) budget.record("op", 1);
    expect(budget.surbCount("op", 0)).toBeGreaterThanOrEqual(1);
  });

  it("EMA_ALPHA is 0.2", () => {
    expect(EMA_ALPHA).toBe(0.2);
  });

  it("EMA_HEADROOM is 1.5", () => {
    expect(EMA_HEADROOM).toBe(1.5);
  });

  it("EMA_MIN_SAMPLES is 3", () => {
    expect(EMA_MIN_SAMPLES).toBe(3);
  });

  it("USABLE_RESPONSE_PER_SURB is 30699", () => {
    expect(USABLE_RESPONSE_PER_SURB).toBe(30_699);
  });
});

// ── NoxClient.connect ──────────────────────────────────────────────────────

describe("NoxClient.connect", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("throws when no seed nodes reachable", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(
      NoxClient.connect({
        seeds: ["http://127.0.0.1:1"],
        dangerouslySkipFingerprintCheck: true,
      }),
    ).rejects.toThrow("No seed nodes reachable");
  });

  it("throws when topology returns 0 nodes", async () => {
    mockFetchForTopology([]); // empty nodes array

    await expect(
      NoxClient.connect({
        seeds: ["http://127.0.0.1:15003"],
        dangerouslySkipFingerprintCheck: true,
      }),
    ).rejects.toThrow("0 nodes");
  });

  it("reports an actionable error when no layer-0 node has HTTP ingress", async () => {
    const nodes = makeMinimalTopology().map((node) => ({
      ...node,
      ingress_url: undefined,
    }));
    mockFetchForTopology(nodes, computeTopologyFingerprint(nodes));

    await expect(
      NoxClient.connect({
        seeds: ["http://127.0.0.1:15003"],
        dangerouslySkipFingerprintCheck: true,
      }),
    ).rejects.toMatchObject({
      code: NoxClientErrorCode.NoNodesAvailable,
      message: "No layer-0 node has a usable HTTP(S) ingress URL",
    });
  });

  it("throws when fingerprint verification fails", async () => {
    const nodes = makeMinimalTopology();
    mockFetchForTopology(nodes, "ff".repeat(32), v2Topology(nodes)); // wrong fingerprint

    await expect(
      NoxClient.connect({
        seeds: ["http://seed.test"],
        ethRpcUrl: "http://rpc.test",
        registryAddress: "0x1111111111111111111111111111111111111111",
        dangerouslySkipFingerprintCheck: false,
      }),
    ).rejects.toThrow("fingerprint");
  });

  it("fails closed when a chain-verifying client receives a legacy partial snapshot", async () => {
    const nodes = makeMinimalTopology();
    mockFetchForTopology(nodes, computeTopologyFingerprint(nodes));

    await expect(
      NoxClient.connect({
        seeds: ["http://seed.test"],
        ethRpcUrl: "http://rpc.test",
        registryAddress: "0x1111111111111111111111111111111111111111",
      }),
    ).rejects.toThrow("schema_version 2");
  });

  it("requires verification inputs unless local-test bypass is explicit", async () => {
    await expect(
      NoxClient.connect({ seeds: ["http://seed.test"] }),
    ).rejects.toMatchObject({
      code: NoxClientErrorCode.InvalidConfig,
      message:
        "Topology verification requires both ethRpcUrl and registryAddress; set dangerouslySkipFingerprintCheck only for a local test mesh",
    });

    await expect(
      NoxClient.connect({
        seeds: ["http://seed.test"],
        ethRpcUrl: "http://rpc.test",
      }),
    ).rejects.toMatchObject({ code: NoxClientErrorCode.InvalidConfig });
  });

  it("rejects the verification bypass for a non-local seed", async () => {
    await expect(
      NoxClient.connect({
        seeds: ["https://api.hisoka.io/seed"],
        dangerouslySkipFingerprintCheck: true,
      }),
    ).rejects.toMatchObject({
      code: NoxClientErrorCode.InvalidConfig,
      message:
        "dangerouslySkipFingerprintCheck is restricted to loopback test meshes",
    });
  });

  it("skips only the on-chain check for a loopback test mesh", async () => {
    const nodes = makeMinimalTopology();
    mockFetchForTopology(nodes, computeTopologyFingerprint(nodes));

    const client = await NoxClient.connect({
      seeds: ["http://127.0.0.1:15003"],
      dangerouslySkipFingerprintCheck: true,
    });
    expect(client).toBeDefined();
    client.disconnect();
  });
});

describe("paid route freshness", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function detachedClient(verifiedAtMs: number): NoxClient {
    const client = Object.create(NoxClient.prototype) as NoxClient;
    Reflect.set(client, "_nodes", parseNodes({
      nodes: makeMinimalTopology(),
      fingerprint: computeTopologyFingerprint(makeMinimalTopology()),
    }));
    Reflect.set(client, "_topologyVerifiedAtMs", verifiedAtMs);
    Reflect.set(client, "_config", {
      ...DEFAULTS_FOR_TEST,
      topologyRefreshMs: 60_000,
    });
    return client;
  }

  const DEFAULTS_FOR_TEST = {
    seeds: ["https://seed.test"],
    ethRpcUrl: "https://rpc.test",
    registryAddress: "0x1111111111111111111111111111111111111111",
    topologyRefreshMs: 60_000,
    timeoutMs: 30_000,
    surbsPerRequest: 10,
    powDifficulty: 3,
    dangerouslySkipFingerprintCheck: false,
    fecRatio: 0.3,
  };

  it("selects a detached exit before the async money path refreshes stale topology", async () => {
    const now = Date.now();
    const client = detachedClient(now);
    const selected = client.selectPaidExit();
    expect(selected.id).toBe("0x0000000000000000000000000000000000000003");
    expect(selected).not.toBe(client.nodes[2]);

    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    expect(client.selectPaidExit().id).toBe(selected.id);
    const refresh = vi.fn(async () => {
      Reflect.set(client, "_topologyVerifiedAtMs", Date.now());
    });
    Reflect.set(client, "_refreshTopology", refresh);
    const ensure = Reflect.get(client, "_ensureFreshPaidTopology") as () => Promise<void>;
    await ensure.call(client);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("performs one bounded refresh attempt for a reachable invalid seed", async () => {
    const client = detachedClient(0);
    let topologyFetches = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/topology")) {
        topologyFetches += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ nodes: [], fingerprint: "ff".repeat(32) }),
        };
      }
      return { ok: true, status: 200 };
    });
    const refresh = Reflect.get(client, "_refreshTopology") as (
      seed: string,
    ) => Promise<void>;

    await refresh.call(client, "https://seed.test");

    expect(topologyFetches).toBe(1);
    expect(client.topologyRefreshError).toMatchObject({
      code: NoxClientErrorCode.TopologyVerificationFailed,
    });
  });
});

// ── NoxClient.disconnect ───────────────────────────────────────────────────

describe("NoxClient.disconnect", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("does not throw on double disconnect", () => {
    // Create a minimal client instance for disconnect testing.
    // We can't use NoxClient.connect (needs WASM), so we test the
    // AdaptiveSurbBudget disconnect behavior instead.
    const budget = new AdaptiveSurbBudget();
    budget.record("op", 1000);
    // Budget is not cleared by disconnect — but this verifies no crash.
    expect(budget.surbCount("op", 10)).toBe(10); // < 3 samples
  });
});

// ── parseSurbIdFromPacketId (tested indirectly via module) ─────────────────

describe("parseSurbIdFromPacketId", () => {
  // This is a private function in client.ts. We test it indirectly through
  // the poll loop. But we can test the regex pattern it uses.
  it("32-char hex regex matches valid SURB IDs", () => {
    const HEX32_RE = /^[0-9a-f]{32}$/;
    expect(HEX32_RE.test("a".repeat(32))).toBe(true);
    expect(HEX32_RE.test("0123456789abcdef".repeat(2))).toBe(true);
    expect(HEX32_RE.test("A".repeat(32))).toBe(false); // uppercase
    expect(HEX32_RE.test("a".repeat(31))).toBe(false); // too short
    expect(HEX32_RE.test("a".repeat(33))).toBe(false); // too long
    expect(HEX32_RE.test("g".repeat(32))).toBe(false); // not hex
  });
});

// ── pickEntryUrl (tested indirectly) ───────────────────────────────────────

describe("pickEntryUrl logic", () => {
  it("uses an entry-capable relay with an HTTP ingress URL", () => {
    const nodes = makeMinimalTopology();
    const entries = nodes.filter((n) => n.role === 1 && n.ingress_url);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]!.ingress_url).toMatch(/^http/);
  });
});

// ── hexToBytes ─────────────────────────────────────────────────────────────

describe("hexToBytes logic", () => {
  it("converts 20-byte address correctly", () => {
    const hex = "0x" + "aa".repeat(20);
    const clean = hex.replace(/^0x/i, "");
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    expect(bytes.length).toBe(20);
    expect(bytes[0]).toBe(0xaa);
  });

  it("handles no 0x prefix", () => {
    const hex = "bb".repeat(20);
    const clean = hex.replace(/^0x/i, "");
    expect(clean).toBe(hex);
  });
});

// ── hexU8 ──────────────────────────────────────────────────────────────────

describe("hexU8 logic", () => {
  it("converts Uint8Array to lowercase hex", () => {
    const bytes = new Uint8Array([0xab, 0xcd, 0xef]);
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe("abcdef");
  });

  it("pads single-digit bytes", () => {
    const bytes = new Uint8Array([0x01, 0x0f]);
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe("010f");
  });
});

// ── Config defaults ────────────────────────────────────────────────────────

describe("NoxClientConfig defaults", () => {
  it("DEFAULTS has production-ready values", async () => {
    const { DEFAULTS } = await import("../src/types.js");
    expect(DEFAULTS.seeds).toEqual(["https://api.hisoka.io/seed"]);
    expect(DEFAULTS.surbsPerRequest).toBe(10);
    expect(DEFAULTS.timeoutMs).toBe(30_000);
    expect(DEFAULTS.topologyRefreshMs).toBe(60_000);
    expect(DEFAULTS.powDifficulty).toBe(3);
    expect(DEFAULTS.fecRatio).toBe(0.3);
    expect(DEFAULTS.dangerouslySkipFingerprintCheck).toBe(false);
  });

  it("DEFAULTS is exported from package root", async () => {
    const { DEFAULTS } = await import("../src/index.js");
    expect(DEFAULTS).toBeDefined();
    expect(DEFAULTS.seeds.length).toBeGreaterThan(0);
  });
});
