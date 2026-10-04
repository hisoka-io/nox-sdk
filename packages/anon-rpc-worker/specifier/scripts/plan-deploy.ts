// Dry-run deployment plan for a worker specifier on Ethereum mainnet (or any chain behind --rpc-url).
//
//   pnpm plan -- --bundle ../dist/nox-anon-rpc-worker.js \
//     --resolver "kps:<ip>:15005:<certhash>/keccak/<hh>/<rest>" --resolver "https://…" \
//     [--variant immutable|reference|both] [--deployer 0x…] [--new-owner 0x…] [--rpc-url https://…]
//
// Reads fees, the latest block and (with --deployer) the deployer's nonce and balance through a read-only
// client; forks that block into a local anvil; deploys every variant there; reads each fork deployment back
// through the anon-rpc reference harness; prints creation code, gas and the ETH needed. It never signs and never
// sends anything to the target chain: there is no broadcast mode. It prints the signer command instead.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { keccak256 } from "ethers";
import { forgeBuild, loadArtifact, PROJECT_ROOT, type Variant } from "../tools/artifacts.ts";
import { DEFAULT_MAINNET_RPC_URL } from "../tools/constants.ts";
import { creationCode } from "../tools/deployment.ts";
import { DEFAULT_PLAN_SETTINGS, planDeployment } from "../tools/plan.ts";
import { castCreateArgs, renderPlan, toJson } from "../tools/report.ts";
import { DEFAULT_RESOLVER_POLICY } from "../tools/resolvers.ts";

const USAGE = `usage: pnpm plan -- (--hash 0x… | --bundle <file>) --resolver <entry> [--resolver <entry> …]
                    [--resolvers-file <json array>] [--variant immutable|reference|both]
                    [--deployer 0x…] [--new-owner 0x…] [--rpc-url <read-only RPC>] [--out <dir>]
                    [--check-resolvers] [--allow-unknown-kinds] [--json] [--dry-run]
Dry run only: nothing is signed or sent to the target chain.`;

class UsageError extends Error {}

async function main(): Promise<void> {
  const { values } = parseArgs({
    // pnpm and vite-node each forward their own "--" separator; neither is an argument of this script.
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      hash: { type: "string" },
      bundle: { type: "string" },
      resolver: { type: "string", multiple: true },
      "resolvers-file": { type: "string" },
      variant: { type: "string", default: "both" },
      deployer: { type: "string" },
      "new-owner": { type: "string" },
      "rpc-url": { type: "string" },
      out: { type: "string" },
      "allow-unknown-kinds": { type: "boolean", default: false },
      "check-resolvers": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: true },
      broadcast: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.broadcast) {
    throw new UsageError("this tool has no broadcast mode; sign the printed creation transaction with your own wallet");
  }

  let workerHash: string;
  if (values.bundle !== undefined) {
    const bytes = await readFile(values.bundle);
    workerHash = keccak256(bytes);
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

  const variants: Variant[] =
    values.variant === "both"
      ? ["immutable", "reference"]
      : values.variant === "immutable" || values.variant === "reference"
        ? [values.variant]
        : [];
  if (variants.length === 0)
    throw new UsageError(`--variant must be immutable, reference or both (got ${values.variant})`);

  const upstreamUrl = values["rpc-url"] ?? process.env["MAINNET_RPC_URL"] ?? DEFAULT_MAINNET_RPC_URL;

  await forgeBuild();
  const plan = await planDeployment({
    variants,
    workerHash,
    resolvers,
    upstreamUrl,
    ...(values.deployer === undefined ? {} : { deployer: values.deployer }),
    ...(values["new-owner"] === undefined ? {} : { newOwner: values["new-owner"] }),
    resolverPolicy: { ...DEFAULT_RESOLVER_POLICY, allowUnknownKinds: values["allow-unknown-kinds"] },
    checkResolvers: values["check-resolvers"],
    settings: DEFAULT_PLAN_SETTINGS,
  });

  const stamp = plan.generatedAt.replace(/[:.]/g, "-");
  const outDir = resolve(values.out ?? `${PROJECT_ROOT}/plans/${stamp}`);
  await mkdir(outDir, { recursive: true });
  const files: Record<string, string> = {};
  const commands: string[] = [];
  for (const v of plan.variants) {
    const artifact = await loadArtifact(v.variant);
    const code = creationCode(artifact, plan.workerHash, plan.resolvers);
    const file = `${outDir}/${v.variant}.creation-code.hex`;
    await writeFile(file, `${code}\n`);
    files[v.variant] = file;
    const args = castCreateArgs('"$MAINNET_RPC_URL"', ["--ledger"], v.deploy, `"$(cat ${file})"`);
    commands.push(`  # ${v.contract}\n  cast ${args.join(" ")}`);
    commands.push(
      `  # then, with the deployed address:\n  forge verify-contract <address> src/${artifact.contract}.sol:${artifact.contract} --rpc-url "$MAINNET_RPC_URL" --guess-constructor-args --watch --verifier sourcify`,
    );
  }
  await writeFile(`${outDir}/plan.json`, `${toJson(plan)}\n`);
  const text = renderPlan(plan, files);
  await writeFile(`${outDir}/plan.txt`, `${text}\n`);

  if (values.json) {
    console.log(toJson(plan));
    return;
  }
  console.log(text);
  console.log(`\nfiles: ${outDir}/plan.json, plan.txt, <variant>.creation-code.hex`);
  for (const v of plan.variants) {
    console.log(`\n${v.contract} creation code (${v.deploy.dataBytes} bytes, keccak256 ${v.creationCodeKeccak}):`);
    console.log(v.deploy.data);
  }
  console.log(
    `\nTo deploy, the founder signs ONE creation transaction from the deploying account (swap --ledger for --trezor or --account <keystore> as needed). This tool never signs or sends:\n${commands.join("\n")}`,
  );
  console.log(
    `\nThen confirm what wallets will read:\n  pnpm inspect -- --rpc-url "$MAINNET_RPC_URL" <deployed address>`,
  );
}

main().catch((e: unknown) => {
  if (e instanceof UsageError) {
    console.error(`${e.message}\n\n${USAGE}`);
  } else {
    console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
  process.exitCode = 1;
});
