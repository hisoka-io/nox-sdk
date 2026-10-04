import { describe, expect, it } from "vitest";
import {
  applyServedTopologies,
  eligiblePinnedMembers,
  formsRoute,
  kpsTopologyNodes,
  pinnedPowDifficulty,
  verifyPinnedSnapshot,
  type ApplyServedOptions,
} from "../src/kps/pinned.js";
import { primaryLayerForRole } from "../src/topology.js";
import { NoxClientError, NoxClientErrorCode, type PinnedSnapshot } from "../src/types.js";
import { kpsAddressFor } from "./helpers/fake_kps.js";
import { PINNED_BLOCK, makePinned, memberAddress, served } from "./helpers/pinned_fixture.js";

const NOW = 1_800_000_000;
const OPTIONS: ApplyServedOptions = { clockSkewToleranceSeconds: 600, livenessMaxAgeSeconds: 180 };

function expectInvalid(pinned: unknown, pattern: RegExp): void {
  try {
    verifyPinnedSnapshot(pinned as PinnedSnapshot);
  } catch (error) {
    expect(error).toBeInstanceOf(NoxClientError);
    expect((error as NoxClientError).code).toBe(NoxClientErrorCode.TopologyVerificationFailed);
    expect((error as Error).message).toMatch(pattern);
    return;
  }
  throw new Error("expected the pinned snapshot to be rejected");
}

describe("verifyPinnedSnapshot", () => {
  it("accepts a well-formed snapshot", () => {
    expect(() => verifyPinnedSnapshot(makePinned())).not.toThrow();
  });

  it("rejects a changed member address (fingerprint) before any network use", () => {
    const pinned = makePinned();
    const tampered = structuredClone(pinned);
    tampered.members[0]!.address = memberAddress(1).replace(/1$/u, "0");
    expectInvalid(tampered, /fingerprint mismatch/u);
  });

  it("rejects unknown and missing fields", () => {
    expectInvalid({ ...makePinned(), extra: 1 }, /unknown field "extra"/u);
    const missing: Record<string, unknown> = { ...makePinned() };
    delete missing["blockHash"];
    expectInvalid(missing, /missing "blockHash"/u);
    const pinned = makePinned();
    expectInvalid({ ...pinned, members: [{ ...pinned.members[0], note: "x" }, ...pinned.members.slice(1)] }, /unknown field "note"/u);
  });

  it("rejects malformed field values", () => {
    const pinned = makePinned();
    expectInvalid({ ...pinned, format: "nox-anon-rpc-snapshot/2" }, /format/u);
    expectInvalid({ ...pinned, registry: pinned.registry.toUpperCase() }, /registry/u);
    expectInvalid({ ...pinned, blockNumber: 0 }, /blockNumber/u);
    expectInvalid({ ...pinned, powDifficulty: 17 }, /powDifficulty/u);
    expectInvalid({ ...pinned, fingerprint: `0x${pinned.fingerprint}` }, /fingerprint/u);
    expectInvalid({ ...pinned, relayerCount: pinned.members.length + 1 }, /relayerCount/u);
    const badKey = structuredClone(pinned);
    badKey.members[0]!.sphinxKey = "zz".repeat(32);
    expectInvalid(badKey, /sphinxKey/u);
    const badLayer = structuredClone(pinned);
    const exit = badLayer.members.find((member) => member.role === 2)!;
    exit.layer = 1;
    expectInvalid(badLayer, /primary layer|layer/u);
    const dupCaps = structuredClone(pinned);
    dupCaps.members[0]!.capabilities = ["surb_v2", "surb_v2"];
    expectInvalid(dupCaps, /capabilities/u);
  });

  it("rejects members out of canonical order", () => {
    const pinned = makePinned();
    const reordered = { ...pinned, members: [...pinned.members].reverse() };
    expectInvalid(reordered, /sorted by address/u);
  });

  it("rejects non-object input", () => {
    expectInvalid(null, /not an object/u);
    expectInvalid([], /not an object/u);
  });
});

describe("applyServedTopologies (removals only)", () => {
  const pinned = makePinned();
  const all = pinned.members.map((member) => member.address);

  it("keeps every pinned eligible member when a source reports them online", () => {
    const result = applyServedTopologies(pinned, [{ anchor: kpsAddressFor(1), snapshot: served(pinned, NOW) }], NOW, OPTIONS);
    expect(result.sourcesAccepted).toBe(1);
    expect(result.members.map((node) => node.address)).toEqual(all);
    expect(result.removed).toEqual([]);
    expect(result.floorApplied).toBe(false);
  });

  it("ignores additions, excludes changed profiles, omissions and offline members", () => {
    const stranger = memberAddress(200);
    const addition = {
      address: stranger,
      sphinx_key: "ee".repeat(32),
      url: "/ip4/10.9.9.9/tcp/15000",
      stake: "0",
      last_seen: 0,
      is_privileged: true,
      layer: primaryLayerForRole(stranger, 1),
      role: 1,
      ingress_url: "https://stranger.test",
      metadata_url: `kps:${kpsAddressFor(200)}/metadata.json`,
    };
    const document = served(pinned, NOW, {
      add: [addition],
      omit: [2],
      offline: [3],
      mutate: (node, index) => (index === 4 ? { ...node, sphinx_key: "ff".repeat(32) } : node),
    });
    const result = applyServedTopologies(pinned, [{ anchor: kpsAddressFor(1), snapshot: document }], NOW, OPTIONS);
    expect(result.ignoredAdditions).toBe(1);
    expect(result.removed.sort()).toEqual([memberAddress(2), memberAddress(3), memberAddress(4)]);
    expect(result.members.map((node) => node.address)).not.toContain(stranger);
    expect(result.members).toHaveLength(pinned.members.length - 3);
  });

  it("treats a changed KPS identity (metadataUrl) as absent", () => {
    const document = served(pinned, NOW, {
      mutate: (node, index) => (index === 5 ? { ...node, metadata_url: `kps:${kpsAddressFor(99)}/metadata.json` } : node),
    });
    const result = applyServedTopologies(pinned, [{ anchor: kpsAddressFor(1), snapshot: document }], NOW, OPTIONS);
    expect(result.removed).toEqual([memberAddress(5)]);
  });

  it("needs every accepted source to agree before removing a member", () => {
    const result = applyServedTopologies(
      pinned,
      [
        { anchor: kpsAddressFor(1), snapshot: served(pinned, NOW, { offline: [2] }) },
        { anchor: kpsAddressFor(3), snapshot: served(pinned, NOW) },
      ],
      NOW,
      OPTIONS,
    );
    expect(result.sourcesAccepted).toBe(2);
    expect(result.removed).toEqual([]);
    const agreed = applyServedTopologies(
      pinned,
      [
        { anchor: kpsAddressFor(1), snapshot: served(pinned, NOW, { offline: [2] }) },
        { anchor: kpsAddressFor(3), snapshot: served(pinned, NOW, { omit: [2] }) },
      ],
      NOW,
      OPTIONS,
    );
    expect(agreed.removed).toEqual([memberAddress(2)]);
  });

  it("rejects stale, future, inconsistent and anchor-less documents", () => {
    const cases = [
      { snapshot: served(pinned, NOW, { blockNumber: PINNED_BLOCK - 1 }), reason: /before the snapshot block/u },
      { snapshot: served(pinned, NOW, { timestamp: NOW - 181 - 600 }), reason: /outside/u },
      { snapshot: served(pinned, NOW, { timestamp: NOW + 601 }), reason: /outside/u },
      { snapshot: { ...served(pinned, NOW), fingerprint: "00".repeat(32) }, reason: /self-consistent/u },
      { snapshot: served(pinned, NOW, { omit: [1] }), reason: /anchor's own member/u },
    ];
    for (const { snapshot, reason } of cases) {
      const result = applyServedTopologies(pinned, [{ anchor: kpsAddressFor(1), snapshot }], NOW, OPTIONS);
      expect(result.sourcesAccepted).toBe(0);
      expect(result.rejected[0]?.reason).toMatch(reason);
      expect(result.members.map((node) => node.address)).toEqual(all);
    }
    const foreign = applyServedTopologies(pinned, [{ anchor: kpsAddressFor(77), snapshot: served(pinned, NOW) }], NOW, OPTIONS);
    expect(foreign.rejected[0]?.reason).toMatch(/not a pinned member/u);
  });

  it("keeps the previous set when one source would leave no route (floor)", () => {
    const exits = pinned.members.flatMap((member, offset) => (member.role === 2 ? [offset + 1] : []));
    const previous = eligiblePinnedMembers(pinned).slice(0, 7).map((member) => ({
      address: member.address,
      sphinx_key: member.sphinxKey,
      url: member.url,
      stake: member.stake,
      last_seen: 0,
      is_privileged: true,
      layer: member.layer,
      role: member.role,
      ingress_url: member.ingressUrl,
      metadata_url: member.metadataUrl,
    }));
    const result = applyServedTopologies(
      pinned,
      [{ anchor: kpsAddressFor(1), snapshot: served(pinned, NOW, { offline: exits }) }],
      NOW,
      { ...OPTIONS, previous },
    );
    expect(result.floorApplied).toBe(true);
    expect(result.members).toEqual(previous);
  });

  it("declares the snapshot stale when two sources agree it has no route", () => {
    const exits = pinned.members.flatMap((member, offset) => (member.role === 2 ? [offset + 1] : []));
    expect(() =>
      applyServedTopologies(
        pinned,
        [
          { anchor: kpsAddressFor(1), snapshot: served(pinned, NOW, { offline: exits }) },
          { anchor: kpsAddressFor(2), snapshot: served(pinned, NOW, { omit: exits }) },
        ],
        NOW,
        OPTIONS,
      )
    ).toThrow(expect.objectContaining({ code: NoxClientErrorCode.TopologyStale }));
  });

  it("never routes over ineligible pinned members", () => {
    const withFrozen = makePinned([{ role: 1 }, { role: 1, frozen: true }, { role: 1 }, { role: 2 }, { role: 2, status: 2 }]);
    const result = applyServedTopologies(withFrozen, [{ anchor: kpsAddressFor(1), snapshot: served(withFrozen, NOW) }], NOW, OPTIONS);
    expect(result.members.map((node) => node.address)).toEqual([
      memberAddress(1),
      memberAddress(3),
      memberAddress(4),
      memberAddress(5),
    ]);
  });
});

describe("routing nodes from the pinned set", () => {
  it("gives kps: entry endpoints only to allowed KPS-capable members, with capability hints", () => {
    const pinned = makePinned([
      { role: 1 },
      { role: 1, kps: false },
      { role: 1, capabilities: ["surb_v2"] },
      { role: 2, capabilities: ["surb_v2", "paid_v2"] },
    ]);
    const members = eligiblePinnedMembers(pinned);
    const relayers = applyServedTopologies(pinned, [], NOW, OPTIONS).members;
    expect(relayers).toHaveLength(members.length);
    const nodes = kpsTopologyNodes(pinned, relayers, new Set([kpsAddressFor(1), kpsAddressFor(4)]));
    expect(nodes.map((node) => node.address)).toEqual([
      `kps:${kpsAddressFor(1)}`,
      "",
      "",
      `kps:${kpsAddressFor(4)}`,
    ]);
    expect(nodes[3]?.capabilities).toEqual(["surb_v2", "paid_v2"]);
    expect(nodes[1]?.routingAddress).toBe(pinned.members[1]?.url);
    const unrestricted = kpsTopologyNodes(pinned, relayers);
    expect(unrestricted.filter((node) => node.address.startsWith("kps:"))).toHaveLength(3);
  });

  it("checks that a member set can form a route under the entry rule", () => {
    const pinned = makePinned();
    const relayers = applyServedTopologies(pinned, [], NOW, OPTIONS).members;
    expect(formsRoute(pinned, relayers)).toBe(true);
    expect(formsRoute(pinned, relayers, new Set())).toBe(false);
    expect(formsRoute(pinned, relayers.filter((node) => node.role === 1))).toBe(false);
  });

  it("takes the highest PoW difficulty, capped at 16", () => {
    const pinned = makePinned();
    expect(pinnedPowDifficulty(pinned, [])).toBe(1);
    expect(pinnedPowDifficulty(pinned, [served(pinned, NOW, { powDifficulty: 3 })])).toBe(3);
    expect(pinnedPowDifficulty(pinned, [served(pinned, NOW, { powDifficulty: 40 })])).toBe(16);
  });
});
