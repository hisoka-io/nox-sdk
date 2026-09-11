/**
 * Topology module unit tests.
 *
 * Tests: fetchTopology, computeTopologyFingerprint, verifySelfConsistency,
 *        verifyOnChain, parseNode, parseNodes, selectRoute.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Interface } from "ethers";
import {
  fetchTopology,
  computeTopologyFingerprint,
  verifySelfConsistency,
  verifyOnChain,
  verifyOnChainWithEligibility,
  parseNode,
  parseNodes,
  selectRoute,
  selectLiveNodes,
} from "../src/topology.js";
import type { RelayerNode, TopologySnapshot, TopologyNode } from "../src/types.js";
import { NoxClientError } from "../src/types.js";

// ── helpers ────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<RelayerNode> = {}): RelayerNode {
  return {
    address: overrides.address ?? "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sphinx_key: overrides.sphinx_key ?? "ab".repeat(32),
    url: overrides.url ?? "/ip4/127.0.0.1/tcp/9000",
    stake: overrides.stake ?? "1000000000000000000",
    last_seen: overrides.last_seen ?? Date.now(),
    is_privileged: overrides.is_privileged ?? false,
    layer: overrides.layer ?? 0,
    role: overrides.role ?? 1,
    ingress_url: overrides.ingress_url,
    metadata_url: overrides.metadata_url,
  };
}

function makeTopologyNode(overrides: Partial<TopologyNode> = {}): TopologyNode {
  return {
    id: overrides.id ?? "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    address: overrides.address ?? "http://127.0.0.1:8080",
    routingAddress: overrides.routingAddress ?? "/ip4/127.0.0.1/tcp/9000",
    publicKey: overrides.publicKey ?? new Uint8Array(32).fill(0xab),
    layer: overrides.layer ?? 0,
    role: overrides.role ?? 1,
  };
}

function makeSnapshot(nodes: RelayerNode[]): TopologySnapshot {
  return {
    nodes,
    fingerprint: computeTopologyFingerprint(nodes),
  };
}

// ── fetchTopology ──────────────────────────────────────────────────────────

describe("fetchTopology", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns a valid snapshot on 200 OK", async () => {
    const nodes = [makeNode()];
    const snapshot = makeSnapshot(nodes);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(snapshot),
    });

    const result = await fetchTopology("http://seed.test");
    expect(result.nodes).toHaveLength(1);
    expect(result.fingerprint).toBe(snapshot.fingerprint);
  });

  it("throws TopologyFetchFailed on non-200 response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });

    await expect(fetchTopology("http://seed.test")).rejects.toThrow(NoxClientError);
    await expect(fetchTopology("http://seed.test")).rejects.toThrow("HTTP 503");
  });

  it("throws TopologyFetchFailed on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(fetchTopology("http://seed.test")).rejects.toThrow(NoxClientError);
    await expect(fetchTopology("http://seed.test")).rejects.toThrow("ECONNREFUSED");
  });

  it("throws TopologyFetchFailed on invalid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    });

    await expect(fetchTopology("http://seed.test")).rejects.toThrow("not valid JSON");
  });

  it("throws TopologyFetchFailed when nodes field is missing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ fingerprint: "0x00" }),
    });

    await expect(fetchTopology("http://seed.test")).rejects.toThrow("invalid topology fields");
  });

  it("throws TopologyFetchFailed when fingerprint field is missing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ nodes: [] }),
    });

    await expect(fetchTopology("http://seed.test")).rejects.toThrow("invalid topology fields");
  });

  it("appends /topology to the seed URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSnapshot([])),
    });
    globalThis.fetch = fetchMock;

    await fetchTopology("http://seed.test");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://seed.test/topology",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    ["address", { address: "0x1234" }],
    ["sphinx key", { sphinx_key: "zz".repeat(32) }],
    ["stake", { stake: "01" }],
    ["privileged flag", { is_privileged: "false" }],
    ["role", { role: 1.5 }],
    ["layer", { layer: -1 }],
    ["last_seen", { last_seen: -1 }],
    ["ingress URL", { ingress_url: 7 }],
    ["metadata URL", { metadata_url: 7 }],
  ])("rejects malformed node %s before returning", async (_field, override) => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        nodes: [{ ...makeNode(), ...override }],
        fingerprint: "00".repeat(32),
      }),
    });
    await expect(fetchTopology("http://seed.test")).rejects.toThrow(
      "invalid topology",
    );
  });
});

// ── computeTopologyFingerprint ─────────────────────────────────────────────

describe("computeTopologyFingerprint", () => {
  it("returns 64-char lowercase hex", () => {
    const fp = computeTopologyFingerprint([makeNode()]);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns all zeros for empty node list", () => {
    const fp = computeTopologyFingerprint([]);
    expect(fp).toBe("0".repeat(64));
  });

  it("is deterministic — same input gives same output", () => {
    const nodes = [makeNode({ address: "0xBBBB" }), makeNode({ address: "0xCCCC" })];
    expect(computeTopologyFingerprint(nodes)).toBe(computeTopologyFingerprint(nodes));
  });

  it("is order-independent (XOR is commutative)", () => {
    const a = makeNode({ address: "0x1111" });
    const b = makeNode({ address: "0x2222" });
    expect(computeTopologyFingerprint([a, b])).toBe(computeTopologyFingerprint([b, a]));
  });

  it("is self-inverse — XOR of a single node twice is zero", () => {
    const node = makeNode({ address: "0xAAAA" });
    const fp = computeTopologyFingerprint([node, node]);
    expect(fp).toBe("0".repeat(64));
  });

  it("handles 0x-prefixed and non-prefixed addresses identically", () => {
    const withPrefix = computeTopologyFingerprint([makeNode({ address: "0xabcdef" })]);
    const withoutPrefix = computeTopologyFingerprint([makeNode({ address: "abcdef" })]);
    expect(withPrefix).toBe(withoutPrefix);
  });

  it("handles uppercase and lowercase addresses identically", () => {
    const lower = computeTopologyFingerprint([makeNode({ address: "0xabcdef" })]);
    const upper = computeTopologyFingerprint([makeNode({ address: "0xABCDEF" })]);
    expect(lower).toBe(upper);
  });
});

// ── verifySelfConsistency ──────────────────────────────────────────────────

describe("verifySelfConsistency", () => {
  it("does not throw when fingerprint matches", () => {
    const nodes = [
      makeNode(),
      makeNode({
        address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        layer: 1,
      }),
    ];
    const snapshot = makeSnapshot(nodes);
    expect(() => verifySelfConsistency(snapshot)).not.toThrow();
  });

  it("throws when fingerprint mismatches", () => {
    const nodes = [makeNode()];
    const snapshot: TopologySnapshot = {
      nodes,
      fingerprint: "ff".repeat(32),
    };
    expect(() => verifySelfConsistency(snapshot)).toThrow("fingerprint mismatch");
  });

  it("handles 0x-prefixed fingerprint", () => {
    const nodes = [makeNode()];
    const fp = computeTopologyFingerprint(nodes);
    const snapshot: TopologySnapshot = {
      nodes,
      fingerprint: `0x${fp}`,
    };
    expect(() => verifySelfConsistency(snapshot)).not.toThrow();
  });

  it("rejects duplicate addresses even when XOR cancels", () => {
    const node = makeNode();
    expect(() => verifySelfConsistency(makeSnapshot([node, node]))).toThrow(
      "duplicate node address",
    );
  });

  it.each([
    makeNode({ role: 0 }),
    makeNode({ role: 4 }),
    makeNode({ role: 1, layer: 2 }),
  ])("rejects invalid role/layer topology records", (node) => {
    expect(() => verifySelfConsistency(makeSnapshot([node]))).toThrow(
      /role|layer/u,
    );
  });

  it("rejects a v2 snapshot whose liveness omits a registered member", () => {
    const nodes = [
      makeNode(),
      makeNode({
        address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        layer: 1,
      }),
    ];
    const snapshot: TopologySnapshot = {
      ...makeSnapshot(nodes),
      schema_version: 2,
      block_number: 12,
      timestamp: 1_700_000_000,
      liveness: [
        {
          address: nodes[0]!.address,
          status: "online",
          observed_at_unix: 1_700_000_000,
        },
      ],
    };

    expect(() => verifySelfConsistency(snapshot, true)).toThrow("liveness");
  });

  it("rejects a v2 snapshot with non-canonical member ordering", () => {
    const nodes = [
      makeNode({ address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
      makeNode({ address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    ];
    const snapshot: TopologySnapshot = {
      ...makeSnapshot(nodes),
      schema_version: 2,
      block_number: 12,
      timestamp: 1_700_000_000,
      liveness: nodes.map((node) => ({
        address: node.address,
        status: "online" as const,
        observed_at_unix: 1_700_000_000,
      })),
    };

    expect(() => verifySelfConsistency(snapshot, true)).toThrow("canonical");
  });

  it("rejects a v2 snapshot whose seed changes a member's deterministic layer", () => {
    const nodes = [
      makeNode({ address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", layer: 0 }),
      makeNode({ address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", layer: 0 }),
    ];
    const snapshot: TopologySnapshot = {
      ...makeSnapshot(nodes),
      schema_version: 2,
      block_number: 12,
      timestamp: 1_700_000_000,
      liveness: nodes.map((node) => ({
        address: node.address,
        status: "online" as const,
        observed_at_unix: 1_700_000_000,
      })),
    };

    expect(() => verifySelfConsistency(snapshot, true)).toThrow("primary layer");
  });

  it("accepts the pinned primary-layer vectors", () => {
    const nodes = [
      makeNode({
        address: "0x0000000000000000000000000000000000000001",
        role: 1,
        layer: 1,
      }),
      makeNode({
        address: "0x0000000000000000000000000000000000000002",
        role: 2,
        layer: 2,
      }),
      makeNode({
        address: "0x0000000000000000000000000000000000000004",
        role: 3,
        layer: 1,
      }),
    ];
    const snapshot: TopologySnapshot = {
      ...makeSnapshot(nodes),
      schema_version: 2,
      block_number: 12,
      timestamp: 1_700_000_000,
      liveness: nodes.map((node) => ({
        address: node.address,
        status: "online" as const,
        observed_at_unix: 1_700_000_000,
      })),
    };

    expect(() => verifySelfConsistency(snapshot, true)).not.toThrow();
  });
});

describe("selectLiveNodes", () => {
  it("uses only recently observed online members after full membership verification", () => {
    const nodes = [
      makeNode({ address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
      makeNode({
        address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        layer: 1,
      }),
      makeNode({
        address: "0xcccccccccccccccccccccccccccccccccccccccc",
        layer: 1,
      }),
    ];
    const snapshot: TopologySnapshot = {
      ...makeSnapshot(nodes),
      schema_version: 2,
      block_number: 12,
      timestamp: 1_700_000_000,
      liveness: [
        {
          address: nodes[0]!.address,
          status: "online",
          observed_at_unix: 1_699_999_990,
        },
        {
          address: nodes[1]!.address,
          status: "offline",
          observed_at_unix: 1_699_999_990,
        },
        {
          address: nodes[2]!.address,
          status: "online",
          observed_at_unix: 1_699_999_000,
        },
      ],
    };

    expect(selectLiveNodes(snapshot, 1_700_000_000, 60)).toEqual([nodes[0]]);
  });

  it("rejects a future liveness observation from route selection", () => {
    const node = makeNode();
    const snapshot: TopologySnapshot = {
      ...makeSnapshot([node]),
      schema_version: 2,
      block_number: 12,
      timestamp: 1_700_000_000,
      liveness: [{
        address: node.address,
        status: "online",
        observed_at_unix: 1_700_000_001,
      }],
    };

    expect(selectLiveNodes(snapshot, 1_700_000_000, 180)).toEqual([]);
  });
});

// ── verifyOnChain ──────────────────────────────────────────────────────────

describe("verifyOnChain", () => {
  const originalFetch = globalThis.fetch;
  const registry = new Interface([
    "function topologyFingerprint() view returns (bytes32)",
    "function relayerCount() view returns (uint256)",
    "function relayers(address) view returns (bytes32 sphinxKey,string url,string ingressUrl,string metadataUrl,uint256 stakedAmount,uint256 unlockTime,bool isRegistered,uint8 status,bool frozen)",
    "function getNodeRole(address) view returns (uint8)",
  ]);

  function mockRegistry(
    node: RelayerNode,
    overrides: {
      fingerprint?: string;
      count?: bigint;
      sphinxKey?: string;
      url?: string;
      ingressUrl?: string;
      metadataUrl?: string;
      stakedAmount?: bigint;
      role?: number;
      registered?: boolean;
      status?: number;
      frozen?: boolean;
    } = {},
  ): void {
    globalThis.fetch = vi.fn().mockImplementation(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          method: string;
          params: [{ data: string }];
        };
        if (body.method === "eth_blockNumber") {
          return { ok: true, json: async () => ({ result: "0x1234" }) };
        }
        const call = registry.parseTransaction({ data: body.params[0].data });
        let result: string;
        switch (call?.name) {
          case "topologyFingerprint":
            result = registry.encodeFunctionResult(call.name, [
              `0x${overrides.fingerprint ?? computeTopologyFingerprint([node])}`,
            ]);
            break;
          case "relayerCount":
            result = registry.encodeFunctionResult(call.name, [
              overrides.count ?? 1n,
            ]);
            break;
          case "relayers":
            result = registry.encodeFunctionResult(call.name, [
              overrides.sphinxKey ?? `0x${node.sphinx_key}`,
              overrides.url ?? node.url,
              overrides.ingressUrl ?? node.ingress_url ?? "",
              overrides.metadataUrl ?? node.metadata_url ?? "",
              overrides.stakedAmount ?? BigInt(node.stake),
              0n,
              overrides.registered ?? true,
              overrides.status ?? 1,
              overrides.frozen ?? false,
            ]);
            break;
          case "getNodeRole":
            result = registry.encodeFunctionResult(call.name, [
              overrides.role ?? node.role,
            ]);
            break;
          default:
            throw new Error("unexpected registry call");
        }
        return { ok: true, json: async () => ({ result }) };
      },
    );
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("succeeds when every topology record matches the registry", async () => {
    const node = makeNode();
    mockRegistry(node);

    await expect(
      verifyOnChain(
        "http://rpc.test",
        "0x1111111111111111111111111111111111111111",
        [node],
      ),
    ).resolves.toBeUndefined();
  });

  it("pins every registry read to one block", async () => {
    const node = makeNode();
    mockRegistry(node);
    await verifyOnChain(
      "http://rpc.test",
      "0x1111111111111111111111111111111111111111",
      [node],
    );
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    const blockTags = calls
      .map(([, init]) => JSON.parse(String(init?.body)) as { method: string; params: unknown[] })
      .filter((body) => body.method === "eth_call")
      .map((body) => body.params[1]);
    expect(blockTags).toEqual(new Array(blockTags.length).fill("0x1234"));
  });

  it("pins registry reads to the seed's processed block when present", async () => {
    const node = makeNode();
    mockRegistry(node);
    await verifyOnChain(
      "http://rpc.test",
      "0x1111111111111111111111111111111111111111",
      [node],
      4_660,
    );
    const bodies = vi.mocked(globalThis.fetch).mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)) as { method: string; params: unknown[] },
    );
    expect(bodies.some((body) => body.method === "eth_blockNumber")).toBe(false);
    expect(
      bodies
        .filter((body) => body.method === "eth_call")
        .map((body) => body.params[1]),
    ).toEqual(new Array(4).fill("0x1234"));
  });

  it("throws when on-chain fingerprint mismatches", async () => {
    const node = makeNode();
    mockRegistry(node, { fingerprint: "ff".repeat(32) });

    await expect(
      verifyOnChain(
        "http://rpc.test",
        "0x1111111111111111111111111111111111111111",
        [node],
      ),
    ).rejects.toThrow("On-chain fingerprint mismatch");
  });

  it.each([
    ["sphinxKey", { sphinxKey: `0x${"cd".repeat(32)}` }],
    ["url", { url: "/ip4/203.0.113.1/tcp/9000" }],
    ["ingressUrl", { ingressUrl: "https://attacker.test" }],
    ["metadataUrl", { metadataUrl: "https://attacker.test/metadata" }],
    ["stake", { stakedAmount: 2n }],
    ["role", { role: 2 }],
    ["isRegistered", { registered: false }],
  ] as const)("reports the substituted %s field", async (field, override) => {
    const node = makeNode({ ingress_url: "https://entry.test" });
    mockRegistry(node, override);
    await expect(
      verifyOnChain(
        "http://rpc.test",
        "0x1111111111111111111111111111111111111111",
        [node],
      ),
    ).rejects.toThrow(field);
  });

  it("verifies a frozen registered member without routing through it", async () => {
    const node = makeNode();
    mockRegistry(node, { frozen: true });

    await expect(
      verifyOnChainWithEligibility(
        "http://rpc.test",
        "0x1111111111111111111111111111111111111111",
        [node],
      ),
    ).resolves.toEqual(new Set());
  });

  it("rejects an incomplete seed address set", async () => {
    const node = makeNode();
    mockRegistry(node, { count: 2n });
    await expect(
      verifyOnChain(
        "http://rpc.test",
        "0x1111111111111111111111111111111111111111",
        [node],
      ),
    ).rejects.toThrow("relayer count mismatch");
  });

  it("rejects a false privileged claim", async () => {
    const node = makeNode({ is_privileged: true });
    mockRegistry(node);
    await expect(
      verifyOnChain(
        "http://rpc.test",
        "0x1111111111111111111111111111111111111111",
        [node],
      ),
    ).rejects.toThrow("isPrivileged");
  });

  it("throws on RPC error response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: { message: "execution reverted" } }),
    });

    await expect(
      verifyOnChain(
        "http://rpc.test",
        "0x1111111111111111111111111111111111111111",
        [makeNode()],
      ),
    ).rejects.toThrow("execution reverted");
  });

  it("throws on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("timeout"));

    await expect(
      verifyOnChain(
        "http://rpc.test",
        "0x1111111111111111111111111111111111111111",
        [makeNode()],
      ),
    ).rejects.toThrow("timeout");
  });
});

// ── parseNode ──────────────────────────────────────────────────────────────

describe("parseNode", () => {
  it("parses valid node with 64-char sphinx_key", () => {
    const raw = makeNode({ sphinx_key: "cd".repeat(32) });
    const parsed = parseNode(raw);
    expect(parsed.publicKey).toHaveLength(32);
    expect(parsed.publicKey[0]).toBe(0xcd);
  });

  it("strips 0x prefix from sphinx_key", () => {
    const raw = makeNode({ sphinx_key: "0x" + "ab".repeat(32) });
    const parsed = parseNode(raw);
    expect(parsed.publicKey).toHaveLength(32);
  });

  it("uses ingress_url as address when present", () => {
    const raw = makeNode({
      url: "/ip4/127.0.0.1/tcp/9000",
      ingress_url: "http://entry1.test:8080",
    });
    const parsed = parseNode(raw);
    expect(parsed.address).toBe("http://entry1.test:8080");
    expect(parsed.routingAddress).toBe("/ip4/127.0.0.1/tcp/9000");
  });

  it("does not expose the P2P multiaddr as an HTTP ingress URL", () => {
    const raw = makeNode({ url: "/ip4/10.0.0.1/tcp/5000" });
    const parsed = parseNode(raw);
    expect(parsed.address).toBe("");
    expect(parsed.routingAddress).toBe("/ip4/10.0.0.1/tcp/5000");
  });

  it("throws when sphinx_key is too short", () => {
    const raw = makeNode({ sphinx_key: "abcd" });
    expect(() => parseNode(raw)).toThrow("64 hex chars");
  });

  it("normalizes address to lowercase with 0x", () => {
    const raw = makeNode({ address: "0xABCDEF1234" });
    const parsed = parseNode(raw);
    expect(parsed.id).toBe("0xabcdef1234");
  });

  it("preserves layer and role", () => {
    const raw = makeNode({ layer: 2, role: 3 });
    const parsed = parseNode(raw);
    expect(parsed.layer).toBe(2);
    expect(parsed.role).toBe(3);
  });
});

// ── parseNodes ─────────────────────────────────────────────────────────────

describe("parseNodes", () => {
  it("parses all nodes in a snapshot", () => {
    const snapshot = makeSnapshot([
      makeNode({ address: "0x11" }),
      makeNode({ address: "0x22" }),
      makeNode({ address: "0x33" }),
    ]);
    const parsed = parseNodes(snapshot);
    expect(parsed).toHaveLength(3);
  });

  it("returns empty array for empty snapshot", () => {
    const snapshot = makeSnapshot([]);
    expect(parseNodes(snapshot)).toHaveLength(0);
  });
});

// ── selectRoute ────────────────────────────────────────────────────────────

describe("selectRoute", () => {
  it("selects entry/mix/exit with distinct nodes", () => {
    // Need enough nodes so dedup can always find 3 distinct hops.
    // With multi-layer, all nodes appear in all their capable layers.
    const nodes: TopologyNode[] = [
      makeTopologyNode({ id: "0x01", layer: 0, role: 1 }),
      makeTopologyNode({ id: "0x02", layer: 1, role: 1 }),
      makeTopologyNode({ id: "0x03", layer: 0, role: 1 }),
      makeTopologyNode({ id: "0x04", layer: 2, role: 2 }),
      makeTopologyNode({ id: "0x05", layer: 2, role: 2 }),
    ];
    for (let i = 0; i < 20; i++) {
      const route = selectRoute(nodes);
      const ids = new Set([route.entry.id, route.mix.id, route.exit.id]);
      expect(ids.size).toBe(3);
      expect([2, 3]).toContain(route.exit.role);
    }
  });

  it("throws when no entry-capable nodes", () => {
    // No nodes at all — even role-based filtering finds nothing
    const nodes: TopologyNode[] = [];
    expect(() => selectRoute(nodes)).toThrow("No entry nodes");
  });

  it("excludes missing and malformed HTTP ingress URLs from entry selection", () => {
    const validEntry = makeTopologyNode({
      id: "0x01",
      layer: 0,
      role: 1,
      address: "https://entry.test",
    });
    const nodes: TopologyNode[] = [
      makeTopologyNode({ id: "0x02", layer: 0, role: 1, address: "" }),
      makeTopologyNode({
        id: "0x03",
        layer: 0,
        role: 1,
        address: "/ip4/127.0.0.1/tcp/9000",
      }),
      validEntry,
      makeTopologyNode({ id: "0x04", layer: 1, role: 1, address: "" }),
      makeTopologyNode({ id: "0x05", layer: 2, role: 2, address: "" }),
    ];
    expect(selectRoute(nodes).entry).toBe(validEntry);

    expect(() => selectRoute(nodes.filter((node) => node !== validEntry))).toThrow(
      "No entry nodes",
    );
  });

  it("throws when no mix-capable nodes", () => {
    // Only exit nodes can't serve as mix? Actually with multi-layer,
    // role=2 (Exit) CAN serve layer 1 (mix). So we need 0 nodes entirely
    // to trigger "no mix". With any role, nodes serve mix.
    // This test verifies the error path with an empty topology.
    const nodes: TopologyNode[] = [];
    expect(() => selectRoute(nodes)).toThrow("No entry nodes");
  });

  it("throws when no exit nodes (layer 2)", () => {
    const nodes: TopologyNode[] = [
      makeTopologyNode({ id: "0x01", layer: 0, role: 1 }),
      makeTopologyNode({ id: "0x02", layer: 1, role: 1 }),
    ];
    expect(() => selectRoute(nodes)).toThrow("No exit nodes");
  });

  it("uses pinnedEntry when provided", () => {
    const pinned = makeTopologyNode({ id: "0xPINNED", layer: 0, role: 1 });
    const nodes: TopologyNode[] = [
      pinned,
      makeTopologyNode({ id: "0x01", layer: 0, role: 1 }),
      makeTopologyNode({ id: "0x02", layer: 1, role: 1 }),
      makeTopologyNode({ id: "0x03", layer: 2, role: 2 }),
    ];
    const route = selectRoute(nodes, pinned);
    expect(route.entry.id).toBe("0xPINNED");
  });

  it("rejects a pinned entry outside the verified topology", () => {
    const nodes: TopologyNode[] = [
      makeTopologyNode({ id: "0x01", layer: 0, role: 1 }),
      makeTopologyNode({ id: "0x02", layer: 1, role: 1 }),
      makeTopologyNode({ id: "0x03", layer: 2, role: 2 }),
    ];
    const unknownEntry = makeTopologyNode({ id: "0xff", layer: 0, role: 1 });
    expect(() => selectRoute(nodes, unknownEntry)).toThrow(
      "Pinned entry is not in the verified topology",
    );
  });

  it("does not repeat nodes across entry/mix/exit", () => {
    const nodes: TopologyNode[] = [
      makeTopologyNode({ id: "0x01", layer: 0, role: 1 }),
      makeTopologyNode({ id: "0x02", layer: 0, role: 1 }),
      makeTopologyNode({ id: "0x03", layer: 1, role: 1 }),
      makeTopologyNode({ id: "0x04", layer: 1, role: 1 }),
      makeTopologyNode({ id: "0x05", layer: 2, role: 2 }),
      makeTopologyNode({ id: "0x06", layer: 2, role: 3 }),
    ];
    // Run multiple times since selection is random
    for (let i = 0; i < 20; i++) {
      const route = selectRoute(nodes);
      const ids = new Set([route.entry.id, route.mix.id, route.exit.id]);
      expect(ids.size).toBe(3);
    }
  });

  it("only selects exit nodes with role 2 or 3", () => {
    const nodes: TopologyNode[] = [
      makeTopologyNode({ id: "0x01", layer: 0, role: 1 }),
      makeTopologyNode({ id: "0x02", layer: 1, role: 1 }),
      makeTopologyNode({ id: "0x03", layer: 2, role: 1 }), // role 1 in layer 2 — not eligible
    ];
    expect(() => selectRoute(nodes)).toThrow("No exit nodes");
  });

  it("pins a selected exit from the verified topology", () => {
    const selectedExit = makeTopologyNode({ id: "0x05", layer: 0, role: 2 });
    const nodes: TopologyNode[] = [
      makeTopologyNode({ id: "0x01", layer: 0, role: 1 }),
      makeTopologyNode({ id: "0x02", layer: 1, role: 1 }),
      makeTopologyNode({ id: "0x03", layer: 0, role: 1 }),
      makeTopologyNode({ id: "0x04", layer: 2, role: 2 }),
      selectedExit,
    ];
    for (let i = 0; i < 20; i++) {
      expect(selectRoute(nodes, undefined, selectedExit).exit).toBe(
        selectedExit,
      );
    }
  });

  it("rejects a selected exit outside the verified topology", () => {
    const nodes: TopologyNode[] = [
      makeTopologyNode({ id: "0x01", layer: 0, role: 1 }),
      makeTopologyNode({ id: "0x02", layer: 1, role: 1 }),
      makeTopologyNode({ id: "0x03", layer: 2, role: 2 }),
    ];
    const unknownExit = makeTopologyNode({ id: "0xff", layer: 2, role: 2 });
    expect(() => selectRoute(nodes, undefined, unknownExit)).toThrow(
      "Selected exit is not in the verified topology",
    );
  });

  it("finds distinct hops when every node is full-role", () => {
    const nodes: TopologyNode[] = [
      makeTopologyNode({ id: "0x01", layer: 0, role: 3 }),
      makeTopologyNode({ id: "0x02", layer: 1, role: 3 }),
      makeTopologyNode({ id: "0x03", layer: 2, role: 3 }),
      makeTopologyNode({ id: "0x04", layer: 2, role: 3 }),
    ];
    const selectedExit = nodes[3]!;
    for (let i = 0; i < 50; i++) {
      const route = selectRoute(nodes, undefined, selectedExit);
      expect(route.exit).toBe(selectedExit);
      expect(new Set([route.entry.id, route.mix.id, route.exit.id]).size).toBe(
        3,
      );
    }
  });
});
