import {
  NoxClientError,
  NoxClientErrorCode,
  DEFAULTS,
  PAID_V2_CAPABILITY,
  type NoxClientConfig,
  type NoxClientSettings,
  type NoxFetch,
  type NoxWebSocketConstructor,
  type PathHop,
  type Route,
  type TopologyNode,
  type TopologySnapshot,
} from "./types.js";
import { seedCandidates } from "./seeder.js";
import {
  fetchTopology,
  verifySelfConsistency,
  verifyOnChainWithEligibility,
  livenessCapabilities,
  parseNodes,
  selectLiveNodes,
  selectRoute,
  hasUsableIngress,
  layersForRole,
} from "./topology.js";
import { postPacket, claimResponses, ResponseWebSocket } from "./transport.js";
import { defaultFetch } from "./rpc.js";
import {
  encodeRelayerPayload,
  encodeServiceRequest,
  decodeRelayerPayload,
  decodeRpcResponse,
  type RelayerPayload,
  decodePaidQuoteOutcomeV2,
  decodePaidTransactionOutcomeV2,
  decodeSubmitTransactionResponse,
  type PaidQuoteRequestV2,
  type PaidTransactionOutcomeV2,
  type SubmitTransactionResponse,
} from "./bincode.js";
import type { FragmentWire } from "./bincode.js";
import { Reassembler } from "./fragmentation.js";
import { SurbPool } from "./surb_pool.js";
import { ReplenishmentManager, buildReturnPath } from "./replenishment.js";
import {
  bytesToHex,
  hexToBytes,
  buildSphinxPacket,
  secureRandomIndex,
} from "./utils.js";
import {
  validateIssuedPaidQuote,
  validatePaidQuoteRequest,
  parsePaidChainTimestamp,
  type IssuedPaidQuoteV2,
  type PaidQuoteResultV2,
} from "./paid.js";

export const EMA_ALPHA = 0.2;
export const EMA_HEADROOM = 1.5;
export const EMA_MIN_SAMPLES = 3;
export const USABLE_RESPONSE_PER_SURB = 30_699;

/** How long a mix or exit stays deprioritised after a route through it timed out. */
export const ROUTE_AVOID_MS = 5 * 60_000;
/** Highest PoW difficulty (leading zero bits) adopted from a seed. */
export const MAX_ADOPTED_POW_DIFFICULTY = 16;
/** Node-served topology endpoints tried when every configured seed fails. */
const NODE_TOPOLOGY_FALLBACKS = 3;

/**
 * What to do when a request times out:
 * - "none": fail (non-idempotent requests);
 * - "route": resend once on a route with a different mix or exit;
 * - "exit": resend once to a different paid-capable exit.
 */
type RetryMode = "none" | "route" | "exit";

interface EmaState {
  ema: number;
  samples: number;
}

/** EMA-based SURB budget. Falls back to caller-provided default until EMA_MIN_SAMPLES. */
export class AdaptiveSurbBudget {
  private readonly ops = new Map<string, EmaState>();

  record(operation: string, bytes: number): void {
    if (bytes === 0) return;
    const existing = this.ops.get(operation);
    if (existing === undefined) {
      this.ops.set(operation, { ema: bytes, samples: 1 });
    } else {
      existing.ema = EMA_ALPHA * bytes + (1 - EMA_ALPHA) * existing.ema;
      existing.samples = Math.min(existing.samples + 1, 0x7fffffff);
    }
  }

  surbCount(operation: string, fallback: number, fecRatio = 0): number {
    const state = this.ops.get(operation);
    let dataSurbs: number;
    if (state === undefined || state.samples < EMA_MIN_SAMPLES) {
      dataSurbs = fallback;
    } else {
      const estimatedBytes = Math.ceil(state.ema * EMA_HEADROOM);
      dataSurbs = Math.max(Math.ceil(estimatedBytes / USABLE_RESPONSE_PER_SURB), 1);
    }
    const paritySurbs = fecRatio > 0 ? Math.ceil(dataSurbs * fecRatio) : 0;
    return dataSurbs + paritySurbs;
  }
}

interface PendingRequest {
  resolve(plaintext: Uint8Array): void;
  reject(err: NoxClientError): void;
  reassembler: Reassembler;
  createdAt: number;
}

export class NoxClient {
  private readonly surbPool: SurbPool;
  private readonly replenishment: ReplenishmentManager;
  private readonly adaptive: AdaptiveSurbBudget;

  private readonly pending = new Map<bigint, PendingRequest>();

  private readonly burstState = new Map<
    bigint,
    {
      round: number;
      sentAt: number;
      serverRequestId: bigint;
      lastFragmentAt: number;
    }
  >();

  private static readonly MAX_BURST_ROUNDS = 50;
  private static readonly STALL_TIMEOUT_MS = 8_000;

  private nextRequestId = BigInt(0);
  private _nodes: TopologyNode[];
  private _entryUrl: string;
  private _seedUrl: string;
  private _topologyVerifiedAtMs: number;
  private _topologyRefreshError: NoxClientError | null = null;
  private _refreshInFlight: Promise<void> | null = null;
  private readonly _avoidUntil = new Map<string, number>();
  private _powDifficultyPinned = false;
  private _fetchImpl: NoxFetch = defaultFetch;
  private _webSocketImpl: NoxWebSocketConstructor | null = null;

  private readonly _config: NoxClientSettings;

  private _wasm: Record<string, unknown> | null = null;

  get nodes(): TopologyNode[] {
    return this._nodes;
  }

  get entryUrl(): string {
    return this._entryUrl;
  }

  get wasm(): Record<string, unknown> | null {
    return this._wasm;
  }

  get config(): NoxClientSettings {
    return this._config;
  }

  /** HTTP client used for seeds, registry reads and packet delivery. */
  get fetch(): NoxFetch {
    return this._fetchImpl ?? defaultFetch;
  }

  get topologyRefreshError(): NoxClientError | null {
    return this._topologyRefreshError;
  }

  private topologyTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private responseWs: ResponseWebSocket | null = null;
  private subscribedSurbIds = new Set<string>();

  public _debugPoll = false;

  private constructor(
    nodes: TopologyNode[],
    entryUrl: string,
    seedUrl: string,
    config: NoxClientSettings,
    topologyVerifiedAtMs: number,
  ) {
    this._nodes = nodes;
    this._entryUrl = entryUrl;
    this._seedUrl = seedUrl;
    this._config = config;
    this._topologyVerifiedAtMs = topologyVerifiedAtMs;
    this.surbPool = new SurbPool();
    this.replenishment = new ReplenishmentManager();
    this.adaptive = new AdaptiveSurbBudget();
  }

  /**
   * Connect with the transport defaults plus your overrides. `ethRpcUrl` and
   * `registryAddress` are required outside a loopback test mesh:
   *
   *   const client = await NoxClient.init({
   *     ethRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
   *     registryAddress: "0xF7BFf88A1412054a001Dc4b8aCBddAd6F9b26cB6",
   *   });
   *
   * Same as `NoxClient.connect(overrides)`.
   */
  static async init(overrides: NoxClientConfig = {}): Promise<NoxClient> {
    return NoxClient.connect(overrides);
  }

  /**
   * Fetch and verify the topology, load WASM and start the background loops.
   *
   * Seeds are tried in order (configured seeds, then the default seed API when
   * chain verification is on). The first seed whose topology passes every check
   * is used; a seed that answers with an unverifiable document does not stop
   * the next one from being tried.
   */
  static async connect(config: NoxClientConfig = {}): Promise<NoxClient> {
    const full = resolveSettings(config);
    validateTopologyVerificationConfig(full);
    const transport = resolveTransport(config);

    const candidates = seedCandidates(full.seeds, !full.dangerouslySkipFingerprintCheck);
    const errors: NoxClientError[] = [];
    let loaded: LoadedTopology | null = null;
    for (const seed of candidates) {
      try {
        loaded = await loadTopology(seed, full, transport.fetch);
        break;
      } catch (error) {
        errors.push(asTopologyLoadError(seed, error));
      }
    }
    if (loaded === null) {
      throw connectError(errors);
    }

    const powDifficultyPinned = config.powDifficulty !== undefined;
    full.powDifficulty = effectivePowDifficulty(
      full.powDifficulty,
      powDifficultyPinned,
      loaded.snapshot.pow_difficulty,
    );

    const entryUrl = pickEntryUrl(loaded.nodes);

    const client = new NoxClient(
      loaded.nodes,
      entryUrl,
      loaded.seed,
      full,
      full.dangerouslySkipFingerprintCheck ? 0 : Date.now(),
    );
    client._powDifficultyPinned = powDifficultyPinned;
    client._fetchImpl = transport.fetch;
    client._webSocketImpl = transport.WebSocket;

    await client._initWasm();
    client._startTopologyRefresh();
    client._startResponseStream();

    return client;
  }

  /** Submit a transaction via the mixnet. Returns raw response bytes (typically tx hash). */
  async submitTransaction(to: string, data: Uint8Array): Promise<Uint8Array> {
    const toBytes = hexToBytes(to);
    if (toBytes.length !== 20) {
      throw new NoxClientError(
        `submitTransaction: 'to' must be a 20-byte Ethereum address, got ${toBytes.length} bytes`,
        NoxClientErrorCode.InvalidConfig,
      );
    }

    const inner = encodeServiceRequest({
      tag: "SubmitTransaction",
      to: toBytes,
      data,
    });

    const response = await this._sendAnonymous(inner, "submitTransaction", undefined, undefined, 2);
    this.adaptive.record("submitTransaction", response.length);
    return response;
  }

  /** Submit through the legacy wire and decode its bounded response. */
  async submitTransactionTyped(
    to: string,
    data: Uint8Array,
  ): Promise<SubmitTransactionResponse> {
    return decodeSubmitTransactionResponse(await this.submitTransaction(to, data));
  }

  /**
   * Pick an exit for paid execution from the verified topology.
   *
   * When the seed publishes capability data, only exits that advertise
   * `paid_v2` qualify, and a topology without one fails fast with
   * `PaidExitUnavailable` instead of a quote that times out. Exits that
   * recently timed out are skipped while another exit qualifies.
   */
  selectPaidExit(): TopologyNode {
    return cloneTopologyNode(this._pickPaidExit(new Set()));
  }

  /**
   * Request a signed quote from `selectedExit`.
   *
   * If that exit does not answer within `timeoutMs`, the request is sent once
   * more to a different paid-capable exit. The returned quote's `selectedExit`
   * is the exit that issued it; pass the quote unchanged to
   * `submitPaidTransaction`.
   */
  async requestPaidQuote(
    request: PaidQuoteRequestV2,
    selectedExit: TopologyNode,
  ): Promise<PaidQuoteResultV2> {
    await this._ensureFreshPaidTopology();
    const chainTimestamp = await this._paidChainTimestamp();
    validatePaidQuoteRequest(request, chainTimestamp);
    const canonicalExit = this._resolvePaidExit(selectedExit);
    const inner = encodeServiceRequest({ tag: "PaidQuoteRequestV2", ...request });
    const { response, exit } = await this._sendAnonymousRouted(
      inner,
      "paidQuoteV2",
      undefined,
      undefined,
      2,
      canonicalExit,
      "exit",
    );
    this.adaptive.record("paidQuoteV2", response.length);
    const outcome = decodePaidQuoteOutcomeV2(response);
    if (outcome.status === "rejected") return outcome;
    return validateIssuedPaidQuote(
      outcome,
      request,
      exit,
      undefined,
    );
  }

  async submitPaidTransaction(
    issued: IssuedPaidQuoteV2,
    calldata: Uint8Array,
  ): Promise<PaidTransactionOutcomeV2> {
    if (!(calldata instanceof Uint8Array) || calldata.length === 0) {
      throw new NoxClientError(
        "submitPaidTransaction calldata must be a non-empty Uint8Array",
        NoxClientErrorCode.InvalidConfig,
      );
    }
    await this._ensureFreshPaidTopology();
    const chainTimestamp = await this._paidChainTimestamp();
    const selectedExit = this._resolvePaidExit(issued.selectedExit);
    const verified = validateIssuedPaidQuote(
      issued,
      undefined,
      selectedExit,
      chainTimestamp,
    );
    const inner = encodeServiceRequest({
      tag: "PaidTransactionV2",
      chainId: wordToU64(verified.quote.chainId, "quote.chainId"),
      entryPoint: verified.quote.entryPoint,
      calldata,
      executionId: verified.executionId,
      validUntilUnix: verified.quote.validUntilUnix,
    });
    const response = await this._sendAnonymous(
      inner,
      "paidTransactionV2",
      undefined,
      undefined,
      2,
      selectedExit,
    );
    this.adaptive.record("paidTransactionV2", response.length);
    const outcome = decodePaidTransactionOutcomeV2(response);
    if (
      outcome.status === "submitted" &&
      !bytesEqual(outcome.executionId, verified.executionId)
    ) {
      throw new NoxClientError(
        "Paid transaction response executionId does not match the submitted quote",
        NoxClientErrorCode.DecryptionFailed,
      );
    }
    if (
      outcome.status === "rejected" &&
      outcome.executionId !== null &&
      !bytesEqual(outcome.executionId, verified.executionId)
    ) {
      throw new NoxClientError(
        "Paid transaction rejection executionId does not match the submitted quote",
        NoxClientErrorCode.DecryptionFailed,
      );
    }
    return outcome;
  }

  /** Broadcast a pre-signed transaction through the mixnet. */
  async broadcastSignedTransaction(
    signedTx: Uint8Array,
    rpcUrl?: string,
  ): Promise<Uint8Array> {
    const inner = encodeServiceRequest({
      tag: "BroadcastSignedTransaction",
      signedTx,
      rpcUrl: rpcUrl ?? null,
      rpcMethod: null,
    });

    const response = await this._sendAnonymous(
      inner,
      "broadcastSignedTransaction",
      undefined,
      undefined,
      2,
      undefined,
      "route",
    );
    this.adaptive.record("broadcastSignedTransaction", response.length);
    return response;
  }

  /** Send an echo request through the mixnet. Returns the echoed data. */
  async sendEcho(data: Uint8Array): Promise<Uint8Array> {
    const inner = encodeServiceRequest({ tag: "Echo", data });
    const response = await this._sendAnonymous(
      inner,
      "echo",
      undefined,
      undefined,
      2,
      undefined,
      "route",
    );
    this.adaptive.record("echo", response.length);
    return response;
  }

  /** Broadcast a pre-signed transaction with full options through the mixnet. */
  async broadcastSignedTransactionWithOptions(
    signedTx: Uint8Array,
    opts?: {
      rpcUrl?: string;
      rpcMethod?: string;
      expectedResponseBytes?: number;
      fecRatio?: number;
    },
  ): Promise<Uint8Array> {
    const inner = encodeServiceRequest({
      tag: "BroadcastSignedTransaction",
      signedTx,
      rpcUrl: opts?.rpcUrl ?? null,
      rpcMethod: opts?.rpcMethod ?? null,
    });

    const response = await this._sendAnonymous(
      inner,
      "broadcastSignedTransaction",
      undefined,
      opts?.expectedResponseBytes,
      undefined,
      undefined,
      "route",
    );
    this.adaptive.record("broadcastSignedTransaction", response.length);
    return response;
  }

  /** Execute a JSON-RPC call through the mixnet. */
  async rpcCall(
    method: string,
    params: unknown,
    rpcUrlOrOpts?: string | { rpcUrl?: string; expectedResponseBytes?: number },
  ): Promise<unknown> {
    const rpcUrl =
      typeof rpcUrlOrOpts === "string"
        ? rpcUrlOrOpts
        : rpcUrlOrOpts?.rpcUrl ?? null;
    const expectedResponseBytes =
      typeof rpcUrlOrOpts === "object"
        ? rpcUrlOrOpts?.expectedResponseBytes
        : undefined;

    const id = this.nextRequestId++;
    const paramsBytes = new TextEncoder().encode(JSON.stringify(params));

    const inner = encodeServiceRequest({
      tag: "RpcRequest",
      method,
      params: paramsBytes,
      id,
      rpcUrl: rpcUrl ?? null,
    });

    const opKey = `rpc:${method}`;
    const response = await this._sendAnonymous(
      inner,
      opKey,
      undefined,
      expectedResponseBytes,
      2,
      undefined,
      "route",
    );
    this.adaptive.record(opKey, response.length);

    const rpcResp = decodeRpcResponse(response);
    if (!rpcResp.result.ok) {
      throw new NoxClientError(
        `RPC error: ${rpcResp.result.error}`,
        NoxClientErrorCode.TransportFailed,
      );
    }

    const text = new TextDecoder().decode(rpcResp.result.data);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  /** Estimate gas for a transaction. */
  async estimateGas(to: string, data: string): Promise<string> {
    return this.rpcCall("eth_estimateGas", [{ to, data }]) as Promise<string>;
  }

  /** Get the current block number. */
  async blockNumber(): Promise<number> {
    const hex = (await this.rpcCall("eth_blockNumber", [])) as string;
    return parseInt(hex, 16);
  }

  /** Get a transaction receipt by hash. */
  async getTransactionReceipt(txHash: string): Promise<unknown | null> {
    return this.rpcCall("eth_getTransactionReceipt", [txHash]);
  }

  /** Get logs matching a filter. Auto-estimates SURB budget from block range. */
  async getLogs(filter: {
    address?: string;
    fromBlock?: string;
    toBlock?: string;
    topics?: (string | null)[];
  }): Promise<unknown[]> {
    let expectedBytes = 50_000;
    if (filter.fromBlock && filter.toBlock) {
      const from = parseInt(filter.fromBlock, 16);
      const to = parseInt(filter.toBlock, 16);
      const blockRange = to - from;
      // ~2 events/block * 500 bytes/event
      expectedBytes = Math.max(50_000, blockRange * 2 * 500);
    }
    return this.rpcCall("eth_getLogs", [filter], {
      expectedResponseBytes: expectedBytes,
    }) as Promise<unknown[]>;
  }

  /**
   * Proxy an HTTP request through the mixnet. GET, HEAD and OPTIONS requests
   * are resent once on another route after a timeout; other methods are not.
   */
  async httpRequest(
    method: string,
    url: string,
    headers: [string, string][],
    body: Uint8Array,
    opts?: { timeoutMs?: number; expectedResponseBytes?: number },
  ): Promise<Uint8Array> {
    const inner = encodeServiceRequest({
      tag: "HttpRequest",
      method,
      url,
      headers,
      body,
    });

    const response = await this._sendAnonymous(
      inner,
      "httpRequest",
      opts?.timeoutMs,
      opts?.expectedResponseBytes,
      undefined,
      undefined,
      isIdempotentHttpMethod(method) ? "route" : "none",
    );
    this.adaptive.record("httpRequest", response.length);
    return response;
  }

  /** Send a custom `RelayerPayload` directly. Prefer submitTransaction/rpcCall/httpRequest. */
  async send(payload: RelayerPayload): Promise<Uint8Array> {
    const opKey = payload.tag;
    const surbCount = this.adaptive.surbCount(opKey, this._config.surbsPerRequest, this._config.fecRatio);
    const { response } = await this._sendWithRetry(payload, surbCount, undefined, undefined, "none");
    return response;
  }

  disconnect(): void {
    if (this.topologyTimer !== null) {
      clearInterval(this.topologyTimer);
      this.topologyTimer = null;
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.stallTimer !== null) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
    if (this.responseWs !== null) {
      this.responseWs.close();
      this.responseWs = null;
    }
    this.subscribedSurbIds.clear();

    const err = new NoxClientError(
      "NoxClient disconnected",
      NoxClientErrorCode.TransportFailed,
    );
    for (const [requestId, req] of this.pending) {
      req.reject(err);
      this.surbPool.cleanup(requestId);
      this.replenishment.clearPath(requestId);
    }
    this.pending.clear();
    this.burstState.clear();
  }

  private async _sendAnonymous(
    inner: Uint8Array,
    opKey: string,
    timeoutMs?: number,
    expectedResponseBytes?: number,
    surbCountOverride?: number,
    selectedExit?: TopologyNode,
    retry: RetryMode = "none",
  ): Promise<Uint8Array> {
    const { response } = await this._sendAnonymousRouted(
      inner,
      opKey,
      timeoutMs,
      expectedResponseBytes,
      surbCountOverride,
      selectedExit,
      retry,
    );
    return response;
  }

  private async _sendAnonymousRouted(
    inner: Uint8Array,
    opKey: string,
    timeoutMs: number | undefined,
    expectedResponseBytes: number | undefined,
    surbCountOverride: number | undefined,
    selectedExit: TopologyNode | undefined,
    retry: RetryMode,
  ): Promise<{ response: Uint8Array; exit: TopologyNode }> {
    let surbCount: number;
    if (expectedResponseBytes !== undefined && expectedResponseBytes > 0) {
      const USABLE_PER_SURB = 30_699;
      surbCount = Math.ceil(
        (expectedResponseBytes / USABLE_PER_SURB) * 1.3,
      );
    } else if (surbCountOverride !== undefined && surbCountOverride > 0) {
      surbCount = surbCountOverride;
    } else {
      surbCount = this.adaptive.surbCount(opKey, this._config.surbsPerRequest, this._config.fecRatio);
    }
    return this._sendWithRetry(
      { tag: "AnonymousRequest", inner, replySurbs: [] },
      surbCount,
      timeoutMs,
      selectedExit,
      retry,
    );
  }

  /**
   * Send on a fresh route and, for idempotent requests, resend once on a
   * different route after a response timeout. Hops of a timed-out route are
   * deprioritised for `ROUTE_AVOID_MS`; a reply through a hop clears it.
   */
  private async _sendWithRetry(
    payload: RelayerPayload,
    surbCount: number,
    timeoutMs: number | undefined,
    selectedExit: TopologyNode | undefined,
    retry: RetryMode,
  ): Promise<{ response: Uint8Array; exit: TopologyNode }> {
    this._requireWasm();
    const pinnedEntry = this._pinnedEntry();
    const first = selectRoute(this._nodes, pinnedEntry, selectedExit, this._avoidedNodeIds());
    try {
      const response = await this._sendOnRoute(payload, surbCount, timeoutMs, first);
      this._clearAvoided(first);
      return { response, exit: first.exit };
    } catch (error) {
      if (!isResponseTimeout(error)) throw error;
      this._avoidRoute(first);
      if (retry === "none" || this._config.retryOnTimeout === false) throw error;

      // Steer the resend away from this route's hops specifically; hops that
      // timed out earlier are only a soft preference and may be reused.
      const avoid = new Set([first.mix.id, first.exit.id]);
      let second: Route;
      try {
        const retryExit = retry === "exit"
          ? this._pickPaidExit(new Set([first.exit.id]))
          : selectedExit;
        second = selectRoute(this._nodes, this._pinnedEntry(), retryExit, avoid);
      } catch {
        throw error;
      }
      if (second.mix.id === first.mix.id && second.exit.id === first.exit.id) {
        throw error;
      }
      try {
        const response = await this._sendOnRoute(payload, surbCount, timeoutMs, second);
        this._clearAvoided(second);
        return { response, exit: second.exit };
      } catch (retryError) {
        if (isResponseTimeout(retryError)) this._avoidRoute(second);
        throw retryError;
      }
    }
  }

  private async _sendOnRoute(
    payload: RelayerPayload,
    surbCount: number,
    timeoutMs: number | undefined,
    route: Route,
  ): Promise<Uint8Array> {
    this._requireWasm();
    const forwardPath: PathHop[] = [
      { pubKeyHex: bytesToHex(route.entry.publicKey), address: route.entry.routingAddress },
      { pubKeyHex: bytesToHex(route.mix.publicKey), address: route.mix.routingAddress },
      { pubKeyHex: bytesToHex(route.exit.publicKey), address: route.exit.routingAddress },
    ];
    const returnPath = buildReturnPath(forwardPath);

    const requestId = this.nextRequestId++;
    const surbBlobs = this._generateSurbs(returnPath, requestId, surbCount);

    this._wsSubscribe(this.surbPool.activeSurbIds());

    const payloadWithSurbs: RelayerPayload =
      payload.tag === "AnonymousRequest"
        ? { ...payload, replySurbs: surbBlobs }
        : payload;

    const payloadBytes = encodeRelayerPayload(payloadWithSurbs);

    const MAX_PAYLOAD_SIZE = 31_716;
    let packets: Uint8Array[];

    if (payloadBytes.length <= MAX_PAYLOAD_SIZE) {
      packets = [this._buildSphinxPacket(forwardPath, payloadBytes)];
    } else {
      // Fragment payload across multiple Sphinx packets
      const FRAG_OVERHEAD = 32;
      const chunkSize = MAX_PAYLOAD_SIZE - FRAG_OVERHEAD;
      const totalFragments = Math.ceil(payloadBytes.length / chunkSize);
      const messageId = requestId;
      packets = [];

      for (let seq = 0; seq < totalFragments; seq++) {
        const start = seq * chunkSize;
        const end = Math.min(start + chunkSize, payloadBytes.length);
        const chunk = payloadBytes.slice(start, end);

        const fragPayload: RelayerPayload = {
          tag: "Fragment",
          frag: {
            messageId: messageId,
            totalFragments,
            sequence: seq,
            data: chunk,
            fec: null,
          },
        };
        const fragBytes = encodeRelayerPayload(fragPayload);
        packets.push(this._buildSphinxPacket(forwardPath, fragBytes));
      }
    }

    const effectiveTimeout = timeoutMs ?? this._config.timeoutMs;
    const responsePromise = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          this.burstState.delete(requestId);
          this.surbPool.cleanup(requestId);
          this.replenishment.clearPath(requestId);
          reject(
            new NoxClientError(
              `Request ${requestId} timed out after ${effectiveTimeout}ms`,
              NoxClientErrorCode.ResponseTimeout,
            ),
          );
        }
      }, effectiveTimeout);

      this.pending.set(requestId, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        reassembler: new Reassembler(),
        createdAt: Date.now(),
      });
    });

    this.replenishment.stashPath(requestId, forwardPath);

    const entryUrl = route.entry.address;
    const sendAll = Promise.all(
      packets.map((pkt) => postPacket(entryUrl, pkt, undefined, this.fetch)),
    );
    sendAll.catch((err: unknown) => {
      const req = this.pending.get(requestId);
      if (req !== undefined) {
        this.pending.delete(requestId);
        this.burstState.delete(requestId);
        this.surbPool.cleanup(requestId);
        this.replenishment.clearPath(requestId);
        req.reject(
          new NoxClientError(
            `Packet transport failed: ${String(err)}`,
            NoxClientErrorCode.TransportFailed,
            err,
          ),
        );
      }
    });

    return responsePromise;
  }

  private _generateSurbs(
    returnPath: PathHop[],
    requestId: bigint,
    count: number,
  ): Uint8Array[] {
    const wasm = this._requireWasm();
    return this.surbPool.generate(wasm, returnPath, requestId, count);
  }

  private _buildSphinxPacket(
    forwardPath: PathHop[],
    payloadBytes: Uint8Array,
  ): Uint8Array {
    const wasm = this._requireWasm();
    return buildSphinxPacket(wasm, forwardPath, payloadBytes, this._config.powDifficulty);
  }

  private _startResponseStream(): void {
    const WebSocketImpl = this._webSocketImpl;
    if (WebSocketImpl !== null) {
      this.responseWs = new ResponseWebSocket(this._entryUrl, (item) => {
        this._onWsResponse(item);
      }, WebSocketImpl);
      // Stall detection + burst recovery still needs a periodic check
      this.stallTimer = setInterval(() => {
        this._checkBurstStalls();
      }, 1000);
    } else {
      // Fallback to HTTP polling for environments without WebSocket (Node 18)
      this.pollTimer = setInterval(() => {
        void this._pollOnce();
      }, 200);
    }
  }

  /** Subscribe SURB IDs to the WebSocket stream. */
  private _wsSubscribe(surbIds: string[]): void {
    if (!this.responseWs) return;
    const newIds = surbIds.filter((id) => !this.subscribedSurbIds.has(id));
    if (newIds.length === 0) return;
    for (const id of newIds) this.subscribedSurbIds.add(id);
    this.responseWs.subscribe(newIds);
  }

  /** Handle a single response item from the WebSocket stream. */
  private _onWsResponse(item: import("./types.js").BatchResponseItem): void {
    if (this._wasm === null) return;
    const wasm = this._wasm;

    const encryptedBody = new Uint8Array(item.data);

    let match: { requestId: bigint; plaintext: Uint8Array } | null = null;
    const surbIdHex = parseSurbIdFromPacketId(item.id);
    if (surbIdHex !== null) {
      match = this.surbPool.decryptById(wasm, surbIdHex, encryptedBody);
      this.subscribedSurbIds.delete(surbIdHex);
    }

    if (match === null) {
      match = this.surbPool.matchAndDecrypt(wasm, encryptedBody);
    }

    if (match === null) return;

    const { requestId, plaintext } = match;

    let decoded: ReturnType<typeof decodeRelayerPayload>;
    try {
      decoded = decodeRelayerPayload(plaintext);
    } catch {
      return;
    }

    if (decoded.tag === "ServiceResponse") {
      this._handleFragment(requestId, decoded.fragment);
    } else if (decoded.tag === "NeedMoreSurbs") {
      void this._handleNeedMoreSurbs(
        requestId,
        decoded.requestId,
        decoded.fragmentsRemaining,
      );
    }
  }

  private async _pollOnce(): Promise<void> {
    if (this._wasm === null || this.pending.size === 0) return;
    const wasm = this._wasm;

    const surbIds = this.surbPool.activeSurbIds();
    if (surbIds.length === 0) return;

    let items: import("./types.js").BatchResponseItem[];
    try {
      items = await claimResponses(this._entryUrl, surbIds, undefined, this.fetch);
    } catch (pollErr) {
      if (this._debugPoll) {
        this._debug(`[poll] fetch error: ${String(pollErr).slice(0, 120)}`);
      }
      return;
    }

    if (this._debugPoll && items.length > 0) {
      this._debug(
        `[poll] got ${items.length} items from ${this._entryUrl}, pending=${this.pending.size}`,
      );
    }

    for (const item of items) {
      const encryptedBody = new Uint8Array(item.data);

      let match: { requestId: bigint; plaintext: Uint8Array } | null = null;
      const surbIdHex = parseSurbIdFromPacketId(item.id);
      if (surbIdHex !== null) {
        match = this.surbPool.decryptById(wasm, surbIdHex, encryptedBody);
      }

      if (match === null) {
        match = this.surbPool.matchAndDecrypt(wasm, encryptedBody);
      }

      if (match === null) {
        if (this._debugPoll) {
          this._debug(
            `[poll] matchAndDecrypt returned null for item id=${item.id} data_len=${encryptedBody.length}`,
          );
        }
        continue;
      }
      const { requestId, plaintext } = match;

      if (this._debugPoll) {
        this._debug(
          `[poll] decrypted item id=${item.id} -> requestId=${requestId} plaintext_len=${plaintext.length}`,
        );
      }

      let decoded: ReturnType<typeof decodeRelayerPayload>;
      try {
        decoded = decodeRelayerPayload(plaintext);
      } catch (decodeErr) {
        if (this._debugPoll) {
          this._debug(
            `[poll] decodeRelayerPayload failed: ${String(decodeErr).slice(0, 120)}`,
          );
        }
        continue;
      }

      if (this._debugPoll) {
        this._debug(`[poll] decoded tag=${decoded.tag}`);
      }

      if (decoded.tag === "ServiceResponse") {
        this._handleFragment(requestId, decoded.fragment);
      } else if (decoded.tag === "NeedMoreSurbs") {
        void this._handleNeedMoreSurbs(
          requestId,
          decoded.requestId,
          decoded.fragmentsRemaining,
        );
      }
    }

    this._checkBurstStalls();
  }

  private _checkBurstStalls(): void {
    const now = Date.now();
    for (const [clientRequestId, bs] of this.burstState) {
      if (bs.round >= NoxClient.MAX_BURST_ROUNDS) continue;

      const sinceLastFragment = now - bs.lastFragmentAt;
      const sinceBurst = now - bs.sentAt;

      if (
        sinceLastFragment >= NoxClient.STALL_TIMEOUT_MS &&
        sinceBurst >= NoxClient.STALL_TIMEOUT_MS
      ) {
        const req = this.pending.get(clientRequestId);
        if (req === undefined) continue;

        const [received, total] = req.reassembler.totalProgress();
        if (total === 0) continue;
        const remaining = total - received;
        if (remaining <= 0) continue;

        if (this._debugPoll) {
          this._debug(
            `[stall] detected stall for request ${clientRequestId}: ` +
              `${received}/${total} fragments, ${remaining} missing, ` +
              `${(sinceLastFragment / 1000).toFixed(1)}s since last fragment`,
          );
        }

        void this._handleNeedMoreSurbs(
          clientRequestId,
          bs.serverRequestId,
          remaining,
        );
      }
    }
  }

  private _handleFragment(
    requestId: bigint,
    fragment: FragmentWire,
  ): void {
    const req = this.pending.get(requestId);
    if (req === undefined) return;

    const bs = this.burstState.get(requestId);
    if (bs !== undefined) {
      bs.lastFragmentAt = Date.now();
    }

    if (this._debugPoll) {
      const progress = req.reassembler.messageProgress(fragment.messageId);
      const received = progress ? progress[0] : 0;
      if (received === 0 || received % 500 === 0) {
        this._debug(
          `[frag] msgId=${fragment.messageId} seq=${fragment.sequence} total=${fragment.totalFragments} received=${received} data=${fragment.data.length} surbPool=${this.surbPool.size}`,
        );
      }
    }

    const result = req.reassembler.addFragment(fragment);
    if (result !== null) {
      this.pending.delete(requestId);
      this.burstState.delete(requestId);
      this.replenishment.clearPath(requestId);
      req.resolve(result);
      // Defer cleanup so remaining fragments in this batch can still match
      setTimeout(() => this.surbPool.cleanup(requestId), 100);
    }
  }

  private async _handleNeedMoreSurbs(
    clientRequestId: bigint,
    serverRequestId: bigint,
    fragmentsRemaining: number,
  ): Promise<void> {
    const wasm = this._wasm;
    if (wasm === null) return;
    if (!this.replenishment.hasPendingPath(clientRequestId)) return;

    const state = this.burstState.get(clientRequestId);
    const now = Date.now();

    if (state !== undefined) {
      // Suppress mid-burst signals; stall detection handles exhausted SURBs
      const sinceBurst = now - state.sentAt;
      if (sinceBurst < NoxClient.STALL_TIMEOUT_MS) {
        if (this._debugPoll) {
          this._debug(
            `[replenish] ignoring NeedMoreSurbs for request ${clientRequestId} ` +
              `(round ${state.round}, ${((NoxClient.STALL_TIMEOUT_MS - sinceBurst) / 1000).toFixed(1)}s until stall check)`,
          );
        }
        return;
      }
      if (state.round >= NoxClient.MAX_BURST_ROUNDS) {
        if (this._debugPoll) {
          this._debug(
            `[replenish] max burst rounds (${NoxClient.MAX_BURST_ROUNDS}) reached for request ${clientRequestId}, ` +
              `${fragmentsRemaining} fragments still missing`,
          );
        }
        return;
      }
    }

    const round = state !== undefined ? state.round + 1 : 1;
    this.burstState.set(clientRequestId, {
      round,
      sentAt: now,
      serverRequestId,
      lastFragmentAt: now,
    });

    const SURBS_PER_PACKET = 40;
    const EFFECTIVE_DATA_SURBS = SURBS_PER_PACKET - 1;
    const MAX_PACKETS_PER_BURST = 10;
    const totalPacketsNeeded = Math.ceil(fragmentsRemaining / EFFECTIVE_DATA_SURBS);
    const packetsNeeded = Math.min(totalPacketsNeeded, MAX_PACKETS_PER_BURST);

    if (this._debugPoll) {
      this._debug(
        `[replenish] burst round ${round}: sending ${packetsNeeded}/${totalPacketsNeeded} ReplenishSurbs ` +
          `for request ${clientRequestId} (${fragmentsRemaining} fragments remaining)`,
      );
    }

    try {
      await this.replenishment.burstReplenish({
        wasm,
        clientRequestId,
        serverRequestId,
        packetsNeeded,
        surbsPerPacket: SURBS_PER_PACKET,
        surbPool: this.surbPool,
        entryUrl: this._entryUrl,
        powDifficulty: this._config.powDifficulty,
        fetch: this.fetch,
      });
      this._wsSubscribe(this.surbPool.activeSurbIds());
    } catch (err) {
      this.burstState.delete(clientRequestId);
      if (this._debugPoll) {
        this._debug(
          `[replenish] burst round ${round} failed for request ${clientRequestId}: ${String(err).slice(0, 120)}`,
        );
      }
    }
  }

  private _debug(message: string): void {
    globalThis.console?.debug(message);
  }

  private _startTopologyRefresh(): void {
    this.topologyTimer = setInterval(() => {
      void this._refreshTopology();
    }, this._config.topologyRefreshMs);
  }

  /**
   * Refresh and re-verify the topology. Concurrent callers (the timer and the
   * paid freshness gate) share one in-flight refresh.
   */
  private _refreshTopology(seedUrl?: string): Promise<void> {
    if (this._refreshInFlight) return this._refreshInFlight;
    const run = this._refreshTopologyOnce(seedUrl ?? this._seedUrl).finally(() => {
      this._refreshInFlight = null;
    });
    this._refreshInFlight = run;
    return run;
  }

  private async _refreshTopologyOnce(seedUrl: string): Promise<void> {
    const seeds = Array.from(
      new Set([
        ...seedCandidates([seedUrl]).slice(0, 1),
        ...seedCandidates(this._config.seeds, !this._config.dangerouslySkipFingerprintCheck),
      ]),
    );
    let firstError: NoxClientError | null = null;

    for (const seed of [...seeds, ...this._nodeTopologyFallbacks(seeds)]) {
      try {
        const loaded = await loadTopology(seed, this._config, this.fetch);
        this._applyTopology(loaded);
        return;
      } catch (error) {
        firstError ??= asTopologyLoadError(seed, error);
      }
    }
    this._topologyRefreshError =
      firstError ??
      new NoxClientError(
        "Topology refresh found no reachable seed",
        NoxClientErrorCode.TopologyFetchFailed,
      );
  }

  /**
   * Ingress URLs of verified nodes, used as topology sources when every seed
   * fails: the current entry first, then up to two others at random. A node
   * that serves the legacy schema fails verification and is skipped.
   */
  private _nodeTopologyFallbacks(seeds: readonly string[]): string[] {
    const tried = new Set(seeds);
    const ingress = Array.from(
      new Set(
        this._nodes
          .map((node) => node.address)
          .filter((address) => hasUsableIngress(address) && !tried.has(address)),
      ),
    );
    const ordered: string[] = [];
    if (this._entryUrl !== undefined && ingress.includes(this._entryUrl)) {
      ordered.push(this._entryUrl);
    }
    const others = ingress.filter((address) => address !== this._entryUrl);
    while (ordered.length < NODE_TOPOLOGY_FALLBACKS && others.length > 0) {
      ordered.push(others.splice(secureRandomIndex(others.length), 1)[0]!);
    }
    return ordered;
  }

  private _applyTopology(loaded: LoadedTopology): void {
    this._nodes = loaded.nodes;
    this._seedUrl = loaded.seed;
    this._topologyVerifiedAtMs = this._config.dangerouslySkipFingerprintCheck
      ? 0
      : Date.now();
    this._topologyRefreshError = null;
    this._config.powDifficulty = effectivePowDifficulty(
      this._config.powDifficulty,
      this._powDifficultyPinned,
      loaded.snapshot.pow_difficulty,
    );
    const currentStillPresent = loaded.nodes.some(
      (n) => n.address === this._entryUrl,
    );
    if (!currentStillPresent) {
      this._entryUrl = pickEntryUrl(loaded.nodes);
      // Reconnect WS to new entry node
      if (this.responseWs !== null) {
        this.responseWs.close();
        this.responseWs = new ResponseWebSocket(this._entryUrl, (item) => {
          this._onWsResponse(item);
        }, this._webSocketImpl ?? undefined);
        this.subscribedSurbIds.clear();
        this._wsSubscribe(this.surbPool.activeSurbIds());
      }
    }
  }

  private async _ensureFreshPaidTopology(): Promise<void> {
    if (this._isPaidTopologyFresh()) return;
    await this._refreshTopology(this._seedUrl);
    this._requireFreshPaidTopology();
  }

  /**
   * Latest block timestamp, read through the mixnet so the RPC provider does
   * not see the client address next to a paid quote or submission.
   */
  private async _paidChainTimestamp(): Promise<bigint> {
    return parsePaidChainTimestamp(
      await this.rpcCall("eth_getBlockByNumber", ["latest", false]),
    );
  }

  private _pinnedEntry(): TopologyNode | undefined {
    return this._nodes.find((n) => n.address === this._entryUrl);
  }

  private _avoidedNodeIds(): Set<string> {
    const avoided = new Set<string>();
    const avoidUntil = this._avoidUntil;
    if (avoidUntil === undefined) return avoided;
    const now = Date.now();
    for (const [id, until] of avoidUntil) {
      if (until <= now) {
        avoidUntil.delete(id);
      } else {
        avoided.add(id);
      }
    }
    return avoided;
  }

  private _avoidRoute(route: Route): void {
    const until = Date.now() + ROUTE_AVOID_MS;
    this._avoidUntil?.set(route.mix.id, until);
    this._avoidUntil?.set(route.exit.id, until);
  }

  private _clearAvoided(route: Route): void {
    this._avoidUntil?.delete(route.mix.id);
    this._avoidUntil?.delete(route.exit.id);
  }

  /**
   * Exits that can serve paid execution. When the topology carries capability
   * data for any node, an exit qualifies only if it advertises `paid_v2`;
   * otherwise every verified exit qualifies.
   */
  private _paidCapableExits(): TopologyNode[] {
    const exits = this._nodes.filter((node) => node.role === 2 || node.role === 3);
    if (!this._nodes.some((node) => node.capabilities !== undefined)) return exits;
    return exits.filter((node) => node.capabilities?.includes(PAID_V2_CAPABILITY) === true);
  }

  private _pickPaidExit(exclude: ReadonlySet<string>): TopologyNode {
    const capable = this._paidCapableExits().filter((node) => !exclude.has(node.id));
    if (capable.length === 0) {
      const anyExit = this._nodes.some((node) => node.role === 2 || node.role === 3);
      throw new NoxClientError(
        anyExit
          ? "No exit in the verified topology advertises paid execution support"
          : "No exit nodes available",
        anyExit
          ? NoxClientErrorCode.PaidExitUnavailable
          : NoxClientErrorCode.NoNodesAvailable,
      );
    }
    const avoided = this._avoidedNodeIds();
    const preferred = capable.filter((node) => !avoided.has(node.id));
    const pool = preferred.length > 0 ? [...preferred] : [...capable];
    const pinnedEntry = this._pinnedEntry();
    let lastError: unknown = null;
    while (pool.length > 0) {
      const candidate = pool.splice(secureRandomIndex(pool.length), 1)[0]!;
      try {
        return selectRoute(this._nodes, pinnedEntry, candidate, avoided).exit;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof NoxClientError
      ? lastError
      : new NoxClientError("No distinct exit node is available", NoxClientErrorCode.NoNodesAvailable);
  }

  private _requireFreshPaidTopology(): void {
    if (this._config.dangerouslySkipFingerprintCheck) {
      throw new NoxClientError(
        "Paid execution requires chain-backed topology verification",
        NoxClientErrorCode.TopologyVerificationFailed,
      );
    }
    if (!this._isPaidTopologyFresh()) {
      const detail = this._topologyRefreshError?.message ??
        "no recent successful verification";
      throw new NoxClientError(
        `Paid route topology is stale: ${detail}`,
        NoxClientErrorCode.TopologyVerificationFailed,
        this._topologyRefreshError ?? undefined,
      );
    }
  }

  private _isPaidTopologyFresh(): boolean {
    return (
      !this._config.dangerouslySkipFingerprintCheck &&
      this._topologyVerifiedAtMs > 0 &&
      Date.now() - this._topologyVerifiedAtMs <= this._config.topologyRefreshMs
    );
  }

  private _resolvePaidExit(selectedExit: TopologyNode): TopologyNode {
    const normalizedId = normalizeEthereumAddress(selectedExit.id);
    const node = this._nodes.find(
      (candidate) =>
        normalizeEthereumAddress(candidate.id) === normalizedId &&
        (candidate.role === 2 || candidate.role === 3),
    );
    if (node === undefined) {
      throw new NoxClientError(
        `Selected paid exit ${selectedExit.id} is absent from the verified topology`,
        NoxClientErrorCode.NoNodesAvailable,
      );
    }
    if (!this._paidCapableExits().includes(node)) {
      throw new NoxClientError(
        `Selected paid exit ${selectedExit.id} does not advertise paid execution support`,
        NoxClientErrorCode.PaidExitUnavailable,
      );
    }
    return node;
  }

  private async _initWasm(): Promise<void> {
    if (this._wasm !== null) return;
    try {
      const mod = await import("@hisoka-io/nox-wasm");
      const maybeInit = (mod as Record<string, unknown>)["default"];
      if (typeof maybeInit === "function") {
        await (maybeInit as () => Promise<void>)();
      }
      this._wasm = mod as Record<string, unknown>;
    } catch (err) {
      throw new NoxClientError(
        `WASM module failed to load: ${String(err)}`,
        NoxClientErrorCode.WasmNotInitialized,
        err,
      );
    }
  }

  private _requireWasm(): Record<string, unknown> {
    if (this._wasm === null) {
      throw new NoxClientError(
        "WASM module not initialised - call NoxClient.connect() first",
        NoxClientErrorCode.WasmNotInitialized,
      );
    }
    return this._wasm;
  }
}

function resolveSettings(config: NoxClientConfig): NoxClientSettings {
  return {
    seeds: config.seeds ?? DEFAULTS.seeds,
    ethRpcUrl: config.ethRpcUrl ?? DEFAULTS.ethRpcUrl,
    registryAddress: config.registryAddress ?? DEFAULTS.registryAddress,
    topologyRefreshMs: config.topologyRefreshMs ?? DEFAULTS.topologyRefreshMs,
    livenessMaxAgeMs: config.livenessMaxAgeMs ?? DEFAULTS.livenessMaxAgeMs,
    timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
    surbsPerRequest: config.surbsPerRequest ?? DEFAULTS.surbsPerRequest,
    powDifficulty: config.powDifficulty ?? DEFAULTS.powDifficulty,
    dangerouslySkipFingerprintCheck:
      config.dangerouslySkipFingerprintCheck ?? DEFAULTS.dangerouslySkipFingerprintCheck,
    fecRatio: config.fecRatio ?? DEFAULTS.fecRatio,
    retryOnTimeout: config.retryOnTimeout ?? DEFAULTS.retryOnTimeout,
  };
}

function resolveTransport(config: NoxClientConfig): {
  fetch: NoxFetch;
  WebSocket: NoxWebSocketConstructor | null;
} {
  const transport = config.transport ?? {};
  if (transport.fetch !== undefined && typeof transport.fetch !== "function") {
    throw new NoxClientError(
      "transport.fetch must be a function",
      NoxClientErrorCode.InvalidConfig,
    );
  }
  if (
    transport.WebSocket !== undefined &&
    transport.WebSocket !== null &&
    typeof transport.WebSocket !== "function"
  ) {
    throw new NoxClientError(
      "transport.WebSocket must be a constructor or null",
      NoxClientErrorCode.InvalidConfig,
    );
  }
  const globalWebSocket = typeof globalThis.WebSocket === "function"
    ? globalThis.WebSocket
    : null;
  return {
    fetch: transport.fetch ?? defaultFetch,
    WebSocket: transport.WebSocket === undefined ? globalWebSocket : transport.WebSocket,
  };
}

interface LoadedTopology {
  readonly seed: string;
  readonly snapshot: TopologySnapshot;
  readonly nodes: TopologyNode[];
}

/** Fetch one seed's topology and run every check the client config requires. */
async function loadTopology(
  seed: string,
  settings: NoxClientSettings,
  fetchImpl: NoxFetch,
): Promise<LoadedTopology> {
  const snapshot = await fetchTopology(seed, settings.timeoutMs, fetchImpl);
  verifySelfConsistency(snapshot, !settings.dangerouslySkipFingerprintCheck);
  const chainEligibleAddresses = settings.dangerouslySkipFingerprintCheck
    ? undefined
    : await verifyOnChainWithEligibility(
      settings.ethRpcUrl,
      settings.registryAddress,
      snapshot.nodes,
      snapshot.block_number,
      { fetch: fetchImpl },
    );
  const nodes = nodesForRouting(snapshot, settings, chainEligibleAddresses);
  if (nodes.length === 0) {
    throw new NoxClientError(
      `Topology from ${seed} returned 0 nodes`,
      NoxClientErrorCode.NoNodesAvailable,
    );
  }
  return { seed, snapshot, nodes };
}

/**
 * Report the most useful connect failure: a seed that answered but failed a
 * check says more than one that was unreachable.
 */
function connectError(errors: readonly NoxClientError[]): NoxClientError {
  const checked = errors.find(
    (error) => error.code !== NoxClientErrorCode.TopologyFetchFailed,
  );
  if (checked !== undefined) return checked;
  const detail = errors.map((error) => error.message).join("; ");
  return new NoxClientError(
    detail.length > 0 ? `No seed nodes reachable: ${detail}` : "No seed nodes reachable",
    NoxClientErrorCode.TopologyFetchFailed,
    errors,
  );
}

/**
 * PoW difficulty to use after reading a seed. A seed value above zero replaces
 * the default and can only raise a caller's explicit value, because nodes
 * accept any packet whose PoW meets or exceeds their own difficulty. Seed
 * values are capped at `MAX_ADOPTED_POW_DIFFICULTY`.
 */
function effectivePowDifficulty(
  current: number,
  pinned: boolean,
  seedDifficulty: number | undefined,
): number {
  if (seedDifficulty === undefined || seedDifficulty <= 0) {
    return pinned ? current : DEFAULTS.powDifficulty;
  }
  const advertised = Math.min(seedDifficulty, MAX_ADOPTED_POW_DIFFICULTY);
  return pinned ? Math.max(current, advertised) : advertised;
}

function isResponseTimeout(error: unknown): boolean {
  return error instanceof NoxClientError &&
    error.code === NoxClientErrorCode.ResponseTimeout;
}

function isIdempotentHttpMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === "GET" || normalized === "HEAD" || normalized === "OPTIONS";
}

function validateTopologyVerificationConfig(
  config: NoxClientSettings,
): void {
  if (
    !Number.isSafeInteger(config.livenessMaxAgeMs) ||
    config.livenessMaxAgeMs <= 0
  ) {
    throw new NoxClientError(
      "livenessMaxAgeMs must be a positive safe integer",
      NoxClientErrorCode.InvalidConfig,
    );
  }
  if (config.dangerouslySkipFingerprintCheck) {
    if (!config.seeds.every(isLoopbackUrl)) {
      throw new NoxClientError(
        "dangerouslySkipFingerprintCheck is restricted to loopback test meshes",
        NoxClientErrorCode.InvalidConfig,
      );
    }
    return;
  }

  if (config.ethRpcUrl.length === 0 || config.registryAddress.length === 0) {
    throw new NoxClientError(
      "Topology verification requires both ethRpcUrl and registryAddress; set dangerouslySkipFingerprintCheck only for a local test mesh",
      NoxClientErrorCode.InvalidConfig,
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/u.test(config.registryAddress)) {
    throw new NoxClientError(
      "Topology verification registryAddress must be a 20-byte 0x-prefixed Ethereum address",
      NoxClientErrorCode.InvalidConfig,
    );
  }
  try {
    const rpcUrl = new URL(config.ethRpcUrl);
    if (rpcUrl.protocol !== "http:" && rpcUrl.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new NoxClientError(
      "Topology verification ethRpcUrl must be an absolute HTTP(S) URL",
      NoxClientErrorCode.InvalidConfig,
    );
  }
}

function nodesForRouting(
  snapshot: TopologySnapshot,
  config: NoxClientSettings,
  chainEligibleAddresses?: ReadonlySet<string>,
): TopologyNode[] {
  if (snapshot.schema_version !== 2) {
    return parseNodes(snapshot);
  }
  const liveNodes = selectLiveNodes(
    snapshot,
    Math.floor(Date.now() / 1000),
    Math.ceil(config.livenessMaxAgeMs / 1000),
  );
  const eligibleNodes = chainEligibleAddresses === undefined
    ? liveNodes
    : liveNodes.filter((node) =>
      chainEligibleAddresses.has(normalizeEthereumAddress(node.address))
    );
  const capabilities = livenessCapabilities(snapshot);
  return parseNodes({ ...snapshot, nodes: eligibleNodes }).map((node) => {
    const nodeCapabilities = capabilities.get(node.id);
    return nodeCapabilities === undefined ? node : { ...node, capabilities: nodeCapabilities };
  });
}

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "[::1]" ||
      /^127(?:\.[0-9]{1,3}){3}$/u.test(hostname)
    );
  } catch {
    return false;
  }
}

function cloneTopologyNode(node: TopologyNode): TopologyNode {
  return { ...node, publicKey: node.publicKey.slice() };
}

function normalizeEthereumAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(value)) {
    throw new NoxClientError(
      `Paid exit ID must be a 20-byte Ethereum address: ${value}`,
      NoxClientErrorCode.InvalidConfig,
    );
  }
  return value.toLowerCase();
}

function wordToU64(value: Uint8Array, field: string): bigint {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new NoxClientError(
      `${field} must be a 32-byte uint256 word`,
      NoxClientErrorCode.DecryptionFailed,
    );
  }
  const decoded = BigInt(`0x${bytesToHex(value)}`);
  if (decoded > (1n << 64n) - 1n) {
    throw new NoxClientError(
      `${field} exceeds the paid-v2 uint64 wire range`,
      NoxClientErrorCode.DecryptionFailed,
    );
  }
  return decoded;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function asTopologyLoadError(
  seed: string,
  error: unknown,
): NoxClientError {
  if (error instanceof NoxClientError) return error;
  return new NoxClientError(
    `Topology from ${seed} failed: ${String(error)}`,
    NoxClientErrorCode.TopologyFetchFailed,
    error,
  );
}

function pickEntryUrl(nodes: TopologyNode[]): string {
  const pool = nodes.filter(
    (node) =>
      layersForRole(node.role).includes(0) &&
      hasUsableIngress(node.address),
  );
  if (pool.length === 0) {
    throw new NoxClientError(
      "No layer-0 node has a usable HTTP(S) ingress URL",
      NoxClientErrorCode.NoNodesAvailable,
    );
  }
  const node = pool[secureRandomIndex(pool.length)]!;
  return node.address;
}


// Parse 32-char hex SURB ID from packet_id suffix: "{prefix}-{rid}-{32hex}"
const HEX32_RE = /^[0-9a-f]{32}$/;
function parseSurbIdFromPacketId(packetId: string): string | null {
  const lastDash = packetId.lastIndexOf("-");
  if (lastDash === -1) return null;
  const suffix = packetId.slice(lastDash + 1);
  if (suffix.length === 32 && HEX32_RE.test(suffix)) return suffix;
  return null;
}
