/**
 * KPS addresses (KPS SPEC §2-§3) and `kps:` locators (anon-rpc SPEC §4.1).
 *
 * An address is `<ipv4>:<udp-port>:<certhash>` or `[<ipv6>]:<udp-port>:<certhash>`.
 * The certhash is multibase `u` (base64url, no padding) of the multihash
 * `0x12 0x20 || sha256(certificate DER)`. A locator is `kps:<address><path>`;
 * it is deliberately not a URL and is split at the first `/` after the prefix.
 */
import { NoxKpsError } from "./errors.js";

/** Prefix of a KPS locator. */
export const KPS_LOCATOR_PREFIX = "kps:";

/** A parsed KPS address. `address` is the canonical string form. */
export interface KpsAddressParts {
  readonly address: string;
  readonly host: string;
  readonly port: number;
  readonly certhash: string;
  readonly ipv6: boolean;
}

/** A parsed `kps:<address><path>` locator. */
export interface KpsLocator extends KpsAddressParts {
  /** Origin-form request target, starting with `/`. */
  readonly path: string;
}

const MULTIHASH_SHA2_256 = 0x12;
const SHA2_256_LENGTH = 0x20;
/** "u" + base64url of 34 bytes without padding. */
const CERTHASH_LENGTH = 1 + Math.ceil(((2 + SHA2_256_LENGTH) * 8) / 6);
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const IPV4_OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])";
const IPV4_RE = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`, "u");
const IPV6_CHARS_RE = /^[0-9A-Fa-f:.]{2,45}$/u;
const PORT_RE = /^[1-9][0-9]{0,4}$/u;
/** Visible ASCII except `#`: no space, no control characters, no fragment. */
const PATH_RE = /^\/[\x21-\x22\x24-\x7e]*$/u;

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
    if (!IPV6_CHARS_RE.test(host) || !host.includes(":")) {
      throw malformed(value, "bracketed host is not an IPv6 literal");
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

/** Canonical form of a KPS address (validated). */
export function canonicalKpsAddress(value: string): string {
  return parseKpsAddress(value).address;
}

/**
 * Parse `kps:<address><path>`. The address ends at the first `/` (certhashes
 * and bracketed IPv6 hosts never contain one). Throws
 * `NoxKpsError("unsupported")` when `value` is not a `kps:` locator and
 * `NoxKpsError("protocol-error")` when it is malformed.
 */
export function parseKpsLocator(value: string): KpsLocator {
  if (typeof value !== "string" || !value.startsWith(KPS_LOCATOR_PREFIX)) {
    throw new NoxKpsError(
      "KPS transport only carries kps:<ip>:<port>:<certhash>/<path> locators; refusing a non-KPS target",
      "unsupported",
    );
  }
  const rest = value.slice(KPS_LOCATOR_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    throw new NoxKpsError("KPS locator has no /<path> after the address", "protocol-error");
  }
  const parts = parseKpsAddress(rest.slice(0, slash));
  const path = rest.slice(slash);
  if (!PATH_RE.test(path)) {
    throw new NoxKpsError(
      "KPS locator path must be origin-form visible ASCII without spaces or a fragment",
      "protocol-error",
    );
  }
  return { ...parts, path };
}

/** `kps:<address>` entry locator for a validated address. */
export function kpsEntryLocator(address: string): string {
  return `${KPS_LOCATOR_PREFIX}${canonicalKpsAddress(address)}`;
}

/** True when `value` is a well-formed `kps:<address>` entry locator. */
export function isKpsEntryLocator(value: string): boolean {
  if (typeof value !== "string" || !value.startsWith(KPS_LOCATOR_PREFIX)) return false;
  try {
    parseKpsAddress(value.slice(KPS_LOCATOR_PREFIX.length));
    return true;
  } catch {
    return false;
  }
}

/**
 * KPS address published in a registry `metadataUrl`: `kps:<address>` or
 * `kps:<address>/<path>`. Returns `undefined` for anything else (empty,
 * https, ...). Throws when the value claims `kps:` but is malformed, so a bad
 * publication is reported instead of silently ignored.
 */
export function kpsAddressFromMetadataUrl(metadataUrl: string | undefined): string | undefined {
  if (metadataUrl === undefined || !metadataUrl.startsWith(KPS_LOCATOR_PREFIX)) return undefined;
  const rest = metadataUrl.slice(KPS_LOCATOR_PREFIX.length);
  const slash = rest.indexOf("/");
  const address = slash < 0 ? rest : rest.slice(0, slash);
  if (slash >= 0 && !PATH_RE.test(rest.slice(slash))) {
    throw new NoxKpsError("metadataUrl kps: locator has an invalid path", "protocol-error");
  }
  return canonicalKpsAddress(address);
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
