import {
  NoxClientError,
  NoxClientErrorCode,
  DEFAULTS,
  type NoxClientConfig,
  type PathHop,
  type TopologyNode,
} from "./types.js";
import { resolveSeedUrl } from "./seeder.js";
import {
  fetchTopology,
  verifySelfConsistency,
  verifyOnChain,
  computeTopologyFingerprint,
  parseNodes,
  selectRoute,
} from "./topology.js";
import { postPacket, claimResponses, ResponseWebSocket, hasWebSocket } from "./transport.js";
import {
  encodeRelayerPayload,
  encodeServiceRequest,
  decodeRelayerPayload,
  decodeRpcResponse,
  type RelayerPayload,
} from "./bincode.js";
import type { FragmentWire } from "./bincode.js";
import { Reassembler } from "./fragmentation.js";
import { SurbPool } from "./surb_pool.js";
import { ReplenishmentManager, buildReturnPath } from "./replenishment.js";
import { bytesToHex, hexToBytes, initNodeCrypto, buildSphinxPacket } from "./utils.js";

export const EMA_ALPHA = 0.2;
export const EMA_HEADROOM = 1.5;
export const EMA_MIN_SAMPLES = 3;
export const USABLE_RESPONSE_PER_SURB = 30_699;

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

  private readonly _config: Required<NoxClientConfig>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _wasm: Record<string, any> | null = null;

  get nodes(): TopologyNode[] {
    return this._nodes;
  }

  get entryUrl(): string {
    return this._entryUrl;
  }

  get wasm(): Record<string, unknown> | null {
    return this._wasm;
  }

  get config(): Required<NoxClientConfig> {
    return this._config;
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
    config: Required<NoxClientConfig>,
  ) {
    this._nodes = nodes;
    this._entryUrl = entryUrl;
    this._config = config;
    this.surbPool = new SurbPool();
    this.replenishment = new ReplenishmentManager();
    this.adaptive = new AdaptiveSurbBudget();
  }

  /**
   * One-liner to connect with production defaults.
   * Equivalent to `NoxClient.connect(DEFAULTS)` with optional overrides.
   *
   *   const client = await NoxClient.init();
   *   const client = await NoxClient.init({ timeoutMs: 60_000 });
   */
  static async init(overrides: NoxClientConfig = {}): Promise<NoxClient> {
    return NoxClient.connect({ ...DEFAULTS, ...overrides });
  }

  /** Resolve seeds, fetch topology, init WASM, start background loops. */
  static async connect(config: NoxClientConfig = {}): Promise<NoxClient> {
    await initNodeCrypto();

    const full: Required<NoxClientConfig> = {
      seeds: config.seeds ?? DEFAULTS.seeds,
      ethRpcUrl: config.ethRpcUrl ?? DEFAULTS.ethRpcUrl,
      registryAddress: config.registryAddress ?? DEFAULTS.registryAddress,
      topologyRefreshMs: config.topologyRefreshMs ?? DEFAULTS.topologyRefreshMs,
      timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
      surbsPerRequest: config.surbsPerRequest ?? DEFAULTS.surbsPerRequest,
      powDifficulty: config.powDifficulty ?? DEFAULTS.powDifficulty,
      dangerouslySkipFingerprintCheck:
        config.dangerouslySkipFingerprintCheck ?? DEFAULTS.dangerouslySkipFingerprintCheck,
      fecRatio: config.fecRatio ?? DEFAULTS.fecRatio,
    };

    const seedUrl = await resolveSeedUrl(full.seeds, full.timeoutMs);
    if (seedUrl === null) {
      throw new NoxClientError(
        "No seed nodes reachable",
        NoxClientErrorCode.TopologyFetchFailed,
      );
    }

    const snapshot = await fetchTopology(seedUrl, full.timeoutMs);
    if (!full.dangerouslySkipFingerprintCheck) {
      verifySelfConsistency(snapshot);
    }
    if (full.ethRpcUrl && full.registryAddress) {
      const fp = computeTopologyFingerprint(snapshot.nodes);
      await verifyOnChain(full.ethRpcUrl, full.registryAddress, fp);
    }
    const nodes = parseNodes(snapshot);
    if (nodes.length === 0) {
      throw new NoxClientError(
        "Topology returned 0 nodes",
        NoxClientErrorCode.NoNodesAvailable,
      );
    }

    if (snapshot.pow_difficulty !== undefined && snapshot.pow_difficulty > 0 && !config?.powDifficulty) {
      full.powDifficulty = snapshot.pow_difficulty;
    }

    const entryUrl = pickEntryUrl(nodes);

    const client = new NoxClient(nodes, entryUrl, full);

    await client._initWasm();
    client._startTopologyRefresh(seedUrl);
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

    const response = await this._sendAnonymous(inner, "broadcastSignedTransaction", undefined, undefined, 2);
    this.adaptive.record("broadcastSignedTransaction", response.length);
    return response;
  }

  /** Send an echo request through the mixnet. Returns the echoed data. */
  async sendEcho(data: Uint8Array): Promise<Uint8Array> {
    const inner = encodeServiceRequest({ tag: "Echo", data });
    const response = await this._sendAnonymous(inner, "echo", undefined, undefined, 2);
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

  /** Proxy an HTTP request through the mixnet. */
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
    );
    this.adaptive.record("httpRequest", response.length);
    return response;
  }

  /** Send a custom `RelayerPayload` directly. Prefer submitTransaction/rpcCall/httpRequest. */
  async send(payload: RelayerPayload): Promise<Uint8Array> {
    const opKey = payload.tag;
    const surbCount = this.adaptive.surbCount(opKey, this._config.surbsPerRequest, this._config.fecRatio);
    return this._sendWithSurbCount(payload, surbCount);
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
  ): Promise<Uint8Array> {
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
    return this._sendWithSurbCount(
      { tag: "AnonymousRequest", inner, replySurbs: [] },
      surbCount,
      timeoutMs,
    );
  }

  private async _sendWithSurbCount(
    payload: RelayerPayload,
    surbCount: number,
    timeoutMs?: number,
  ): Promise<Uint8Array> {
    this._requireWasm();

    const pinnedEntry = this._nodes.find((n) => n.address === this._entryUrl);
    const route = selectRoute(this._nodes, pinnedEntry);
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
      packets.map((pkt) => postPacket(entryUrl, pkt)),
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
    if (hasWebSocket()) {
      this.responseWs = new ResponseWebSocket(this._entryUrl, (item) => {
        this._onWsResponse(item);
      });
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
      items = await claimResponses(this._entryUrl, surbIds);
    } catch (pollErr) {
      if (this._debugPoll) {
        process.stderr.write(`[poll] fetch error: ${String(pollErr).slice(0, 120)}\n`);
      }
      return;
    }

    if (this._debugPoll && items.length > 0) {
      process.stderr.write(
        `[poll] got ${items.length} items from ${this._entryUrl}, pending=${this.pending.size}\n`,
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
          process.stderr.write(
            `[poll] matchAndDecrypt returned null for item id=${item.id} data_len=${encryptedBody.length}\n`,
          );
        }
        continue;
      }
      const { requestId, plaintext } = match;

      if (this._debugPoll) {
        process.stderr.write(
          `[poll] decrypted item id=${item.id} -> requestId=${requestId} plaintext_len=${plaintext.length}\n`,
        );
      }

      let decoded: ReturnType<typeof decodeRelayerPayload>;
      try {
        decoded = decodeRelayerPayload(plaintext);
      } catch (decodeErr) {
        if (this._debugPoll) {
          process.stderr.write(
            `[poll] decodeRelayerPayload failed: ${String(decodeErr).slice(0, 120)}\n`,
          );
        }
        continue;
      }

      if (this._debugPoll) {
        process.stderr.write(`[poll] decoded tag=${decoded.tag}\n`);
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
          process.stderr.write(
            `[stall] detected stall for request ${clientRequestId}: ` +
              `${received}/${total} fragments, ${remaining} missing, ` +
              `${(sinceLastFragment / 1000).toFixed(1)}s since last fragment\n`,
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
        process.stderr.write(
          `[frag] msgId=${fragment.messageId} seq=${fragment.sequence} total=${fragment.totalFragments} received=${received} data=${fragment.data.length} surbPool=${this.surbPool.size}\n`,
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
          process.stderr.write(
            `[replenish] ignoring NeedMoreSurbs for request ${clientRequestId} ` +
              `(round ${state.round}, ${((NoxClient.STALL_TIMEOUT_MS - sinceBurst) / 1000).toFixed(1)}s until stall check)\n`,
          );
        }
        return;
      }
      if (state.round >= NoxClient.MAX_BURST_ROUNDS) {
        if (this._debugPoll) {
          process.stderr.write(
            `[replenish] max burst rounds (${NoxClient.MAX_BURST_ROUNDS}) reached for request ${clientRequestId}, ` +
              `${fragmentsRemaining} fragments still missing\n`,
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
      process.stderr.write(
        `[replenish] burst round ${round}: sending ${packetsNeeded}/${totalPacketsNeeded} ReplenishSurbs ` +
          `for request ${clientRequestId} (${fragmentsRemaining} fragments remaining)\n`,
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
      });
      this._wsSubscribe(this.surbPool.activeSurbIds());
    } catch (err) {
      this.burstState.delete(clientRequestId);
      if (this._debugPoll) {
        process.stderr.write(
          `[replenish] burst round ${round} failed for request ${clientRequestId}: ${String(err).slice(0, 120)}\n`,
        );
      }
    }
  }

  private _startTopologyRefresh(initialSeed: string): void {
    this.topologyTimer = setInterval(() => {
      void this._refreshTopology(initialSeed);
    }, this._config.topologyRefreshMs);
  }

  private async _refreshTopology(seedUrl: string): Promise<void> {
    const candidates = [seedUrl];

    for (const seed of candidates) {
      try {
        const snapshot = await fetchTopology(seed, this._config.timeoutMs);
        if (!this._config.dangerouslySkipFingerprintCheck) {
          verifySelfConsistency(snapshot);
        }
        if (this._config.ethRpcUrl && this._config.registryAddress) {
          const fp = computeTopologyFingerprint(snapshot.nodes);
          await verifyOnChain(
            this._config.ethRpcUrl,
            this._config.registryAddress,
            fp,
          );
        }
        const nodes = parseNodes(snapshot);
        if (nodes.length > 0) {
          this._nodes = nodes;
          const currentStillPresent = nodes.some(
            (n) => n.address === this._entryUrl,
          );
          if (!currentStillPresent) {
            this._entryUrl = pickEntryUrl(nodes);
            // Reconnect WS to new entry node
            if (this.responseWs !== null) {
              this.responseWs.close();
              this.responseWs = new ResponseWebSocket(this._entryUrl, (item) => {
                this._onWsResponse(item);
              });
              this.subscribedSurbIds.clear();
              this._wsSubscribe(this.surbPool.activeSurbIds());
            }
          }
          return;
        }
      } catch {
        // Try next seed
      }
    }

    const newSeed = await resolveSeedUrl(this._config.seeds, this._config.timeoutMs);
    if (newSeed !== null) {
      await this._refreshTopology(newSeed);
    }
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

function pickEntryUrl(nodes: TopologyNode[]): string {
  const httpsEntries = nodes.filter((n) => n.address.startsWith("https://"));
  const layerEntries = nodes.filter((n) => n.layer === 0 || n.layer === 1);
  const pool = httpsEntries.length > 0 ? httpsEntries : layerEntries.length > 0 ? layerEntries : nodes;
  const node = pool[Math.floor(Math.random() * pool.length)];
  if (node === undefined) {
    throw new NoxClientError(
      "Cannot pick entry URL: topology is empty",
      NoxClientErrorCode.NoNodesAvailable,
    );
  }
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

