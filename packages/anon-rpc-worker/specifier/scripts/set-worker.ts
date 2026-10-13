// Repoint an owner-updatable WorkerSpecifier at a new worker release with setWorker(hash, resolvers).
//
//   pnpm set-worker -- --specifier 0x… --rpc-url <RPC of the specifier's chain> \
//     (--hash 0x… | --bundle <file>) --resolver <entry> [--resolver <entry> …] [--resolvers-file <json array>]
//     [--resolver-order https-first|as-given] [--chain-id <n>] [--from 0x…] [--skip-resolver-fetch] [--json]
//     [--broadcast --key-file <file>]
//
// Dry run by default: it reads the specifier, checks the new resolver list, downloads every https: resolver through
// the harness and compares it with the new hash, simulates the call as the owner on the target chain, and prints the
// transaction. Nothing is signed or sent unless --broadcast is given together with --chain-id and --key-file.

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { keccak256 } from "ethers";
import { forgeBuild, loadArtifact } from "../tools/artifacts.ts";
import { checkAvailability, type AvailabilityResult } from "../tools/availability.ts";
import { MAX_BUNDLE_BYTES } from "../tools/harness.ts";
import { DEFAULT_PLAN_SETTINGS } from "../tools/plan.ts";
import { formatEth, toJson } from "../tools/report.ts";
import { DEFAULT_RESOLVER_ORDER, DEFAULT_RESOLVER_POLICY, orderResolvers, type ResolverOrder } from "../tools/resolvers.ts";
import { readOnlyRpc } from "../tools/rpc.ts";
import { broadcastSetWorker, castSetWorkerArgs, planSetWorker, renderUpdatePlan } from "../tools/update.ts";

const USAGE = `usage: pnpm set-worker -- --specifier 0x… --rpc-url <RPC> (--hash 0x… | --bundle <file>)
                          --resolver <entry> [--resolver <entry> …] [--resolvers-file <json array>]
                          [--resolver-order https-first|as-given] [--chain-id <n>] [--from 0x…]
                          [--skip-resolver-fetch] [--allow-unknown-kinds] [--json]
                          [--broadcast --key-file <file>]
Dry run by default: prints the setWorker transaction; nothing is signed or sent.
--broadcast signs with the owner key in --key-file and sends; it needs --chain-id.`;

/** Blocks waited for after the transaction is mined before the read-back. */
const BROADCAST_CONFIRMATIONS = 2;
const BROADCAST_TIMEOUT_MS = 600_000;

class UsageError extends Error {}

async function main(): Promise<void> {
  const { values } = parseArgs({
    // pnpm and vite-node each forward their own "--" separator; neither is an argument of this script.
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      specifier: { type: "string" },
      "rpc-url": { type: "string" },
      hash: { type: "string" },
      bundle: { type: "string" },
      resolver: { type: "string", multiple: true },
      "resolvers-file": { type: "string" },
      "resolver-order": { type: "string", default: DEFAULT_RESOLVER_ORDER },
      "chain-id": { type: "string" },
      from: { type: "string" },
      "skip-resolver-fetch": { type: "boolean", default: false },
      "allow-unknown-kinds": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      broadcast: { type: "boolean", default: false },
      "key-file": { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.specifier === undefined) throw new UsageError("give --specifier");
  const rpcUrl = values["rpc-url"];
  if (rpcUrl === undefined) throw new UsageError("give --rpc-url (the chain the specifier lives on)");
  if (values["chain-id"] !== undefined && !/^\d+$/.test(values["chain-id"])) {
    throw new UsageError(`--chain-id must be a decimal chain id (got ${values["chain-id"]})`);
  }
  const expectedChainId = values["chain-id"] === undefined ? undefined : BigInt(values["chain-id"]);
  if (values.broadcast && expectedChainId === undefined) {
    throw new UsageError("--broadcast needs --chain-id, so a wrong RPC URL cannot send to another chain");
  }
  if (values.broadcast && values["key-file"] === undefined) {
    throw new UsageError("--broadcast needs --key-file (a file holding the owner's private key as hex)");
  }
  if (!values.broadcast && values["key-file"] !== undefined) {
    throw new UsageError("--key-file is read only with --broadcast");
  }

  let workerHash: string;
  if (values.bundle !== undefined) {
    workerHash = keccak256(await readFile(values.bundle));
    if (values.hash !== undefined && values.hash.toLowerCase() !== workerHash) {
      throw new UsageError(`--hash ${values.hash} does not match keccak256(${values.bundle}) = ${workerHash}`);
    }
  } else if (values.hash !== undefined) {
    workerHash = values.hash;
  } else {
    throw new UsageError("give --hash or --bundle");
  }

  const resolvers = [...(values.resolver ?? [])];
  if (values["resolvers-file"] !== undefined) {
    const parsed: unknown = JSON.parse(await readFile(values["resolvers-file"], "utf8"));
    if (!Array.isArray(parsed) || !parsed.every((r): r is string => typeof r === "string")) {
      throw new UsageError(`${values["resolvers-file"]} must hold a JSON array of strings`);
    }
    resolvers.push(...parsed);
  }
  const order = values["resolver-order"];
  if (order !== "https-first" && order !== "as-given") {
    throw new UsageError(`--resolver-order must be https-first or as-given (got ${order})`);
  }

  await forgeBuild();
  const artifacts = { reference: await loadArtifact("reference"), immutable: await loadArtifact("immutable") };
  const plan = await planSetWorker(
    {
      rpc: readOnlyRpc(rpcUrl, { timeoutMs: DEFAULT_PLAN_SETTINGS.rpcTimeoutMs }),
      specifier: values.specifier,
      workerHash,
      resolvers: orderResolvers(resolvers, order as ResolverOrder),
      ...(expectedChainId === undefined ? {} : { expectedChainId }),
      ...(values.from === undefined ? {} : { from: values.from }),
      resolverPolicy: { ...DEFAULT_RESOLVER_POLICY, allowUnknownKinds: values["allow-unknown-kinds"] },
      settings: DEFAULT_PLAN_SETTINGS,
    },
    artifacts,
  );
  const availability: AvailabilityResult[] | null = values["skip-resolver-fetch"]
    ? null
    : await checkAvailability(plan.next.workerHash, plan.next.resolvers, { maxBytes: MAX_BUNDLE_BYTES });

  if (!values.broadcast) {
    if (values.json) {
      console.log(toJson({ dryRun: true, plan, availability }));
      return;
    }
    console.log("DRY RUN: nothing was signed or sent.\n");
    console.log(renderUpdatePlan(plan, availability));
    if (plan.owner.kind === "eoa") {
      console.log(
        `\nTo send it, the owner signs this one transaction with its own wallet (swap --ledger for --trezor or --account <keystore>):\n  cast ${castSetWorkerArgs('"$RPC_URL"', ["--ledger"], plan).join(" ")}\nor run this command again with --broadcast --chain-id ${plan.chainId} --key-file <file>.`,
      );
    }
    console.log(`\nThen confirm what wallets read:\n  pnpm inspect -- --rpc-url "$RPC_URL" ${plan.specifier} --fetch`);
    return;
  }

  const keyFile = values["key-file"];
  if (keyFile === undefined) throw new UsageError("--broadcast needs --key-file");
  if (!values.json) {
    console.log(renderUpdatePlan(plan, availability));
    console.log(`\nBROADCAST: signing as ${plan.tx.from} and sending to chain ${plan.chainId}.`);
  }
  const result = await broadcastSetWorker(plan, {
    rpcUrl,
    privateKey: await readFile(keyFile, "utf8"),
    availability,
    confirmations: BROADCAST_CONFIRMATIONS,
    timeoutMs: BROADCAST_TIMEOUT_MS,
  });
  if (values.json) {
    console.log(toJson({ dryRun: false, plan, availability, result }));
    return;
  }
  console.log(
    `sent: tx ${result.txHash} · block ${result.blockNumber} · nonce ${result.nonce} · gas used ${result.gasUsed} · fee ${formatEth(result.fee)}`,
  );
  console.log(`read back through the harness: workerHash ${plan.next.workerHash}, ${plan.next.resolvers.length} resolvers`);
}

main().catch((e: unknown) => {
  if (e instanceof UsageError) {
    console.error(`${e.message}\n\n${USAGE}`);
  } else {
    console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
  process.exitCode = 1;
});
