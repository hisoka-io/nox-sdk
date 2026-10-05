/**
 * The discovery bootstrap format (`nox-anon-rpc-bootstrap/1`) and the
 * probation cap in route selection.
 */
import { describe, expect, it } from "vitest";
import { isAllowedRpcUrl, rpcProviderKey, verifyBootstrap } from "../src/kps/bootstrap.js";
import { selectRoute } from "../src/topology.js";
import { NoxClientErrorCode, type TopologyNode } from "../src/types.js";
import { kpsAddressFor } from "./helpers/fake_kps.js";
import { makeBootstrap, makePinned } from "./helpers/pinned_fixture.js";

const pinned = makePinned();

function expectInvalid(value: unknown, pattern: RegExp): void {
  expect(() => verifyBootstrap(value, pinned)).toThrow(
    expect.objectContaining({ code: NoxClientErrorCode.TopologyVerificationFailed, message: expect.stringMatching(pattern) }),
  );
}

describe("verifyBootstrap", () => {
  it("accepts a well-formed bootstrap and returns a frozen copy", () => {
    const raw = makeBootstrap(pinned, { anchors: [kpsAddressFor(1), kpsAddressFor(2)] });
    const verified = verifyBootstrap(raw, pinned);
    expect(verified).toEqual(raw);
    expect(Object.isFrozen(verified.policy)).toBe(true);
    expect(Object.isFrozen(verified.anchors)).toBe(true);
  });

  it("binds the bootstrap to the snapshot's chain and registry", () => {
    expectInvalid({ ...makeBootstrap(pinned), chainId: 1 }, /chainId/u);
    expectInvalid({ ...makeBootstrap(pinned), registry: `0x${"11".repeat(20)}` }, /registry differs/u);
    expectInvalid({ ...makeBootstrap(pinned), registryImpl: `0x${"00".repeat(20)}` }, /registryImpl/u);
    expectInvalid({ ...makeBootstrap(pinned), registryImpl: "0x7285125CFDCB6337aaed2d56d4fe99f870ede2a2" }, /registryImpl/u);
  });

  it("rejects unknown and missing fields, at the top and in the policy", () => {
    expectInvalid({ ...makeBootstrap(pinned), extra: true }, /unknown field "extra"/u);
    const missing: Record<string, unknown> = { ...makeBootstrap(pinned) };
    delete missing["anchors"];
    expectInvalid(missing, /missing "anchors"/u);
    const bootstrap = makeBootstrap(pinned);
    expectInvalid({ ...bootstrap, policy: { ...bootstrap.policy, surprise: 1 } }, /policy has an unknown field/u);
    expectInvalid({ ...bootstrap, format: "nox-anon-rpc-bootstrap/2" }, /format/u);
    expectInvalid("not an object", /not an object/u);
  });

  it("checks anchors: well-formed, unique, at most 16", () => {
    expectInvalid(makeBootstrap(pinned, { anchors: ["1.2.3.4:15005"] }), /anchors\[0\]/u);
    expectInvalid(makeBootstrap(pinned, { anchors: [kpsAddressFor(1), kpsAddressFor(1)] }), /repeats/u);
    expectInvalid(makeBootstrap(pinned, { anchors: Array.from({ length: 17 }, (_, i) => kpsAddressFor(i + 1)) }), /0\.\.16/u);
    expect(() => verifyBootstrap(makeBootstrap(pinned, { anchors: [] }), pinned)).not.toThrow();
  });

  it("checks RPC URLs: 2..8, unique, https (http only on loopback), no credentials", () => {
    expectInvalid(makeBootstrap(pinned, { registryRpcUrls: ["https://a.test/"] }), /2\.\.8/u);
    expectInvalid(makeBootstrap(pinned, { registryRpcUrls: ["https://a.test/", "https://a.test/"] }), /repeats/u);
    expectInvalid(makeBootstrap(pinned, { registryRpcUrls: ["https://a.test/", "http://b.test/"] }), /https/u);
    expectInvalid(makeBootstrap(pinned, { registryRpcUrls: ["https://a.test/", "https://user:pw@b.test/"] }), /https/u);
    expect(() =>
      verifyBootstrap(makeBootstrap(pinned, { registryRpcUrls: ["http://127.0.0.1:8545", "http://localhost:9545"] }), pinned)
    ).not.toThrow();
    expect(isAllowedRpcUrl("ws://127.0.0.1:1")).toBe(false);
    expect(isAllowedRpcUrl("https://x.test/#frag")).toBe(false);
    expect(isAllowedRpcUrl("https://x.test/rpc?network=arb-sepolia")).toBe(true);
    expect(isAllowedRpcUrl("https://[::1]:8545/")).toBe(true);
    expect(isAllowedRpcUrl("http://[::1]:8545/")).toBe(true);
    for (const bad of [
      "https://user@x.test/",
      "https://x.test:99999/",
      "https://-x.test/",
      "https://x..test/",
      "HTTPS://x.test/",
      "https://X.test/",
      "https://x.test/ space",
      "http://127.0.0.256/",
      "http://10.0.0.1:8545/",
    ]) {
      expect(isAllowedRpcUrl(bad), bad).toBe(false);
    }
  });

  it("checks every policy field against its range", () => {
    const bootstrap = makeBootstrap(pinned);
    for (const [field, bad] of [
      ["chainQuorum", 1],
      ["chainQuorum", 5],
      ["maxStateAgeSeconds", 59],
      ["chainRefreshSeconds", 0],
      ["probationMaxPerRoute", 3],
      ["probationSeconds", -1],
      ["minRemovalSources", 1],
      ["minMembersPerLayer", 0],
      ["minMembersPerLayer", 1.5],
    ] as const) {
      expectInvalid({ ...bootstrap, policy: { ...bootstrap.policy, [field]: bad } }, new RegExp(`policy\\.${field}`, "u"));
    }
  });

  it("tells providers apart by organisation", () => {
    expect(rpcProviderKey("https://sepolia-rollup.arbitrum.io/rpc")).toBe("arbitrum.io");
    expect(rpcProviderKey("https://arbitrum-sepolia.gateway.tenderly.co")).toBe("tenderly.co");
    expect(rpcProviderKey("https://arbitrum-sepolia-testnet.api.pocket.network")).toBe("pocket.network");
    expect(rpcProviderKey("http://127.0.0.1:8545")).not.toBe(rpcProviderKey("http://127.0.0.1:8546"));
  });
});

describe("probation cap in route selection", () => {
  function node(id: string, role: number, probation = false): TopologyNode {
    return {
      id,
      address: `kps:${kpsAddressFor(Number.parseInt(id.slice(-2), 16))}`,
      routingAddress: `/ip4/10.0.0.1/tcp/1/p2p/${id}`,
      publicKey: new Uint8Array(32),
      layer: 0,
      role,
      ...(probation ? { probation: true } : {}),
    };
  }

  it("never puts two probation members in one route while settled members exist", () => {
    const nodes = [
      node("0x01", 1, true),
      node("0x02", 1, true),
      node("0x03", 1),
      node("0x04", 1),
      node("0x05", 2, true),
      node("0x06", 2),
      node("0x07", 2),
    ];
    for (let i = 0; i < 500; i++) {
      const route = selectRoute(nodes, undefined, undefined, undefined, () => true, 1);
      const count = [route.entry, route.mix, route.exit].filter((hop) => hop.probation === true).length;
      expect(count).toBeLessThanOrEqual(1);
    }
  });

  it("with a probation entry, picks settled mix and exit", () => {
    const nodes = [node("0x01", 1, true), node("0x02", 1, true), node("0x03", 1), node("0x05", 2, true), node("0x06", 2)];
    for (let i = 0; i < 200; i++) {
      const route = selectRoute(nodes, nodes[0], undefined, undefined, () => true, 1);
      expect(route.mix.probation).toBeUndefined();
      expect(route.exit.probation).toBeUndefined();
    }
  });

  it("uses probation members of a layer that has nothing else (availability)", () => {
    const nodes = [node("0x01", 1), node("0x02", 1, true), node("0x05", 2, true)];
    const route = selectRoute(nodes, nodes[0], undefined, undefined, () => true, 1);
    expect(route.mix.id).toBe("0x02");
    expect(route.exit.id).toBe("0x05");
  });

  it("refuses a probation exit with a probation pinned entry while a settled exit exists", () => {
    const nodes = [node("0x01", 1, true), node("0x03", 1), node("0x04", 1), node("0x05", 2, true), node("0x06", 2)];
    expect(() => selectRoute(nodes, nodes[0], nodes[3], undefined, () => true, 1)).toThrow(
      expect.objectContaining({ code: NoxClientErrorCode.NoNodesAvailable, message: expect.stringMatching(/probation/u) }),
    );
    for (let i = 0; i < 200; i++) {
      const route = selectRoute(nodes, nodes[0], nodes[4], undefined, () => true, 1);
      expect([route.entry, route.mix, route.exit].filter((hop) => hop.probation === true)).toHaveLength(1);
    }
    // A budget of 2 lets the caller's choice stand.
    expect(selectRoute(nodes, nodes[0], nodes[3], undefined, () => true, 2).exit.id).toBe("0x05");
  });

  it("keeps a probation exit with a probation pinned entry when no settled exit exists (availability)", () => {
    const nodes = [node("0x01", 1, true), node("0x03", 1), node("0x05", 2, true)];
    const route = selectRoute(nodes, nodes[0], nodes[2], undefined, () => true, 1);
    expect(route.mix.id).toBe("0x03");
  });

  it("allows any mix without a cap (classic and pinned-only modes)", () => {
    const nodes = [node("0x01", 1, true), node("0x02", 1, true), node("0x03", 2, true)];
    expect(() => selectRoute(nodes, undefined, undefined, undefined, () => true)).not.toThrow();
  });
});
