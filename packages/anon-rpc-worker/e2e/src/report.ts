// Measurement reports: one JSON file per probe in the run directory, plus a
// copy at .run/reports/<name>.json so the latest numbers are easy to find.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestbedConfig } from "./config.js";
import type { RunPaths } from "./testbed.js";

export interface Environment {
  readonly node: string;
  readonly platform: string;
  readonly kernel: string;
  readonly browser?: string;
}

export function writeReport(config: TestbedConfig, paths: RunPaths, name: string, data: unknown): string {
  const body = `${JSON.stringify({ name, writtenAt: new Date().toISOString(), data }, null, 2)}\n`;
  const path = join(paths.reports, `${name}.json`);
  writeFileSync(path, body);
  const latestDir = join(config.runDir, "reports");
  mkdirSync(latestDir, { recursive: true });
  writeFileSync(join(latestDir, `${name}.json`), body);
  return path;
}

/** Nearest-rank percentile (the method the anon-rpc bench uses). */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export interface LatencySummary {
  readonly n: number;
  readonly min: number | undefined;
  readonly p50: number | undefined;
  readonly p95: number | undefined;
  readonly max: number | undefined;
}

/** n, min, nearest-rank p50 and p95, max of a sample. */
export function summarize(values: readonly number[]): LatencySummary {
  return {
    n: values.length,
    min: values.length === 0 ? undefined : Math.min(...values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length === 0 ? undefined : Math.max(...values),
  };
}
