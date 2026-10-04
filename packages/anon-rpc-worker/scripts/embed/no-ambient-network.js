// @ts-check
// Injected into the worker bundle by scripts/build.mjs (ARCHITECTURE §3.5).
//
// The SDK's classic-mode helpers default to `globalThis.fetch`; the build
// defines that expression as `noxAmbientFetchDisabled`, so the shipped bytes
// hold no live path to the ambient fetch. KPS mode never reaches it (the KPS
// transport replaces every fetch), and if anything ever did, it fails closed
// with the SDK's MODE_VIOLATION code instead of leaving the KPS path.

/**
 * Stand-in for `globalThis.fetch` inside the worker bundle. Always rejects.
 * @param {unknown} _input
 * @param {unknown} [_init]
 * @returns {Promise<never>}
 */
export function noxAmbientFetchDisabled(_input, _init) {
  const error = new Error("The Nox anon-rpc worker never uses the ambient fetch; requests go through anonRpcWorker.kps only");
  return Promise.reject(Object.assign(error, { name: "NoxClientError", code: "MODE_VIOLATION" }));
}
