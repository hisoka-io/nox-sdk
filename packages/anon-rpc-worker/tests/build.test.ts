import { keccak_256 } from "@noble/hashes/sha3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildWorker,
  BUNDLE_OPTIONS,
  checkBundle,
  embeddedModuleText,
  embeddedSnapshotText,
  GLUE_URL_EXPRESSION,
  resolveNoxWasm,
  rewriteGlue,
  snapshotModuleSource,
} from "../scripts/build.mjs";
import { BOOTSTRAP_PATH, PACKAGE_DIR, REPO_DIR, SNAPSHOT_PATH } from "../scripts/lib/paths.mjs";
import { gitState, makeProvenance, parseToolchainEnv, PROVENANCE_NAME } from "../scripts/provenance.mjs";
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

/** A directory outside any git checkout. */
function exportedRoot(): string {
  const root = join(dir, "no-git");
  mkdirSync(root, { recursive: true });
  return root;
}

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

  it("embeds the committed bootstrap byte for byte and records its digest", async () => {
    const { bundle, record } = await buildWorker({ outfile: outfile("boot"), write: false });
    const text = Buffer.from(bundle).toString("utf8");
    const file = readFileSync(BOOTSTRAP_PATH, "utf8");
    expect(embeddedModuleText(text, "bootstrap")).toBe(file);
    expect(record.bootstrap).toEqual(expect.objectContaining({
      path: "snapshot/nox-bootstrap.json",
      keccak256: `0x${Buffer.from(keccak_256(Buffer.from(file))).toString("hex")}`,
    }));
  });

  it("refuses a non-canonical bootstrap file", async () => {
    const path = join(dir, "bootstrap-pretty.json");
    writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(BOOTSTRAP_PATH, "utf8"))));
    await expect(buildWorker({ outfile: outfile("bad-boot"), write: false, bootstrap: path })).rejects.toThrow(/not canonical JSON/u);
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
    const snapshotBytes = readFileSync(SNAPSHOT_PATH);
    expect(record.snapshot).toEqual({
      path: "snapshot/nox-snapshot.json",
      bytes: snapshotBytes.byteLength,
      sha256: record.snapshot.sha256,
      keccak256: `0x${Buffer.from(keccak_256(snapshotBytes)).toString("hex")}`,
    });
    expect(embeddedSnapshotText(text)).toBe(snapshotBytes.toString("utf8"));
    expect(record.entry).toBe("src/worker.ts");
  });

  it("embeds the TLS module, and a test root only when asked for one", async () => {
    const release = await buildWorker({ outfile: outfile("tls"), write: false });
    const tlsWasm = readFileSync(join(REPO_DIR, "packages", "nox-tls", "pkg-web", "nox_tls_bg.wasm"));
    expect(Buffer.from(release.bundle).toString("utf8")).toContain(tlsWasm.toString("base64"));
    expect(release.record.tls).toMatchObject({ bytes: tlsWasm.byteLength, keccak256: `0x${Buffer.from(keccak_256(tlsWasm)).toString("hex")}` });
    expect(release.record.extraRoots).toBe(0);
    const ca = join(REPO_DIR, "packages", "nox-tls", "tests", "fixtures", "ca.cert.der");
    const test = await buildWorker({ outfile: outfile("tls-root"), write: false, extraRoot: ca });
    expect(test.record.extraRoots).toBe(1);
    expect(Buffer.from(test.bundle).toString("utf8")).toContain(readFileSync(ca).toString("base64"));
    await expect(buildWorker({ outfile: outfile("tls-bad-root"), write: false, extraRoot: SNAPSHOT_PATH })).rejects.toThrow(/not a DER certificate/u);
  });

  it("holds no live path to the ambient fetch or WebSocket", async () => {
    const { bundle } = await buildWorker({ outfile: outfile("policy"), write: false });
    const text = Buffer.from(bundle).toString("utf8");
    expect(text).not.toMatch(/\bglobalThis\.(?:fetch|WebSocket)\b/u);
    expect(text).not.toMatch(/\bnew\s+WebSocket\b/u);
    expect(text).not.toContain("@kpstreams/");
    expect(text).not.toContain("createDataChannel");
    expect(text).toContain("noxAmbientFetchDisabled(");
  });

  it("embeds a test-bed snapshot given with --snapshot and records it", async () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as { blockNumber: number };
    const path = join(dir, "bed-snapshot.json");
    writeFileSync(path, canonicalJson({ ...snapshot, blockNumber: snapshot.blockNumber + 1 }));
    const { bundle, record } = await buildWorker({ outfile: outfile("bed"), snapshot: path, write: false });
    expect(embeddedSnapshotText(Buffer.from(bundle).toString("utf8"))).toBe(readFileSync(path, "utf8"));
    expect(record.snapshot.keccak256).toBe(`0x${Buffer.from(keccak_256(readFileSync(path))).toString("hex")}`);
  });

  it("refuses a snapshot that is not canonical JSON", async () => {
    const path = join(dir, "pretty.json");
    writeFileSync(path, JSON.stringify({ b: 1, a: 2 }, null, 4));
    await expect(buildWorker({ outfile: outfile("pretty"), snapshot: path, write: false })).rejects.toMatchObject({ code: "invalid-snapshot" });
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

describe("checkBundle", () => {
  const snapshot = '{\n  "a": 1\n}\n';
  const wasm = "AGFzbQ==";
  const module = (text: string) => `// nox-embed:snapshot\n  var snapshot_default = ${snapshotModuleSource(text).slice("export default ".length)}`;

  it("accepts the snapshot module and the embedded WASM", () => {
    expect(() => checkBundle(`${module(snapshot)}\n"${wasm}"`, wasm, snapshot)).not.toThrow();
  });

  it("refuses a bundle without the snapshot, with another snapshot, or with ambient network code", () => {
    expect(() => checkBundle(`"${wasm}"`, wasm, snapshot)).toThrow(/does not embed the pinned snapshot/u);
    expect(() => checkBundle(`${module('{"b":2}')}\n"${wasm}"`, wasm, snapshot)).toThrow(/differs from the snapshot file/u);
    for (const bad of ["new WebSocket(u)", "globalThis.fetch(u)", "self.fetch(u)", "createDataChannel()", "new XMLHttpRequest()", "@kpstreams/core"]) {
      expect(() => checkBundle(`${module(snapshot)}\n"${wasm}"\n${bad}`, wasm, snapshot)).toThrow(/bundle contains/u);
    }
  });
  it("requires the bootstrap module when one is pinned, byte for byte", () => {
    const bootstrap = '{\n  "format": "nox-anon-rpc-bootstrap/1"\n}\n';
    const bootModule = (text: string) => `// nox-embed:bootstrap\n  var bootstrap_default = ${snapshotModuleSource(text).slice("export default ".length)}`;
    const base = `${module(snapshot)}\n"${wasm}"`;
    expect(() => checkBundle(`${base}\n${bootModule(bootstrap)}`, wasm, snapshot, bootstrap)).not.toThrow();
    expect(() => checkBundle(base, wasm, snapshot, bootstrap)).toThrow(/does not embed the discovery bootstrap/u);
    expect(() => checkBundle(`${base}\n${bootModule("{}\n")}`, wasm, snapshot, bootstrap)).toThrow(/bootstrap embedded in the bundle differs/u);
    expect(embeddedModuleText(`${base}\n${bootModule(bootstrap)}`, "bootstrap")).toBe(bootstrap);
    expect(() => checkBundle(base, wasm, snapshot)).not.toThrow();
  });
});

describe("the release worker bundle", () => {
  it("boots in a bare script context, verifies its snapshot and bootstrap, dials the default anchors and retries, never touching fetch", async () => {
    const { bundle } = await buildWorker({ outfile: outfile("release"), write: false });
    const events: string[] = [];
    const logs: unknown[][] = [];
    const dials: string[] = [];
    const fetchStub = vi.fn(() => Promise.reject(new Error("ambient fetch")));
    const anonRpcWorker = {
      config: undefined,
      signalReady: () => events.push("ready"),
      signalFailed: (reason: unknown) => events.push(`failed ${JSON.stringify(reason)}`),
      log: {
        debug: (...args: unknown[]) => logs.push(args),
        info: (...args: unknown[]) => logs.push(args),
        warn: (...args: unknown[]) => logs.push(args),
        error: (...args: unknown[]) => logs.push(args),
      },
      acceptCall: () => new Promise(() => {}),
      kps: {
        dial: (address: string) => {
          dials.push(address);
          return Promise.reject(Object.assign(new Error("no network in this test"), { code: "network-error" }));
        },
        openStream: () => Promise.reject(new Error("unused")),
      },
      storage: undefined,
    };
    const context = vm.createContext({
      anonRpcWorker,
      fetch: fetchStub,
      crypto: globalThis.crypto,
      WebAssembly: (globalThis as { WebAssembly?: unknown }).WebAssembly,
      AbortController,
      ReadableStream,
      WritableStream,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      DOMException,
      console,
    });
    // A Web Worker's global is reachable as `self` (ethers looks it up).
    context["self"] = context;
    vm.runInContext(Buffer.from(bundle).toString("utf8"), context);
    await vi.waitFor(() => expect(logs.some((entry) => entry[1] === "boot.retry")).toBe(true), { timeout: 5_000 });
    expect(logs.some((entry) => entry[1] === "boot.wasm")).toBe(true);
    expect(events).toEqual([]);
    expect(fetchStub).not.toHaveBeenCalled();
    // An empty config boots on the bundle's default anchors (nox-1, nox-2, nox-8 on
    // their Elastic IPs); the committed snapshot publishes no KPS address yet, so
    // they are the only addresses tried, and the worker keeps retrying.
    const bootstrap = JSON.parse(readFileSync(join(PACKAGE_DIR, "snapshot", "nox-bootstrap.json"), "utf8")) as { anchors: string[] };
    expect(new Set(dials)).toEqual(new Set(bootstrap.anchors));
    const retry = logs.find((entry) => entry[1] === "boot.retry") as [string, string, { code: string }];
    expect(retry[2].code).toBe("no-anchor-reachable");
  });
});

describe("provenance", () => {
  it("is identical for identical builds and agrees with the bundle bytes", async () => {
    await buildWorker({ outfile: outfile("p1") });
    await buildWorker({ outfile: outfile("p2") });
    // --source-commit is for exported trees: give provenance a repository root without .git.
    const exported = join(dir, "exported-repo");
    mkdirSync(exported, { recursive: true });
    mkdirSync(join(exported, "packages", "nox-tls"), { recursive: true });
    for (const file of ["package.json", "pnpm-lock.yaml", "Cargo.lock", "packages/nox-tls/Cargo.toml"]) {
      writeFileSync(join(exported, file), readFileSync(join(REPO_DIR, file)));
    }
    const options = (name: string) => ({
      distDir: join(dir, name),
      wasmRecordPath: join(dir, "absent.json"),
      sourceCommit: "a".repeat(40),
      repoDir: exported,
    });
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

  it("accepts --source-commit inside a checkout only when it is the clean HEAD", () => {
    expect(gitState(exportedRoot(), "b".repeat(40))).toEqual({ gitCommit: "b".repeat(40), gitTreeClean: true });
    expect(() => gitState(REPO_DIR, "c".repeat(40))).toThrow(/is for exported trees/u);
    expect(() => gitState(REPO_DIR, "not-a-commit")).toThrow(/full 40-character/u);
  });

  it("refuses a snapshot file that differs from the one the bundle embeds", async () => {
    await buildWorker({ outfile: outfile("p5") });
    const other = join(dir, "other-snapshot.json");
    writeFileSync(other, "{}\n");
    expect(() => makeProvenance({ distDir: join(dir, "p5"), wasmRecordPath: join(dir, "absent.json"), snapshotPath: other })).toThrow(
      /is not the snapshot the bundle embeds/u,
    );
  });

  it("records the WASM toolchain and refuses a record of another module", async () => {
    await buildWorker({ outfile: outfile("p3") });
    const record = JSON.parse(readFileSync(join(dir, "p3", "build-record.json"), "utf8")) as {
      wasm: { sha256: string };
      tls: { sha256: string };
    };
    const wasmRecord = join(dir, "wasm-toolchain.json");
    const tools = { rustc: "rustc 1.95.0", wasmPack: "0.13.1", wasmBindgen: "0.2.114", wasmOpt: "117", clang: "19.1.7", pinsChecked: true };
    writeFileSync(wasmRecord, JSON.stringify({ ...tools, wasmSha256: record.wasm.sha256, tlsWasmSha256: record.tls.sha256 }));
    const provenance = makeProvenance({ distDir: join(dir, "p3"), wasmRecordPath: wasmRecord });
    expect(provenance["toolchain"]).toMatchObject({ rustc: "rustc 1.95.0", wasmOpt: "117", clang: "19.1.7", wasmPinsChecked: true });
    expect(provenance["inputs"]).toMatchObject({ tlsWasmSha256: record.tls.sha256 });
    expect(provenance["tls"]).toMatchObject({ webpkiRoots: expect.stringMatching(/^\d+\.\d+\.\d+$/u), extraRoots: 0 });
    writeFileSync(wasmRecord, JSON.stringify({ ...tools, wasmSha256: "00".repeat(32), tlsWasmSha256: record.tls.sha256 }));
    expect(() => makeProvenance({ distDir: join(dir, "p3"), wasmRecordPath: wasmRecord })).toThrow(/nox-wasm module .* is not the one/u);
    writeFileSync(wasmRecord, JSON.stringify({ ...tools, wasmSha256: record.wasm.sha256, tlsWasmSha256: "00".repeat(32) }));
    expect(() => makeProvenance({ distDir: join(dir, "p3"), wasmRecordPath: wasmRecord })).toThrow(/nox-tls module .* is not the one/u);
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
