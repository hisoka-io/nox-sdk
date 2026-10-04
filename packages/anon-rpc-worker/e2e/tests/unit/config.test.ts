import { describe, expect, it } from "vitest";
import { FLEET_ROLES, loadConfig, rolesFrom } from "../../src/config.js";
import { TestbedError } from "../../src/errors.js";

const ROOT = "/tmp/e2e-root/packages/anon-rpc-worker/e2e";

describe("loadConfig", () => {
  it("uses documented defaults when no variables are set", () => {
    const cfg = loadConfig({}, ROOT);
    expect(cfg.mesh.nodes).toBe(10);
    expect(cfg.mesh.roles).toEqual(FLEET_ROLES);
    expect(cfg.mesh.basePort).toBe(27_000);
    expect(cfg.mesh.mixDelayMs).toBe(0);
    expect(cfg.anvil.specifierChainId).toBe(1);
    expect(cfg.anvil.upstreamChainId).toBe(31_337);
    expect(cfg.kps.advertiseIp).toBe("127.0.0.1");
    expect(cfg.kps.sidecarCommand).toBeUndefined();
    expect(cfg.worker.bundlePath).toBe("/tmp/e2e-root/packages/anon-rpc-worker/dist/anon-rpc-worker.js");
    expect(cfg.runDir).toBe(`${ROOT}/.run`);
    expect(cfg.sdkRoot).toBe("/tmp/e2e-root");
  });

  it("resolves relative paths against the e2e root", () => {
    const cfg = loadConfig({ NOX_WORKER_BUNDLE: "out/worker.js", NOX_REPO: "/abs/nox" }, ROOT);
    expect(cfg.worker.bundlePath).toBe(`${ROOT}/out/worker.js`);
    expect(cfg.nox.repo).toBe("/abs/nox");
    expect(cfg.nox.meshBin).toBe("/abs/nox/target/release/nox_mesh_server");
  });

  it("treats blank variables as unset", () => {
    expect(loadConfig({ NOX_KPS_CMD: "   " }, ROOT).kps.sidecarCommand).toBeUndefined();
  });

  it("rejects out-of-range and non-integer numbers with the variable named", () => {
    expect(() => loadConfig({ E2E_MESH_NODES: "2" }, ROOT)).toThrow(/E2E_MESH_NODES=2/u);
    expect(() => loadConfig({ E2E_MESH_NODES: "4.5" }, ROOT)).toThrow(/must be an integer/u);
    expect(() => loadConfig({ E2E_MIX_DELAY_MS: "abc" }, ROOT)).toThrow(TestbedError);
  });

  it("rejects a base port whose mesh would run past 65535", () => {
    expect(() => loadConfig({ E2E_BASE_PORT: "65480" }, ROOT)).toThrow(/above 65535/u);
  });

  it("rejects a malformed advertise IP", () => {
    expect(() => loadConfig({ E2E_KPS_IP: "300.1.1.1" }, ROOT)).toThrow(/dotted IPv4/u);
    expect(() => loadConfig({ E2E_KPS_IP: "localhost" }, ROOT)).toThrow(/dotted IPv4/u);
  });
});

describe("rolesFrom", () => {
  it("defaults to the fleet layout and pads with relays", () => {
    expect(rolesFrom({}, "R", 10)).toEqual(FLEET_ROLES);
    expect(rolesFrom({}, "R", 12)).toEqual([...FLEET_ROLES, 1, 1]);
  });

  it("requires an exit-capable node", () => {
    expect(() => rolesFrom({}, "R", 3)).toThrow(/exit-capable/u);
    expect(rolesFrom({ R: "1,2,1" }, "R", 4)).toEqual([1, 2, 1, 1]);
  });

  it("requires a relay-capable node", () => {
    expect(() => rolesFrom({ R: "2,2,2" }, "R", 3)).toThrow(/relay-capable/u);
    expect(rolesFrom({ R: "3,3,3" }, "R", 3)).toEqual([3, 3, 3]);
  });

  it("rejects unknown roles and over-long lists", () => {
    expect(() => rolesFrom({ R: "1,4,2" }, "R", 3)).toThrow(/R\[1\]=4/u);
    expect(() => rolesFrom({ R: "1,2,1,1" }, "R", 3)).toThrow(/lists 4 roles for 3 nodes/u);
  });
});
