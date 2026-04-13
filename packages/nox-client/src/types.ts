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
}

export interface TopologySnapshot {
  nodes: RelayerNode[];
  fingerprint: string;
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

/** Configuration for `NoxClient.connect()`. */
export interface NoxClientConfig {
  seeds?: string[];
  ethRpcUrl?: string;
  registryAddress?: string;
  topologyRefreshMs?: number;
  timeoutMs?: number;
  /** SURBs per request (~30KB each). Default: 10. */
  surbsPerRequest?: number;
  powDifficulty?: number;
  /** Skip fingerprint check -- only for local test meshes. */
  dangerouslySkipFingerprintCheck?: boolean;
  /** FEC (Forward Error Correction) ratio for redundancy shards. Range: 0.0-1.0. Default: 0.3. */
  fecRatio?: number;
}

/**
 * Production-ready defaults for the Hisoka testnet.
 * Pass directly to `NoxClient.connect()` or spread with overrides:
 *
 *   await NoxClient.connect(DEFAULTS)
 *   await NoxClient.connect({ ...DEFAULTS, timeoutMs: 60_000 })
 */
export const DEFAULTS: Required<NoxClientConfig> = {
  seeds: ["https://api.hisoka.io/seed"],
  ethRpcUrl: "",
  registryAddress: "",
  topologyRefreshMs: 60_000,
  timeoutMs: 30_000,
  surbsPerRequest: 10,
  powDifficulty: 3,
  dangerouslySkipFingerprintCheck: true,
  fecRatio: 0.3,
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

export const enum NoxClientErrorCode {
  TopologyFetchFailed = "TOPOLOGY_FETCH_FAILED",
  TopologyVerificationFailed = "TOPOLOGY_VERIFICATION_FAILED",
  NoNodesAvailable = "NO_NODES_AVAILABLE",
  PacketBuildFailed = "PACKET_BUILD_FAILED",
  TransportFailed = "TRANSPORT_FAILED",
  ResponseTimeout = "RESPONSE_TIMEOUT",
  DecryptionFailed = "DECRYPTION_FAILED",
  WasmNotInitialized = "WASM_NOT_INITIALIZED",
  InvalidConfig = "INVALID_CONFIG",
}
