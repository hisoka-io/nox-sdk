// Virtual modules that the bundle build (scripts/build.mjs) provides. They do
// not exist on disk; the build resolves them and inlines their content, so the
// pinned snapshot is covered by the worker's keccak-256 pin.

declare module "nox-embed:snapshot" {
  /** The pinned registry snapshot (`nox-anon-rpc-snapshot/1`), parsed JSON; verified at boot. */
  const snapshot: unknown;
  export default snapshot;
}

declare module "nox-embed:bootstrap" {
  /** The discovery bootstrap (`nox-anon-rpc-bootstrap/1`), parsed JSON; verified at boot. */
  const bootstrap: unknown;
  export default bootstrap;
}

declare module "nox-embed:tls" {
  /** Initialise the embedded nox-tls module (no fetch; the bytes are in the bundle). */
  export default function init(): Promise<void>;
  export const TlsClientConfig: import("./tls/module.js").NoxTlsExports["TlsClientConfig"];
  export const TlsClientSession: import("./tls/module.js").NoxTlsExports["TlsClientSession"];
  export const HttpResponseParser: import("./tls/module.js").NoxTlsExports["HttpResponseParser"];
  export const encodeHttpRequest: import("./tls/module.js").NoxTlsExports["encodeHttpRequest"];
  export const buildInfo: import("./tls/module.js").NoxTlsExports["buildInfo"];
}

declare module "nox-embed:tls-root" {
  /** A test bed's CA certificate (DER), trusted next to the compiled-in roots; `null` in every release build. */
  const extraRootDer: Uint8Array | null;
  export default extraRootDer;
}
