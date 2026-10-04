import { keccak_256 } from "@noble/hashes/sha3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildWorker,
  BUNDLE_OPTIONS,
  GLUE_URL_EXPRESSION,
  resolveNoxWasm,
  rewriteGlue,
} from "../scripts/build.mjs";
import { PACKAGE_DIR, REPO_DIR, SNAPSHOT_PATH } from "../scripts/lib/paths.mjs";
import { makeProvenance, parseToolchainEnv, PROVENANCE_NAME } from "../scripts/provenance.mjs";
import { canonicalJson } from "../scripts/lib/snapshot-format.mjs";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "nox-build-test-"));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterAll(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function outfile(name: string): string {
  return relative(PACKAGE_DIR, join(dir, name, "anon-rpc-worker.js"));
}

describe("buildWorker", () => {
  it("gives identical bytes on every build and pins them with Ethereum keccak-256", async () => {
    const first = await buildWorker({ outfile: outfile("a") });
    const second = await buildWorker({ outfile: outfile("b") });
    expect(Buffer.from(second.bundle).equals(Buffer.from(first.bundle))).toBe(true);
    const onDisk = readFileSync(join(dir, "a", "anon-rpc-worker.js"));
    expect(onDisk.equals(Buffer.from(first.bundle))).toBe(true);
    const keccak = `0x${Buffer.from(keccak_256(onDisk)).toString("hex")}`;
    expect(first.record.artifact.keccak256).toBe(keccak);
    expect(readFileSync(join(dir, "a", "anon-rpc-worker.js.keccak256"), "utf8")).toBe(`${keccak}  anon-rpc-worker.js\n`);
  });

  it("emits one auditable classic script with the WASM and snapshot inlined and no machine paths", async () => {
    const { bundle, record } = await buildWorker({ outfile: outfile("c"), write: false });
    const text = Buffer.from(bundle).toString("utf8");
    expect(() => new vm.Script(text)).not.toThrow();
    expect(text).not.toMatch(/^\s*(?:import|export)\s/mu);
    expect(text).not.toContain("import.meta");
    expect(text).not.toContain(PACKAGE_DIR);
    expect(text).not.toContain(REPO_DIR);
    expect(text).not.toContain(homedir());
    expect(text).toContain(readFileSync(resolveNoxWasm(PACKAGE_DIR).wasmPath).toString("base64"));
    const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as { blockHash: string };
    expect(text).toContain(snapshot.blockHash);
    expect(text.startsWith("/* @hisoka-io/anon-rpc-worker ")).toBe(true);
    expect(record.esbuild.options).toMatchObject({ format: "iife", minify: false, target: BUNDLE_OPTIONS.target });
    expect(record.modules.map((module) => module.path)).toContain("snapshot/nox-snapshot.json");
  });

  it("bundles an entry that uses the SDK sources and the embedded WASM", async () => {
    const { bundle, record } = await buildWorker({ entry: "tests/fixtures/sdk-entry.ts", outfile: outfile("sdk"), write: false });
    const text = Buffer.from(bundle).toString("utf8");
    expect(() => new vm.Script(text)).not.toThrow();
    expect(text).not.toContain("import.meta");
    expect(record.modules.map((module) => module.path)).toContain("../nox-client/src/topology.ts");
  });

  it("refuses an entry that drops the embedded WASM", async () => {
    await expect(buildWorker({ entry: "tests/fixtures/no-wasm-entry.ts", outfile: outfile("bad"), write: false })).rejects.toMatchObject({
      code: "bundle-check-failed",
    });
  });

  it("refuses a WASM file that is not WebAssembly", async () => {
    const fake = join(dir, "fake.wasm");
    writeFileSync(fake, "not wasm");
    await expect(buildWorker({ outfile: outfile("fake"), wasm: fake, write: false })).rejects.toMatchObject({ code: "invalid-wasm" });
  });
});

describe("rewriteGlue", () => {
  it("replaces the one URL lookup and refuses glue it does not recognise", () => {
    const glue = `a(); x = ${GLUE_URL_EXPRESSION}; b();`;
    const rewritten = rewriteGlue(glue, "glue.js");
    expect(rewritten).not.toContain("import.meta");
    expect(rewritten).toContain("never loads one by URL");
    expect(() => rewriteGlue("a();", "glue.js")).toThrow(/exactly once, found 0/u);
    expect(() => rewriteGlue(`${GLUE_URL_EXPRESSION}${GLUE_URL_EXPRESSION}`, "glue.js")).toThrow(/found 2/u);
    expect(() => rewriteGlue(`${GLUE_URL_EXPRESSION}; import.meta.env`, "glue.js")).toThrow(/outside the module lookup/u);
  });
});

describe("the placeholder worker bundle", () => {
  it("boots in a bare script context, initialises the embedded WASM and answers fetch calls", async () => {
    const { bundle } = await buildWorker({ outfile: outfile("smoke"), write: false });
    const events: string[] = [];
    const responses: unknown[] = [];
    let served = false;
    const requests: Array<{ url: string; method: string | undefined }> = [];
    const anonRpcWorker = {
      config: undefined,
      signalReady: () => events.push("ready"),
      signalFailed: (reason: unknown) => events.push(`failed ${JSON.stringify(reason)}`),
      log: { debug() {}, info() {}, warn() {}, error: (...args: unknown[]) => events.push(`error ${args.join(" ")}`) },
      acceptCall: () => {
        if (served) return new Promise(() => {});
        served = true;
        return Promise.resolve({
          kind: "fetch",
          url: "https://rpc.example/",
          requestInit: { method: "POST", headers: [["content-type", "application/json"]], body: new TextEncoder().encode("{}") },
          respond: (value: unknown) => {
            void Promise.resolve(value).then((resolved) => responses.push(resolved));
          },
        });
      },
    };
    const fetchStub = async (url: string, init?: { method?: string }) => {
      requests.push({ url, method: init?.method });
      return new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', { status: 200, headers: { "content-type": "application/json" } });
    };
    const context = vm.createContext({ anonRpcWorker, fetch: fetchStub, TextEncoder, TextDecoder, console });
    vm.runInContext(Buffer.from(bundle).toString("utf8"), context);
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    expect(events).toEqual(["ready"]);
    expect(requests).toEqual([{ url: "https://rpc.example/", method: "POST" }]);
    const response = responses[0] as { status: number; body: Uint8Array };
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.body)).toContain('"result":"0x1"');
  });
});

describe("provenance", () => {
  it("is identical for identical builds and agrees with the bundle bytes", async () => {
    await buildWorker({ outfile: outfile("p1") });
    await buildWorker({ outfile: outfile("p2") });
    const options = (name: string) => ({ distDir: join(dir, name), wasmRecordPath: join(dir, "absent.json"), sourceCommit: "a".repeat(40) });
    const first = makeProvenance(options("p1"));
    const second = makeProvenance(options("p2"));
    expect(canonicalJson(second)).toBe(canonicalJson(first));
    const bytes = readFileSync(join(dir, "p1", "anon-rpc-worker.js"));
    expect((first["output"] as { keccak256: string }).keccak256).toBe(`0x${Buffer.from(keccak_256(bytes)).toString("hex")}`);
    expect(first).toMatchObject({ gitCommit: "a".repeat(40), gitTreeClean: true, package: "@hisoka-io/anon-rpc-worker" });
    expect((first["inputs"] as { snapshotKeccak: string }).snapshotKeccak).toBe(
      readFileSync(`${SNAPSHOT_PATH}.keccak256`, "utf8").split(" ")[0],
    );
    expect(PROVENANCE_NAME).toBe("anon-rpc-worker.provenance.json");
  });

  it("records the WASM toolchain and refuses a record of another module", async () => {
    await buildWorker({ outfile: outfile("p3") });
    const record = JSON.parse(readFileSync(join(dir, "p3", "build-record.json"), "utf8")) as { wasm: { sha256: string } };
    const wasmRecord = join(dir, "wasm-toolchain.json");
    writeFileSync(wasmRecord, JSON.stringify({ wasmSha256: record.wasm.sha256, rustc: "rustc 1.95.0", wasmPack: "0.13.1", wasmBindgen: "0.2.114", wasmOpt: "117", pinsChecked: true }));
    const provenance = makeProvenance({ distDir: join(dir, "p3"), wasmRecordPath: wasmRecord });
    expect(provenance["toolchain"]).toMatchObject({ rustc: "rustc 1.95.0", wasmOpt: "117", wasmPinsChecked: true });
    writeFileSync(wasmRecord, JSON.stringify({ wasmSha256: "00".repeat(32) }));
    expect(() => makeProvenance({ distDir: join(dir, "p3"), wasmRecordPath: wasmRecord })).toThrow(/is not the one/u);
  });

  it("refuses a bundle that changed after the build", async () => {
    await buildWorker({ outfile: outfile("p4") });
    writeFileSync(join(dir, "p4", "anon-rpc-worker.js"), "tampered");
    expect(() => makeProvenance({ distDir: join(dir, "p4"), wasmRecordPath: join(dir, "absent.json") })).toThrow(
      /is not the bundle the build record describes/u,
    );
  });

  it("reads the pinned toolchain file and rejects shell syntax in it", () => {
    const pins = parseToolchainEnv(readFileSync(join(PACKAGE_DIR, "scripts", "toolchain.env"), "utf8"));
    expect(pins["NODE_IMAGE"]).toMatch(/^docker\.io\/library\/node:22\.[0-9.]+-bookworm-slim@sha256:[0-9a-f]{64}$/u);
    expect(pins["RUST_IMAGE"]).toMatch(/@sha256:[0-9a-f]{64}$/u);
    expect(pins["WASM_BINDGEN_VERSION"]).toBe("0.2.114");
    expect(() => parseToolchainEnv('NODE_IMAGE="x"\n')).toThrow(/not a plain KEY=VALUE pair/u);
    expect(() => parseToolchainEnv("NODE_IMAGE=$(id)\n")).toThrow(/not a plain KEY=VALUE pair/u);
  });
});
