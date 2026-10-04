/**
 * WASM injection with the real nox-wasm web build (SDK-205): bindings
 * initialised from bytes with `initSync`, the global `fetch` throwing, then a
 * KPS-mode client builds a real 32,768-byte Sphinx packet and SURBs and sends
 * them over KPS. Skipped when `packages/nox-wasm/pkg-web` has not been built
 * (`pnpm --filter @hisoka-io/nox-wasm build:web`).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoxClient } from "../src/client.js";
import { FakeKpsNetwork, json } from "./helpers/fake_kps.js";
import { DEFAULT_MEMBERS, makePinned, served } from "./helpers/pinned_fixture.js";

const PKG_WEB = fileURLToPath(new URL("../../nox-wasm/pkg-web/", import.meta.url));
const built = existsSync(`${PKG_WEB}nox_wasm.js`) && existsSync(`${PKG_WEB}nox_wasm_bg.wasm`);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.skipIf(!built)("WASM bytes injection (real nox-wasm)", () => {
  it("initialises from bytes without fetch and sends real Sphinx packets over KPS", async () => {
    const ambientFetch = vi.fn(() => {
      throw new Error("no fetch in KPS mode");
    });
    vi.stubGlobal("fetch", ambientFetch);
    const glue = (await import(pathToFileURL(`${PKG_WEB}nox_wasm.js`).href)) as Record<string, unknown> & {
      initSync(options: { module: Uint8Array }): unknown;
    };
    glue.initSync({ module: new Uint8Array(readFileSync(`${PKG_WEB}nox_wasm_bg.wasm`)) });

    // The fixture's sphinx keys are arbitrary 32-byte strings, which X25519
    // accepts as public keys, so the real WASM builds real packets for them.
    const pinned = makePinned(DEFAULT_MEMBERS);
    const network = new FakeKpsNetwork();
    const packets: Uint8Array[] = [];
    network.route(undefined, (request) => {
      if (request.path === "/topology") return json(200, served(pinned, Math.floor(Date.now() / 1000)));
      if (request.path === "/api/v1/packets") {
        packets.push(request.body);
        return { status: 202, body: "" };
      }
      return json(200, []);
    });
    const client = await NoxClient.connect({
      mode: "kps",
      wasm: () => glue,
      timeoutMs: 200,
      kps: { dial: network.dial, pinned, topologySources: 1 },
    });
    try {
      await expect(client.sendEcho(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: "RESPONSE_TIMEOUT" });
    } finally {
      client.disconnect();
    }
    expect(packets.length).toBeGreaterThanOrEqual(1);
    expect(packets.every((packet) => packet.length === 32_768)).toBe(true);
    expect(ambientFetch).not.toHaveBeenCalled();
  });
});
