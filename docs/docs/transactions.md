---
sidebar_position: 3
title: Transactions
---

# Transactions

Send Ethereum transactions through the mixnet. The exit node submits them on your behalf  - it sees the transaction but not who sent it.

## Broadcast a signed transaction

Sign the transaction yourself and broadcast the raw bytes through the mixnet:

```ts
const txHash = await client.broadcastSignedTransaction(signedTx);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `signedTx` | `Uint8Array` | RLP-encoded signed transaction |
| `rpcUrl` | `string?` | Optional target RPC URL |

**Returns:** `Uint8Array`  - typically the transaction hash.

The exit node calls `eth_sendRawTransaction` with your signed bytes. Since you signed it, the exit node can't modify anything.

### With ethers.js

```ts
import { Wallet, parseEther } from "ethers";

const wallet = new Wallet(privateKey);
const signedTx = await wallet.signTransaction({
  to: "0xContractAddress",
  data: "0xCalldata",
  gasLimit: 100_000,
  maxFeePerGas: 30_000_000_000n,
  nonce: 42,
  chainId: 421614,
});

const raw = Uint8Array.from(Buffer.from(signedTx.slice(2), "hex"));
const txHash = await client.broadcastSignedTransaction(raw);
```

### With viem

```ts
import { createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

const account = privateKeyToAccount("0xYourPrivateKey");
const walletClient = createWalletClient({
  account,
  chain: arbitrumSepolia,
  transport: http(),
});

const signedTx = await account.signTransaction({
  to: "0xContractAddress",
  data: "0xCalldata",
  gasLimit: 100_000n,
  maxFeePerGas: 30_000_000_000n,
  nonce: 42,
  chainId: 421614,
});

const raw = Uint8Array.from(Buffer.from(signedTx.slice(2), "hex"));
const txHash = await client.broadcastSignedTransaction(raw);
```

## Broadcast with options

For more control, use `broadcastSignedTransactionWithOptions`:

```ts
const txHash = await client.broadcastSignedTransactionWithOptions(raw, {
  rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
  rpcMethod: "eth_sendRawTransaction",
  expectedResponseBytes: 256,
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `rpcUrl` | `string?` | exit node default | Target RPC endpoint |
| `rpcMethod` | `string?` | `"eth_sendRawTransaction"` | RPC method to call |
| `expectedResponseBytes` | `number?` | auto | Expected response size  - controls SURB allocation |

Use `expectedResponseBytes` when you know the response will be larger than a typical tx hash (e.g., if your RPC returns extra metadata). The SDK uses this to allocate enough SURBs for the response.

## Submit a relay transaction

Let the exit node handle gas and submission:

```ts
const response = await client.submitTransaction(to, data);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `to` | `string` | Contract address (hex, 0x-prefixed) |
| `data` | `Uint8Array` | Encoded calldata |

**Returns:** `Uint8Array`  - raw response bytes from the exit node.

:::warning
With relay transactions, the exit node pays gas and constructs the on-chain transaction. Use this only when you trust the relay node's behavior, or when the target contract validates the original sender separately.
:::

## Which one to use

| Method | Gas payment | Signing | Use when |
|--------|------------|---------|----------|
| `broadcastSignedTransaction` | You pay gas | Your wallet | You need full control |
| `broadcastSignedTransactionWithOptions` | You pay gas | Your wallet | You need custom RPC or response sizing |
| `submitTransaction` | Handled by relay | Exit node | You want simplicity and trust the relay |
