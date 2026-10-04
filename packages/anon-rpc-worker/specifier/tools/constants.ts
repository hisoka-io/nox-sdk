// Fixed facts and defaults shared by the tools. Values here were read from Ethereum mainnet on 2026-10-03.

/** Read-only public endpoint used when no --rpc-url / MAINNET_RPC_URL is given (no account, no key). */
export const DEFAULT_MAINNET_RPC_URL = "https://ethereum-rpc.publicnode.com";

/** keccak256 of the runtime code shared by every WorkerSpecifier on Ethereum mainnet. */
export const MAINNET_REFERENCE_CODEHASH = "0xc4c54384a9c1f1201ef3711a7ed7ba20e078a432e85ecc4f8b14927587cc7b5f";

/** Worker specifiers on Ethereum mainnet known to the anon-rpc ecosystem. */
export const KNOWN_MAINNET_SPECIFIERS: readonly { label: string; address: string; source: string }[] = [
  {
    label: "passthrough (anon-rpc reference worker)",
    address: "0x4fd77be300f31c5fe6ab266d35d27750a3478d27",
    source: "ethereum/anon-rpc adopters.json5 (kind: reference)",
  },
  {
    label: "tor-js",
    address: "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e",
    source: "ethereum/anon-rpc adopters.json5 (kind: network)",
  },
  {
    label: "Nym mixnet PoC",
    address: "0xfCc24f66E2F8bdF17537f2b117c80707219e91AD",
    source: "voltrevo/poc-nym-anon-rpc README",
  },
];
