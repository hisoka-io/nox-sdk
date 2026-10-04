// Do the resolvers serve the pinned bytes? Each https: entry is fetched on its own through the reference harness's
// fetchAndVerifyBundle, so "match" means exactly what it means in a wallet. kps: entries need a KPS client (WebRTC
// in browsers, QUIC natively) and Node has neither, so they are reported as not checked here.

import { fetchAndVerifyBundle } from "./harness.ts";

export type AvailabilityStatus = "match" | "mismatch" | "unreachable" | "not-checked";

export type AvailabilityResult = {
  entry: string;
  status: AvailabilityStatus;
  detail: string;
};

export type AvailabilityOptions = {
  /** Body cap per resolver; the harness default is 64 MiB. */
  maxBytes: number;
};

export async function checkAvailability(
  workerHash: string,
  resolvers: readonly string[],
  options: AvailabilityOptions,
): Promise<AvailabilityResult[]> {
  const results: AvailabilityResult[] = [];
  for (const entry of resolvers) {
    if (entry.startsWith("kps:")) {
      results.push({
        entry,
        status: "not-checked",
        detail: "kps: needs a KPS client (browser harness or a QUIC client); Node has neither",
      });
      continue;
    }
    if (!entry.startsWith("https:")) {
      results.push({ entry, status: "not-checked", detail: "not an https: entry" });
      continue;
    }
    try {
      const bytes = await fetchAndVerifyBundle({ workerHash, resolvers: [entry] }, options.maxBytes);
      results.push({ entry, status: "match", detail: `${bytes.byteLength} bytes, keccak256 = workerHash` });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const detail = message.replace(/^no resolver yielded bytes matching workerHash: /, "");
      results.push({ entry, status: /hash mismatch/.test(message) ? "mismatch" : "unreachable", detail });
    }
  }
  return results;
}

/**
 * True when every https: entry serves the pinned bytes. Only kps: entries may stay unchecked (Node has no KPS
 * client); any other unchecked entry is one no wallet would use, so it fails the check.
 */
export function allHttpsMatch(results: readonly AvailabilityResult[]): boolean {
  return results.every((r) => r.status === "match" || (r.status === "not-checked" && r.entry.startsWith("kps:")));
}
