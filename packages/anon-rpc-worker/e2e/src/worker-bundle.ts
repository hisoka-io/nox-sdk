// Where the Nox worker bundle under test comes from. The worker pins its
// topology snapshot inside the bundle (D-02), and a local mesh gets fresh
// sphinx keys every run, so the bundle has to be built for the running mesh:
// NOX_WORKER_BUILD_CMD receives testbed.json (nodes, roles, sphinx keys, KPS
// addresses) and writes the bundle. Without it, NOX_WORKER_BUNDLE (default
// ../dist/anon-rpc-worker.js) is used as is.

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

export async function resolveWorkerBundle(
  config: TestbedConfig,
  runRoot: string,
  testbedJson: string,
  logDir: string,
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
    return { kind: "prebuilt", path, bytes: new Uint8Array(readFileSync(path)) };
  }
  const out = join(runRoot, "nox-worker", "anon-rpc-worker.js");
  mkdirSync(dirname(out), { recursive: true });
  const rendered = renderBuildCommand(template, { testbed_json: testbedJson, out });
  const { command, args } = splitCommand(rendered);
  const proc = ManagedProcess.start({
    label: "worker build (NOX_WORKER_BUILD_CMD)",
    command,
    args,
    logFile: join(logDir, "worker-build.log"),
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
  return { kind: "built", path: out, bytes: new Uint8Array(readFileSync(out)), command: rendered };
}
