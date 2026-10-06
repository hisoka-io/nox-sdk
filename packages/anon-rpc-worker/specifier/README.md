# Worker specifier

The on-chain half of the Nox anon-rpc worker: a specifier contract pins the worker bundle by its keccak256 hash and
lists where to fetch it ([anon-rpc SPEC §4](https://github.com/ethereum/anon-rpc/blob/main/SPEC.md#4-worker-identity-and-integrity)).
A wallet's harness reads two views, `workerHash()` and `workerResolvers()`, fetches the bytes from a resolver and runs
them only if their keccak256 equals the pinned hash.

This package holds two specifier contracts, tests that read them through the reference harness's own code, and
read-only tools for planning and checking a deployment.

## Contracts

| Contract | Updates | Source |
|---|---|---|
| `ImmutableWorkerSpecifier` | None. The hash and resolver list are set once by the constructor. There is no owner and no setter, so a new worker version ships as a new specifier at a new address. | `src/ImmutableWorkerSpecifier.sol` |
| `WorkerSpecifier` | The owner can repoint the address with `setWorker`, hand control to another account (for example a Safe) with `transferOwnership`, or freeze it with `renounceOwnership`. | `src/WorkerSpecifier.sol`, the reference contract of [ethereum/anon-rpc](https://github.com/ethereum/anon-rpc/tree/main/impl/specifier), unmodified |

Both implement `IWorkerSpecifier` (`src/IWorkerSpecifier.sol`, selectors `0x3898587d` and `0x1c67ff29`) and emit the
same `WorkerUpdated(bytes32,string[])` event, so harnesses, explorers and log-based tools treat them alike.

`ImmutableWorkerSpecifier` stores the hash in its runtime code and the resolver list in storage that only the
constructor writes. Its runtime code contains no instruction that writes storage (SSTORE, TSTORE), emits a log,
sends a call that can change state (CALL, CALLCODE, DELEGATECALL), creates a contract or self-destructs;
`test/ImmutableWorkerSpecifier.t.sol` checks this opcode by opcode. Read-only STATICCALL is outside that list (the
compiled runtime code has none today). The constructor
rejects a zero hash, an empty resolver list and empty entries, since an immutable specifier keeps whatever it is
given.

`WorkerSpecifier` here compiles, with the settings in `foundry.toml`, to the same runtime code (codehash
`0xc4c54384…7b5f`) as the WorkerSpecifier deployments on Ethereum mainnet behind the passthrough, tor-js and Nym
workers; `test/ReferenceBytecode.t.sol` keeps it that way.

## Deployments

| Worker | Chain | Specifier | Contract | Deployment |
|---|---|---|---|---|
| `@hisoka-io/anon-rpc-worker` 0.3.0, `workerHash` `0x24604525d220bcc7e39f2dbc22966a814600a63ada51baafad5dd0bcc1d28549` | Ethereum Sepolia (11155111) | [`0x29B51ca9Ad80E9c0B0D111C8748E6a7908b82eDB`](https://sepolia.etherscan.io/address/0x29B51ca9Ad80E9c0B0D111C8748E6a7908b82eDB) | `ImmutableWorkerSpecifier`, source verified on Sourcify (exact match) | tx [`0x48b8cced…24a97d`](https://sepolia.etherscan.io/tx/0x48b8cced35edfcfc7d69769d3aed130412d27525029bd48aa4e37dcd7e24a97d), block 11,855,976, 1,032,240 gas |
| `@hisoka-io/anon-rpc-worker` 0.2.0, `workerHash` `0x0a58f9915f686950072a4786249d396ecbf2194a39ac835effe8ea1a7c76f324` | Ethereum Sepolia (11155111) | [`0x29b4a6A8Cc11769531854d87f9F33EC63Efe8fe6`](https://sepolia.etherscan.io/address/0x29b4a6A8Cc11769531854d87f9F33EC63Efe8fe6) | `ImmutableWorkerSpecifier`, source verified on Sourcify (exact match) | tx [`0x5e5c7cb6…aa30e`](https://sepolia.etherscan.io/tx/0x5e5c7cb6ef38efc6ad5a0683f31036558ca7c8893f80bb1b0e0e985fd17aa30e), block 11,852,795, 1,032,240 gas |

The specifier is immutable: a new worker version ships as a new specifier at a new address. The 0.3.0 resolvers, in
order (https first, then `kps:`):

1. `https://raw.githubusercontent.com/hisoka-io/anon-rpc/keccak/24/6045…8549` (orphan `keccak` branch)
2. `https://cdn.jsdelivr.net/npm/@hisoka-io/anon-rpc-worker@0.3.0/dist/anon-rpc-worker.js`
3. `https://unpkg.com/@hisoka-io/anon-rpc-worker@0.3.0/dist/anon-rpc-worker.js`
4. `kps:100.56.0.72:15005:uEiBVDwIs40bsslDkM-BYb2AOHw3PHe70_bj5U_09r7vdIQ/keccak/24/6045…8549` (nox-1)
5. `kps:3.232.137.146:15005:uEiDGVPDwsQ96ri9T5WLR6jZov_9LW-gRAgs-DN9FyKuHuw/keccak/24/6045…8549` (nox-2)
6. `kps:18.215.18.61:15005:uEiCStd3rfGTo0ts0lSUw5f22u93O3PLCZVWWQIv_MXHm7w/keccak/24/6045…8549` (nox-8)

The three `https:` entries served the exact bytes (keccak256 = `workerHash`) through the harness's
`fetchAndVerifyBundle` right after the deployment
(`pnpm inspect -- --rpc-url <sepolia rpc> 0x29B51ca9Ad80E9c0B0D111C8748E6a7908b82eDB --fetch`). The 0.2.0 specifier
lists `kps:` first, then the same three kinds of `https:` entry for 0.2.0.

## Requirements

[Foundry](https://getfoundry.sh) 1.3.2 or later (`forge`, `cast`, `anvil` on `PATH`), Node.js 20 or later, pnpm.

## Tests

```sh
pnpm install
pnpm --filter @hisoka-io/anon-rpc-specifier test
```

This runs `tsc --noEmit`, the Foundry tests (`forge test`) and the TypeScript tests (`vitest run`):

- Foundry: interface conformance for both contracts (selectors, canonical ABI return data, fuzzed round trips),
  the immutability and constructor checks, the opcode scan, the reference bytecode match and the upstream
  `WorkerSpecifier` tests.
- `itest/harness-resolve.test.ts`: deploys both contracts to a local anvil chain with `https:` and `kps:` resolvers,
  then reads them with `readSpecifier` and `fetchAndVerifyBundle` from `@anon-rpc/browser-harness` 0.3.2, the code a
  wallet runs. The `kps:` entries pass the harness's resolver parser and the KPS client's address and certhash
  parser; the bundle then arrives, hash-verified, from the first `https:` resolver.
- `itest/plan.test.ts`: plans a deployment against a local chain standing in for mainnet, checks the gas and cost
  arithmetic, checks the target chain is untouched, and deploys with the printed signer command.
- `itest/gas-calibration.test.ts`: replays the mainnet history of the passthrough and tor-js specifiers (two
  deployments, two `setWorker` updates) on a local chain and checks each one uses exactly the gas of its mainnet
  receipt (1,088,838; 1,113,503; 478,453; 152,782).

## Planning a deployment (dry run)

```sh
pnpm --filter @hisoka-io/anon-rpc-specifier plan -- \
  --bundle path/to/nox-anon-rpc-worker.js \
  --resolver "https://cdn.jsdelivr.net/npm/@hisoka-io/anon-rpc-worker@<version>/dist/<file>.js" \
  --resolver "kps:<ip>:<udp-port>:<certhash>/keccak/<hh>/<rest>" \
  [--variant immutable|reference|both] [--deployer 0x…] [--new-owner 0x…] [--rpc-url <read-only RPC>] \
  [--resolver-order https-first|as-given] [--check-resolvers]
```

### Resolver order for the next specifier

Harnesses try resolvers in list order, so the first entry that answers sets boot time. The planner publishes
`https:` resolvers first by default (`--resolver-order https-first`, a stable reorder: entries of one kind keep the
order you gave), then `kps:` resolvers, which stay as the censorship-resistant fallback when every `https:` host is
blocked. The resolver check warns when a `kps:` entry comes before an `https:` one, and the reference variant's
planned `setWorker` uses the same order. `--resolver-order as-given` publishes the list exactly as passed.

Measured from India on 2026-10-06 against the 0.2.0 specifier (`kps:` first): ready after 26.5-45.1 s, of which
14-37 s was the ~0.9 MB bundle over one WebRTC data channel; with an `https:` resolver first, ready after
7.8-8.5 s. The next specifier's resolvers, in the order the planner writes them:

1. `https://raw.githubusercontent.com/hisoka-io/anon-rpc/keccak/<hh>/<rest>`
2. `https://cdn.jsdelivr.net/npm/@hisoka-io/anon-rpc-worker@<version>/dist/anon-rpc-worker.js`
3. `https://unpkg.com/@hisoka-io/anon-rpc-worker@<version>/dist/anon-rpc-worker.js`
4. `kps:<nox-1 address>/keccak/<hh>/<rest>`, then nox-2 and nox-8 the same way

The planner checks every resolver entry, reads fees and the latest block from the RPC (default
`https://ethereum-rpc.publicnode.com`, or `MAINNET_RPC_URL`; the endpoint operator sees which specifier and deployer
are read, so set `MAINNET_RPC_URL` to an endpoint you trust for real deployments), forks that block into a local
anvil, deploys each
variant there and reads it back through the harness. It prints the creation code, `eth_estimateGas`, the gas used,
the expected cost (gas used x (base fee + tip)), the balance to hold (gas limit x a fee cap of twice the base fee
plus tip), and, with `--deployer`, that account's balance and the address the specifier will have if the deployment is its
next transaction. It writes `plan.json`, `plan.txt` and
the creation code to `plans/<timestamp>/`. With `--check-resolvers` it first downloads every `https:` resolver
through the harness's `fetchAndVerifyBundle` and reports whether each one serves the pinned bytes; `kps:` entries are
checked from a browser harness or a KPS QUIC client.

The planner has no broadcast mode: it never signs and never sends to the target chain. Deploying is one creation
transaction signed by the deployer's own wallet, for example
`cast send --rpc-url "$MAINNET_RPC_URL" --ledger --from <deployer> --gas-limit <planned limit> --create "$(cat <file>)"`,
as the plan prints it. A fork URL that carries an API key reaches anvil through `ETH_RPC_URL`, never its command
line.

### Funding the deploying account

A transaction costs its gas used x (base fee + tip), but a node accepts it only if the sender already holds its gas
limit x fee cap. The printed command pins the gas limit (estimate + 20%) and leaves fees to cast, which signs a fee
cap of twice the current base fee plus the tip. So fund the deploying account with the "hold" amount for the base
fee you expect on signing day; the unspent part stays in the account. The report gives both figures at today's fees
and at base fees of 1, 4 and 20 gwei (`scenarioBaseFeesGwei` in `DEFAULT_PLAN_SETTINGS`).

Deployment gas grows with the resolver list, by about 930 gas per byte of resolver strings. Measured on a mainnet
fork at block 26,115,996 (2026-10-04, base fee 0.0715 gwei, tip 0.0219 gwei) with three `https:` and three `kps:`
resolvers (722 bytes). "Paid" is the cost of the transactions; "hold" is the balance the account needs before
signing, with cast's default fee cap (rounded up):

| Sequence | Gas used | Gas limit | Paid at that block | Base fee 4 gwei: paid / hold | Base fee 20 gwei: paid / hold |
|---|---|---|---|---|---|
| `ImmutableWorkerSpecifier` deploy | 1,032,360 | 1,238,832 | 0.000096 ETH | 0.00415 / 0.00994 ETH | 0.0207 / 0.0496 ETH |
| `WorkerSpecifier` deploy | 1,671,891 | 2,006,269 | 0.000156 ETH | 0.00672 / 0.0161 ETH | 0.0335 / 0.0803 ETH |
| `WorkerSpecifier` deploy + `renounceOwnership` | 1,695,252 | 2,040,062 | 0.000158 ETH | 0.00682 / 0.0164 ETH | 0.0339 / 0.0817 ETH |

For a sequence, "hold" adds up each transaction's gas limit x fee cap, which is enough to send them one after
another.

The same planner run with tor-js's first resolver list (two `https:` entries, 119 bytes) gives 1,113,503 gas for
`WorkerSpecifier`, the gas of tor-js's own mainnet deployment.

## Inspecting a deployed specifier

```sh
pnpm --filter @hisoka-io/anon-rpc-specifier inspect -- --known            # passthrough, tor-js, Nym PoC
pnpm --filter @hisoka-io/anon-rpc-specifier inspect -- 0x… [--fetch] [--json]
```

Read-only: shows what a harness reads, which contract the runtime code is, the owner and update policy, the
state-changing opcodes present, and the resolver checks. `--fetch` also downloads every `https:` resolver through the
harness and compares it with `workerHash()`.

## License

Apache-2.0, except `src/WorkerSpecifier.sol`, `test/WorkerSpecifier.t.sol` and `src/IWorkerSpecifier.sol`, which
come from ethereum/anon-rpc under the MIT License. See [NOTICE](./NOTICE).
