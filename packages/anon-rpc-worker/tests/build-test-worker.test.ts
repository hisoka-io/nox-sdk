// The test-bed worker build's input handling (scripts/build-test-worker.mjs).
// The chain and build steps it chains are covered by snapshot-chain and build tests.
import { describe, expect, it } from "vitest";
import { DISCOVERY_POLICY_DEFAULTS, verifyBootstrap, type PinnedSnapshot } from "@hisoka-io/nox-client";
import { bootstrapFromTestbed, capabilitiesFromTopology, main, mergeCapabilities, testbedRegistry, TestWorkerError } from "../scripts/build-test-worker.mjs";
import { kpsAddressFor, makePinned } from "./helpers/fixtures.js";

const REGISTRY = {
  address: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
  chainId: 31_337,
  rpcUrl: "http://127.0.0.1:8545",
  deployBlock: 2,
  registeredBlock: 12,
};

describe("build-test-worker", () => {
  it("reads the registry and topology URLs a testbed.json describes", () => {
    const info = {
      mesh: {
        registry: REGISTRY,
        nodes: [{ topologyUrl: "http://127.0.0.1:27001/topology" }, { topologyUrl: "http://127.0.0.1:27011/topology" }],
      },
    };
    expect(testbedRegistry(info)).toEqual({
      registry: REGISTRY,
      topologyUrls: ["http://127.0.0.1:27001/topology", "http://127.0.0.1:27011/topology"],
    });
  });

  it("refuses a testbed.json without a registry or without nodes", () => {
    expect(() => testbedRegistry({ mesh: { nodes: [{ topologyUrl: "x" }] } })).toThrow(TestWorkerError);
    expect(() => testbedRegistry({ mesh: { registry: { ...REGISTRY, address: "0xABC" }, nodes: [] } })).toThrow(/mesh.registry/u);
    expect(() => testbedRegistry({ mesh: { registry: REGISTRY, nodes: [] } })).toThrow(/topology URLs/u);
  });

  it("turns a served liveness section into nox-capabilities/1 hints", () => {
    const hints = capabilitiesFromTopology(
      {
        liveness: [
          { address: "0x0000000000000000000000000000000000B00005", capabilities: ["surb_v2", "paid_v2", "surb_v2"] },
          { address: "0x0000000000000000000000000000000000b00001", capabilities: ["surb_v2", 7] },
          { address: "0x0000000000000000000000000000000000b00002" },
        ],
      },
      "node 0",
    );
    expect(hints).toEqual({
      format: "nox-capabilities/1",
      source: "node 0",
      members: {
        "0x0000000000000000000000000000000000b00005": ["paid_v2", "surb_v2"],
        "0x0000000000000000000000000000000000b00001": ["surb_v2"],
      },
    });
    expect(capabilitiesFromTopology({}, "empty").members).toEqual({});
  });

  it("merges served and self-reported hints, and can leave one capability out", () => {
    const served = { "0xb1": ["surb_v2"], "0xb2": ["paid_v2"] };
    const reported = { "0xb1": ["tunnel_v1", "surb_v2"], "0xb3": ["tunnel_v1"] };
    expect(mergeCapabilities(served, reported, undefined)).toEqual({
      "0xb1": ["surb_v2", "tunnel_v1"],
      "0xb2": ["paid_v2"],
      "0xb3": ["tunnel_v1"],
    });
    expect(mergeCapabilities(served, reported, "tunnel_v1")).toEqual({ "0xb1": ["surb_v2"], "0xb2": ["paid_v2"] });
  });

  it("builds the bed's discovery bootstrap from testbed.json and the snapshot", () => {
    const pinned: PinnedSnapshot = makePinned();
    const info = {
      mesh: {
        registry: { ...REGISTRY, implementation: "0x5fbdb2315678afecb367f032d93f642f64180aa3" },
        discovery: {
          providers: ["http://127.0.0.1:8545", "http://127.0.0.1:8546/"],
          anchors: [kpsAddressFor(1), kpsAddressFor(2)],
          chainRefreshSeconds: 3,
          maxStateAgeSeconds: 86_400,
        },
      },
    };
    const bootstrap = bootstrapFromTestbed(info, pinned);
    expect(bootstrap).toMatchObject({
      chainId: pinned.chainId,
      registry: pinned.registry,
      registryImpl: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
      anchors: [kpsAddressFor(1), kpsAddressFor(2)],
      registryRpcUrls: ["http://127.0.0.1:8545", "http://127.0.0.1:8546/"],
      policy: { ...DISCOVERY_POLICY_DEFAULTS, chainRefreshSeconds: 3, maxStateAgeSeconds: 86_400 },
    });
    expect(() => verifyBootstrap(bootstrap, pinned)).not.toThrow();
    expect(() => bootstrapFromTestbed({ mesh: { registry: REGISTRY } }, pinned)).toThrow(/implementation/u);
    expect(() => bootstrapFromTestbed({ mesh: { registry: info.mesh.registry } }, pinned)).toThrow(/mesh.discovery/u);
  });

  it("requires --testbed and --out", async () => {
    await expect(main(["--out", "x.js"])).rejects.toThrow(/--testbed and --out are required/u);
  });
});
