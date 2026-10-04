// Test-bed configuration: every port, path, timeout and size comes from here.
// Defaults are documented in README.md; each can be overridden by the env var
// named next to it.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestbedError } from "./errors.js";

export type Env = Readonly<Record<string, string | undefined>>;

/** Registry roles accepted by nox_mesh_server: 1 relay, 2 exit, 3 full. */
export type MeshRole = 1 | 2 | 3;

/**
 * The fleet layout on Arbitrum Sepolia (2026-09-25 deployment): nox-6, nox-7
 * and nox-10 are exits, the other seven are relays.
 */
export const FLEET_ROLES: readonly MeshRole[] = [1, 1, 1, 1, 1, 2, 2, 1, 1, 2];

export interface NoxBinaries {
  /** Checkout the binaries were built from (informational). */
  readonly repo: string;
  readonly noxBin: string;
  readonly meshBin: string;
}

export interface MeshConfig {
  readonly nodes: number;
  readonly roles: readonly MeshRole[];
  /**
   * Node i uses p2p base+10i, metrics base+10i+1, ingress base+10i+2, and its
   * nox-kps sidecar UDP base+10i+5 (TEST-PLAN bed L: 14005+10N) and admin
   * TCP base+10i+6.
   */
  readonly basePort: number;
  readonly mixDelayMs: number;
  readonly startupTimeoutMs: number;
  readonly teardownGraceMs: number;
}

export interface AnvilConfig {
  readonly bin: string;
  /** Chain that holds the WorkerSpecifier (stands in for Ethereum mainnet). */
  readonly specifierChainId: number;
  /** Chain the wallet's RPC URL points at (the exits' HttpRequest target). */
  readonly upstreamChainId: number;
  readonly startupTimeoutMs: number;
}

export interface KpsConfig {
  /** Directory holding kps-rust-server, kps-go-server (scripts/build-kps-servers.sh). */
  readonly binDir: string;
  readonly addressTimeoutMs: number;
  /** IP the KPS servers bind and advertise. */
  readonly advertiseIp: string;
  /**
   * Command template that starts one nox-kps sidecar per mesh node, with
   * {placeholders} (see src/kps-server.ts). Unset: the sidecar tests skip.
   */
  readonly sidecarCommand: string | undefined;
  /**
   * Optional command template run to completion before each sidecar starts
   * (nox-kps creates its identity with `init`; `run` never creates one).
   */
  readonly sidecarInitCommand: string | undefined;
  /** Optional config-file template rendered to {config_file}. */
  readonly sidecarConfigTemplate: string | undefined;
  /** Set KPS_DEBUG=1 on the Rust KPS servers (frame-level tracing; slows them down). */
  readonly debug: boolean;
}

export interface WorkerConfig {
  /** The Nox anon-rpc worker bundle produced by the worker package build. */
  readonly bundlePath: string;
  /**
   * Command that builds a test bundle for this run's mesh, with {testbed_json}
   * (input: mesh nodes, sphinx keys, KPS addresses) and {out} (bundle path to
   * write) placeholders. Unset: bundlePath is used as is.
   */
  readonly buildCommand: string | undefined;
  readonly buildTimeoutMs: number;
  /** JSON file holding the worker config, used verbatim. */
  readonly configPath: string | undefined;
  /** Module exporting buildWorkerConfig(testbed) => unknown. */
  readonly configModule: string | undefined;
  readonly readyTimeoutMs: number;
  readonly callTimeoutMs: number;
  /** signalFailed code the worker documents for an unusable config. */
  readonly expectedBadConfigCode: string;
}

export interface ClassicSdkConfig {
  /** Built @hisoka-io/nox-client ESM entry (pnpm --filter @hisoka-io/nox-client build). */
  readonly clientEntry: string;
  readonly callTimeoutMs: number;
}

export interface TestbedConfig {
  readonly e2eRoot: string;
  readonly sdkRoot: string;
  readonly runDir: string;
  readonly cacheDir: string;
  readonly nox: NoxBinaries;
  readonly mesh: MeshConfig;
  readonly anvil: AnvilConfig;
  readonly kps: KpsConfig;
  readonly worker: WorkerConfig;
  readonly classic: ClassicSdkConfig;
  /** Upper bound for one Chromium page operation that has no other deadline. */
  readonly pageTimeoutMs: number;
}

/** Offset of a node's nox-kps UDP port from its p2p port (bed L: 14005+10N). */
export const KPS_UDP_OFFSET = 5;
/** Offset of a node's nox-kps admin (metrics, health) TCP port from its p2p port. */
export const KPS_ADMIN_OFFSET = 6;

/** Admin TCP port of the nox-kps sidecar in front of mesh node `id`. */
export function sidecarAdminPort(basePort: number, id: number): number {
  return basePort + id * 10 + KPS_ADMIN_OFFSET;
}

/** UDP port of the nox-kps sidecar in front of mesh node `id`. */
export function sidecarUdpPort(basePort: number, id: number): number {
  return basePort + id * 10 + KPS_UDP_OFFSET;
}

/** Root of this e2e package (the directory holding package.json). */
export const E2E_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env: Env = process.env, e2eRoot: string = E2E_ROOT): TestbedConfig {
  const sdkRoot = resolve(e2eRoot, "..", "..", "..");
  const runDir = pathFrom(env, "E2E_RUN_DIR", join(e2eRoot, ".run"), e2eRoot);
  const cacheDir = pathFrom(env, "E2E_CACHE_DIR", join(e2eRoot, ".cache"), e2eRoot);

  const nodes = intFrom(env, "E2E_MESH_NODES", 10, 3, 32);
  const roles = rolesFrom(env, "E2E_MESH_ROLES", nodes);
  const basePort = intFrom(env, "E2E_BASE_PORT", 27_000, 1_024, 65_533);
  const lastPort = basePort + (nodes - 1) * 10 + KPS_ADMIN_OFFSET;
  if (lastPort > 65_535) {
    throw new TestbedError(
      "config",
      `E2E_BASE_PORT=${basePort} with ${nodes} nodes needs ports up to ${lastPort}, above 65535`,
    );
  }

  return {
    e2eRoot,
    sdkRoot,
    runDir,
    cacheDir,
    nox: noxBinaries(env, sdkRoot, e2eRoot),
    mesh: {
      nodes,
      roles,
      basePort,
      mixDelayMs: numberFrom(env, "E2E_MIX_DELAY_MS", 0, 0, 10_000),
      startupTimeoutMs: intFrom(env, "E2E_MESH_STARTUP_TIMEOUT_MS", 180_000, 5_000, 1_800_000),
      teardownGraceMs: intFrom(env, "E2E_MESH_TEARDOWN_GRACE_MS", 10_000, 500, 120_000),
    },
    anvil: {
      bin: env["ANVIL_BIN"] ?? "anvil",
      specifierChainId: intFrom(env, "E2E_SPECIFIER_CHAIN_ID", 1, 1, 2 ** 31),
      upstreamChainId: intFrom(env, "E2E_UPSTREAM_CHAIN_ID", 31_337, 1, 2 ** 31),
      startupTimeoutMs: intFrom(env, "E2E_ANVIL_TIMEOUT_MS", 20_000, 1_000, 300_000),
    },
    kps: {
      binDir: pathFrom(env, "KPS_BIN_DIR", join(cacheDir, "bin"), e2eRoot),
      addressTimeoutMs: intFrom(env, "E2E_KPS_ADDRESS_TIMEOUT_MS", 30_000, 1_000, 300_000),
      advertiseIp: ipFrom(env, "E2E_KPS_IP", "127.0.0.1"),
      sidecarCommand: nonEmpty(env["NOX_KPS_CMD"]),
      sidecarInitCommand: nonEmpty(env["NOX_KPS_INIT_CMD"]),
      sidecarConfigTemplate: optionalPath(env, "NOX_KPS_CONFIG_TEMPLATE", e2eRoot),
      debug: env["E2E_KPS_DEBUG"] === "1",
    },
    worker: {
      bundlePath: pathFrom(
        env,
        "NOX_WORKER_BUNDLE",
        join(e2eRoot, "..", "dist", "anon-rpc-worker.js"),
        e2eRoot,
      ),
      buildCommand: nonEmpty(env["NOX_WORKER_BUILD_CMD"]),
      buildTimeoutMs: intFrom(env, "E2E_WORKER_BUILD_TIMEOUT_MS", 600_000, 1_000, 3_600_000),
      configPath: optionalPath(env, "NOX_WORKER_CONFIG", e2eRoot),
      configModule: optionalPath(env, "NOX_WORKER_CONFIG_MODULE", e2eRoot),
      readyTimeoutMs: intFrom(env, "E2E_WORKER_READY_TIMEOUT_MS", 60_000, 1_000, 600_000),
      callTimeoutMs: intFrom(env, "E2E_CALL_TIMEOUT_MS", 30_000, 1_000, 600_000),
      expectedBadConfigCode: env["E2E_EXPECT_BAD_CONFIG_CODE"] ?? "bad-config",
    },
    classic: {
      clientEntry: pathFrom(
        env,
        "NOX_CLIENT_ENTRY",
        join(sdkRoot, "packages", "nox-client", "dist", "index.js"),
        e2eRoot,
      ),
      callTimeoutMs: intFrom(env, "E2E_CLASSIC_CALL_TIMEOUT_MS", 60_000, 1_000, 600_000),
    },
    pageTimeoutMs: intFrom(env, "E2E_PAGE_TIMEOUT_MS", 30_000, 1_000, 600_000),
  };
}

function noxBinaries(env: Env, sdkRoot: string, e2eRoot: string): NoxBinaries {
  const explicitRepo = optionalPath(env, "NOX_REPO", e2eRoot);
  const candidates = explicitRepo !== undefined
    ? [explicitRepo]
    : ["nox-e2e", "nox", "nox-clean"].map((name) => resolve(sdkRoot, "..", name));
  const repo = candidates.find((dir) => existsSync(join(dir, "crates"))) ?? candidates[0] ?? sdkRoot;
  return {
    repo,
    noxBin: pathFrom(env, "NOX_BIN", join(repo, "target", "release", "nox"), e2eRoot),
    meshBin: pathFrom(env, "NOX_MESH_BIN", join(repo, "target", "release", "nox_mesh_server"), e2eRoot),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function optionalPath(env: Env, name: string, base: string): string | undefined {
  const value = nonEmpty(env[name]);
  return value === undefined ? undefined : absolute(value, base);
}

function pathFrom(env: Env, name: string, fallback: string, base: string): string {
  return optionalPath(env, name, base) ?? fallback;
}

function absolute(path: string, base: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

function numberFrom(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new TestbedError("config", `${name}=${raw} must be a number in [${min}, ${max}]`);
  }
  return value;
}

function intFrom(env: Env, name: string, fallback: number, min: number, max: number): number {
  const value = numberFrom(env, name, fallback, min, max);
  if (!Number.isSafeInteger(value)) {
    throw new TestbedError("config", `${name}=${String(env[name])} must be an integer`);
  }
  return value;
}

function ipFrom(env: Env, name: string, fallback: string): string {
  const raw = nonEmpty(env[name]) ?? fallback;
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(raw) || raw.split(".").some((octet) => Number(octet) > 255)) {
    throw new TestbedError("config", `${name}=${raw} must be a dotted IPv4 address`);
  }
  return raw;
}

/** Parse "1,1,2" into roles; nodes past the list default to the fleet layout, then to relays. */
export function rolesFrom(env: Env, name: string, nodes: number): MeshRole[] {
  const raw = nonEmpty(env[name]);
  const listed = raw === undefined
    ? FLEET_ROLES.slice(0, nodes)
    : raw.split(",").map((part, index) => {
      const value = Number(part.trim());
      if (value !== 1 && value !== 2 && value !== 3) {
        throw new TestbedError(
          "config",
          `${name}[${index}]=${part.trim()} must be 1 (relay), 2 (exit) or 3 (full)`,
        );
      }
      return value;
    });
  if (listed.length > nodes) {
    throw new TestbedError("config", `${name} lists ${listed.length} roles for ${nodes} nodes`);
  }
  const roles: MeshRole[] = [...listed];
  while (roles.length < nodes) roles.push(1);
  if (!roles.some((role) => role === 2 || role === 3)) {
    throw new TestbedError("config", `${name} must include at least one exit-capable node (2 or 3)`);
  }
  if (!roles.some((role) => role === 1 || role === 3)) {
    throw new TestbedError("config", `${name} must include at least one relay-capable node (1 or 3)`);
  }
  return roles;
}
