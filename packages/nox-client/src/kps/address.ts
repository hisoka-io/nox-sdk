/**
 * KPS addresses (KPS SPEC §2-§3), `kps:` endpoints (anon-rpc SPEC §4.1) and
 * the `metadataUrl` publication format (ARCHITECTURE §6).
 *
 * An address is `<ipv4>:<udp-port>:<certhash>` or `[<ipv6>]:<udp-port>:<certhash>`.
 * The certhash is multibase `u` (base64url, no padding) of the multihash
 * `0x12 0x20 || sha256(certificate DER)`, 47 characters. An endpoint is
 * `kps:<address><target>`; it is deliberately not a URL, is never fed to
 * `new URL`, and is split at the first `/` after the prefix.
 */
import { NoxKpsError } from "./errors.js";

/** Prefix of a KPS endpoint. */
export const KPS_ENDPOINT_PREFIX = "kps:";

/** Path every node publishes after its address in `metadataUrl`. */
export const KPS_METADATA_PATH = "/metadata.json";

/** A parsed KPS address. `address` is the canonical string form. */
export interface KpsAddressParts {
  readonly address: string;
  readonly host: string;
  readonly port: number;
  readonly certhash: string;
  readonly ipv6: boolean;
}

const MULTIHASH_SHA2_256 = 0x12;
const SHA2_256_LENGTH = 0x20;
/** "u" + base64url of 34 bytes without padding. */
const CERTHASH_LENGTH = 1 + Math.ceil(((2 + SHA2_256_LENGTH) * 8) / 6);
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const IPV4_OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])";
const IPV4_RE = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`, "u");
const IPV6_GROUP_RE = /^[0-9A-Fa-f]{1,4}$/u;
/** Longest IPv6 literal in text form (RFC 4291 §2.2 with an embedded IPv4 address). */
const MAX_IPV6_LITERAL_LENGTH = 45;
const PORT_RE = /^[1-9][0-9]{0,4}$/u;
/** Origin-form target: visible ASCII except `#`, no space, no control characters. */
const TARGET_RE = /^\/[\x21-\x22\x24-\x7e]*$/u;

/**
 * Parse and validate a KPS address. Throws `NoxKpsError("protocol-error")`
 * naming the first problem.
 */
export function parseKpsAddress(value: string): KpsAddressParts {
  if (typeof value !== "string" || value.length === 0) {
    throw malformed(value, "address is empty");
  }
  let host: string;
  let rest: string;
  let ipv6 = false;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0 || value[end + 1] !== ":") {
      throw malformed(value, "IPv6 host must be bracketed as [<ipv6>]:<port>:<certhash>");
    }
    host = value.slice(1, end);
    rest = value.slice(end + 2);
    ipv6 = true;
    if (!isIpv6Literal(host)) {
      throw malformed(value, "bracketed host is not an IPv6 literal (zone IDs are not allowed)");
    }
  } else {
    const colon = value.indexOf(":");
    if (colon < 0) throw malformed(value, "missing ':' after the host");
    host = value.slice(0, colon);
    rest = value.slice(colon + 1);
    if (!IPV4_RE.test(host)) {
      throw malformed(value, "host must be a dotted-quad IPv4 address or a bracketed IPv6 literal");
    }
  }
  const colon = rest.indexOf(":");
  if (colon < 0) throw malformed(value, "missing ':' between port and certhash");
  const portText = rest.slice(0, colon);
  const certhash = rest.slice(colon + 1);
  if (!PORT_RE.test(portText)) {
    throw malformed(value, "port must be a decimal number without leading zeros");
  }
  const port = Number(portText);
  if (port < 1 || port > 65_535) throw malformed(value, `port ${port} is outside 1..65535`);
  validateCerthash(certhash, value);
  const address = `${ipv6 ? `[${host}]` : host}:${port}:${certhash}`;
  return { address, host, port, certhash, ipv6 };
}

/**
 * True for an IPv6 address in RFC 4291 §2.2 text form: eight groups of 1-4 hex
 * digits, at most one `::`, and optionally a dotted-quad IPv4 address as the
 * last 32 bits. No zone ID (`%eth0`): it names a local interface.
 */
export function isIpv6Literal(value: string): boolean {
  if (value.length < 2 || value.length > MAX_IPV6_LITERAL_LENGTH) return false;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const groupsOf = (part: string): string[] | null => (part === "" ? [] : part.split(":"));
  const head = groupsOf(halves[0] ?? "");
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
  if (head === null || tail === null) return false;
  const all = [...head, ...tail];
  let units = 0;
  for (let index = 0; index < all.length; index++) {
    const group = all[index] ?? "";
    const last = index === all.length - 1;
    // An embedded IPv4 address is the last 32 bits, never just before "::".
    if (last && group.includes(".") && (halves.length === 1 || tail.length > 0)) {
      if (!IPV4_RE.test(group)) return false;
      units += 2;
    } else if (IPV6_GROUP_RE.test(group)) {
      units += 1;
    } else {
      return false;
    }
  }
  return halves.length === 2 ? units <= 7 : units === 8;
}

/** True when `value` is a well-formed KPS address. */
export function isKpsAddress(value: string): boolean {
  try {
    parseKpsAddress(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Split `kps:<address><target>` at the first `/` after the prefix (anon-rpc
 * SPEC §4.1). Returns `null` for anything that is not a well-formed KPS
 * endpoint with an origin-form target.
 */
export function parseKpsEndpoint(value: string): { addr: string; target: string } | null {
  if (typeof value !== "string" || !value.startsWith(KPS_ENDPOINT_PREFIX)) return null;
  const rest = value.slice(KPS_ENDPOINT_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const target = rest.slice(slash);
  if (!TARGET_RE.test(target)) return null;
  try {
    return { addr: parseKpsAddress(rest.slice(0, slash)).address, target };
  } catch {
    return null;
  }
}

/** The entry endpoint `kps:<address>` of a validated address. */
export function kpsEntryEndpoint(address: string): string {
  return `${KPS_ENDPOINT_PREFIX}${parseKpsAddress(address).address}`;
}

/** The KPS address of an entry endpoint `kps:<address>`, or `null`. */
export function kpsAddressOfEntry(endpoint: string): string | null {
  if (typeof endpoint !== "string" || !endpoint.startsWith(KPS_ENDPOINT_PREFIX)) return null;
  try {
    return parseKpsAddress(endpoint.slice(KPS_ENDPOINT_PREFIX.length)).address;
  } catch {
    return null;
  }
}

/**
 * KPS address published in a registry `metadataUrl`:
 * exactly `kps:<address>/metadata.json` (ARCHITECTURE §6). Anything else
 * (empty, https, another path, a malformed address) means "this node has no
 * KPS endpoint" and returns `null`.
 */
export function kpsAddrFromMetadataUrl(metadataUrl: string): string | null {
  if (typeof metadataUrl !== "string" || !metadataUrl.startsWith(KPS_ENDPOINT_PREFIX)) return null;
  const rest = metadataUrl.slice(KPS_ENDPOINT_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || rest.slice(slash) !== KPS_METADATA_PATH) return null;
  try {
    const parts = parseKpsAddress(rest.slice(0, slash));
    // The published string must already be canonical, or two spellings would
    // name one identity.
    return parts.address === rest.slice(0, slash) ? parts.address : null;
  } catch {
    return null;
  }
}

/** Short, non-sensitive label for logs: the first characters of the certhash. */
export function kpsAddressLabel(address: string): string {
  const certhash = address.slice(address.lastIndexOf(":") + 1);
  return certhash.length > 12 ? `${certhash.slice(0, 12)}…` : certhash;
}

function validateCerthash(certhash: string, address: string): void {
  if (certhash.length !== CERTHASH_LENGTH || certhash[0] !== "u") {
    throw malformed(
      address,
      `certhash must be multibase 'u' + base64url of a 34-byte sha2-256 multihash (${CERTHASH_LENGTH} characters)`,
    );
  }
  const bytes = decodeBase64UrlNoPad(certhash.slice(1));
  if (bytes === null || bytes.length !== 2 + SHA2_256_LENGTH) {
    throw malformed(address, "certhash is not canonical base64url");
  }
  if (bytes[0] !== MULTIHASH_SHA2_256 || bytes[1] !== SHA2_256_LENGTH) {
    throw malformed(address, "certhash is not a sha2-256 multihash (expected prefix 0x12 0x20)");
  }
}

/** Strict base64url (no padding) decoder; null on any non-canonical input. */
function decodeBase64UrlNoPad(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    const value = BASE64URL_ALPHABET.indexOf(char);
    if (value < 0) return null;
    buffer = ((buffer << 6) | value) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  // Leftover bits must be zero, or two strings would name the same bytes.
  if ((buffer & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

function malformed(address: unknown, reason: string): NoxKpsError {
  const shown = typeof address === "string" ? address.slice(0, 120) : String(address);
  return new NoxKpsError(`Malformed KPS address "${shown}": ${reason}`, "protocol-error");
}
