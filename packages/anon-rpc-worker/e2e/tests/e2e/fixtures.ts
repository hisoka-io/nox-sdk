// Playwright fixtures. Infrastructure is worker-scoped (started once per test
// worker, on first use, torn down at the end): a spec that never asks for the
// mesh never starts it.

import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { test as base, type Page, type TestInfo } from "@playwright/test";
import type { HarnessVersion } from "../../src/bundles.js";
import { loadConfig, type TestbedConfig } from "../../src/config.js";
import { egressPolicy } from "../../src/egress.js";
import { startEgressProxy } from "../../src/egress-proxy.js";
import { startHostServer, type HostServer } from "../../src/host-server.js";
import {
  createRunPaths,
  startChains,
  startMeshWithSidecars,
  startResolver,
  type Chains,
  type MeshWithSidecars,
  type Resolver,
  type RunPaths,
} from "../../src/testbed.js";
import { EgressMonitor } from "./helpers.js";

/** Mesh startup budget: nox_mesh_server readiness plus sidecars. */
const MESH_FIXTURE_TIMEOUT_MS = 6 * 60_000;
const INFRA_FIXTURE_TIMEOUT_MS = 2 * 60_000;

export interface WorkerFixtures {
  cfg: TestbedConfig;
  runPaths: RunPaths;
  chains: Chains;
  resolver: Resolver;
  hostServer: HostServer;
  meshBed: MeshWithSidecars;
}

/** A browser context whose every request goes through the recording egress proxy. */
export interface GuardedHost {
  /** Watching since before the context's first page existed. */
  readonly monitor: EgressMonitor;
  /** Navigate the guarded page to the host page of a harness version. */
  open(version: HarnessVersion): Promise<Page>;
}

export interface TestFixtures {
  /** Navigate the test page to the host page of a harness version and wait for window.e2e. */
  openHost: (version: HarnessVersion) => Promise<Page>;
  /**
   * The host page in its own proxied context, for the egress check. Allowlist:
   * the host page origin, the resolver origin and the specifier RPC.
   */
  guardedHost: GuardedHost;
}

/** Write a page's console and errors to the run's log directory. */
function logPage(page: Page, runPaths: RunPaths, testInfo: TestInfo, label: string): () => Promise<void> {
  const consoleLog = createWriteStream(
    join(runPaths.logs, `page-${testInfo.project.name}-${testInfo.testId}${label}.log`),
    { flags: "a" },
  );
  consoleLog.on("error", () => undefined);
  page.on("console", (message) => consoleLog.write(`[${message.type()}] ${message.text()}\n`));
  page.on("pageerror", (error) => consoleLog.write(`[pageerror] ${error.message}\n`));
  return () => new Promise<void>((resolve) => consoleLog.end(() => resolve()));
}

async function navigateHost(page: Page, hostServer: HostServer, version: HarnessVersion, cfg: TestbedConfig): Promise<Page> {
  await page.goto(hostServer.pageUrl(version));
  await page.waitForFunction(
    (expected) => typeof window.e2e === "object" && window.e2e.harnessVersion === expected,
    version,
    { timeout: cfg.pageTimeoutMs },
  );
  return page;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  cfg: [
    async ({}, use) => {
      await use(loadConfig());
    },
    { scope: "worker" },
  ],

  runPaths: [
    async ({ cfg }, use, workerInfo) => {
      await use(createRunPaths(cfg, `playwright-${workerInfo.project.name}`));
    },
    { scope: "worker" },
  ],

  chains: [
    async ({ cfg, runPaths }, use) => {
      const chains = await startChains(cfg, runPaths);
      try {
        await use(chains);
      } finally {
        await chains.stop();
      }
    },
    { scope: "worker", timeout: INFRA_FIXTURE_TIMEOUT_MS },
  ],

  resolver: [
    async ({}, use) => {
      const resolver = await startResolver();
      try {
        await use(resolver);
      } finally {
        await resolver.server.close();
      }
    },
    { scope: "worker" },
  ],

  hostServer: [
    async ({ cfg }, use) => {
      const server = await startHostServer(cfg.e2eRoot);
      try {
        await use(server);
      } finally {
        await server.close();
      }
    },
    { scope: "worker", timeout: INFRA_FIXTURE_TIMEOUT_MS },
  ],

  meshBed: [
    async ({ cfg, runPaths, chains }, use) => {
      const bed = await startMeshWithSidecars(cfg, runPaths, chains.upstream);
      try {
        await use(bed);
      } finally {
        await bed.stop();
      }
    },
    { scope: "worker", timeout: MESH_FIXTURE_TIMEOUT_MS },
  ],

  openHost: async ({ page, hostServer, runPaths, cfg }, use, testInfo) => {
    const closeLog = logPage(page, runPaths, testInfo, "");
    await use((version) => navigateHost(page, hostServer, version, cfg));
    await closeLog();
  },

  guardedHost: async ({ browser, hostServer, resolver, chains, runPaths, cfg }, use, testInfo) => {
    const proxy = await startEgressProxy();
    try {
      const context = await browser.newContext({ proxy: { server: proxy.url } });
      try {
        const policy = egressPolicy([hostServer.origin, resolver.server.origin, chains.specifier.url]);
        const monitor = new EgressMonitor(context, proxy, policy);
        const page = await context.newPage();
        const closeLog = logPage(page, runPaths, testInfo, "-guarded");
        await use({ monitor, open: (version) => navigateHost(page, hostServer, version, cfg) });
        monitor.stop();
        await closeLog();
      } finally {
        await context.close();
      }
    } finally {
      await proxy.close();
    }
  },
});

export { expect } from "@playwright/test";
