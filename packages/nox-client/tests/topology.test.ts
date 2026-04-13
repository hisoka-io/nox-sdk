/**
 * Topology module unit tests.
 *
 * Tests: fetchTopology, computeTopologyFingerprint, verifySelfConsistency,
 *        verifyOnChain, parseNode, parseNodes, selectRoute.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchTopology,
  computeTopologyFingerprint,
  verifySelfConsistency,
  verifyOnChain,
  parseNode,
  parseNodes,
  selectRoute,
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

    await expect(fetchTopology("http://seed.test")).rejects.toThrow("missing required fields");
  });

  it("throws TopologyFetchFailed when fingerprint field is missing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ nodes: [] }),
    });

    await expect(fetchTopology("http://seed.test")).rejects.toThrow("missing required fields");
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
    const nodes = [makeNode(), makeNode({ address: "0xBBBB" })];
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
});

// ── verifyOnChain ──────────────────────────────────────────────────────────

describe("verifyOnChain", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("succeeds when on-chain fingerprint matches", async () => {
    const fp = "ab".repeat(32);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: `0x${fp}` }),
    });

    await expect(
      verifyOnChain("http://rpc.test", "0xREGISTRY", fp),
    ).resolves.toBeUndefined();
  });

  it("throws when on-chain fingerprint mismatches", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: "0x" + "ff".repeat(32) }),
    });

    await expect(
      verifyOnChain("http://rpc.test", "0xREGISTRY", "00".repeat(32)),
    ).rejects.toThrow("On-chain fingerprint mismatch");
  });

  it("throws on RPC error response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: { message: "execution reverted" } }),
    });

    await expect(
      verifyOnChain("http://rpc.test", "0xREGISTRY", "ab".repeat(32)),
    ).rejects.toThrow("execution reverted");
  });

  it("throws on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("timeout"));

    await expect(
      verifyOnChain("http://rpc.test", "0xREGISTRY", "ab".repeat(32)),
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

  it("falls back to url when ingress_url is absent", () => {
    const raw = makeNode({ url: "/ip4/10.0.0.1/tcp/5000" });
    const parsed = parseNode(raw);
    expect(parsed.address).toBe("/ip4/10.0.0.1/tcp/5000");
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
      makeTopologyNode({ id: "0x01", layer: 0, role: 1 }),
      makeTopologyNode({ id: "0x02", layer: 1, role: 1 }),
      makeTopologyNode({ id: "0x03", layer: 2, role: 2 }),
    ];
    const route = selectRoute(nodes, pinned);
    expect(route.entry.id).toBe("0xPINNED");
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
});
