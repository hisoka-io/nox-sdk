# Reference worker specifier (vendored)

`WorkerSpecifier.sol` is a byte-identical copy of the anon-rpc reference specifier,
[`impl/specifier/src/WorkerSpecifier.sol`](https://github.com/ethereum/anon-rpc/blob/f2c8a758caaa555974a3c79769e8cb4a40ac1ae1/impl/specifier/src/WorkerSpecifier.sol)
at `ethereum/anon-rpc@f2c8a75` (sha256 `f86a1da4e84433a731bf6f96b0a0b7f196fc946c5753914d1e0471c0033ce5be`),
MIT licensed, copyright Ethereum Foundation (see `LICENSE.anon-rpc`).

The test bed deploys it on a local anvil chain so the harness reads `workerHash()` and
`workerResolvers()` from a real contract, exactly as a wallet does on mainnet.

`WorkerSpecifier.json` holds its ABI and creation bytecode, compiled with solc 0.8.28 (the version the
upstream project pins). Regenerate it with:

```sh
pnpm compile:specifier        # or: bash scripts/compile-specifier.sh (SOLC=/path/to/solc-0.8.28)
```

`tests/unit/codecs.test.ts` ("vendored WorkerSpecifier artifact") checks that the artifact records the sha256 of the vendored source,
so the two cannot drift apart silently.

# Local chain fixtures

`NoxRegistry.json` and `ERC1967Proxy.json` hold the ABI and creation bytecode of the Nox registry
(`packages/evm-contracts/contracts/nox/NoxRegistry.sol` in hisoka-io/darkpool, Apache-2.0) and the OpenZeppelin
proxy it is deployed behind, compiled with solc 0.8.28 and the darkpool settings for the registry (optimizer runs 1,
evm cancun). Each artifact records the source commit and sha256. The bed deploys them on the upstream anvil so the
mesh nodes observe a real registry and the worker's snapshot is generated from it (`src/registry.ts`).

`E2eLogEmitter.sol` (Apache-2.0, this package) gives the JSON-RPC matrix an `eth_call` target and `eth_getLogs`
results of a chosen size; `E2eLogEmitter.json` is its artifact.

Regenerate all three with:

```sh
DARKPOOL_REPO=/path/to/darkpool bash scripts/compile-local-contracts.sh
```
