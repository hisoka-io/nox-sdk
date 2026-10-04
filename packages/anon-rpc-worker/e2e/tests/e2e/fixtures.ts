// Playwright fixtures. Infrastructure is worker-scoped (started once per test
// worker, on first use, torn down at the end): a spec that never asks for the
// mesh never starts it.

import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { test as base, type Page } from "@playwright/test";
import type { HarnessVersion } from "../../src/bundles.js";
import { loadConfig, type TestbedConfig } from "../../src/config.js";
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

export interface TestFixtures {
  /** Navigate the test page to the host page of a harness version and wait for window.e2e. */
  openHost: (version: HarnessVersion) => Promise<Page>;
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
    const consoleLog = createWriteStream(
      join(runPaths.logs, `page-${testInfo.project.name}-${testInfo.testId}.log`),
      { flags: "a" },
    );
    consoleLog.on("error", () => undefined);
    page.on("console", (message) => consoleLog.write(`[${message.type()}] ${message.text()}\n`));
    page.on("pageerror", (error) => consoleLog.write(`[pageerror] ${error.message}\n`));
    await use(async (version) => {
      await page.goto(hostServer.pageUrl(version));
      await page.waitForFunction(
        (expected) => typeof window.e2e === "object" && window.e2e.harnessVersion === expected,
        version,
        { timeout: cfg.pageTimeoutMs },
      );
      return page;
    });
    await new Promise<void>((resolve) => consoleLog.end(() => resolve()));
  },
});

export { expect } from "@playwright/test";
