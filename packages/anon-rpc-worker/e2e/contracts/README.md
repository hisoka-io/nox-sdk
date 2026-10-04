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
