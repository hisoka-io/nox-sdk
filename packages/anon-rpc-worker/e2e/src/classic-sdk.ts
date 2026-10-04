// Loader for the classic @hisoka-io/nox-client build (HTTP(S) transport, seed
// topology), used by the classic-path regression test. The SDK is imported
// from its built ESM entry at run time, so this package typechecks without
// compiling the SDK sources under its own compiler options; the interface
// below lists only what the test calls.

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { TestbedError } from "./errors.js";

export interface ClassicClient {
  sendEcho(data: Uint8Array): Promise<Uint8Array>;
  httpRequest(
    method: string,
    url: string,
    headers: [string, string][],
    body: Uint8Array,
    opts?: { timeoutMs?: number; expectedResponseBytes?: number },
  ): Promise<Uint8Array>;
  disconnect(): void;
}

export interface ClassicConnectOptions {
  readonly seeds: string[];
  readonly timeoutMs: number;
  readonly powDifficulty: number;
  readonly surbsPerRequest: number;
  readonly dangerouslySkipFingerprintCheck: boolean;
}

export interface ClassicTopology {
  readonly fingerprint: string;
}

export interface ClassicSdk {
  readonly NoxClient: { connect(options: ClassicConnectOptions): Promise<ClassicClient> };
  fetchTopology(seedBaseUrl: string, timeoutMs?: number): Promise<ClassicTopology>;
  /** Throws when the served node list does not hash to the served fingerprint. */
  verifySelfConsistency(snapshot: ClassicTopology): void;
}

export async function loadClassicSdk(entry: string): Promise<ClassicSdk> {
  if (!existsSync(entry)) {
    throw new TestbedError(
      "prerequisite",
      `${entry} not found: build the SDK first (in nox-sdk: pnpm --filter @hisoka-io/nox-wasm build:node && ` +
        "pnpm --filter @hisoka-io/nox-client build) or set NOX_CLIENT_ENTRY",
    );
  }
  const module = (await import(pathToFileURL(entry).href)) as Partial<ClassicSdk>;
  if (
    typeof module.NoxClient?.connect !== "function" ||
    typeof module.fetchTopology !== "function" ||
    typeof module.verifySelfConsistency !== "function"
  ) {
    throw new TestbedError(
      "prerequisite",
      `${entry} does not export NoxClient.connect, fetchTopology and verifySelfConsistency`,
    );
  }
  return module as ClassicSdk;
}

/** A local mesh publishes an all-zero topology fingerprint (no registry behind it). */
export function isZeroFingerprint(fingerprint: string): boolean {
  return /^(?:0x)?0+$/u.test(fingerprint);
}
