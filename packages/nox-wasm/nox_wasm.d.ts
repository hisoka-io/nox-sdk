/* tslint:disable */
/* eslint-disable */
/**
 * Hand-written type declarations for @hisoka/nox-wasm.
 *
 * These declarations mirror what wasm-bindgen generates so that TypeScript
 * can type-check the nox-client package WITHOUT building the WASM first.
 * The actual runtime JS/WASM comes from wasm-pack build outputs (pkg-*).
 */

/**
 * A single hop in a Sphinx path.
 *
 * `public_key` must be a 64-character hex string (32 bytes).
 * `address` is the routing string (e.g. `"1.2.3.4:9000"` or a libp2p multiaddr).
 */
export class JsPathHop {
  free(): void;
  constructor(pub_key_hex: string, address: string);
  readonly address: string;
  readonly pub_key_hex: string;
}

/** Result of `create_surb`. */
export class JsSurbCreateResult {
  private constructor();
  free(): void;
  /** The recovery object -- store this to decrypt the exit node's response. */
  readonly recovery: JsSurbRecovery;
  /** The serialized SURB bytes to embed in the `AnonymousRequest`. */
  readonly surb_bytes: Uint8Array;
}

/**
 * An opaque SURB recovery object -- keep this to decrypt the exit node's response.
 *
 * Serialized as JSON internally; pass the string back to `decrypt_surb_response`.
 */
export class JsSurbRecovery {
  private constructor();
  free(): void;
  static from_json(json: string): JsSurbRecovery;
  to_json(): string;
  readonly id_hex: string;
}

/**
 * Build a Sphinx packet ready to send to an entry node.
 *
 * Returns raw packet bytes (always exactly 32,768 bytes = PACKET_SIZE).
 */
export function build_sphinx_packet(
  hops: JsPathHop[],
  payload: Uint8Array,
  pow_difficulty: number,
): Uint8Array;

/** Check if a hash meets the difficulty -- exposed for testing. */
export function check_difficulty(hash: Uint8Array, difficulty: number): boolean;

/** Count leading zero bits in a hash -- exposed for testing. */
export function count_leading_zero_bits(hash: Uint8Array): number;

/**
 * Create a Single-Use Reply Block for the given reverse path.
 */
export function create_surb(
  path: JsPathHop[],
  id_hex: string,
  pow_difficulty: number,
): JsSurbCreateResult;

/**
 * Decrypt a SURB response body received from the entry node's poll endpoint.
 */
export function decrypt_surb_response(
  recovery: JsSurbRecovery,
  encrypted_body: Uint8Array,
): Uint8Array;

/**
 * Find a nonce that satisfies the PoW difficulty requirement.
 */
export function solve_pow(
  header_bytes: Uint8Array,
  difficulty: number,
  start_nonce: number,
): Uint8Array;

/**
 * Compute the XOR topology fingerprint over a list of node Ethereum addresses.
 */
export function topology_fingerprint(addresses_hex: string[]): string;

/** Verify that a nonce is valid for the given header and difficulty. */
export function verify_pow(
  header_bytes: Uint8Array,
  nonce_le_bytes: Uint8Array,
  difficulty: number,
): boolean;

/** Default export: WASM init function (for bundler targets). */
export default function init(): Promise<void>;
