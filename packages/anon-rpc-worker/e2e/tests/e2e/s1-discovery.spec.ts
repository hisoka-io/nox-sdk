// S1 discovery end to end (PROPOSAL §2.2, D-22..D-24) on bed L: identity from
// the chain, location looked up at run time, with no new bundle.
//
//   1. A node changes its KPS address: its nox-kps restarts on another port
//      with the same identity and the node sends updateMetadataUrl from its
//      own key. The running worker's chain check (through the mixnet, two
//      exits to two providers, finalized block) picks the new address up, and
//      calls keep working when that address is the only reachable entry.
//   2. A node registers after the bundle was built. The running worker finds
//      it (registration logs close the member set), puts it on probation, and
//      routes through it when it is the only reachable entry.
//
// Setup: only two nodes publish a KPS address (the others' metadataUrl is
// parked empty, restored afterwards), so the entries the worker can use are
// exactly the ones each test leaves reachable. The bundle is built for this
// spec: snapshot after the parking and after the late node left, bootstrap
// anchors = the anchor node only, empty worker config.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { mineBlocks } from "../../src/anvil.js";
import { loadConfig } from "../../src/config.js";
import { describeEvents } from "../../src/egress.js";
import {
  forceUnregister,
  registerMember,
  updateMetadataUrl,
  waitForServedRegistry,
  waitForServedState,
  type RegistryMember,
} from "../../src/registry.js";
import { writeReport } from "../../src/report.js";
import {
  describeTestbed,
  kpsMetadataUrl,
  publishWorker,
  writeTestbedInfo,
  type MeshWithSidecars,
  type PublishedWorker,
  type RegisteredRegistry,
} from "../../src/testbed.js";
import { resolveWorkerBundle } from "../../src/worker-bundle.js";
import type { LogLine } from "../../page/api.js";
import { expect, test, type GuardedHost } from "./fixtures.js";
import { rpcCall, rpcResult, rpcViaWorker } from "./helpers.js";

/** Relays in the fleet layout (1,1,1,1,1,2,2,1,1,2): the node that moves, the anchor, the late joiner. */
const MOVER = 1;
const ANCHOR = 2;
const LATE = 8;
const WORKER_ID = "nox-s1";
/** Blocks mined after a registry change, so the `finalized` tag (latest - 2) includes it. */
const FINALITY_BLOCKS = 3;
/** Wait for the worker to log a verified chain check with the expected change. */
const DISCOVERY_WAIT_MS = 90_000;
const LOG_POLL_MS = 500;
const LOG_DRAIN_MAX = 200;
/** Calls allowed while the worker moves off entries that went away. */
const ENTRY_FAILOVER_CALLS = 4;

const early = loadConfig();
const prerequisites: string[] = [];
if (early.kps.sidecarCommand === undefined) prerequisites.push("NOX_KPS_CMD is unset (one nox-kps sidecar per mesh node)");
if (!early.mesh.localRegistry) prerequisites.push("E2E_LOCAL_REGISTRY=0: discovery reads the mesh's local NoxRegistry");
if (early.worker.buildCommand === undefined) prerequisites.push("NOX_WORKER_BUILD_CMD is unset: this spec builds its own bundle");
if (early.mesh.nodes <= LATE) prerequisites.push(`the mesh needs more than ${LATE} nodes`);

interface SpecState {
  readonly registry: RegisteredRegistry;
  readonly worker: PublishedWorker;
  readonly snapshotBlock: number;
  /** Nodes whose metadataUrl this spec parked empty. */
  readonly parked: readonly number[];
  lateRegistered: boolean;
  moved: boolean;
}

test.describe.serial("S1: identity from chain, location at run time", () => {
  test.skip(prerequisites.length > 0, prerequisites.join("; "));

  let state: SpecState | undefined;

  function pin(): SpecState {
    if (state === undefined) throw new Error("the S1 bundle was not published in beforeAll");
    return state;
  }

  function memberOf(registry: RegisteredRegistry, mesh: MeshWithSidecars, id: number): RegistryMember {
    const node = mesh.mesh.info.nodes[id];
    const member = registry.members.find((candidate) => candidate.address === node?.address);
    if (member === undefined) throw new Error(`node ${id} is not a registry member of this bed`);
    return member;
  }

  test.beforeAll(async ({ cfg, runPaths, chains, resolver, meshBed }) => {
    const registry = meshBed.registry;
    if (registry === undefined) throw new Error("the bed has no local NoxRegistry");
    const upstream = chains.upstream.url;
    const nodes = meshBed.mesh.info.nodes;
    const parked = nodes.map((node) => node.id).filter((id) => id !== MOVER && id !== ANCHOR && id !== LATE);
    for (const id of parked) await updateMetadataUrl(upstream, registry.address, nodes[id]!.address, "");
    // Nodes report the block of the last registry change they applied, not the chain head.
    const lastChange = await forceUnregister(upstream, registry, nodes[LATE]!.address);
    await mineBlocks(upstream, FINALITY_BLOCKS);
    // The snapshot block must not be after the block nodes serve, or every served document is refused.
    const snapshotBlock = lastChange;
    const parkedAddresses = new Set(parked.map((id) => nodes[id]!.address.toLowerCase()));
    await waitForServedState(
      nodes.filter((node) => node.id !== LATE).map((node) => node.topologyUrl),
      lastChange,
      cfg.mesh.registrySyncTimeoutMs,
      (served) => !served.has(nodes[LATE]!.address.toLowerCase()) &&
        [...parkedAddresses].every((address) => served.get(address)?.metadataUrl === ""),
    );

    const info = describeTestbed({ config: cfg, paths: runPaths, chains, resolver, mesh: meshBed });
    const anchor = meshBed.publishedKps.get(ANCHOR);
    if (info.mesh?.registry === undefined || info.mesh.discovery === undefined || anchor === undefined) {
      throw new Error("testbed.json lacks the registry, discovery inputs or the anchor's KPS address");
    }
    const variant = {
      ...info,
      mesh: {
        ...info.mesh,
        // The late node is not in this bundle's snapshot: that is the point of test 2.
        nodes: info.mesh.nodes.filter((node) => node.id !== LATE),
        registry: { ...info.mesh.registry, registeredBlock: snapshotBlock },
        discovery: { ...info.mesh.discovery, anchors: [anchor] },
      },
    };
    const testbedJson = join(runPaths.root, "testbed-s1.json");
    writeFileSync(testbedJson, `${JSON.stringify(variant, null, 2)}\n`);
    const source = await resolveWorkerBundle(cfg, join(runPaths.root, "s1"), testbedJson, runPaths.logs);
    if (source.kind === "missing") throw new Error(source.reason);
    const worker = await publishWorker(chains, resolver, source.bytes);
    state = { registry, worker, snapshotBlock, parked, lateRegistered: false, moved: false };
    writeTestbedInfo(runPaths, { ...info, workers: { "nox-s1": worker } });
    writeReport(cfg, runPaths, "s1-fixture", {
      snapshotBlock,
      parked,
      anchor: anchor.split(":").slice(0, 2).join(":"),
      workerHash: worker.workerHash,
      bytes: worker.bytes,
      providers: info.mesh.discovery.providers,
    });
  });

  test.afterAll(async ({ cfg, chains, meshBed }) => {
    const current = state;
    const registry = meshBed.registry;
    if (current === undefined || registry === undefined) return;
    const upstream = chains.upstream.url;
    const nodes = meshBed.mesh.info.nodes;
    // Every sidecar back on its published address, every metadataUrl back, the late node registered.
    for (const node of nodes) {
      if (!meshBed.sidecars.has(node.id) || (node.id === MOVER && current.moved)) {
        await meshBed.startSidecar(node.id, "original");
      }
    }
    let lastChange = 0;
    for (const id of [...current.parked, ...(current.moved ? [MOVER] : [])]) {
      lastChange = await updateMetadataUrl(upstream, registry.address, nodes[id]!.address, memberOf(registry, meshBed, id).metadataUrl);
    }
    if (!current.lateRegistered) lastChange = await registerMember(upstream, registry, memberOf(registry, meshBed, LATE));
    await mineBlocks(upstream, FINALITY_BLOCKS);
    await waitForServedRegistry(nodes.map((node) => node.topologyUrl), registry.members, lastChange, cfg.mesh.registrySyncTimeoutMs);
  });

  function expectKpsOnlyEgress(guarded: GuardedHost): void {
    expect(guarded.monitor.violations(), guarded.monitor.describeViolations()).toEqual([]);
  }

  async function bootEmpty(page: Page, specifierUrl: string, readyTimeoutMs: number) {
    // The adopters' default: no config at all. The bundle's bootstrap supplies the anchor.
    return page.evaluate((request) => window.e2e.boot(request), {
      id: WORKER_ID,
      address: pin().worker.address,
      specifierRpcUrl: specifierUrl,
      readyTimeoutMs,
    });
  }

  /** Drain worker logs until one line matches `predicate` or the wait ends; returns every line read. */
  async function waitForLog(page: Page, seen: LogLine[], predicate: (line: LogLine) => boolean, timeoutMs: number): Promise<LogLine | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = seen.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() > deadline) return undefined;
      const lines = await page.evaluate(({ id, max, wait }) => window.e2e.logs(id, max, wait), {
        id: WORKER_ID,
        max: LOG_DRAIN_MAX,
        wait: LOG_POLL_MS,
      });
      seen.push(...lines);
    }
  }

  function field(line: LogLine | undefined, name: string): number {
    const match = line === undefined ? null : new RegExp(`"${name}":(\\d+)`, "u").exec(line.text);
    return match === null ? -1 : Number(match[1]);
  }

  /** eth_blockNumber through the worker, allowing a few calls while entries that went away are left behind. */
  async function callThroughFailover(page: Page, upstreamUrl: string, timeoutMs: number) {
    const outcomes = [];
    for (let attempt = 0; attempt < ENTRY_FAILOVER_CALLS; attempt++) {
      const outcome = await rpcViaWorker(page, WORKER_ID, upstreamUrl, rpcCall("eth_blockNumber", [], attempt), timeoutMs);
      outcomes.push({ ok: outcome.result.ok, ms: outcome.result.ms, error: outcome.result.error?.code });
      if (outcome.result.ok && outcome.result.status === 200) return { outcome, outcomes };
    }
    return { outcome: undefined, outcomes };
  }

  test("a node changes its KPS address on chain and the running worker follows it without a new bundle", async ({
    cfg,
    runPaths,
    chains,
    meshBed,
    guardedHost,
  }) => {
    const page = await guardedHost.open("0.3.2");
    const ready = await bootEmpty(page, chains.specifier.url, cfg.worker.readyTimeoutMs);
    expect(ready.ok, JSON.stringify(ready.error)).toBe(true);
    const first = await rpcViaWorker(page, WORKER_ID, chains.upstream.url, rpcCall("eth_chainId"), cfg.worker.callTimeoutMs);
    expect(rpcResult(first.json)).toBe(`0x${chains.upstream.chainId.toString(16)}`);
    const logs: LogLine[] = [];
    const firstCheck = await waitForLog(page, logs, (line) => line.text.includes("discovery.verified"), DISCOVERY_WAIT_MS);
    expect(firstCheck, logs.map((line) => line.text).slice(-20).join("\n")).toBeDefined();

    // The operator moves: same identity (certhash), new UDP port, then updateMetadataUrl from the node's key.
    const registry = pin().registry;
    const original = meshBed.publishedKps.get(MOVER)!;
    const newPort = cfg.mesh.basePort + cfg.mesh.nodes * 10 + 5;
    const moved = await meshBed.moveSidecar(MOVER, newPort);
    pin().moved = true;
    expect(moved.address).not.toBe(original);
    expect(moved.address.split(":")[2]).toBe(original.split(":")[2]);
    const mover = meshBed.mesh.info.nodes[MOVER]!.address;
    await updateMetadataUrl(chains.upstream.url, registry.address, mover, kpsMetadataUrl(moved.address));
    await mineBlocks(chains.upstream.url, FINALITY_BLOCKS);

    const picked = await waitForLog(
      page,
      logs,
      (line) => line.text.includes("discovery.verified") && field(line, "moved") >= 1,
      DISCOVERY_WAIT_MS,
    );
    expect(picked, logs.map((line) => line.text).slice(-30).join("\n")).toBeDefined();

    // Leave the moved address as the only reachable entry: the worker must use it.
    await meshBed.stopSidecar(ANCHOR);
    try {
      const { outcome, outcomes } = await callThroughFailover(page, chains.upstream.url, cfg.worker.callTimeoutMs);
      expect(outcome, JSON.stringify(outcomes)).toBeDefined();
      expectKpsOnlyEgress(guardedHost);
      writeReport(cfg, runPaths, "s1-location-change", {
        movedTo: moved.address.split(":").slice(0, 2).join(":"),
        verifiedLog: picked?.text,
        callsAfterAnchorStopped: outcomes,
        egress: describeEvents(guardedHost.monitor.events()),
      });
    } finally {
      await meshBed.startSidecar(ANCHOR, "original");
    }
    await page.evaluate((id) => window.e2e.close(id), WORKER_ID);
  });

  test("a node registers after the bundle and becomes usable on probation", async ({
    cfg,
    runPaths,
    chains,
    meshBed,
    guardedHost,
  }) => {
    const page = await guardedHost.open("0.3.2");
    const ready = await bootEmpty(page, chains.specifier.url, cfg.worker.readyTimeoutMs);
    expect(ready.ok, JSON.stringify(ready.error)).toBe(true);
    const logs: LogLine[] = [];
    expect(await waitForLog(page, logs, (line) => line.text.includes("discovery.verified"), DISCOVERY_WAIT_MS)).toBeDefined();

    const registry = pin().registry;
    await registerMember(chains.upstream.url, registry, memberOf(registry, meshBed, LATE));
    pin().lateRegistered = true;
    await mineBlocks(chains.upstream.url, FINALITY_BLOCKS);

    const probation = await waitForLog(
      page,
      logs,
      (line) => line.text.includes("discovery.probation") && field(line, "members") >= 1,
      DISCOVERY_WAIT_MS,
    );
    expect(probation, logs.map((line) => line.text).slice(-30).join("\n")).toBeDefined();
    const verified = logs.filter((line) => line.text.includes("discovery.verified")).at(-1);
    expect(field(verified, "added")).toBeGreaterThanOrEqual(1);

    // The new member is the only reachable entry: routes are new member (probation) -> settled mix -> settled exit.
    const stopped = [ANCHOR, MOVER];
    for (const id of stopped) await meshBed.stopSidecar(id);
    try {
      const { outcome, outcomes } = await callThroughFailover(page, chains.upstream.url, cfg.worker.callTimeoutMs);
      expect(outcome, JSON.stringify(outcomes)).toBeDefined();
      expectKpsOnlyEgress(guardedHost);
      writeReport(cfg, runPaths, "s1-new-member-probation", {
        probationLog: probation?.text,
        verifiedLog: verified?.text,
        callsWithOnlyTheNewEntry: outcomes,
      });
    } finally {
      // Sidecars back where the chain says they are (afterAll restores the published addresses).
      await meshBed.startSidecar(ANCHOR, "original");
      if (pin().moved) await meshBed.moveSidecar(MOVER, cfg.mesh.basePort + cfg.mesh.nodes * 10 + 5);
      else await meshBed.startSidecar(MOVER, "original");
    }
    await page.evaluate((id) => window.e2e.close(id), WORKER_ID);
  });
});
