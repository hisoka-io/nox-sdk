/**
 * Stub for @hisoka-io/nox-wasm when the WASM package isn't built.
 * Tests use vi.mock() to override these with proper mocks.
 * This file only exists to satisfy Vite's module resolution.
 */
export function build_sphinx_packet() {
  throw new Error("nox-wasm stub: use vi.mock() in tests");
}
export function create_surb() {
  throw new Error("nox-wasm stub: use vi.mock() in tests");
}
export function decrypt_surb_response() {
  throw new Error("nox-wasm stub: use vi.mock() in tests");
}
export function solve_pow() {
  throw new Error("nox-wasm stub: use vi.mock() in tests");
}
export function verify_pow() {
  return false;
}
export function topology_fingerprint() {
  return "0".repeat(64);
}
export class JsPathHop {
  constructor(
    public pubKeyHex: string,
    public address: string,
  ) {}
}
export class JsSurbRecovery {
  id_hex = "0".repeat(32);
  to_json() {
    return "{}";
  }
  static from_json() {
    return new JsSurbRecovery();
  }
}
export class JsSurbCreateResult {
  surb_bytes = new Uint8Array(0);
  recovery = new JsSurbRecovery();
}
export default {
  build_sphinx_packet,
  create_surb,
  decrypt_surb_response,
  solve_pow,
  verify_pow,
  topology_fingerprint,
  JsPathHop,
  JsSurbRecovery,
  JsSurbCreateResult,
};
