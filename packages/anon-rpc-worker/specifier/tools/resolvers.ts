// Pre-deployment checks for `workerResolvers()` entries (anon-rpc SPEC.md §4.1, KPS SPEC §2-§3). An immutable
// specifier can never correct a resolver, so every entry is checked before any calldata is produced. `kps:`
// entries are split with the reference harness's own parser and their addresses parsed with the KPS client
// library's, so a string that passes here parses identically in wallets.

import { isIPv4, isIPv6 } from "node:net";
import { decodeCerthash, encodeCerthash, parseAddress } from "@kpstreams/core";
import { parseKpsResolver } from "./harness.ts";

export type ResolverKind = "https" | "kps" | "unsupported";

export type ResolverCheck = {
  entry: string;
  kind: ResolverKind;
  errors: string[];
  warnings: string[];
};

export type ResolverReport = {
  checks: ResolverCheck[];
  /** Problems that make the list unfit to publish. */
  errors: string[];
  /** Publishable, but worth a second look. */
  warnings: string[];
  /** UTF-8 bytes across all entries (drives storage gas). */
  totalBytes: number;
};

export type ResolverPolicy = {
  /** The anon-rpc network listing checklist asks for two or more resolvers. */
  minResolvers: number;
  /** Harnesses ignore unrecognized kinds (§4.1); publishing one is allowed only when explicitly requested. */
  allowUnknownKinds: boolean;
};

export const DEFAULT_RESOLVER_POLICY: ResolverPolicy = { minResolvers: 2, allowUnknownKinds: false };

const KECCAK_PATH = /\/keccak\/([0-9a-f]{2})\/([0-9a-f]{62})(?:$|[/?#])/;
/** Package path layouts of the npm CDNs: jsDelivr serves /npm/<pkg>[@<version>]/..., unpkg /<pkg>[@<version>]/.... */
const NPM_CDN_PATHS: Readonly<Record<string, RegExp>> = {
  "cdn.jsdelivr.net": /^\/npm\/((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?\//,
  "unpkg.com": /^\/((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?\//,
};
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function checkContentAddress(path: string, workerHash: string | undefined, check: ResolverCheck): void {
  const match = KECCAK_PATH.exec(path);
  if (match === null) {
    if (path.includes("/keccak/")) check.errors.push("has a /keccak/ segment that is not <2 hex>/<62 hex> lowercase");
    return;
  }
  if (workerHash === undefined) return;
  const named = `0x${match[1]}${match[2]}`;
  if (named !== workerHash.toLowerCase()) {
    check.errors.push(`content-addressed path names ${named}, but the worker hash is ${workerHash.toLowerCase()}`);
  }
}

function checkHttps(entry: string, workerHash: string | undefined, check: ResolverCheck): void {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    check.errors.push("not a valid URL");
    return;
  }
  if (url.username !== "" || url.password !== "") check.errors.push("must not carry credentials");
  if (url.hostname === "") check.errors.push("has no host");
  if (url.hash !== "") check.warnings.push("has a #fragment, which is never sent to the server");
  const layout = NPM_CDN_PATHS[url.hostname];
  const npm = layout === undefined ? null : layout.exec(url.pathname);
  if (npm !== null) {
    const version = npm[2] === undefined ? undefined : decodeURIComponent(npm[2]);
    if (version === undefined || !EXACT_SEMVER.test(version)) {
      check.warnings.push(
        `npm CDN path pins ${version === undefined ? "no version" : `version "${version}"`}, not an exact version, so the bytes behind it can change`,
      );
    }
  }
  checkContentAddress(url.pathname, workerHash, check);
}

function checkKpsAddress(addr: string, check: ResolverCheck): void {
  // The KPS client library's own parser and certhash decoder (what a browser harness dials with), then the
  // address rules it leaves to the caller: the host must be an IP literal (KPS SPEC §2) and the certhash must be
  // the canonical encoding of its digest.
  let parsed: { ip: string; port: number; certhash: string };
  try {
    parsed = parseAddress(addr);
    const digest = decodeCerthash(parsed.certhash);
    if (encodeCerthash(digest) !== parsed.certhash) {
      check.errors.push(`certhash "${parsed.certhash}" is not the canonical base64url encoding of its digest`);
    }
  } catch (e) {
    check.errors.push(`the KPS client library rejects "${addr}": ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const bracketed = addr.startsWith("[");
  if (bracketed ? !isIPv6(parsed.ip) : !isIPv4(parsed.ip)) {
    check.errors.push(
      `"${parsed.ip}" is not an ${bracketed ? "IPv6" : "IPv4"} literal (KPS SPEC §2: IP addresses only)`,
    );
  }
}

function checkKps(entry: string, workerHash: string | undefined, check: ResolverCheck): void {
  let parsed: { addr: string; path: string } | undefined;
  try {
    parsed = parseKpsResolver(entry);
  } catch (e) {
    check.errors.push(`the reference harness cannot parse it: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (parsed === undefined) {
    check.errors.push("not a kps resolver string");
    return;
  }
  checkKpsAddress(parsed.addr, check);
  if (parsed.path.startsWith("//")) check.errors.push("request target must not start with //");
  checkContentAddress(parsed.path, workerHash, check);
}

export function checkResolver(
  entry: string,
  workerHash: string | undefined,
  policy: ResolverPolicy = DEFAULT_RESOLVER_POLICY,
): ResolverCheck {
  const check: ResolverCheck = { entry, kind: "unsupported", errors: [], warnings: [] };
  if (entry.length === 0) {
    check.errors.push("empty entry");
    return check;
  }
  if (!/^[\x21-\x7e]+$/.test(entry)) {
    check.errors.push("contains whitespace, control or non-ASCII characters");
    return check;
  }
  const scheme = entry.slice(0, entry.indexOf(":") + 1).toLowerCase();
  if (scheme === "https:") {
    check.kind = "https";
    checkHttps(entry, workerHash, check);
  } else if (entry.startsWith("kps:")) {
    check.kind = "kps";
    checkKps(entry, workerHash, check);
  } else if (scheme === "http:") {
    check.errors.push("http: is a local-development affordance of the reference harness; publish https: instead");
  } else if (scheme === "blob:") {
    check.errors.push("blob: names bytes inside one running program and cannot work from a deployed specifier (§4.1)");
  } else if (policy.allowUnknownKinds) {
    check.warnings.push("unrecognized kind: harnesses ignore it (§4.1)");
  } else {
    check.errors.push("unrecognized kind: harnesses ignore it (§4.1); pass --allow-unknown-kinds to publish it anyway");
  }
  return check;
}

export function checkResolvers(
  entries: readonly string[],
  workerHash: string | undefined,
  policy: ResolverPolicy = DEFAULT_RESOLVER_POLICY,
): ResolverReport {
  const checks = entries.map((entry) => checkResolver(entry, workerHash, policy));
  const errors: string[] = [];
  const warnings: string[] = [];
  checks.forEach((check, i) => {
    for (const e of check.errors) errors.push(`resolver ${i} (${check.entry || "<empty>"}): ${e}`);
    for (const w of check.warnings) warnings.push(`resolver ${i} (${check.entry}): ${w}`);
  });
  if (entries.length === 0) errors.push("no resolvers: harnesses would have nowhere to fetch the bundle from");
  else if (entries.length < policy.minResolvers) {
    warnings.push(
      `${entries.length} resolver(s); the network listing checklist asks for ${policy.minResolvers} or more`,
    );
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry)) errors.push(`duplicate resolver: ${entry}`);
    seen.add(entry);
  }
  const totalBytes = entries.reduce((sum, e) => sum + Buffer.byteLength(e, "utf8"), 0);
  return { checks, errors, warnings, totalBytes };
}
