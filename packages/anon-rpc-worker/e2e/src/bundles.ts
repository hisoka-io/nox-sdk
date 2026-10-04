// esbuild builds used by the test bed: the host page script (once per harness
// version) and the test-only workers (classic-script IIFEs, the anon-rpc §4
// artifact shape).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { E2E_ROOT } from "./config.js";
import { TestbedError } from "./errors.js";

/** Published harness versions under test and the package name each is installed as. */
export const HARNESS_PACKAGES = {
  "0.3.2": "@anon-rpc/browser-harness",
  "0.3.0": "@anon-rpc/browser-harness-0.3.0",
} as const;

export type HarnessVersion = keyof typeof HARNESS_PACKAGES;
export const HARNESS_VERSIONS = Object.keys(HARNESS_PACKAGES) as HarnessVersion[];

/** Read the installed harness package version, so a lockfile drift fails loudly. */
export function installedHarnessVersion(version: HarnessVersion, e2eRoot: string = E2E_ROOT): string {
  const manifest = join(e2eRoot, "node_modules", HARNESS_PACKAGES[version], "package.json");
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
  if (parsed.version !== version) {
    throw new TestbedError(
      "prerequisite",
      `${HARNESS_PACKAGES[version]} is ${String(parsed.version)}, expected ${version}; run pnpm install --ignore-workspace`,
    );
  }
  return version;
}

export async function buildPageBundle(version: HarnessVersion, e2eRoot: string = E2E_ROOT): Promise<Uint8Array> {
  installedHarnessVersion(version, e2eRoot);
  const result = await build({
    absWorkingDir: e2eRoot,
    entryPoints: [join(e2eRoot, "page", "probe-page.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "warning",
    tsconfig: join(e2eRoot, "page", "tsconfig.json"),
    alias: { "@anon-rpc/browser-harness": HARNESS_PACKAGES[version] },
    define: { __HARNESS_VERSION__: JSON.stringify(version) },
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new TestbedError("prerequisite", "esbuild produced no page bundle");
  return output.contents;
}

/** Test-only workers under workers/, each bundled to a classic-script IIFE. */
export const TEST_WORKERS = {
  /** Exercises anonRpcWorker.kps (workers/kps-probe-worker.ts). */
  "kps-probe": "kps-probe-worker.ts",
  /** Negative control for the egress check (workers/leaky-worker.ts). */
  leaky: "leaky-worker.ts",
} as const;

export type TestWorker = keyof typeof TEST_WORKERS;

/** A test worker's bundle bytes (hash-pinned through a specifier like any worker). */
export async function buildTestWorker(worker: TestWorker, e2eRoot: string = E2E_ROOT): Promise<Uint8Array> {
  const result = await build({
    absWorkingDir: e2eRoot,
    entryPoints: [join(e2eRoot, "workers", TEST_WORKERS[worker])],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "warning",
    tsconfig: join(e2eRoot, "workers", "tsconfig.json"),
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new TestbedError("prerequisite", `esbuild produced no ${worker} worker bundle`);
  return output.contents;
}

/** The KPS probe worker bundle bytes. */
export function buildProbeWorker(e2eRoot: string = E2E_ROOT): Promise<Uint8Array> {
  return buildTestWorker("kps-probe", e2eRoot);
}
