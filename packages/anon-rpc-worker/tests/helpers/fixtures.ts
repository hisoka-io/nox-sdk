/**
 * Test inputs: a valid pinned snapshot (`nox-anon-rpc-snapshot/1`) whose
 * members publish KPS addresses, exit replies in the wire format, and a
 * scripted stand-in for `NoxClient`.
 */
import { createHash } from "node:crypto";
import {
  computeTopologyFingerprint,
  primaryLayerForRole,
  type KpsBootstrap,
  type HttpRequestOptions,
  type NoxClientConfig,
  type PinnedMember,
  type PinnedSnapshot,
  type RelayerNode,
  type TopologyNode,
  type TunnelSendHandle,
} from "@hisoka-io/nox-client";
import type { NoxClientPort } from "../../src/core.js";
import type { NoxTlsBindings } from "../../src/tls/module.js";

export function certhashFor(label: string): string {
  const digest = createHash("sha256").update(label).digest();
  return `u${Buffer.concat([Buffer.from([0x12, 0x20]), digest]).toString("base64url")}`;
}

export function kpsAddressFor(index: number): string {
  return `10.0.0.${index}:15005:${certhashFor(`node-${index}`)}`;
}

export function memberAddress(index: number): string {
  return `0x${index.toString(16).padStart(40, "0")}`;
}

export function relayerOf(member: PinnedMember): RelayerNode {
  return {
    address: member.address,
    sphinx_key: member.sphinxKey,
    url: member.url,
    stake: member.stake,
    last_seen: 0,
    is_privileged: member.stake === "0",
    layer: member.layer,
    role: member.role,
    ingress_url: member.ingressUrl,
    metadata_url: member.metadataUrl,
  };
}

/** Five relays and three exits, all with KPS addresses. */
export function makePinned(roles: (1 | 2)[] = [1, 1, 1, 1, 1, 2, 2, 2]): PinnedSnapshot {
  const members: PinnedMember[] = roles.map((role, offset) => {
    const index = offset + 1;
    const address = memberAddress(index);
    return {
      address,
      sphinxKey: index.toString(16).padStart(2, "0").repeat(32),
      url: `/ip4/10.0.0.${index}/tcp/15000/p2p/12D3KooWNode${index}`,
      ingressUrl: `https://nox-${index}.test`,
      metadataUrl: `kps:${kpsAddressFor(index)}/metadata.json`,
      stake: "0",
      role,
      layer: primaryLayerForRole(address, role) as 0 | 1 | 2,
      status: 1,
      frozen: false,
      capabilities: [],
    };
  });
  return {
    format: "nox-anon-rpc-snapshot/1",
    chainId: 421614,
    registry: "0xf7bff88a1412054a001dc4b8acbddad6f9b26cb6",
    blockNumber: 315_453_396,
    blockHash: `0x${"ab".repeat(32)}`,
    fingerprint: computeTopologyFingerprint(members.map(relayerOf)),
    relayerCount: members.length,
    powDifficulty: 1,
    members,
  };
}

/** RPC endpoints of the fixture bootstrap: three different organisations. */
export const FIXTURE_PROVIDERS = [
  "https://rpc.provider-a.test/rpc",
  "https://gateway.provider-b.test/",
  "https://api.provider-c.test/v1",
];

/** A `nox-anon-rpc-bootstrap/1` for `pinned` with no default anchors unless given. */
export function makeBootstrap(pinned: PinnedSnapshot, overrides: Partial<KpsBootstrap> = {}): KpsBootstrap {
  return {
    format: "nox-anon-rpc-bootstrap/1",
    chainId: pinned.chainId,
    registry: pinned.registry,
    registryImpl: "0x7285125cfdcb6337aaed2d56d4fe99f870ede2a2",
    anchors: [],
    registryRpcUrls: [...FIXTURE_PROVIDERS],
    policy: {
      chainQuorum: 2,
      maxStateAgeSeconds: 3_600,
      chainRefreshSeconds: 600,
      probationMaxPerRoute: 1,
      probationSeconds: 1_209_600,
      minRemovalSources: 2,
      minMembersPerLayer: 2,
    },
    ...overrides,
  };
}

const encoder = new TextEncoder();

/** Bincode 1 `SerializableHttpResponse`, as an exit sends it. */
export function exitReply(
  status: number,
  headers: [string, string][],
  body: Uint8Array | string,
  truncated = false,
): Uint8Array {
  const bodyBytes = typeof body === "string" ? encoder.encode(body) : body;
  const parts: number[] = [status & 0xff, status >> 8];
  const u64 = (value: number): void => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    parts.push(...bytes);
  };
  const bytes = (value: Uint8Array): void => {
    u64(value.length);
    parts.push(...value);
  };
  u64(headers.length);
  for (const [name, value] of headers) {
    bytes(encoder.encode(name));
    bytes(encoder.encode(value));
  }
  bytes(bodyBytes);
  parts.push(truncated ? 1 : 0);
  return Uint8Array.from(parts);
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: Uint8Array;
  options: HttpRequestOptions;
}

export type ScriptedReply = (request: RecordedRequest) => Promise<Uint8Array> | Uint8Array;

/** A scripted `NoxClientPort`; `httpRequest` honours the abort signal like the SDK. */
export class FakeClient implements NoxClientPort {
  readonly requests: RecordedRequest[] = [];
  nodes: { id: string }[];
  disconnected = 0;
  inFlight = 0;
  maxInFlight = 0;
  echo: (data: Uint8Array) => Promise<Uint8Array> = async (data) => data;

  constructor(
    pinned: PinnedSnapshot,
    public reply: ScriptedReply = () => exitReply(200, [["content-type", "application/json"]], '{"jsonrpc":"2.0","id":1,"result":"0x1"}'),
  ) {
    this.nodes = pinned.members.map((member) => ({ id: member.address }));
  }

  async httpRequest(
    method: string,
    url: string,
    headers: [string, string][],
    body: Uint8Array,
    options: HttpRequestOptions,
  ): Promise<Uint8Array> {
    const request = { method, url, headers, body, options };
    this.requests.push(request);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const signal = options.signal;
      const work = Promise.resolve(this.reply(request));
      if (signal === undefined) return await work;
      return await new Promise<Uint8Array>((resolve, reject) => {
        const abort = (): void =>
          reject(Object.assign(new Error("Request aborted by the caller"), { code: "ABORTED" }));
        if (signal.aborted) abort();
        signal.addEventListener("abort", abort, { once: true });
        work.then(resolve, reject);
      });
    } finally {
      this.inFlight -= 1;
    }
  }

  sendEcho(data: Uint8Array): Promise<Uint8Array> {
    return this.echo(data);
  }

  /** Exits advertising `tunnel_v1`: none unless a test sets some. */
  tunnelNodes: TopologyNode[] = [];

  tunnelExits(): TopologyNode[] {
    return this.tunnelNodes;
  }

  tunnelSend(): TunnelSendHandle {
    throw new Error("FakeClient has no tunnel exits; tests of the tunnel path use tests/helpers/fake-tunnel.ts");
  }

  disconnect(): void {
    this.disconnected += 1;
  }
}

/** A `connect` that fails `failures` times with `code`, then returns `client`. */
export function scriptedConnect(
  client: FakeClient,
  failures: { code: string; message?: string }[] = [],
): { connect: (config: NoxClientConfig) => Promise<NoxClientPort>; configs: NoxClientConfig[] } {
  const configs: NoxClientConfig[] = [];
  const queue = [...failures];
  return {
    configs,
    connect: async (config) => {
      configs.push(config);
      const next = queue.shift();
      if (next !== undefined) {
        throw Object.assign(new Error(next.message ?? next.code), { code: next.code });
      }
      return client;
    },
  };
}

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** TLS module stand-in for tests that never open a tunnel. */
export function fakeTlsBindings(): NoxTlsBindings {
  const unused = (): never => {
    throw new Error("the TLS module is not used in this test");
  };
  return {
    newSession: unused,
    newParser: unused,
    encodeRequest: unused,
    info: { crate: "0.0.0", webpkiRoots: 0 },
  };
}

/** `config` with `tls: "off"` unless it sets `tls`: tests of the exit `HttpRequest` path. */
export function tlsOff(config: unknown): unknown {
  if (config === undefined) return { tls: "off" };
  if (typeof config !== "object" || config === null || Array.isArray(config)) return config;
  return "tls" in config ? config : { tls: "off", ...config };
}
