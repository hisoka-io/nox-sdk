/**
 * The discovery bootstrap (`nox-anon-rpc-bootstrap/1`, PROPOSAL §2.2): default
 * anchors, the registry implementation the proxy must point at, the public RPC
 * endpoints read through exits, and the discovery policy. Hashed into the
 * bundle next to the snapshot; nothing in it changes when a node moves.
 *
 * Pure functions: no network, no clock.
 */
import {
  NoxClientError,
  NoxClientErrorCode,
  type DiscoveryPolicy,
  type KpsBootstrap,
  type PinnedSnapshot,
} from "../types.js";
import { isKpsAddress } from "./address.js";
import {
  BOOTSTRAP_FORMAT,
  DISCOVERY_LIMITS,
  DISCOVERY_POLICY_RANGES,
} from "./constants.js";

const BOOTSTRAP_KEYS = ["format", "chainId", "registry", "registryImpl", "anchors", "registryRpcUrls", "policy"] as const;
const POLICY_KEYS = Object.keys(DISCOVERY_POLICY_RANGES) as (keyof DiscoveryPolicy)[];
const ADDRESS_RE = /^0x[0-9a-f]{40}$/u;

/**
 * Check a bootstrap completely and against the snapshot it ships with: exact
 * keys, same chain and registry, a lowercase implementation address, unique
 * well-formed anchors, 2..8 unique RPC URLs (`https:`, or `http:` on a
 * loopback host for local test beds) and every policy field in range. Throws
 * `TOPOLOGY_VERIFICATION_FAILED` naming the problem.
 */
export function verifyBootstrap(value: unknown, pinned: PinnedSnapshot): KpsBootstrap {
  if (!isPlainRecord(value)) throw invalid("the bootstrap is not an object");
  checkKeys(value, BOOTSTRAP_KEYS, "bootstrap");
  if (value["format"] !== BOOTSTRAP_FORMAT) throw invalid(`format must be "${BOOTSTRAP_FORMAT}"`);
  if (value["chainId"] !== pinned.chainId) {
    throw invalid(`chainId ${String(value["chainId"])} differs from the snapshot's chain ${pinned.chainId}`);
  }
  if (value["registry"] !== pinned.registry) throw invalid("registry differs from the snapshot's registry");
  const impl = value["registryImpl"];
  if (typeof impl !== "string" || !ADDRESS_RE.test(impl) || /^0x0{40}$/u.test(impl)) {
    throw invalid("registryImpl must be a non-zero lowercase 0x address");
  }
  const anchors = checkAnchorList(value["anchors"], "anchors", 0, (detail) => invalid(detail));
  const rpcUrls = checkRpcUrls(value["registryRpcUrls"], "registryRpcUrls", (detail) => invalid(detail));
  const policy = value["policy"];
  if (!isPlainRecord(policy)) throw invalid("policy is not an object");
  checkKeys(policy, POLICY_KEYS, "policy");
  const out = {} as DiscoveryPolicy;
  for (const key of POLICY_KEYS) {
    const [min, max] = DISCOVERY_POLICY_RANGES[key];
    const field = policy[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < min || field > max) {
      throw invalid(`policy.${key} must be an integer in ${min}..${max}`);
    }
    out[key] = field;
  }
  return Object.freeze({
    format: BOOTSTRAP_FORMAT,
    chainId: pinned.chainId,
    registry: pinned.registry,
    registryImpl: impl,
    anchors: Object.freeze([...anchors]) as string[],
    registryRpcUrls: Object.freeze([...rpcUrls]) as string[],
    policy: Object.freeze(out),
  });
}

/**
 * A list of `min..16` unique KPS addresses. `fail` builds the error so the
 * same rule serves the bundle (`TOPOLOGY_VERIFICATION_FAILED`) and caller
 * options (`INVALID_CONFIG`).
 */
export function checkAnchorList(
  value: unknown,
  field: string,
  min: number,
  fail: (detail: string) => Error,
): string[] {
  const max = DISCOVERY_LIMITS.maxAnchors;
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw fail(`${field} must be a list of ${min}..${max} KPS addresses`);
  }
  const seen = new Set<string>();
  value.forEach((entry: unknown, index) => {
    if (typeof entry !== "string" || !isKpsAddress(entry)) {
      throw fail(`${field}[${index}] is not a KPS address <ip>:<port>:<certhash>`);
    }
    if (seen.has(entry)) throw fail(`${field}[${index}] repeats an address`);
    seen.add(entry);
  });
  return [...seen];
}

/** 2..8 unique RPC URLs: `https:`, or `http:` on a loopback host (local test beds only). */
export function checkRpcUrls(value: unknown, field: string, fail: (detail: string) => Error): string[] {
  const { minRpcUrls, maxRpcUrls, maxRpcUrlLength } = DISCOVERY_LIMITS;
  if (!Array.isArray(value) || value.length < minRpcUrls || value.length > maxRpcUrls) {
    throw fail(`${field} must be a list of ${minRpcUrls}..${maxRpcUrls} RPC URLs`);
  }
  const seen = new Set<string>();
  value.forEach((entry: unknown, index) => {
    if (typeof entry !== "string" || entry.length > maxRpcUrlLength || !isAllowedRpcUrl(entry)) {
      throw fail(`${field}[${index}] must be an https: URL (http: only on a loopback host) of at most ${maxRpcUrlLength} characters`);
    }
    if (seen.has(entry)) throw fail(`${field}[${index}] repeats a URL`);
    seen.add(entry);
  });
  return [...seen];
}

/** `https:` anywhere, `http:` only on 127.0.0.0/8, `localhost` or `[::1]`; no credentials or fragment. */
export function isAllowedRpcUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") return false;
  if (url.protocol === "https:") return url.hostname.length > 0;
  if (url.protocol !== "http:") return false;
  return url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(url.hostname);
}

/** Name of the organisation behind an RPC URL, for "different providers": its registrable host. */
export function rpcProviderKey(url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) || host.startsWith("[") || host === "localhost") {
    // Local beds run several providers on one host; tell them apart by port.
    return new URL(url).host.toLowerCase();
  }
  const labels = host.split(".");
  return labels.slice(-2).join(".");
}

function checkKeys(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw invalid(`${where} has an unknown field "${key}"`);
  }
  for (const key of keys) {
    if (!(key in value)) throw invalid(`${where} is missing "${key}"`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function invalid(detail: string): NoxClientError {
  return new NoxClientError(`Discovery bootstrap is invalid: ${detail}`, NoxClientErrorCode.TopologyVerificationFailed);
}
