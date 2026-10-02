/**
 * Seed bootstrap resolution.
 *
 * A seed is any base URL that serves `GET {seed}/topology`: the indexer seed
 * API or a node ingress URL. The client itself tries each seed in order and
 * keeps the first one whose topology verifies (see `NoxClient.connect`); this
 * helper only probes reachability.
 */

import type { NoxFetch } from "./types.js";
import { defaultFetch } from "./rpc.js";

/** The Hisoka testnet seed API. */
export const DEFAULT_SEED = "https://api.hisoka.io/seed";

/** Strip a trailing `/topology` (and slashes) so seeds compare by base URL. */
export function seedBaseUrl(seed: string): string {
  const trimmed = seed.replace(/\/+$/u, "");
  return trimmed.endsWith("/topology")
    ? trimmed.slice(0, -"/topology".length)
    : trimmed;
}

/** Seed base URLs in try order, without duplicates. */
export function seedCandidates(
  userSeeds: readonly string[],
  includeDefault = true,
): string[] {
  const candidates = userSeeds.map(seedBaseUrl);
  if (includeDefault) candidates.push(DEFAULT_SEED);
  return Array.from(new Set(candidates));
}

/**
 * Resolve a reachable seed URL.
 *
 * @param userSeeds - Optional user-provided seed URLs (tried first, before the default seed).
 * @param timeoutMs - Per-seed request timeout in milliseconds.
 * @param fetchImpl - HTTP client. Defaults to the global `fetch`.
 * @returns The first seed base URL that responded, or `null` if all failed.
 */
export async function resolveSeedUrl(
  userSeeds: string[] = [],
  timeoutMs = 5_000,
  fetchImpl: NoxFetch = defaultFetch,
): Promise<string | null> {
  for (const seed of seedCandidates(userSeeds)) {
    const url = `${seed}/topology`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(url, { signal: controller.signal });
      if (resp.ok) return seed;
    } catch {
      // Timeout or network error: try the next seed.
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}
