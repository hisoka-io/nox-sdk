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
