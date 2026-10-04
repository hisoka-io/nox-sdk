// Upstream chain content for the worker's JSON-RPC matrix: an E2eLogEmitter
// (contracts/E2eLogEmitter.sol) with a few small Ping logs and Blob logs large
// enough that one eth_getLogs reply is about 1 MB of JSON.

import { encodeCall } from "./abi.js";
import { deployContract, loadArtifact, sendTransaction } from "./tx.js";

export interface LogFixture {
  readonly emitter: string;
  /** Inclusive block range holding the Ping logs. */
  readonly pings: { readonly fromBlock: number; readonly toBlock: number; readonly count: number };
  /** Inclusive block range holding the Blob logs. */
  readonly blobs: { readonly fromBlock: number; readonly toBlock: number; readonly count: number; readonly size: number };
}

export interface LogFixtureOptions {
  readonly pings: number;
  /** Blob logs per transaction and transactions. */
  readonly blobsPerTx: number;
  readonly blobTxs: number;
  readonly blobBytes: number;
}

/** 4 Ping logs; 2 x 4 Blob logs of 64 KiB = 512 KiB of log data, ~1.05 MB as JSON hex. */
export const DEFAULT_LOG_FIXTURE: LogFixtureOptions = { pings: 4, blobsPerTx: 4, blobTxs: 2, blobBytes: 65_536 };

/** Gas for one emitBlobs transaction (anvil's default block gas limit is 30M). */
const BLOB_TX_GAS = "0x1c9c380";

export async function deployLogFixture(
  rpcUrl: string,
  from: string,
  options: LogFixtureOptions = DEFAULT_LOG_FIXTURE,
): Promise<LogFixture> {
  const emitter = await deployContract(rpcUrl, from, loadArtifact("E2eLogEmitter"));
  let pingFrom = Number.POSITIVE_INFINITY;
  let pingTo = 0;
  for (let i = 0; i < options.pings; i++) {
    const receipt = await sendTransaction(
      rpcUrl,
      { from, to: emitter, data: encodeCall("ping(uint256)", [{ type: "uint", value: 1_000 + i }]) },
      `ping(${1_000 + i})`,
    );
    pingFrom = Math.min(pingFrom, receipt.blockNumber);
    pingTo = Math.max(pingTo, receipt.blockNumber);
  }
  let blobFrom = Number.POSITIVE_INFINITY;
  let blobTo = 0;
  for (let i = 0; i < options.blobTxs; i++) {
    const receipt = await sendTransaction(
      rpcUrl,
      {
        from,
        to: emitter,
        gas: BLOB_TX_GAS,
        data: encodeCall("emitBlobs(uint256,uint256)", [
          { type: "uint", value: options.blobsPerTx },
          { type: "uint", value: options.blobBytes },
        ]),
      },
      `emitBlobs(${options.blobsPerTx}, ${options.blobBytes})`,
    );
    blobFrom = Math.min(blobFrom, receipt.blockNumber);
    blobTo = Math.max(blobTo, receipt.blockNumber);
  }
  return {
    emitter,
    pings: { fromBlock: pingFrom, toBlock: pingTo, count: options.pings },
    blobs: { fromBlock: blobFrom, toBlock: blobTo, count: options.blobsPerTx * options.blobTxs, size: options.blobBytes },
  };
}
