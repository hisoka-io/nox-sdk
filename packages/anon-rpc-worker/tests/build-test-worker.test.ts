// The test-bed worker build's input handling (scripts/build-test-worker.mjs).
// The chain and build steps it chains are covered by snapshot-chain and build tests.
import { describe, expect, it } from "vitest";
import { capabilitiesFromTopology, main, testbedRegistry, TestWorkerError } from "../scripts/build-test-worker.mjs";

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

  it("requires --testbed and --out", async () => {
    await expect(main(["--out", "x.js"])).rejects.toThrow(/--testbed and --out are required/u);
  });
});
