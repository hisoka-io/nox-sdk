// Read-only inspection of deployed worker specifiers: what a wallet's harness reads (through the harness's own
// code), which contract the runtime code is, who can change it, and the resolver checks.
//
//   pnpm inspect -- [--rpc-url <read-only RPC>] [--json] (--known | <address> [<address> …])
//
// --known inspects the specifiers the anon-rpc ecosystem has on Ethereum mainnet (passthrough, tor-js, Nym PoC).
// --fetch also downloads every https: resolver through the harness and checks it against workerHash().

import { parseArgs } from "node:util";
import { forgeBuild, loadArtifact } from "../tools/artifacts.ts";
import { DEFAULT_MAINNET_RPC_URL, KNOWN_MAINNET_SPECIFIERS } from "../tools/constants.ts";
import { checkAvailability, type AvailabilityResult } from "../tools/availability.ts";
import { MAX_BUNDLE_BYTES } from "../tools/harness.ts";
import { renderAvailability, renderInspection, toJson } from "../tools/report.ts";
import { DEFAULT_RPC_OPTIONS, readOnlyRpc } from "../tools/rpc.ts";
import { inspectSpecifier, type SpecifierInspection } from "../tools/specifier.ts";

const USAGE =
  "usage: pnpm inspect -- [--rpc-url <read-only RPC>] [--fetch] [--json] (--known | <address> [<address> …])";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    // pnpm and vite-node each forward their own "--" separator; neither is an argument of this script.
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      "rpc-url": { type: "string" },
      known: { type: "boolean", default: false },
      fetch: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const targets = [
    ...(values.known ? KNOWN_MAINNET_SPECIFIERS.map((k) => ({ label: k.label, address: k.address })) : []),
    ...positionals.map((address) => ({ label: "", address })),
  ];
  if (targets.length === 0) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  await forgeBuild();
  const artifacts = { reference: await loadArtifact("reference"), immutable: await loadArtifact("immutable") };
  const rpc = readOnlyRpc(
    values["rpc-url"] ?? process.env["MAINNET_RPC_URL"] ?? DEFAULT_MAINNET_RPC_URL,
    DEFAULT_RPC_OPTIONS,
  );

  const results: (SpecifierInspection & { label: string; availability: AvailabilityResult[] | null })[] = [];
  for (const target of targets) {
    const inspection = await inspectSpecifier(rpc, target.address, artifacts);
    const availability = values.fetch
      ? await checkAvailability(inspection.workerHash, inspection.resolvers, { maxBytes: MAX_BUNDLE_BYTES })
      : null;
    results.push({ label: target.label, ...inspection, availability });
    if (!values.json) {
      const lines = [renderInspection(inspection), ...(availability === null ? [] : renderAvailability(availability))];
      console.log(`${target.label === "" ? "" : `${target.label}: `}${lines.join("\n  ")}\n`);
    }
  }
  if (values.json) console.log(toJson(results));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exitCode = 1;
});
