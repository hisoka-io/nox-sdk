// @ts-check
/**
 * The pinned snapshot document `nox-anon-rpc-snapshot/1` (ARCHITECTURE §5.1;
 * JSON Schema in snapshot/nox-snapshot.schema.json) and its canonical bytes.
 *
 * Canonical bytes: object keys sorted lexicographically at every level,
 * members sorted by address ascending, lowercase hex, 2-space indent, LF line
 * ends, one trailing newline, no wall-clock fields. Two generations at the same
 * block give identical bytes, and the worker hash covers those bytes.
 *
 * Validation has two layers:
 *   - shape: exactly the schema (required keys, no extra keys, patterns and
 *     ranges), reported with the member address and field of every problem;
 *   - meaning: the SDK must agree with every derived field (fingerprint,
 *     primary layer, canonical order). Nothing here recomputes an SDK rule.
 */
import * as sdk from "@hisoka-io/nox-client";
import { readFileSync } from "node:fs";
import { SNAPSHOT_SCHEMA_PATH } from "./paths.mjs";

export const SNAPSHOT_FORMAT = "nox-anon-rpc-snapshot/1";

/** Bounds from the schema (snapshot/nox-snapshot.schema.json). */
export const SNAPSHOT_LIMITS = Object.freeze({
  maxMembers: 256,
  maxPowDifficulty: 16,
  maxUrlLength: 256,
  maxCapabilities: 32,
  maxCapabilityLength: 64,
});

/** Top-level keys, in schema order (serialisation sorts them). */
export const SNAPSHOT_KEYS = Object.freeze([
  "format",
  "chainId",
  "registry",
  "blockNumber",
  "blockHash",
  "fingerprint",
  "relayerCount",
  "powDifficulty",
  "members",
]);

/** Member keys, in schema order (serialisation sorts them). */
export const MEMBER_KEYS = Object.freeze([
  "address",
  "sphinxKey",
  "url",
  "ingressUrl",
  "metadataUrl",
  "stake",
  "role",
  "layer",
  "status",
  "frozen",
  "capabilities",
]);

const ADDRESS = /^0x[0-9a-f]{40}$/u;
const BLOCK_HASH = /^0x[0-9a-f]{64}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

/**
 * @typedef {object} SnapshotMember
 * @property {string} address       lowercase 0x address
 * @property {string} sphinxKey     64 lowercase hex, no 0x
 * @property {string} url           P2P multiaddr (Sphinx routing address)
 * @property {string} ingressUrl
 * @property {string} metadataUrl
 * @property {string} stake         staked amount, decimal
 * @property {1 | 2 | 3} role       getNodeRole: 1 relay, 2 exit, 3 full
 * @property {0 | 1 | 2} layer      the primary layer the SDK assigns
 * @property {1 | 2} status         RelayerStatus: 1 Registered, 2 Unstaking
 * @property {boolean} frozen
 * @property {string[]} capabilities reviewed capability hints, sorted
 */

/**
 * @typedef {object} NoxAnonRpcSnapshot
 * @property {"nox-anon-rpc-snapshot/1"} format
 * @property {number} chainId
 * @property {string} registry      lowercase 0x address
 * @property {number} blockNumber
 * @property {string} blockHash     0x + 64 lowercase hex
 * @property {string} fingerprint   64 lowercase hex, no 0x (SDK form)
 * @property {number} relayerCount
 * @property {number} powDifficulty
 * @property {SnapshotMember[]} members ascending by address
 */

/** Typed snapshot failure; `code` is stable, the message says what to check. */
export class SnapshotError extends Error {
  /**
   * @param {string} message
   * @param {"chain-mismatch" | "block-unavailable" | "block-unsafe" | "state-read-failed" | "registry-missing" | "scan-failed"
   *   | "registry-inconsistent" | "sdk-rejected" | "invalid-document" | "providers-disagree"
   *   | "release-gate" | "config"} code
   */
  constructor(message, code) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

/**
 * Canonical JSON: keys sorted at every level, 2-space indent, LF, trailing newline.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(/** @type {Record<string, unknown>} */ (value)[key]);
    }
    return out;
  }
  return value;
}

/**
 * The canonical bytes of a snapshot document.
 * @param {NoxAnonRpcSnapshot} snapshot
 * @returns {string}
 */
export function serializeSnapshot(snapshot) {
  return canonicalJson(snapshot);
}

/**
 * The committed JSON Schema (snapshot/nox-snapshot.schema.json).
 * @returns {Record<string, unknown>}
 */
export function loadSnapshotSchema() {
  return JSON.parse(readFileSync(SNAPSHOT_SCHEMA_PATH, "utf8"));
}

/**
 * Label of a member in messages: its address when readable, else its index.
 * @param {unknown} member
 * @param {number} index
 * @returns {string}
 */
function memberLabel(member, index) {
  const address = isRecord(member) ? member["address"] : undefined;
  return typeof address === "string" && ADDRESS.test(address)
    ? `members[${index}] (${address})`
    : `members[${index}]`;
}

/**
 * Shape check against the schema. Returns every problem found.
 * @param {unknown} doc
 * @returns {string[]}
 */
export function snapshotShapeProblems(doc) {
  /** @type {string[]} */
  const problems = [];
  if (!isRecord(doc)) return ["the snapshot is not a JSON object"];
  checkExactKeys(doc, SNAPSHOT_KEYS, "snapshot", problems);
  if (doc["format"] !== SNAPSHOT_FORMAT) problems.push(`format must be "${SNAPSHOT_FORMAT}"`);
  if (!isInteger(doc["chainId"]) || doc["chainId"] < 1) problems.push("chainId must be an integer >= 1");
  if (!matches(doc["registry"], ADDRESS)) problems.push("registry must be a lowercase 0x address");
  if (!isInteger(doc["blockNumber"]) || doc["blockNumber"] < 1) problems.push("blockNumber must be an integer >= 1");
  if (!matches(doc["blockHash"], BLOCK_HASH)) problems.push("blockHash must be 0x followed by 64 lowercase hex characters");
  if (!matches(doc["fingerprint"], HEX64)) problems.push("fingerprint must be 64 lowercase hex characters without 0x");
  if (!isInteger(doc["relayerCount"]) || doc["relayerCount"] < 1 || doc["relayerCount"] > SNAPSHOT_LIMITS.maxMembers) {
    problems.push(`relayerCount must be an integer in 1..${SNAPSHOT_LIMITS.maxMembers}`);
  }
  if (!isInteger(doc["powDifficulty"]) || doc["powDifficulty"] < 0 || doc["powDifficulty"] > SNAPSHOT_LIMITS.maxPowDifficulty) {
    problems.push(`powDifficulty must be an integer in 0..${SNAPSHOT_LIMITS.maxPowDifficulty}`);
  }
  const members = doc["members"];
  if (!Array.isArray(members) || members.length < 1 || members.length > SNAPSHOT_LIMITS.maxMembers) {
    problems.push(`members must be an array of 1..${SNAPSHOT_LIMITS.maxMembers} members`);
    return problems;
  }
  members.forEach((member, index) => {
    const at = memberLabel(member, index);
    if (!isRecord(member)) {
      problems.push(`${at} must be an object`);
      return;
    }
    checkExactKeys(member, MEMBER_KEYS, at, problems);
    if (!matches(member["address"], ADDRESS)) problems.push(`${at}.address must be a lowercase 0x address`);
    if (!matches(member["sphinxKey"], HEX64)) problems.push(`${at}.sphinxKey must be 64 lowercase hex characters without 0x`);
    const url = member["url"];
    if (typeof url !== "string" || url.length < 1 || url.length > SNAPSHOT_LIMITS.maxUrlLength) {
      problems.push(`${at}.url must be a string of 1..${SNAPSHOT_LIMITS.maxUrlLength} characters`);
    }
    for (const field of ["ingressUrl", "metadataUrl"]) {
      const value = member[field];
      if (typeof value !== "string" || value.length > SNAPSHOT_LIMITS.maxUrlLength) {
        problems.push(`${at}.${field} must be a string of at most ${SNAPSHOT_LIMITS.maxUrlLength} characters`);
      }
    }
    if (!matches(member["stake"], DECIMAL)) problems.push(`${at}.stake must be a decimal string without leading zeros`);
    if (![1, 2, 3].includes(/** @type {number} */ (member["role"]))) problems.push(`${at}.role must be 1, 2 or 3`);
    if (![0, 1, 2].includes(/** @type {number} */ (member["layer"]))) problems.push(`${at}.layer must be 0, 1 or 2`);
    if (![1, 2].includes(/** @type {number} */ (member["status"]))) problems.push(`${at}.status must be 1 (Registered) or 2 (Unstaking)`);
    if (typeof member["frozen"] !== "boolean") problems.push(`${at}.frozen must be a boolean`);
    const capabilities = member["capabilities"];
    if (
      !Array.isArray(capabilities) ||
      capabilities.length > SNAPSHOT_LIMITS.maxCapabilities ||
      new Set(capabilities).size !== capabilities.length ||
      !capabilities.every(
        (entry) => typeof entry === "string" && entry.length >= 1 && entry.length <= SNAPSHOT_LIMITS.maxCapabilityLength,
      )
    ) {
      problems.push(
        `${at}.capabilities must be at most ${SNAPSHOT_LIMITS.maxCapabilities} unique strings of 1..${SNAPSHOT_LIMITS.maxCapabilityLength} characters`,
      );
    }
  });
  return problems;
}

/**
 * Validate a parsed snapshot document: shape, then every SDK-derived field.
 * Throws SnapshotError("invalid-document") listing every problem found.
 * @param {unknown} doc
 * @returns {NoxAnonRpcSnapshot}
 */
export function validateSnapshotDocument(doc) {
  const shape = snapshotShapeProblems(doc);
  if (shape.length > 0) throw invalid(shape);
  const snapshot = /** @type {NoxAnonRpcSnapshot} */ (doc);

  /** @type {string[]} */
  const problems = [];
  if (snapshot.relayerCount !== snapshot.members.length) {
    problems.push(`relayerCount ${snapshot.relayerCount} differs from the ${snapshot.members.length} members`);
  }
  snapshot.members.forEach((member, index) => {
    const previous = snapshot.members[index - 1];
    if (previous !== undefined && previous.address >= member.address) {
      problems.push(`members are not in strictly ascending address order at ${memberLabel(member, index)}`);
    }
    const sorted = [...member.capabilities].sort();
    if (sorted.some((entry, i) => entry !== member.capabilities[i])) {
      problems.push(`${memberLabel(member, index)}.capabilities must be sorted`);
    }
  });
  if (problems.length > 0) throw invalid(problems);

  const nodes = snapshot.members.map(toRelayerNode);
  const fingerprint = sdk.computeTopologyFingerprint(nodes);
  if (fingerprint !== snapshot.fingerprint) {
    problems.push(`fingerprint ${snapshot.fingerprint} differs from the SDK fingerprint ${fingerprint} of the members`);
  }
  snapshot.members.forEach((member, index) => {
    try {
      const layer = primaryLayer(toRelayerNode(member));
      if (layer !== member.layer) {
        problems.push(`${memberLabel(member, index)}.layer is ${member.layer}, the SDK assigns layer ${layer}`);
      }
    } catch (error) {
      problems.push(`${memberLabel(member, index)}: ${errorText(error)}`);
    }
  });
  if (problems.length > 0) throw invalid(problems);
  checkWithSdkValidator(nodes, fingerprint, snapshot.blockNumber);
  return snapshot;
}

/**
 * The SDK `RelayerNode` for a snapshot member.
 * @param {Pick<SnapshotMember, "address" | "sphinxKey" | "url" | "ingressUrl" | "metadataUrl" | "stake" | "role" | "layer">
 *   & { capabilities?: string[] }} member
 * @returns {import("@hisoka-io/nox-client").RelayerNode}
 */
export function toRelayerNode(member) {
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

/**
 * The single primary layer the SDK's schema-2 validator accepts for a node.
 * Each candidate from the SDK's layersForRole(role) is offered in a one-member
 * schema-2 topology; exactly one must pass verifySelfConsistency, and it must
 * equal the SDK's primaryLayerForRole. This asks the SDK instead of copying
 * its layer rule.
 * @param {import("@hisoka-io/nox-client").RelayerNode} node
 * @returns {number}
 */
export function primaryLayer(node) {
  const candidates = sdk.layersForRole(node.role);
  // Field and role errors are reported as themselves, before probing layers.
  try {
    sdk.verifySelfConsistency({
      nodes: [{ ...node, layer: /** @type {number} */ (candidates[0]) }],
      fingerprint: sdk.computeTopologyFingerprint([node]),
      schema_version: 1,
    });
  } catch (error) {
    throw new SnapshotError(`the SDK rejects member ${node.address}: ${errorText(error)}`, "sdk-rejected");
  }
  const accepted = candidates.filter((layer) => {
    const probe = { ...node, layer };
    try {
      sdk.verifySelfConsistency({
        schema_version: 2,
        nodes: [probe],
        fingerprint: sdk.computeTopologyFingerprint([probe]),
        block_number: 1,
        timestamp: 1,
        liveness: [{ address: probe.address, status: "online", observed_at_unix: 1 }],
      });
      return true;
    } catch {
      return false;
    }
  });
  if (accepted.length !== 1) {
    throw new SnapshotError(
      `the SDK accepts ${accepted.length} primary layers for ${node.address} (role ${node.role}); expected exactly one`,
      "sdk-rejected",
    );
  }
  const layer = /** @type {number} */ (accepted[0]);
  // The validator and the SDK's exported rule (the one the worker uses at boot)
  // must name the same layer.
  const exported = sdk.primaryLayerForRole(node.address, node.role);
  if (exported !== layer) {
    throw new SnapshotError(
      `the SDK's validator accepts layer ${layer} for ${node.address} but primaryLayerForRole gives ${exported}`,
      "sdk-rejected",
    );
  }
  return layer;
}

/**
 * Run the SDK's schema-2 topology validator over the whole member set
 * (canonical order, primary layers, field formats, fingerprint). The liveness
 * entries exist only for this call; liveness is never part of the snapshot.
 * @param {import("@hisoka-io/nox-client").RelayerNode[]} nodes
 * @param {string} fingerprint
 * @param {number} blockNumber
 */
export function checkWithSdkValidator(nodes, fingerprint, blockNumber) {
  try {
    sdk.verifySelfConsistency({
      schema_version: 2,
      nodes,
      fingerprint,
      block_number: Math.max(blockNumber, 1),
      timestamp: 1,
      liveness: nodes.map((node) => ({ address: node.address, status: "online", observed_at_unix: 1 })),
    });
  } catch (error) {
    throw new SnapshotError(`the SDK's topology validator rejects the member set: ${errorText(error)}`, "sdk-rejected");
  }
}

/**
 * @param {Record<string, unknown>} value
 * @param {readonly string[]} keys
 * @param {string} at
 * @param {string[]} problems
 */
function checkExactKeys(value, keys, at, problems) {
  for (const key of keys) if (!(key in value)) problems.push(`${at} is missing "${key}"`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) problems.push(`${at} has unknown field "${key}"`);
}

/**
 * @param {string[]} problems
 * @returns {SnapshotError}
 */
function invalid(problems) {
  return new SnapshotError(`invalid snapshot document:\n  - ${problems.join("\n  - ")}`, "invalid-document");
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * @param {unknown} value
 * @param {RegExp} pattern
 * @returns {boolean}
 */
function matches(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}
