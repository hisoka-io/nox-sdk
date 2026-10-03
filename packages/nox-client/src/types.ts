export interface RelayerNode {
  address: string;
  sphinx_key: string;
  url: string;
  stake: string;
  last_seen: number;
  is_privileged: boolean;
  layer: number;
  role: number;
  ingress_url?: string;
  metadata_url?: string;
}

export type TopologyLivenessStatus = "online" | "offline";

/** Untrusted availability observation for a chain-authenticated member. */
export interface TopologyLiveness {
  address: string;
  status: TopologyLivenessStatus;
  observed_at_unix: number;
  /**
   * Optional service capabilities observed for this member, for example
   * `"paid_v2"`. Seeds that do not publish capabilities omit the field.
   */
  capabilities?: string[];
  /** Optional build version observed for this member. Informational only. */
  build_version?: string;
}

/** Capability an exit must advertise before it is chosen for paid execution. */
export const PAID_V2_CAPABILITY = "paid_v2";

/** Capability a node advertises when it handles format v2 reply blocks. */
export const SURB_V2_CAPABILITY = "surb_v2";

/**
 * Reply block format:
 * - "auto": v2 when every hop of the chosen route advertises `surb_v2`, v1 otherwise;
 * - "v1": always v1 (the 0.3.0 behaviour);
 * - "v2": only routes on which every hop advertises `surb_v2`; fails with
 *   `SurbV2Unavailable` when there is none.
 */
export type SurbFormat = "auto" | "v1" | "v2";

export interface TopologySnapshot {
  nodes: RelayerNode[];
  fingerprint: string;
  /** Seed topology wire schema. Version 2 separates chain membership from liveness. */
  schema_version?: number;
  liveness?: TopologyLiveness[];
  timestamp?: number;
  block_number?: number;
  pow_difficulty?: number;
}

export interface TopologyNode {
  id: string;
  /** HTTP ingress URL (from `ingress_url ?? url`). */
  address: string;
  /** P2P multiaddr for Sphinx routing info. */
  routingAddress: string;
  publicKey: Uint8Array;
  layer: number;
  role: number;
  /**
   * Capabilities the seed observed for this node. `undefined` means the seed
   * published no capability data for it.
   */
  capabilities?: readonly string[];
}

export interface PathHop {
  pubKeyHex: string;
  address: string;
}

export interface Route {
  entry: TopologyNode;
  mix: TopologyNode;
  exit: TopologyNode;
}

export interface BatchResponseItem {
  id: string;
  data: number[];
}

/** `fetch`-compatible function used for every HTTP request the client makes. */
export type NoxFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Constructor used for the response stream. Same shape as the WHATWG `WebSocket`. */
export type NoxWebSocketConstructor = new (url: string) => WebSocket;

/**
 * Network primitives used by the client. Each one defaults to the runtime
 * global, so most applications never set this. Set it to run the client in an
 * environment that restricts or wraps ambient network APIs.
 */
export interface NoxTransport {
  fetch?: NoxFetch;
  /** Set to `null` to disable the WebSocket stream and use HTTP claim polling. */
  WebSocket?: NoxWebSocketConstructor | null;
}

/** Configuration for `NoxClient.connect()`. */
export interface NoxClientConfig {
  seeds?: string[];
  ethRpcUrl?: string;
  registryAddress?: string;
  topologyRefreshMs?: number;
  /** Maximum age accepted for an indexer's online liveness observation. */
  livenessMaxAgeMs?: number;
  timeoutMs?: number;
  /** SURBs per request (~30KB each). Default: 10. */
  surbsPerRequest?: number;
  powDifficulty?: number;
  /** Skip fingerprint checks. Accepted only when every seed is a loopback URL. */
  dangerouslySkipFingerprintCheck?: boolean;
  /** FEC (Forward Error Correction) ratio for redundancy shards. Range: 0.0-1.0. Default: 0.3. */
  fecRatio?: number;
  /**
   * Retry an idempotent request once on a different route after a response
   * timeout, and avoid the hops of the failed route for a while. A retried
   * call can take up to about twice `timeoutMs`. When false, a timeout is
   * returned at once and does not affect later route choice. Default: true.
   */
  retryOnTimeout?: boolean;
  /** Reply block format. Default: "auto". See `SurbFormat`. */
  surbFormat?: SurbFormat;
  /** Network primitives. Defaults to the runtime's global `fetch` and `WebSocket`. */
  transport?: NoxTransport;
}

/** Resolved client settings: every `NoxClientConfig` field except `transport`. */
export type NoxClientSettings = Required<Omit<NoxClientConfig, "transport">>;

/**
 * Transport defaults. `ethRpcUrl` and `registryAddress` are empty on purpose:
 * every caller must supply both, so spread the defaults with them:
 *
 *   await NoxClient.connect({
 *     ...DEFAULTS,
 *     ethRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
 *     registryAddress: "0xF7BFf88A1412054a001Dc4b8aCBddAd6F9b26cB6",
 *   })
 *
 * `connect()` fills any field you leave out from these defaults, so spreading
 * them is optional.
 */
export const DEFAULTS: NoxClientSettings = {
  seeds: ["https://api.hisoka.io/seed"],
  ethRpcUrl: "",
  registryAddress: "",
  topologyRefreshMs: 60_000,
  livenessMaxAgeMs: 180_000,
  timeoutMs: 30_000,
  surbsPerRequest: 10,
  powDifficulty: 3,
  dangerouslySkipFingerprintCheck: false,
  fecRatio: 0.3,
  retryOnTimeout: true,
  surbFormat: "auto",
};

export class NoxClientError extends Error {
  constructor(
    message: string,
    public readonly code: NoxClientErrorCode,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "NoxClientError";
  }
}

// A regular enum (not `const enum`) so that `NoxClientErrorCode.X` compiles
// under `isolatedModules` and `verbatimModuleSyntax`.
export enum NoxClientErrorCode {
  TopologyFetchFailed = "TOPOLOGY_FETCH_FAILED",
  TopologyVerificationFailed = "TOPOLOGY_VERIFICATION_FAILED",
  NoNodesAvailable = "NO_NODES_AVAILABLE",
  PacketBuildFailed = "PACKET_BUILD_FAILED",
  TransportFailed = "TRANSPORT_FAILED",
  ResponseTimeout = "RESPONSE_TIMEOUT",
  DecryptionFailed = "DECRYPTION_FAILED",
  WasmNotInitialized = "WASM_NOT_INITIALIZED",
  InvalidConfig = "INVALID_CONFIG",
  /** No exit in the verified topology advertises paid execution support. */
  PaidExitUnavailable = "PAID_EXIT_UNAVAILABLE",
  /** `surbFormat: "v2"` and no route on which every hop advertises `surb_v2`. */
  SurbV2Unavailable = "SURB_V2_UNAVAILABLE",
}
