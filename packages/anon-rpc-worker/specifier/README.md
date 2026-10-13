# Worker specifier

The on-chain half of the Nox anon-rpc worker: a specifier contract pins the worker bundle by its keccak256 hash and
lists where to fetch it ([anon-rpc SPEC §4](https://github.com/ethereum/anon-rpc/blob/main/SPEC.md#4-worker-identity-and-integrity)).
A wallet's harness reads two views, `workerHash()` and `workerResolvers()`, fetches the bytes from a resolver and runs
them only if their keccak256 equals the pinned hash.

This package holds two specifier contracts, tests that read them through the reference harness's own code, read-only
tools for planning and checking a deployment, and a dry-run-first tool for the `setWorker` update.

**The address to pin:** [`0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A`](https://sepolia.etherscan.io/address/0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A)
on Ethereum Sepolia. It follows the current worker release, so a wallet or a listing that pins it picks up each new
Nox worker with nothing to change on its side. See [Deployments](#deployments) for its trust model and for the
per-release immutable addresses.

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

### Stable address (follows the current release)

| | |
|---|---|
| Specifier | [`0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A`](https://sepolia.etherscan.io/address/0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A), Ethereum Sepolia (11155111) |
| Contract | `WorkerSpecifier`, the reference contract of ethereum/anon-rpc, unmodified; runtime codehash `0xc4c54384a9c1f1201ef3711a7ed7ba20e078a432e85ecc4f8b14927587cc7b5f`, the codehash of the reference deployments on Ethereum mainnet; source verified on Sourcify (exact match, creation and runtime) |
| Deployment | tx [`0x2300d269…556f32`](https://sepolia.etherscan.io/tx/0x2300d269aa45043212ccba045407e0b806db211e48235904193597db29556f32), block 11,906,012 (2026-10-13), 9,678,303 gas |
| Owner | [`0xb18ddF10a9F6a0b9143d05B294815a83d3fa69C5`](https://sepolia.etherscan.io/address/0xb18ddF10a9F6a0b9143d05B294815a83d3fa69C5) |
| Publishes today | `@hisoka-io/anon-rpc-worker` 0.4.0, `workerHash` `0xd8bef626ec8511d7a468bca5137880680ca2da20d2ea4d9c981a2a3d0c86ba1e`, with the same six resolvers in the same order as the 0.4.0 immutable specifier below |

Trust model. The owner can repoint this address at any worker bundle and resolver list with `setWorker`, hand
ownership on with `transferOwnership`, and freeze the current contents for good with `renounceOwnership`. A wallet
that pins this address therefore runs the worker the owner last published: the owner key is part of that wallet's
supply chain. Today the owner is a single testnet key held by the Hisoka team, the account that deployed every
specifier on this page, and an update reaches a wallet on its next boot. Planned ahead of mainnet: ownership moves
to a multisig behind a delay, so each update is visible on chain for a set time before wallets load it; a transfer
of ownership keeps the address. Every update emits `WorkerUpdated(bytes32,string[])`, and `owner()` names who can
make the next one.

Wallets that want the current release use the stable address. A wallet that prefers to review each release itself
pins an immutable per-release address from the next table: its contents are fixed at deployment, and it keeps
publishing the same worker for good.

### Per-release pins (immutable)

| Worker | Chain | Specifier | Contract | Deployment |
|---|---|---|---|---|
| `@hisoka-io/anon-rpc-worker` 0.4.0, `workerHash` `0xd8bef626ec8511d7a468bca5137880680ca2da20d2ea4d9c981a2a3d0c86ba1e` | Ethereum Sepolia (11155111) | [`0xDf5Db854BA75B52a4bF1a250a93D8d25cB982b2d`](https://sepolia.etherscan.io/address/0xDf5Db854BA75B52a4bF1a250a93D8d25cB982b2d) | `ImmutableWorkerSpecifier`, source verified on Sourcify (exact match) | tx [`0xb645b0b8…a7e707`](https://sepolia.etherscan.io/tx/0xb645b0b8b1af1d99212f9345eaeac6c3f791c0afae55c2330433e2caa4a7e707), block 11,883,337, 5,188,850 gas |
| `@hisoka-io/anon-rpc-worker` 0.3.0, `workerHash` `0x24604525d220bcc7e39f2dbc22966a814600a63ada51baafad5dd0bcc1d28549` | Ethereum Sepolia (11155111) | [`0x29B51ca9Ad80E9c0B0D111C8748E6a7908b82eDB`](https://sepolia.etherscan.io/address/0x29B51ca9Ad80E9c0B0D111C8748E6a7908b82eDB) | `ImmutableWorkerSpecifier`, source verified on Sourcify (exact match) | tx [`0x48b8cced…24a97d`](https://sepolia.etherscan.io/tx/0x48b8cced35edfcfc7d69769d3aed130412d27525029bd48aa4e37dcd7e24a97d), block 11,855,976, 1,032,240 gas |
| `@hisoka-io/anon-rpc-worker` 0.2.0, `workerHash` `0x0a58f9915f686950072a4786249d396ecbf2194a39ac835effe8ea1a7c76f324` | Ethereum Sepolia (11155111) | [`0x29b4a6A8Cc11769531854d87f9F33EC63Efe8fe6`](https://sepolia.etherscan.io/address/0x29b4a6A8Cc11769531854d87f9F33EC63Efe8fe6) | `ImmutableWorkerSpecifier`, source verified on Sourcify (exact match) | tx [`0x5e5c7cb6…aa30e`](https://sepolia.etherscan.io/tx/0x5e5c7cb6ef38efc6ad5a0683f31036558ca7c8893f80bb1b0e0e985fd17aa30e), block 11,852,795, 1,032,240 gas |

Each of these is immutable: it publishes one worker version for good, and each new version gets its own immutable
specifier next to the update of the stable address. The 0.4.0 resolvers, in order (https first, then `kps:`), which
the stable address publishes too:

1. `https://raw.githubusercontent.com/hisoka-io/anon-rpc/keccak/d8/bef6…ba1e` (orphan `keccak` branch)
2. `https://cdn.jsdelivr.net/npm/@hisoka-io/anon-rpc-worker@0.4.0/dist/anon-rpc-worker.js`
3. `https://unpkg.com/@hisoka-io/anon-rpc-worker@0.4.0/dist/anon-rpc-worker.js`
4. `kps:100.56.0.72:15005:uEiBVDwIs40bsslDkM-BYb2AOHw3PHe70_bj5U_09r7vdIQ/keccak/d8/bef6…ba1e` (nox-1)
5. `kps:3.232.137.146:15005:uEiDGVPDwsQ96ri9T5WLR6jZov_9LW-gRAgs-DN9FyKuHuw/keccak/d8/bef6…ba1e` (nox-2)
6. `kps:18.215.18.61:15005:uEiCStd3rfGTo0ts0lSUw5f22u93O3PLCZVWWQIv_MXHm7w/keccak/d8/bef6…ba1e` (nox-8)

The three `https:` entries served the exact bytes (keccak256 = `workerHash`) through the harness's
`fetchAndVerifyBundle` right after the deployment
(`pnpm inspect -- --rpc-url <sepolia rpc> 0xDf5Db854BA75B52a4bF1a250a93D8d25cB982b2d --fetch`), and the three `kps:`
entries served the same 1,820,668 bytes to a KPS QUIC client. The 0.3.0 specifier lists the same six kinds of entry
for 0.3.0; the 0.2.0 specifier lists `kps:` first, then the three kinds of `https:` entry for 0.2.0.

Gas on Ethereum Sepolia: the 0.4.0 deployment used 5,188,850 gas (live `eth_estimateGas` 5,231,199), where the
0.3.0 deployment of the same contract used 1,032,240 on 2026-10-06. Sepolia's current gas schedule prices contract
creation higher than the planner's anvil fork (Foundry 1.3.2) models, so take the gas limit for a deployment from
`eth_estimateGas` on the target chain itself, plus 20%. The stable `WorkerSpecifier` used 9,678,303 gas on
2026-10-13 (live `eth_estimateGas` 9,756,282; the planner's fork measured 1,671,783). The `setWorker` tool below
reads its estimate from the target chain.

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
- `itest/set-worker.test.ts`: plans a `setWorker` update against a local chain and checks that planning sends
  nothing, that the printed `cast` command performs exactly the planned update, that a wrong sender, a wrong key, a
  frozen or immutable specifier, a stale plan and an unserved bundle are each refused before anything is signed, and
  that the broadcast path updates the specifier and reads it back through the harness.
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

### Resolver order for each release

Harnesses try resolvers in list order, so the first entry that answers sets boot time. The planner publishes
`https:` resolvers first by default (`--resolver-order https-first`, a stable reorder: entries of one kind keep the
order you gave), then `kps:` resolvers, which stay as the censorship-resistant fallback when every `https:` host is
blocked. The resolver check warns when a `kps:` entry comes before an `https:` one, and the reference variant's
planned `setWorker` uses the same order. `--resolver-order as-given` publishes the list exactly as passed.

Measured from India on 2026-10-06 against the 0.2.0 specifier (`kps:` first): ready after 26.5-45.1 s, of which
14-37 s was the ~0.9 MB bundle over one WebRTC data channel; with an `https:` resolver first, ready after
7.8-8.5 s. With worker 0.4.0 (1,820,668 bytes, 649,310 with gzip) and `https:` resolvers first, the anon-rpc
reference bench of 2026-10-10 measured a cold boot of 1.3-1.7 s from the US and 2.7-3.2 s from India (four boots
each). Each release's resolvers, in the order the planner writes them:

1. `https://raw.githubusercontent.com/hisoka-io/anon-rpc/keccak/<hh>/<rest>`
2. `https://cdn.jsdelivr.net/npm/@hisoka-io/anon-rpc-worker@<version>/dist/anon-rpc-worker.js`
3. `https://unpkg.com/@hisoka-io/anon-rpc-worker@<version>/dist/anon-rpc-worker.js`
4. `kps:<nox-1 address>/keccak/<hh>/<rest>`, then nox-2 and nox-8 the same way

A release reaches the stable address as one `setWorker` call with the same list in the same order
(see [Updating the stable address](#updating-the-stable-address-setworker)).

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

## Updating the stable address (`setWorker`)

A worker release ends with one transaction from the owner: `setWorker(newHash, newResolvers)` on the stable address.
Wallets and listings that pin it then read the new worker on their next boot. The release order:

1. Publish the bundle everywhere the new resolver list points: the npm package (jsDelivr and unpkg serve it), the
   `keccak` branch of `hisoka-io/anon-rpc`, and the KPS nodes.
2. Deploy the release's `ImmutableWorkerSpecifier` (see [Planning a deployment](#planning-a-deployment-dry-run)) and
   boot a wallet harness against it. This is the per-release pin, and the test of the exact hash and resolver list.
3. Plan the update of the stable address with the same hash and resolver list, and read the printed transaction:

   ```sh
   pnpm --filter @hisoka-io/anon-rpc-specifier set-worker -- \
     --specifier 0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A --chain-id 11155111 \
     --rpc-url https://ethereum-sepolia-rpc.publicnode.com \
     --bundle path/to/anon-rpc-worker.js \
     --resolver "https://raw.githubusercontent.com/hisoka-io/anon-rpc/keccak/<hh>/<rest>" \
     --resolver "https://cdn.jsdelivr.net/npm/@hisoka-io/anon-rpc-worker@<version>/dist/anon-rpc-worker.js" \
     --resolver "https://unpkg.com/@hisoka-io/anon-rpc-worker@<version>/dist/anon-rpc-worker.js" \
     --resolver "kps:<ip>:<udp-port>:<certhash>/keccak/<hh>/<rest>"
   ```

4. Send it: sign the printed `cast send` command with the owner's wallet, or run the same command again with
   `--broadcast --key-file <file>`.
5. Confirm what wallets read: `pnpm --filter @hisoka-io/anon-rpc-specifier inspect -- --rpc-url <rpc> 0x3513…7A9A --fetch`,
   then boot a harness against the stable address.

The tool is a dry run by default. It reads the specifier through the harness, checks that it is the owner-updatable
contract and who its owner is, checks every new resolver entry (a content-addressed path must name the new hash),
downloads each `https:` resolver through the harness's `fetchAndVerifyBundle` and compares it with the new hash,
simulates the call as the owner with `eth_call` and takes the gas limit from `eth_estimateGas` on the target chain
plus 20%. It prints the transaction (`from`, `to`, calldata, gas limit) and the signer command, and signs nothing.

`--broadcast` is the one mode that signs and sends. It needs `--chain-id` and `--key-file` (a file holding the
owner's key; the key is read in-process and never printed). Before signing it checks the chain id of the sending
RPC, that the key is the owner's, that the owner has no pending transaction and that the specifier still holds what
the plan read, and it sends only when every `https:` resolver served the new bytes in this run's download check.
`--skip-resolver-fetch` belongs to dry runs: the tool refuses it together with `--broadcast`. After the transaction
it reads the specifier back through the harness and compares it with the plan. When the owner is a contract such as a Safe, the tool prints `to`, `value` and
calldata for that contract's own transaction flow.

The same command repairs a resolver list for the current worker: give the current hash and the new list. To return
to an earlier release, give that release's hash and resolvers.

## Inspecting a deployed specifier

```sh
pnpm --filter @hisoka-io/anon-rpc-specifier inspect -- --known            # passthrough, tor-js, Nym PoC
pnpm --filter @hisoka-io/anon-rpc-specifier inspect -- 0x… [--fetch] [--json]
pnpm --filter @hisoka-io/anon-rpc-specifier inspect -- \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com 0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A --fetch   # the Nox stable address
```

Read-only: shows what a harness reads, which contract the runtime code is, the owner and update policy, the
state-changing opcodes present, and the resolver checks. `--fetch` also downloads every `https:` resolver through the
harness and compares it with `workerHash()`.

## License

Apache-2.0, except `src/WorkerSpecifier.sol`, `test/WorkerSpecifier.t.sol` and `src/IWorkerSpecifier.sol`, which
come from ethereum/anon-rpc under the MIT License. See [NOTICE](./NOTICE).
