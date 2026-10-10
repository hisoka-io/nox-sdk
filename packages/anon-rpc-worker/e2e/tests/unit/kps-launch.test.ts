import { spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startSidecar, type SidecarVars } from "../../src/kps-server.js";
import { assertUdpPortsFree, freeTcpPort } from "../../src/ports.js";

async function vars(dir: string): Promise<SidecarVars> {
  return {
    node: 0,
    node_address: "0x00000000000000000000000000000000000b0000",
    udp_port: await freeTcpPort(),
    advertise_ip: "127.0.0.1",
    listen: "127.0.0.1:0",
    ingress_port: 1,
    ingress_url: "http://127.0.0.1:1",
    topology_port: 2,
    topology_url: "http://127.0.0.1:2/topology",
    admin_port: await freeTcpPort(),
    key_file: join(dir, "key"),
    config_file: join(dir, "config.toml"),
    bundle_dir: dir,
    expected_certhash: "",
  };
}

describe("KPS server launch", () => {
  it("stops a sidecar that never prints its address", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-kps-launch-"));
    const script = join(dir, "silent.mjs");
    writeFileSync(script, "setInterval(() => {}, 1000);\n");
    await expect(
      startSidecar({
        commandTemplate: `${process.execPath} ${script}`,
        initCommandTemplate: undefined,
        configTemplate: undefined,
        vars: await vars(dir),
        logDir: dir,
        addressTimeoutMs: 1_000,
      }),
    ).rejects.toThrow(/KPS address/u);
    // pgrep exits 1 when it ran and no command line matches the script.
    expect(spawnSync("pgrep", ["-f", script], { stdio: "ignore" }).status).toBe(1);
  });

  it("names a UDP port that is already bound", async () => {
    const socket = createSocket("udp4");
    await new Promise<void>((resolve) => socket.bind(0, "0.0.0.0", () => resolve()));
    const { port } = socket.address();
    try {
      await expect(assertUdpPortsFree([port], "nox-kps(node 0) KPS listener")).rejects.toMatchObject({ code: "port" });
      await expect(assertUdpPortsFree([port], "x")).rejects.toThrow(new RegExp(`UDP ports already in use: ${port}`, "u"));
    } finally {
      socket.close();
    }
    await expect(assertUdpPortsFree([port], "x")).resolves.toBeUndefined();
  });
});
