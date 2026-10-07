// Where the Nox worker bundle under test comes from. The worker pins its
// topology snapshot inside the bundle (D-02), and a local mesh gets fresh
// sphinx keys every run, so the bundle has to be built for the running mesh:
// NOX_WORKER_BUILD_CMD receives testbed.json (nodes, roles, sphinx keys, KPS
// addresses) and writes the bundle. Without it, NOX_WORKER_BUNDLE (default
// ../dist/anon-rpc-worker.js) is used as is. Either way the bundle must pin
// this run's mesh: every node's sphinx key has to appear in its embedded
// snapshot, or the run stops with a config error instead of failing later in
// a confusing way.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestbedConfig } from "./config.js";
import { TestbedError } from "./errors.js";
import { ManagedProcess } from "./process.js";
import { splitCommand } from "./kps-server.js";

export type WorkerBundleSource =
  | { readonly kind: "built"; readonly path: string; readonly bytes: Uint8Array; readonly command: string }
  | { readonly kind: "prebuilt"; readonly path: string; readonly bytes: Uint8Array }
  | { readonly kind: "missing"; readonly reason: string };

const PLACEHOLDER = /\{(testbed_json|out)\}/gu;

/** Render NOX_WORKER_BUILD_CMD; any other {placeholder} is an error. */
export function renderBuildCommand(template: string, vars: { testbed_json: string; out: string }): string {
  const unknown = /\{([a-z_]+)\}/gu.exec(template.replace(PLACEHOLDER, ""));
  if (unknown !== null) {
    throw new TestbedError("config", `NOX_WORKER_BUILD_CMD has an unknown placeholder {${unknown[1] ?? ""}}; known: {testbed_json}, {out}`);
  }
  for (const [name, value] of Object.entries(vars)) {
    if (/\s/u.test(value)) throw new TestbedError("config", `NOX_WORKER_BUILD_CMD placeholder {${name}} contains whitespace: ${value}`);
  }
  return template.replace(PLACEHOLDER, (_whole, name: "testbed_json" | "out") => vars[name]);
}

/**
 * Mesh nodes whose sphinx key the bundle does not carry; empty when the bundle
 * pins this mesh or when testbed.json describes no mesh.
 */
export function meshKeysMissingFromBundle(bundle: Uint8Array, testbedJson: string): string[] {
  if (!existsSync(testbedJson)) return [];
  const info = JSON.parse(readFileSync(testbedJson, "utf8")) as {
    mesh?: { nodes?: readonly { id: number; sphinxPublicKey: string }[] };
  };
  const nodes = info.mesh?.nodes ?? [];
  const text = new TextDecoder().decode(bundle).toLowerCase();
  return nodes
    .filter((node) => !text.includes(node.sphinxPublicKey.toLowerCase().replace(/^0x/u, "")))
    .map((node) => `node ${node.id}`);
}

function requirePinnedMesh(source: { readonly path: string; readonly bytes: Uint8Array }, testbedJson: string): void {
  const missing = meshKeysMissingFromBundle(source.bytes, testbedJson);
  if (missing.length === 0) return;
  throw new TestbedError(
    "config",
    `the worker bundle at ${source.path} pins another topology: the sphinx keys of ${missing.join(", ")} of this run's mesh ` +
      "are absent. Mesh keys are fresh every run, so build the bundle for it with NOX_WORKER_BUILD_CMD",
  );
}

/**
 * The bundle under test. `variant` names a second build for the same mesh
 * (its own directory and log) and `extraArgs` go to the build command after
 * the template, e.g. `--extra-root` for the TLS-tunnel spec.
 */
export async function resolveWorkerBundle(
  config: TestbedConfig,
  runRoot: string,
  testbedJson: string,
  logDir: string,
  variant?: { readonly name: string; readonly extraArgs: readonly string[] },
): Promise<WorkerBundleSource> {
  const template = config.worker.buildCommand;
  if (template === undefined) {
    const path = config.worker.bundlePath;
    if (!existsSync(path)) {
      return {
        kind: "missing",
        reason: `no worker bundle at ${path}; set NOX_WORKER_BUILD_CMD (builds one for this mesh) or NOX_WORKER_BUNDLE`,
      };
    }
    const prebuilt = { kind: "prebuilt", path, bytes: new Uint8Array(readFileSync(path)) } as const;
    requirePinnedMesh(prebuilt, testbedJson);
    return prebuilt;
  }
  const out = join(runRoot, variant === undefined ? "nox-worker" : `nox-worker-${variant.name}`, "anon-rpc-worker.js");
  mkdirSync(dirname(out), { recursive: true });
  const rendered = [renderBuildCommand(template, { testbed_json: testbedJson, out }), ...(variant?.extraArgs ?? [])].join(" ");
  const { command, args } = splitCommand(rendered);
  const proc = ManagedProcess.start({
    label: "worker build (NOX_WORKER_BUILD_CMD)",
    command,
    args,
    logFile: join(logDir, variant === undefined ? "worker-build.log" : `worker-build-${variant.name}.log`),
  });
  const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), config.worker.buildTimeoutMs));
  const outcome = await Promise.race([proc.exited, timer]);
  if (outcome === "timeout") {
    await proc.stop("SIGTERM");
    throw new TestbedError(
      "timeout",
      `worker build did not finish within ${config.worker.buildTimeoutMs} ms (log: ${proc.logFile})\n${proc.tail()}`,
    );
  }
  if (outcome.code !== 0) {
    throw new TestbedError(
      "process-exit",
      `worker build exited with ${outcome.signal ?? `code ${String(outcome.code)}`} (log: ${proc.logFile})\n${proc.tail()}`,
    );
  }
  await proc.stop();
  if (!existsSync(out)) {
    throw new TestbedError("process-exit", `worker build succeeded but wrote no bundle at ${out} (log: ${proc.logFile})`);
  }
  const built = { kind: "built", path: out, bytes: new Uint8Array(readFileSync(out)), command: rendered } as const;
  requirePinnedMesh(built, testbedJson);
  return built;
}
