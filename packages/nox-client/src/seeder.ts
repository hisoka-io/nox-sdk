/**
 * Seed node bootstrap resolution.
 *
 * Tries user-provided seeds first, then falls back to the default seed API.
 * Returns the URL of the first seed that responds successfully.
 */

const DNS_SEED = "https://api.hisoka.io/seed";

const HARDCODED_SEEDS: readonly string[] = [
  "https://entry1.nox.hisoka.io",
  "https://entry2.nox.hisoka.io",
  "https://entry3.nox.hisoka.io",
];

/**
 * Resolve a working seed node URL.
 *
 * @param userSeeds - Optional user-provided seed URLs (tried first, before DNS seed).
 * @param timeoutMs - Per-seed request timeout in milliseconds.
 * @returns The first seed URL that responded, or `null` if all failed.
 */
export async function resolveSeedUrl(
  userSeeds: string[] = [],
  timeoutMs = 5_000,
): Promise<string | null> {
  const candidates = [...userSeeds, DNS_SEED, ...HARDCODED_SEEDS];

  for (const seed of candidates) {
    const url = seed.endsWith("/topology") ? seed : `${seed}/topology`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (resp.ok) {
        // Base URL without the /topology suffix
        return seed.endsWith("/topology") ? seed.slice(0, -"/topology".length) : seed;
      }
    } catch {
      // Timeout or network error — try next seed
    }
  }

  return null;
}
