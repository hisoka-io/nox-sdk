// Forge build artifacts for the two specifier contracts.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expectHex } from "./rpc.ts";

export const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

export type Variant = "reference" | "immutable";

export const VARIANTS: readonly Variant[] = ["immutable", "reference"];

export const CONTRACTS: Readonly<Record<Variant, { source: string; name: string }>> = {
  reference: { source: "WorkerSpecifier.sol", name: "WorkerSpecifier" },
  immutable: { source: "ImmutableWorkerSpecifier.sol", name: "ImmutableWorkerSpecifier" },
};

export { MAINNET_REFERENCE_CODEHASH } from "./constants.ts";

export type CodeRange = { start: number; length: number };

export type Artifact = {
  variant: Variant;
  contract: string;
  /** Creation code without constructor arguments. */
  bytecode: `0x${string}`;
  /** Runtime code with zeroed immutable slots (filled in at deployment). */
  deployedBytecode: `0x${string}`;
  /** Byte ranges of immutables inside deployedBytecode. */
  immutableRanges: CodeRange[];
};

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function field(value: unknown, key: string, where: string): unknown {
  if (!isRecord(value) || !(key in value)) throw new ArtifactError(`${where}: missing "${key}"`);
  return value[key];
}

export async function loadArtifact(variant: Variant, root: string = PROJECT_ROOT): Promise<Artifact> {
  const { source, name } = CONTRACTS[variant];
  const path = `${root}/out/${source}/${name}.json`;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ArtifactError(`no build artifact at ${path}; run \`forge build\` in ${root} first`);
  }
  const json: unknown = JSON.parse(text);
  const bytecode = expectHex(field(field(json, "bytecode", path), "object", `${path} bytecode`), `${path} bytecode`);
  const deployed = field(json, "deployedBytecode", path);
  const deployedBytecode = expectHex(field(deployed, "object", `${path} deployedBytecode`), `${path} deployedBytecode`);
  const refs = isRecord(deployed) ? deployed["immutableReferences"] : undefined;
  const immutableRanges: CodeRange[] = [];
  if (isRecord(refs)) {
    for (const ranges of Object.values(refs)) {
      if (!Array.isArray(ranges)) throw new ArtifactError(`${path}: malformed immutableReferences`);
      for (const r of ranges) {
        const start = field(r, "start", path);
        const length = field(r, "length", path);
        if (typeof start !== "number" || typeof length !== "number") {
          throw new ArtifactError(`${path}: malformed immutable range ${JSON.stringify(r)}`);
        }
        immutableRanges.push({ start, length });
      }
    }
  }
  if (bytecode.length <= 2) throw new ArtifactError(`${path}: empty creation code (abstract contract?)`);
  return { variant, contract: name, bytecode, deployedBytecode, immutableRanges };
}

/** Runs `forge build` so artifacts always match the sources on disk. */
export function forgeBuild(root: string = PROJECT_ROOT): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("forge", ["build"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (b: Buffer) => (output += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (output += b.toString("utf8")));
    child.once("error", (e) => reject(new ArtifactError(`cannot run forge (is Foundry installed?): ${e.message}`)));
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new ArtifactError(`forge build failed in ${root} (exit ${code}):\n${output}`)),
    );
  });
}
