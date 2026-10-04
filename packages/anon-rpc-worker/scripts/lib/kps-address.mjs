// @ts-check
/**
 * KPS addresses published in a node's NoxRegistry `metadataUrl`.
 *
 * The one accepted form (ARCHITECTURE §6) is the anon-rpc SPEC §4.1 resolver
 * string of the document nox-kps serves:
 *
 *   kps:<kps-address>/metadata.json   e.g. kps:3.239.73.249:15005:uEiB.../metadata.json
 *
 * <kps-address> follows KPS SPEC 0.2.1 §2-§3: "<ipv4>:<udp-port>:<certhash>" or
 * "[<ipv6>]:<udp-port>:<certhash>", where the certhash is multibase "u"
 * (base64url, no padding) of the sha2-256 multihash 0x12 0x20 <32-byte digest>.
 * The address is kept verbatim because it is the dial string.
 */
import { isIPv4, isIPv6 } from "node:net";

/**
 * @typedef {object} KpsEndpoint
 * @property {string} address   "<ip>:<port>:<certhash>" (IPv6 bracketed), verbatim
 * @property {string} ip        IPv4 dotted quad or IPv6 literal (no brackets)
 * @property {number} port
 * @property {string} certhash  "u" + 46 base64url characters
 */

const CERTHASH_PATTERN = /^u[A-Za-z0-9_-]{46}$/u;
const PORT_PATTERN = /^[1-9][0-9]{0,4}$/u;

/** Typed parse failure; `kpsAddrFromMetadataUrl` turns it into `null` plus a reason. */
export class KpsAddressError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "KpsAddressError";
  }
}

/**
 * Parse a KPS address ("<ip>:<port>:<certhash>"). Throws KpsAddressError.
 * @param {string} text
 * @returns {KpsEndpoint}
 */
export function parseKpsAddress(text) {
  /** @type {string} */
  let ip;
  /** @type {string} */
  let rest;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0 || text[end + 1] !== ":") throw new KpsAddressError("bracketed IPv6 host is not followed by ':'");
    ip = text.slice(1, end);
    if (!isIPv6(ip)) throw new KpsAddressError(`"${ip}" is not an IPv6 literal`);
    rest = text.slice(end + 2);
  } else {
    const colon = text.indexOf(":");
    if (colon < 0) throw new KpsAddressError("missing ':' after the host");
    ip = text.slice(0, colon);
    if (!isIPv4(ip)) throw new KpsAddressError(`"${ip}" is not an IPv4 dotted quad (IPv6 hosts must be bracketed)`);
    rest = text.slice(colon + 1);
  }
  const colon = rest.indexOf(":");
  if (colon < 0) throw new KpsAddressError("missing ':' between port and certhash");
  const portText = rest.slice(0, colon);
  const certhash = rest.slice(colon + 1);
  if (!PORT_PATTERN.test(portText) || Number(portText) > 65535) {
    throw new KpsAddressError(`"${portText}" is not a UDP port in canonical decimal (1-65535)`);
  }
  checkCerthash(certhash);
  return { address: text, ip, port: Number(portText), certhash };
}

/** The only path a node publishes after its KPS address (ARCHITECTURE §6). */
export const KPS_METADATA_PATH = "/metadata.json";

/**
 * KPS address published in a registry `metadataUrl`, which must be exactly
 * `kps:<kps-address>/metadata.json` with the address in canonical form
 * (ARCHITECTURE §6, the same rule as the SDK's kpsAddrFromMetadataUrl).
 * Anything else means "this node has no KPS endpoint": `endpoint` is null, and
 * `reason` says why when the value starts with "kps:" (a likely typo worth
 * reporting) and is null otherwise (an https URL or an empty string).
 * The value is split at the first "/" and never parsed as a URL.
 * @param {string} metadataUrl
 * @returns {{ endpoint: KpsEndpoint | null, reason: string | null }}
 */
export function kpsAddrFromMetadataUrl(metadataUrl) {
  if (!metadataUrl.startsWith("kps:")) return { endpoint: null, reason: null };
  const body = metadataUrl.slice("kps:".length);
  const slash = body.indexOf("/");
  try {
    if (slash < 0) throw new KpsAddressError(`missing the "${KPS_METADATA_PATH}" path after the address`);
    if (body.slice(slash) !== KPS_METADATA_PATH) {
      throw new KpsAddressError(`the path after the address must be exactly "${KPS_METADATA_PATH}"`);
    }
    return { endpoint: parseKpsAddress(body.slice(0, slash)), reason: null };
  } catch (error) {
    if (error instanceof KpsAddressError) return { endpoint: null, reason: error.message };
    throw error;
  }
}

/**
 * @param {string} certhash
 */
function checkCerthash(certhash) {
  if (!CERTHASH_PATTERN.test(certhash)) {
    throw new KpsAddressError("certhash must be 'u' followed by 46 base64url characters");
  }
  const bytes = Buffer.from(certhash.slice(1), "base64url");
  if (bytes.length !== 34 || bytes[0] !== 0x12 || bytes[1] !== 0x20) {
    throw new KpsAddressError("certhash is not a sha2-256 multihash (expected prefix 0x12 0x20 and 32 digest bytes)");
  }
  if (bytes.toString("base64url") !== certhash.slice(1)) {
    throw new KpsAddressError("certhash base64url is not canonical");
  }
}
