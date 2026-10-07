// Composition of the test-bed pieces, shared by the Playwright fixtures and the
// long-running `pnpm testbed` CLI.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { startAnvil, type AnvilChain } from "./anvil.js";
import { sidecarAdminPort, sidecarUdpPort, type TestbedConfig } from "./config.js";
import { ContentStore, keccakPath } from "./content-store.js";
import { TestbedError } from "./errors.js";
import { parseKpsAddress, startSidecar, type RunningKpsServer, type SidecarVars } from "./kps-server.js";
import { startMesh, type MeshNodeInfo, type RunningMesh } from "./mesh.js";
import { delay } from "./process.js";
import {
  deployLocalRegistry,
  registerMembers,
  waitForServedRegistry,
  type LocalRegistry,
  type RegistryMember,
} from "./registry.js";
import { startResolverServer, type ResolverServer } from "./resolver-server.js";
import { startRpcForwarder, type RpcForwarder } from "./rpc-forwarder.js";
import { deploySpecifier } from "./specifier.js";

/** Directory of one test-bed run: logs, mesh data, KPS keys, reports. */
export interface RunPaths {
  readonly root: string;
  readonly logs: string;
  readonly mesh: string;
  readonly kps: string;
  readonly keccak: string;
  readonly reports: string;
}

export function createRunPaths(config: TestbedConfig, label: string): RunPaths {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const root = join(config.runDir, `${stamp}-${label}-${process.pid}`);
  const paths: RunPaths = {
    root,
    logs: join(root, "logs"),
    mesh: join(root, "mesh"),
    kps: join(root, "kps"),
    keccak: join(root, "keccak"),
    reports: join(root, "reports"),
  };
  for (const dir of [paths.logs, paths.kps, paths.keccak, paths.reports]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(config.runDir, "latest-run.txt"), `${root}\n`);
  return paths;
}

export interface Chains {
  /** Holds the WorkerSpecifier (stands in for Ethereum mainnet). */
  readonly specifier: AnvilChain;
  /** The wallet's RPC target; the exits' HttpRequest destination. */
  readonly upstream: AnvilChain;
  /**
   * The RPC providers the worker's registry checks read through exits: the
   * upstream anvil and a forwarder on another port in front of it (two
   * providers serving one chain, as the fleet's providers serve Arbitrum).
   */
  readonly registryProviders: readonly string[];
  readonly forwarder: RpcForwarder;
  stop(): Promise<void>;
}

export async function startChains(config: TestbedConfig, paths: RunPaths): Promise<Chains> {
  const specifier = await startAnvil(config.anvil, {
    label: "anvil-specifier",
    chainId: config.anvil.specifierChainId,
    logDir: paths.logs,
  });
  let upstream: AnvilChain;
  try {
    upstream = await startAnvil(config.anvil, {
      label: "anvil-upstream",
      chainId: config.anvil.upstreamChainId,
      logDir: paths.logs,
      // `finalized` trails `latest` by two blocks: registry checks see recent changes.
      slotsInAnEpoch: 1,
    });
  } catch (error) {
    await specifier.stop();
    throw error;
  }
  let forwarder: RpcForwarder;
  try {
    forwarder = await startRpcForwarder(upstream.url);
  } catch (error) {
    await Promise.all([specifier.stop(), upstream.stop()]);
    throw error;
  }
  return {
    specifier,
    upstream,
    registryProviders: [upstream.url, forwarder.url],
    forwarder,
    stop: async () => {
      await Promise.all([specifier.stop(), upstream.stop(), forwarder.close()]);
    },
  };
}

export interface Resolver {
  readonly store: ContentStore;
  readonly server: ResolverServer;
}

export async function startResolver(): Promise<Resolver> {
  const store = new ContentStore();
  return { store, server: await startResolverServer(store) };
}

export interface PublishedWorker {
  /** WorkerSpecifier address on the specifier chain. */
  readonly address: string;
  readonly workerHash: string;
  readonly resolvers: readonly string[];
  readonly bytes: number;
}

/**
 * Put `bundle` in the resolver store and deploy a WorkerSpecifier pinning it,
 * with the local resolver as the only resolver (plus any `extraResolvers`
 * listed first, e.g. failing entries for fall-through tests).
 */
export async function publishWorker(
  chains: Chains,
  resolver: Resolver,
  bundle: Uint8Array,
  extraResolvers: readonly string[] = [],
): Promise<PublishedWorker> {
  const workerHash = resolver.store.put(bundle);
  const resolvers = [...extraResolvers, resolver.server.urlFor(workerHash)];
  const address = await deploySpecifier(chains.specifier.url, chains.specifier.account, { workerHash, resolvers });
  return { address, workerHash, resolvers, bytes: bundle.length };
}

/** Which identity a restarted sidecar serves. */
export type SidecarIdentity = "original" | "rotated";

/**
 * Put `bundle` where every nox-kps sidecar serves it (`keccak_dir/<hh>/<62>`,
 * read-only, the layout `nox-kps bundle add` writes) and deploy a
 * WorkerSpecifier whose only resolver is `kps:<entry>/keccak/<hh>/<62>` (the
 * anon-rpc `kps:` resolver profile). The sidecars rescan the directory every
 * `limits.bundle_rescan_secs`; `settleMs` waits that out before returning.
 */
export async function publishWorkerViaKps(
  chains: Chains,
  resolver: Resolver,
  bundle: Uint8Array,
  keccakDir: string,
  kpsAddress: string,
  settleMs: number,
): Promise<PublishedWorker> {
  const workerHash = resolver.store.put(bundle);
  const relative = keccakPath(workerHash);
  const file = join(keccakDir, ...relative.split("/").slice(2));
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) {
    writeFileSync(file, bundle);
    chmodSync(file, 0o444);
  }
  const resolvers = [`kps:${kpsAddress}${relative}`];
  const address = await deploySpecifier(chains.specifier.url, chains.specifier.account, { workerHash, resolvers });
  await delay(settleMs);
  return { address, workerHash, resolvers, bytes: bundle.length };
}

export interface MeshWithSidecars {
  readonly mesh: RunningMesh;
  /** nox-kps sidecar per node id; empty when NOX_KPS_CMD is unset. Entries change with stop/start below. */
  readonly sidecars: ReadonlyMap<number, RunningKpsServer>;
  /** The NoxRegistry the nodes observe, with the members registered in it (absent with E2E_LOCAL_REGISTRY=0). */
  readonly registry: RegisteredRegistry | undefined;
  /** KPS address each node published on chain (the one the snapshot pins). */
  readonly publishedKps: ReadonlyMap<number, string>;
  /** Stop node `id`'s sidecar (failure drills). */
  stopSidecar(id: number): Promise<void>;
  /**
   * Start node `id`'s sidecar again on the same UDP port: with its original
   * identity, or with a fresh one, which changes the certhash under the
   * published (pinned) address (TC-570 key rotation).
   */
  startSidecar(id: number, identity: SidecarIdentity): Promise<RunningKpsServer>;
  /**
   * Restart node `id`'s sidecar with its original identity on another UDP
   * port: the node moves to a new KPS address with the same certhash, as an
   * operator's IP change does.
   */
  moveSidecar(id: number, udpPort: number): Promise<RunningKpsServer>;
  /**
   * Start an unpublished bridge for node `id`: a second nox-kps with its own
   * identity (certhash) on its own UDP and admin ports, whose /metadata.json
   * names the node (run-nox profile "kps-bridge"). One bridge per node.
   */
  startBridge(id: number, udpPort: number, adminPort: number): Promise<RunningKpsServer>;
  /** Stop node `id`'s bridge, if one runs. */
  stopBridge(id: number): Promise<void>;
  stop(): Promise<void>;
}

export interface RegisteredRegistry extends LocalRegistry {
  /** Block of the last registration; the snapshot is taken here. */
  readonly registeredBlock: number;
  readonly members: readonly RegistryMember[];
}

/** The registry metadataUrl of a KPS address (ARCHITECTURE §6). */
export function kpsMetadataUrl(address: string): string {
  return `kps:${address}/metadata.json`;
}

export async function startMeshWithSidecars(
  config: TestbedConfig,
  paths: RunPaths,
  upstream: AnvilChain,
): Promise<MeshWithSidecars> {
  // The registry exists before the nodes start, so every chain observer
  // follows it from its first block.
  const local = config.mesh.localRegistry
    ? await deployLocalRegistry(upstream.url, upstream.account, upstream.chainId)
    : undefined;
  const mesh = await startMesh({
    binaries: config.nox,
    config: config.mesh,
    upstreamAnvilPort: upstream.port,
    dataDir: paths.mesh,
    logDir: paths.logs,
    ...(local === undefined ? {} : { registry: { address: local.address, chainId: local.chainId } }),
  });
  const sidecars = new Map<number, RunningKpsServer>();
  const bridges = new Map<number, RunningKpsServer>();
  const published = new Map<number, string>();
  let rotations = 0;
  const stopAll = async (): Promise<void> => {
    await Promise.all([...sidecars.values(), ...bridges.values()].map((sidecar) => sidecar.stop()));
    sidecars.clear();
    bridges.clear();
    await mesh.stop();
  };
  const varsFor = (node: MeshNodeInfo, keyName: string, certhash: string, portOverride?: number, adminOverride?: number): SidecarVars => {
    const udpPort = portOverride ?? sidecarUdpPort(config.mesh.basePort, node.id);
    return {
      node: node.id,
      node_address: node.address,
      udp_port: udpPort,
      advertise_ip: config.kps.advertiseIp,
      listen: `${config.kps.advertiseIp}:${udpPort}`,
      ingress_port: node.ingressPort,
      ingress_url: node.ingressUrl,
      topology_port: node.metricsPort,
      topology_url: node.topologyUrl,
      admin_port: adminOverride ?? sidecarAdminPort(config.mesh.basePort, node.id),
      key_file: join(paths.kps, `${keyName}.key`),
      config_file: join(paths.kps, `${keyName}.conf`),
      bundle_dir: paths.keccak,
      expected_certhash: certhash,
    };
  };
  const start = async (
    node: MeshNodeInfo,
    keyName: string,
    certhash: string,
    portOverride?: number,
    adminOverride?: number,
  ): Promise<RunningKpsServer> => {
    const command = config.kps.sidecarCommand;
    if (command === undefined) throw new TestbedError("config", "NOX_KPS_CMD is unset; there are no sidecars to start");
    const sidecar = await startSidecar({
      commandTemplate: command,
      initCommandTemplate: config.kps.sidecarInitCommand,
      configTemplate: config.kps.sidecarConfigTemplate,
      logDir: paths.logs,
      addressTimeoutMs: config.kps.addressTimeoutMs,
      vars: varsFor(node, keyName, certhash, portOverride, adminOverride),
    });
    return sidecar;
  };
  const launch = async (node: MeshNodeInfo, keyName: string, certhash: string, portOverride?: number): Promise<RunningKpsServer> => {
    const sidecar = await start(node, keyName, certhash, portOverride);
    sidecars.set(node.id, sidecar);
    return sidecar;
  };
  const nodeById = (id: number): MeshNodeInfo => {
    const node = mesh.info.nodes[id];
    if (node === undefined) throw new TestbedError("config", `the mesh has no node ${id}`);
    return node;
  };

  let registry: RegisteredRegistry | undefined;
  try {
    if (config.kps.sidecarCommand !== undefined) {
      for (const node of mesh.info.nodes) {
        const sidecar = await launch(node, `node-${node.id}`, "");
        published.set(node.id, sidecar.address);
      }
    }
    const members: RegistryMember[] = mesh.info.nodes.map((node) => {
      const kps = published.get(node.id);
      return {
        address: node.address,
        sphinxKey: node.sphinxPublicKey,
        url: node.p2pMultiaddr,
        ingressUrl: node.ingressUrl,
        metadataUrl: kps === undefined ? "" : kpsMetadataUrl(kps),
        role: node.role,
      };
    });
    if (local !== undefined) {
      const registeredBlock = await registerMembers(upstream.url, local, members);
      await waitForServedRegistry(
        mesh.info.nodes.map((node) => node.topologyUrl),
        members,
        registeredBlock,
        config.mesh.registrySyncTimeoutMs,
      );
      registry = { ...local, registeredBlock, members };
    }
  } catch (error) {
    await stopAll();
    throw error;
  }

  return {
    mesh,
    sidecars,
    registry,
    publishedKps: published,
    stopSidecar: async (id) => {
      const running = sidecars.get(id);
      sidecars.delete(id);
      if (running !== undefined) await running.stop();
    },
    startSidecar: async (id, identity) => {
      const node = nodeById(id);
      const current = sidecars.get(id);
      if (current !== undefined) {
        sidecars.delete(id);
        await current.stop();
      }
      if (identity === "rotated") {
        rotations += 1;
        return launch(node, `node-${id}-rotated-${rotations}`, "");
      }
      const original = published.get(id);
      if (original === undefined) throw new TestbedError("config", `node ${id} never had a sidecar`);
      return launch(node, `node-${id}`, parseKpsAddress(original).certhash);
    },
    moveSidecar: async (id, udpPort) => {
      const node = nodeById(id);
      const current = sidecars.get(id);
      if (current !== undefined) {
        sidecars.delete(id);
        await current.stop();
      }
      const original = published.get(id);
      if (original === undefined) throw new TestbedError("config", `node ${id} never had a sidecar`);
      return launch(node, `node-${id}`, parseKpsAddress(original).certhash, udpPort);
    },
    startBridge: async (id, udpPort, adminPort) => {
      if (bridges.has(id)) throw new TestbedError("config", `node ${id} already runs a bridge`);
      const bridge = await start(nodeById(id), `node-${id}-bridge`, "", udpPort, adminPort);
      bridges.set(id, bridge);
      return bridge;
    },
    stopBridge: async (id) => {
      const running = bridges.get(id);
      bridges.delete(id);
      if (running !== undefined) await running.stop();
    },
    stop: stopAll,
  };
}

/** Machine-readable description of a running test bed (written to testbed.json). */
export interface TestbedInfo {
  readonly generatedAt: string;
  readonly runDir: string;
  readonly specifierChain: { readonly url: string; readonly chainId: number };
  readonly upstreamChain: { readonly url: string; readonly chainId: number };
  readonly resolverOrigin: string;
  readonly hostPageOrigin?: string;
  readonly mesh?: {
    readonly mixDelayMs: number;
    readonly seedUrl: string;
    /** `kpsAddress`: the KPS address the node published on chain (pinned by snapshots). */
    readonly nodes: readonly (MeshNodeInfo & { readonly kpsAddress?: string })[];
    /** The NoxRegistry on the upstream chain the nodes observe; snapshots come from it. */
    readonly registry?: {
      readonly address: string;
      /** Implementation behind the proxy (the bootstrap's `registryImpl`). */
      readonly implementation: string;
      readonly chainId: number;
      readonly rpcUrl: string;
      readonly deployBlock: number;
      readonly registeredBlock: number;
    };
    /** Inputs of the worker's discovery bootstrap for this bed (scripts/build-test-worker.mjs). */
    readonly discovery?: {
      /** RPC providers the registry checks read through exits. */
      readonly providers: readonly string[];
      /** Default anchors: published KPS addresses of the first nodes. */
      readonly anchors: readonly string[];
      readonly chainRefreshSeconds: number;
      readonly maxStateAgeSeconds: number;
    };
  };
  readonly workers?: Readonly<Record<string, PublishedWorker>>;
}

export interface TestbedInfoInput {
  readonly config: TestbedConfig;
  readonly paths: RunPaths;
  readonly chains: Chains;
  readonly resolver: Resolver;
  readonly hostPageOrigin?: string;
  readonly mesh?: MeshWithSidecars;
  readonly workers?: Readonly<Record<string, PublishedWorker>>;
}

export function describeTestbed(input: TestbedInfoInput): TestbedInfo {
  const { mesh } = input;
  return {
    generatedAt: new Date().toISOString(),
    runDir: input.paths.root,
    specifierChain: { url: input.chains.specifier.url, chainId: input.chains.specifier.chainId },
    upstreamChain: { url: input.chains.upstream.url, chainId: input.chains.upstream.chainId },
    resolverOrigin: input.resolver.server.origin,
    ...(input.hostPageOrigin === undefined ? {} : { hostPageOrigin: input.hostPageOrigin }),
    ...(mesh === undefined
      ? {}
      : {
        mesh: {
          mixDelayMs: input.config.mesh.mixDelayMs,
          seedUrl: mesh.mesh.seedUrl,
          nodes: mesh.mesh.info.nodes.map((node) => {
            const kpsAddress = mesh.publishedKps.get(node.id);
            return kpsAddress === undefined ? node : { ...node, kpsAddress };
          }),
          ...(mesh.registry === undefined
            ? {}
            : {
              registry: {
                address: mesh.registry.address,
                implementation: mesh.registry.implementation,
                chainId: mesh.registry.chainId,
                rpcUrl: input.chains.upstream.url,
                deployBlock: mesh.registry.deployBlock,
                registeredBlock: mesh.registry.registeredBlock,
              },
              discovery: {
                providers: input.chains.registryProviders,
                anchors: mesh.mesh.info.nodes
                  .slice(0, input.config.discovery.anchors)
                  .map((node) => mesh.publishedKps.get(node.id))
                  .filter((address): address is string => address !== undefined),
                chainRefreshSeconds: input.config.discovery.chainRefreshSeconds,
                maxStateAgeSeconds: input.config.discovery.maxStateAgeSeconds,
              },
            }),
        },
      }),
    ...(input.workers === undefined ? {} : { workers: input.workers }),
  };
}

export function writeTestbedInfo(paths: RunPaths, info: TestbedInfo): string {
  const path = join(paths.root, "testbed.json");
  writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`);
  return path;
}

/**
 * The config handed to the Nox worker. Precedence: NOX_WORKER_CONFIG (a JSON
 * file used verbatim), then NOX_WORKER_CONFIG_MODULE (exports
 * buildWorkerConfig(info)), then the default below, which follows the
 * `gateways` shape of the adopters.json5 exampleConfig convention.
 */
export async function workerConfigFor(config: TestbedConfig, info: TestbedInfo): Promise<unknown> {
  if (config.worker.configPath !== undefined) {
    return JSON.parse(readFileSync(config.worker.configPath, "utf8")) as unknown;
  }
  if (config.worker.configModule !== undefined) {
    if (!existsSync(config.worker.configModule)) {
      throw new TestbedError("config", `NOX_WORKER_CONFIG_MODULE ${config.worker.configModule} does not exist`);
    }
    const module = (await import(pathToFileURL(config.worker.configModule).href)) as {
      buildWorkerConfig?: (testbed: TestbedInfo) => unknown;
    };
    if (typeof module.buildWorkerConfig !== "function") {
      throw new TestbedError("config", `${config.worker.configModule} must export buildWorkerConfig(testbed)`);
    }
    return await module.buildWorkerConfig(info);
  }
  return defaultWorkerConfig(info);
}

/**
 * Every sidecar as a gateway, debug logs, and `tls: "off"`: the specs that use
 * it call the upstream anvil by its plain-http URL through the exit's
 * `HttpRequest` path (tls-tunnel.spec.ts sets its own TLS settings).
 */
export function defaultWorkerConfig(info: TestbedInfo): { gateways: string[]; logLevel: string; tls: string } {
  const gateways = (info.mesh?.nodes ?? [])
    .map((node) => node.kpsAddress)
    .filter((address): address is string => address !== undefined);
  return { gateways, logLevel: "debug", tls: "off" };
}
