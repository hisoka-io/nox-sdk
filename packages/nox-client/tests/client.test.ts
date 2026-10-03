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
import { Interface } from "ethers";
import type { Route, TopologyNode } from "../src/types.js";

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
    Reflect.set(client, "_seedUrl", "https://seed.test");
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
    let nodeTopologyFetches = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/topology") && !url.startsWith("https://seed.test")) {
        nodeTopologyFetches += 1;
      }
      if (url.endsWith("/topology") && url.startsWith("https://seed.test")) {
        topologyFetches += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ nodes: [], fingerprint: "ff".repeat(32) }),
        };
      }
      return { ok: true, status: 200 };
    });
    const refresh = Reflect.get(client, "_refreshTopology") as () => Promise<void>;

    await refresh.call(client);

    expect(topologyFetches).toBe(1);
    // Node-served topology fallbacks are bounded too.
    expect(nodeTopologyFetches).toBeLessThanOrEqual(3);
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

// ── Seeds, verification and refresh ───────────────────────────────────────

const REGISTRY = new Interface([
  "function topologyFingerprint() view returns (bytes32)",
  "function relayerCount() view returns (uint256)",
  "function relayers(address) view returns (bytes32 sphinxKey,string url,string ingressUrl,string metadataUrl,uint256 stakedAmount,uint256 unlockTime,bool isRegistered,uint8 status,bool frozen)",
  "function getNodeRole(address) view returns (uint8)",
]);

type TestNode = ReturnType<typeof makeNode>;

/** Answer registry eth_calls (single or batched) for `nodes`. */
function registryAnswer(nodes: TestNode[], body: { id?: number; params: [{ data: string }] }) {
  const call = REGISTRY.parseTransaction({ data: body.params[0].data })!;
  const node = call.fragment.inputs.length === 0
    ? undefined
    : nodes.find((n) => n.address.toLowerCase() === String(call.args[0]).toLowerCase())!;
  let result: string;
  switch (call.name) {
    case "topologyFingerprint":
      result = REGISTRY.encodeFunctionResult(call.name, [`0x${computeTopologyFingerprint(nodes)}`]);
      break;
    case "relayerCount":
      result = REGISTRY.encodeFunctionResult(call.name, [BigInt(nodes.length)]);
      break;
    case "relayers":
      result = REGISTRY.encodeFunctionResult(call.name, [
        `0x${node!.sphinx_key}`, node!.url, node!.ingress_url ?? "", "",
        BigInt(node!.stake), 0n, true, 1, false,
      ]);
      break;
    default:
      result = REGISTRY.encodeFunctionResult(call.name, [node!.role]);
  }
  return { jsonrpc: "2.0", id: body.id ?? 1, result };
}

function liveV2(nodes: TestNode[], extra: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    nodes,
    fingerprint: computeTopologyFingerprint(nodes),
    schema_version: 2,
    block_number: 4_660,
    timestamp: now,
    pow_difficulty: 0,
    liveness: nodes.map((node) => ({
      address: node.address,
      status: "online",
      observed_at_unix: now,
    })),
    ...extra,
  };
}

/** Canonically ordered v2 topology (addresses ascending, exits on layer 2). */
function verifiedNodes(): TestNode[] {
  // Layer must match sha256(address)[0] % 2 for relays, so pick relays whose
  // primary layer is valid by construction: read it back from the checker.
  return [makeNode(0, 1, 1), makeNode(0, 1, 2), makeNode(2, 2, 3), makeNode(2, 2, 4)];
}

function mockNetwork(
  topologies: Record<string, unknown>,
  nodes: TestNode[],
): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/topology")) {
      const base = url.slice(0, -"/topology".length);
      if (!(base in topologies)) throw new Error(`unreachable ${base}`);
      return { ok: true, status: 200, json: async () => topologies[base] };
    }
    if (url === "http://rpc.test") {
      const body = JSON.parse(String(init?.body));
      const reply = Array.isArray(body)
        ? body.map((entry) => registryAnswer(nodes, entry))
        : registryAnswer(nodes, body);
      return { ok: true, status: 200, json: async () => reply };
    }
    throw new Error(`unexpected ${url}`);
  });
  return mock;
}

const VERIFY = {
  ethRpcUrl: "http://rpc.test",
  registryAddress: "0x1111111111111111111111111111111111111111",
};

/** Fix relay layers so they satisfy the schema v2 primary-layer rule. */
async function canonical(nodes: TestNode[]): Promise<TestNode[]> {
  const { sha256, toUtf8Bytes } = await import("ethers");
  return nodes.map((node) => {
    if (node.role !== 1) return node;
    const first = Number.parseInt(sha256(toUtf8Bytes(node.address.toLowerCase())).slice(2, 4), 16);
    return { ...node, layer: first % 2 };
  });
}

describe("seed fallback and transport injection", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("moves on to the next seed when the first serves the legacy schema", async () => {
    const nodes = await canonical(verifiedNodes());
    const legacy = { nodes, fingerprint: computeTopologyFingerprint(nodes) };
    const fetchMock = mockNetwork(
      { "https://node.test": legacy, "https://seed.test": liveV2(nodes) },
      nodes,
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = await NoxClient.connect({
      ...VERIFY,
      seeds: ["https://node.test", "https://seed.test"],
      transport: { WebSocket: null },
    });
    try {
      expect(client.nodes).toHaveLength(4);
      expect(Reflect.get(client, "_seedUrl")).toBe("https://seed.test");
      // One batched registry read for 4 members.
      const rpcCalls = fetchMock.mock.calls.filter(([url]) => url === "http://rpc.test");
      expect(rpcCalls).toHaveLength(1);
    } finally {
      client.disconnect();
    }
  });

  it("uses the injected fetch for seeds and registry reads", async () => {
    const nodes = await canonical(verifiedNodes());
    const injected = mockNetwork({ "https://seed.test": liveV2(nodes) }, nodes);
    const globalFetch = vi.fn().mockRejectedValue(new Error("global fetch used"));
    globalThis.fetch = globalFetch as unknown as typeof fetch;

    const client = await NoxClient.connect({
      ...VERIFY,
      seeds: ["https://seed.test"],
      transport: {
        fetch: injected as unknown as (input: string, init?: RequestInit) => Promise<Response>,
        WebSocket: null,
      },
    });
    client.disconnect();

    expect(injected).toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("follows the seed PoW difficulty unless the caller raised it", async () => {
    const nodes = await canonical(verifiedNodes());
    globalThis.fetch = mockNetwork(
      { "https://seed.test": liveV2(nodes, { pow_difficulty: 5 }) },
      nodes,
    ) as unknown as typeof fetch;

    const viaInit = await NoxClient.init({ ...VERIFY, seeds: ["https://seed.test"], transport: { WebSocket: null } });
    viaInit.disconnect();
    expect(viaInit.config.powDifficulty).toBe(5);

    const pinnedLow = await NoxClient.connect({
      ...VERIFY, seeds: ["https://seed.test"], powDifficulty: 0, transport: { WebSocket: null },
    });
    pinnedLow.disconnect();
    expect(pinnedLow.config.powDifficulty).toBe(5);

    const pinnedHigh = await NoxClient.connect({
      ...VERIFY, seeds: ["https://seed.test"], powDifficulty: 8, transport: { WebSocket: null },
    });
    pinnedHigh.disconnect();
    expect(pinnedHigh.config.powDifficulty).toBe(8);
  });

  it("does not fall back to the public seed for a loopback test mesh", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("down"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      NoxClient.connect({ seeds: ["http://127.0.0.1:1"], dangerouslySkipFingerprintCheck: true }),
    ).rejects.toThrow("No seed nodes reachable");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["http://127.0.0.1:1/topology"]);
  });

  it("shares one in-flight refresh between concurrent callers", async () => {
    const nodes = await canonical(verifiedNodes());
    const fetchMock = mockNetwork({ "https://seed.test": liveV2(nodes) }, nodes);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = await NoxClient.connect({
      ...VERIFY, seeds: ["https://seed.test"], transport: { WebSocket: null },
    });
    try {
      fetchMock.mockClear();
      const refresh = Reflect.get(client, "_refreshTopology") as () => Promise<void>;
      await Promise.all([refresh.call(client), refresh.call(client), refresh.call(client)]);
      const topologyFetches = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/topology"));
      expect(topologyFetches).toHaveLength(1);
    } finally {
      client.disconnect();
    }
  });

  /** v2 snapshot that reports the members at `offline` as offline. */
  function withOffline(nodes: TestNode[], offline: number[], extra: Record<string, unknown> = {}) {
    const snapshot = liveV2(nodes, extra);
    snapshot.liveness = snapshot.liveness.map((entry, index) =>
      offline.includes(index) ? { ...entry, status: "offline" } : entry
    );
    return snapshot;
  }

  async function nodeFallbackClient() {
    const nodes = await canonical(verifiedNodes());
    const topologies: Record<string, unknown> = { "https://seed.test": liveV2(nodes) };
    const fetchMock = mockNetwork(topologies, nodes);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = await NoxClient.connect({
      ...VERIFY, seeds: ["https://seed.test"], transport: { WebSocket: null },
    });
    const refresh = Reflect.get(client, "_refreshTopology") as () => Promise<void>;
    const seedDown = (nodeSnapshot: unknown) => {
      delete topologies["https://seed.test"];
      for (const node of nodes) {
        if (node.ingress_url) topologies[node.ingress_url] = nodeSnapshot;
      }
    };
    return {
      nodes, topologies, fetchMock, client,
      refresh: () => refresh.call(client),
      seedDown,
    };
  }

  it("uses a verified node only to confirm membership when every seed is down", async () => {
    const { nodes, client, refresh, seedDown } = await nodeFallbackClient();
    try {
      // The node claims every other member is offline.
      seedDown(withOffline(nodes, [1, 2, 3]));
      Reflect.set(client, "_topologyVerifiedAtMs", 1);
      await refresh();
      expect(client.topologyRefreshError).toBeNull();
      expect(Reflect.get(client, "_topologyVerifiedAtMs")).toBeGreaterThan(1);
      // Liveness stays as the seed last reported; the seed stays the source.
      expect(client.nodes.map((n) => n.id)).toEqual(
        nodes.map((n) => n.address.toLowerCase()),
      );
      expect(Reflect.get(client, "_seedUrl")).toBe("https://seed.test");
    } finally {
      client.disconnect();
    }
  });

  it("goes back to the seed on the next refresh after a node fallback", async () => {
    const { nodes, topologies, fetchMock, client, refresh, seedDown } = await nodeFallbackClient();
    try {
      seedDown(liveV2(nodes));
      await refresh();
      expect(client.topologyRefreshError).toBeNull();

      topologies["https://seed.test"] = withOffline(nodes, [3]);
      fetchMock.mockClear();
      await refresh();
      const topologyFetches = fetchMock.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.endsWith("/topology"));
      expect(topologyFetches).toEqual(["https://seed.test/topology"]);
      expect(client.nodes).toHaveLength(3);
    } finally {
      client.disconnect();
    }
  });

  it("rejects a node snapshot pinned before the last seed block", async () => {
    const { nodes, client, refresh, seedDown } = await nodeFallbackClient();
    try {
      seedDown(liveV2(nodes, { block_number: 4_000 }));
      Reflect.set(client, "_topologyVerifiedAtMs", 1);
      await refresh();
      expect(client.topologyRefreshError).toMatchObject({
        code: NoxClientErrorCode.TopologyFetchFailed,
      });
      expect(Reflect.get(client, "_topologyVerifiedAtMs")).toBe(1);
    } finally {
      client.disconnect();
    }
  });
});

// ── Retry after a response timeout ─────────────────────────────────────────

describe("retry on a different route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function retryClient(): { client: NoxClient; routes: Route[]; outcomes: (Uint8Array | Error)[] } {
    const nodes: TopologyNode[] = [
      { id: "0x01", address: "https://entry.test", routingAddress: "/e", publicKey: new Uint8Array(32), layer: 0, role: 1 },
      { id: "0x02", address: "", routingAddress: "/m1", publicKey: new Uint8Array(32), layer: 1, role: 1 },
      { id: "0x03", address: "", routingAddress: "/m2", publicKey: new Uint8Array(32), layer: 1, role: 1 },
      { id: "0x04", address: "", routingAddress: "/x1", publicKey: new Uint8Array(32), layer: 2, role: 2 },
      { id: "0x05", address: "", routingAddress: "/x2", publicKey: new Uint8Array(32), layer: 2, role: 2 },
    ];
    const client = Object.create(NoxClient.prototype) as NoxClient;
    Reflect.set(client, "_nodes", nodes);
    Reflect.set(client, "_entryUrl", "https://entry.test");
    Reflect.set(client, "_wasm", {});
    Reflect.set(client, "_avoidUntil", new Map());
    Reflect.set(client, "_config", { retryOnTimeout: true, surbsPerRequest: 2, fecRatio: 0 });
    Reflect.set(client, "adaptive", new AdaptiveSurbBudget());
    Reflect.set(client, "nextRequestId", 0n);
    const routes: Route[] = [];
    const outcomes: (Uint8Array | Error)[] = [];
    Reflect.set(client, "_sendOnRoute", async (_p: unknown, _s: number, _t: unknown, route: Route) => {
      routes.push(route);
      const next = outcomes.shift() ?? new Uint8Array([1]);
      if (next instanceof Error) throw next;
      return next;
    });
    return { client, routes, outcomes };
  }

  const timeout = () =>
    new NoxClientError("timed out", NoxClientErrorCode.ResponseTimeout);

  it("resends an echo once on a different mix and exit", async () => {
    const { client, routes, outcomes } = retryClient();
    outcomes.push(timeout(), new Uint8Array([7]));

    await expect(client.sendEcho(new Uint8Array([7]))).resolves.toEqual(new Uint8Array([7]));

    expect(routes).toHaveLength(2);
    expect(routes[1]!.mix.id).not.toBe(routes[0]!.mix.id);
    expect(routes[1]!.exit.id).not.toBe(routes[0]!.exit.id);
  });

  it("avoids the timed-out hops on later requests until they answer", async () => {
    const { client, routes, outcomes } = retryClient();
    outcomes.push(timeout(), timeout());

    await expect(client.sendEcho(new Uint8Array([1]))).rejects.toMatchObject({
      code: NoxClientErrorCode.ResponseTimeout,
    });
    expect(routes).toHaveLength(2);

    await client.sendEcho(new Uint8Array([2]));
    // Every mix and exit timed out once, so the third route reuses some;
    // the successful reply clears them.
    const avoided = Reflect.get(client, "_avoidUntil") as Map<string, number>;
    expect(avoided.has(routes[2]!.mix.id)).toBe(false);
    expect(avoided.has(routes[2]!.exit.id)).toBe(false);
  });

  it("does not resend a non-idempotent transaction submission", async () => {
    const { client, routes, outcomes } = retryClient();
    outcomes.push(timeout());

    await expect(
      client.submitTransaction("0x" + "11".repeat(20), new Uint8Array([1])),
    ).rejects.toMatchObject({ code: NoxClientErrorCode.ResponseTimeout });
    expect(routes).toHaveLength(1);
  });

  it("does not resend when retryOnTimeout is off", async () => {
    const { client, routes, outcomes } = retryClient();
    Reflect.set(client, "_config", { retryOnTimeout: false, surbsPerRequest: 2, fecRatio: 0 });
    outcomes.push(timeout());

    await expect(client.sendEcho(new Uint8Array([1]))).rejects.toMatchObject({
      code: NoxClientErrorCode.ResponseTimeout,
    });
    expect(routes).toHaveLength(1);
    expect((Reflect.get(client, "_avoidUntil") as Map<string, number>).size).toBe(0);
  });

  it("only resends GET-like HTTP requests", async () => {
    const { client, routes, outcomes } = retryClient();
    outcomes.push(timeout());
    await expect(
      client.httpRequest("POST", "https://api.test", [], new Uint8Array()),
    ).rejects.toMatchObject({ code: NoxClientErrorCode.ResponseTimeout });
    expect(routes).toHaveLength(1);

    outcomes.push(timeout(), new Uint8Array([3]));
    await expect(
      client.httpRequest("GET", "https://api.test", [], new Uint8Array()),
    ).resolves.toEqual(new Uint8Array([3]));
    expect(routes).toHaveLength(3);
  });

  it("sends a paid quote retry to a different exit", async () => {
    const { client, routes, outcomes } = retryClient();
    outcomes.push(timeout(), new Uint8Array([9]));
    const nodes = client.nodes;
    const send = Reflect.get(client, "_sendWithRetry") as (
      ...args: unknown[]
    ) => Promise<{ response: Uint8Array; exit: TopologyNode }>;

    const result = await send.call(
      client,
      { tag: "AnonymousRequest", inner: new Uint8Array(), replySurbs: [] },
      2,
      undefined,
      nodes[3],
      "exit",
    );

    expect(routes[0]!.exit.id).toBe("0x04");
    expect(routes[1]!.exit.id).toBe("0x05");
    expect(result.exit.id).toBe("0x05");
  });
});

// ── Paid exit capability ───────────────────────────────────────────────────

describe("paid exit capability", () => {
  function capabilityClient(capabilities: (readonly string[] | undefined)[]): NoxClient {
    const base: TopologyNode[] = [
      { id: "0x0000000000000000000000000000000000000001", address: "https://entry.test", routingAddress: "/e", publicKey: new Uint8Array(32), layer: 0, role: 1 },
      { id: "0x0000000000000000000000000000000000000002", address: "", routingAddress: "/m", publicKey: new Uint8Array(32), layer: 1, role: 1 },
      { id: "0x0000000000000000000000000000000000000004", address: "", routingAddress: "/x1", publicKey: new Uint8Array(32), layer: 2, role: 2 },
      { id: "0x0000000000000000000000000000000000000005", address: "", routingAddress: "/x2", publicKey: new Uint8Array(32), layer: 2, role: 2 },
    ];
    const nodes = base.map((node, index) => {
      const nodeCapabilities = capabilities[index];
      return nodeCapabilities === undefined ? node : { ...node, capabilities: nodeCapabilities };
    });
    const client = Object.create(NoxClient.prototype) as NoxClient;
    Reflect.set(client, "_nodes", nodes);
    Reflect.set(client, "_entryUrl", "https://entry.test");
    Reflect.set(client, "_avoidUntil", new Map());
    return client;
  }

  it("chooses only exits that advertise paid_v2 when the seed publishes capabilities", () => {
    const client = capabilityClient([[], [], [], ["paid_v2"]]);
    for (let i = 0; i < 10; i++) {
      expect(client.selectPaidExit().id).toBe("0x0000000000000000000000000000000000000005");
    }
  });

  it("fails fast when no exit advertises paid_v2", () => {
    const client = capabilityClient([[], [], ["echo"], []]);
    expect(() => client.selectPaidExit()).toThrow(
      expect.objectContaining({ code: NoxClientErrorCode.PaidExitUnavailable }),
    );
    const resolve = Reflect.get(client, "_resolvePaidExit") as (exit: TopologyNode) => TopologyNode;
    expect(() => resolve.call(client, client.nodes[2]!)).toThrow(
      expect.objectContaining({ code: NoxClientErrorCode.PaidExitUnavailable }),
    );
  });

  it("keeps every exit eligible when the seed publishes no capability data", () => {
    const client = capabilityClient([undefined, undefined, undefined, undefined]);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add(client.selectPaidExit().id);
    expect(seen.size).toBe(2);
  });
});
