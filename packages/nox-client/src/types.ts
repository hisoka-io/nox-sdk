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
  /**
   * Entry endpoint. Classic mode: the HTTP(S) ingress URL (`ingress_url`).
   * KPS mode: `kps:<ip>:<port>:<certhash>` from the member's `metadataUrl`.
   * Empty when the node cannot be an entry in the current mode; it can still
   * be a mix or an exit, which route by multiaddr.
   */
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

/** `"classic"`: seeds, chain-verified topology, HTTP(S) entries (the default). `"kps"`: see `KpsModeOptions`. */
export type NoxTransportMode = "classic" | "kps";

/** SPEC §12 error codes of the KPS transport (anon-rpc SPEC.md §12). */
export type KpsErrorCode =
  | "cancelled"
  | "closed"
  | "reset"
  | "timeout"
  | "network-error"
  | "protocol-error"
  | "unsupported"
  | "too-large"
  | "queue-full"
  | "permission-denied"
  | "internal-error";

/** Structural subset of anon-rpc SPEC §10/§12 (`KpsReason`). */
export interface KpsReason {
  code?: string;
  message?: string;
}

/** Structural subset of anon-rpc SPEC §10.2 `KpsStream` and `@kpstreams/core`. */
export interface KpsStreamLike {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  closeWrite(): void | Promise<void>;
  resetWrite(reason?: KpsReason): void | Promise<void>;
  close(reason?: KpsReason): void | Promise<void>;
  readonly closed: Promise<{ ok: boolean; reason?: KpsReason }>;
}

/** Structural subset of anon-rpc SPEC §10.1 `KpsConn`. */
export interface KpsConnLike {
  openStream(opts?: { signal?: AbortSignal }): Promise<KpsStreamLike>;
  close(reason?: KpsReason): Promise<void>;
  readonly closed: Promise<{ ok: boolean; reason?: KpsReason }>;
}

/**
 * Dials a KPS address (`<ip>:<port>:<certhash>`). The dialer authenticates the
 * peer against the certhash (anon-rpc SPEC §10). In a worker:
 * `(address, opts) => anonRpcWorker.kps.dial(address, opts)`.
 */
export type KpsDial = (address: string, opts?: { signal?: AbortSignal }) => Promise<KpsConnLike>;

/** One pinned member (`nox-anon-rpc-snapshot/1`). */
export interface PinnedMember {
  address: string;
  sphinxKey: string;
  url: string;
  ingressUrl: string;
  metadataUrl: string;
  stake: string;
  role: 1 | 2 | 3;
  layer: 0 | 1 | 2;
  status: 1 | 2;
  frozen: boolean;
  capabilities: string[];
}

/** Parsed `nox-snapshot.json` (format `nox-anon-rpc-snapshot/1`): NoxRegistry at one block. */
export interface PinnedSnapshot {
  format: "nox-anon-rpc-snapshot/1";
  chainId: number;
  registry: string;
  blockNumber: number;
  blockHash: string;
  fingerprint: string;
  relayerCount: number;
  powDifficulty: number;
  members: PinnedMember[];
}

/** KPS mode inputs. There is no seed, no RPC and no HTTP(S) entry in this mode. */
export interface KpsModeOptions {
  /** Dialer, e.g. `(a, o) => anonRpcWorker.kps.dial(a, o)`. */
  dial: KpsDial;
  /** The pinned registry snapshot; its members are the only nodes the client trusts. */
  pinned: PinnedSnapshot;
  /** Allowed entry KPS addresses; each must belong to a pinned member. Default: every KPS-capable member. */
  entries?: readonly string[];
  /**
   * Registry addresses of members to try last as boot anchors (for example a
   * cache of members recent served topologies removed). Only reorders anchors.
   */
  deprioritize?: readonly string[];
  /** Served topologies wanted per refresh. Default 2, range 1..4. */
  topologySources?: number;
  /** Anchors dialled at once during boot. Default 3. */
  anchorParallelism?: number;
  /** Bound on one dial. Default 10 s. */
  dialTimeoutMs?: number;
  /** Bound on opening one stream; openStream can hang when a connection dies. Default 10 s. */
  openStreamTimeoutMs?: number;
  /** Bound on one HTTP exchange. Default 15 s. */
  exchangeTimeoutMs?: number;
  /** Reply claim interval. Default 200 ms. */
  claimIntervalMs?: number;
  /** `GET /health` on an idle open connection after this long. Default 60 s. */
  keepaliveMs?: number;
  /** Largest accepted response head. Default 16 KiB. */
  maxHeadBytes?: number;
  /** Largest accepted response body. Default 16 MiB. */
  maxBodyBytes?: number;
  /** Clock skew tolerated on served topology timestamps. Default 600 s. */
  clockSkewToleranceSeconds?: number;
}

/** WebAssembly bindings with the exports of `@hisoka-io/nox-wasm`, already initialised. */
export type NoxWasmBindings = Record<string, unknown>;

/** Initialised bindings, or a function that returns them. */
export type NoxWasmProvider = NoxWasmBindings | (() => NoxWasmBindings | Promise<NoxWasmBindings>);

export type NoxLogLevel = "debug" | "info" | "warn" | "error";

/**
 * Structured diagnostics. Events carry identifiers and counts only: never
 * URLs, bodies, keys or SURB IDs.
 */
export type NoxLogSink = (
  level: NoxLogLevel,
  event: string,
  fields?: Readonly<Record<string, string | number | boolean>>,
) => void;

/** Options of `NoxClient.httpRequest`. */
export interface HttpRequestOptions {
  /** Response timeout per attempt. Default: the client's `timeoutMs`. */
  timeoutMs?: number;
  /** Expected reply size; sizes the reply blocks. */
  expectedResponseBytes?: number;
  /** Adaptive reply-block budget key. Default `"httpRequest"`. */
  opKey?: string;
  /** Floor on reply blocks. */
  minSurbs?: number;
  /** Resend policy. Default: `"route"` for GET, HEAD and OPTIONS, `"none"` otherwise. */
  retry?: "none" | "route";
  /** Abort: rejects with `ABORTED` and frees the request's reply blocks at once. */
  signal?: AbortSignal;
  /** Largest reply accepted; a larger one fails with `RESPONSE_TOO_LARGE`. */
  maxResponseBytes?: number;
}

/** Configuration for `NoxClient.connect()`. */
export interface NoxClientConfig {
  /** Default `"classic"`. */
  mode?: NoxTransportMode;
  /** Required when `mode` is `"kps"`, rejected otherwise. */
  kps?: KpsModeOptions;
  /** Application-supplied WASM bindings; skips `import("@hisoka-io/nox-wasm")`. */
  wasm?: NoxWasmProvider;
  /** Structured diagnostics sink. */
  log?: NoxLogSink;
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

/**
 * Resolved client settings: the `NoxClientConfig` tuning fields (every field
 * except `transport`, `mode`, `kps`, `wasm` and `log`).
 */
export type NoxClientSettings = Required<
  Omit<NoxClientConfig, "transport" | "mode" | "kps" | "wasm" | "log">
>;

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
  /** KPS mode: no pinned KPS entry answered. */
  KpsUnavailable = "KPS_UNAVAILABLE",
  /** A non-`kps:` endpoint in KPS mode, or KPS options in classic mode. */
  ModeViolation = "MODE_VIOLATION",
  /** KPS mode: served topologies agree the registry no longer lists every pinned member of a route layer. */
  TopologyStale = "TOPOLOGY_STALE",
  /** The caller aborted the request. */
  Aborted = "ABORTED",
  /** The reply exceeded the caller's `maxResponseBytes`. */
  ResponseTooLarge = "RESPONSE_TOO_LARGE",
}
