/**
 * Public constructor of the KPS `fetch` (ARCHITECTURE §3.2, §3.5).
 */
import type { KpsModeOptions, NoxLogSink } from "../types.js";
import {
  KpsHttpTransport,
  resolveKpsTransportSettings,
  type KpsFetchStats,
  type KpsTransportSettings,
} from "./transport.js";

/** A `fetch` over KPS with its lifecycle. */
export interface KpsFetch {
  (input: string, init?: RequestInit): Promise<Response>;
  /** Close every KPS connection; later calls fail with `TRANSPORT_FAILED`. */
  close(): Promise<void>;
  stats(): KpsFetchStats;
}

/** Transport settings carried by `KpsModeOptions` (the rest keep their defaults). */
export function kpsTransportSettingsFrom(options: KpsModeOptions): KpsTransportSettings {
  const overrides: Partial<KpsTransportSettings> = {};
  if (options.dialTimeoutMs !== undefined) overrides.dialTimeoutMs = options.dialTimeoutMs;
  if (options.openStreamTimeoutMs !== undefined) overrides.openStreamTimeoutMs = options.openStreamTimeoutMs;
  if (options.exchangeTimeoutMs !== undefined) overrides.exchangeTimeoutMs = options.exchangeTimeoutMs;
  if (options.keepaliveMs !== undefined) overrides.keepaliveMs = options.keepaliveMs;
  if (options.maxHeadBytes !== undefined) overrides.maxHeadBytes = options.maxHeadBytes;
  if (options.maxBodyBytes !== undefined) overrides.maxBodyBytes = options.maxBodyBytes;
  if (options.writeChunkBytes !== undefined) overrides.writeChunkBytes = options.writeChunkBytes;
  if (options.warmupBytes !== undefined) overrides.warmupBytes = options.warmupBytes;
  if (options.warmupMaxBytesPerMinute !== undefined) overrides.warmupMaxBytesPerMinute = options.warmupMaxBytesPerMinute;
  return resolveKpsTransportSettings(overrides);
}

/**
 * A `fetch` that carries `kps:<address><target>` endpoints over KPS streams,
 * one HTTP/1.1 exchange per stream, one reused connection per address. Any
 * other input fails with `MODE_VIOLATION`; nothing falls back to HTTPS.
 */
export function createKpsFetch(options: KpsModeOptions & { log?: NoxLogSink }): KpsFetch {
  const transport = new KpsHttpTransport(options.dial, kpsTransportSettingsFrom(options), options.log);
  const kpsFetch = ((input: string, init?: RequestInit) => transport.fetch(input, init)) as KpsFetch;
  kpsFetch.close = () => transport.close();
  kpsFetch.stats = () => transport.stats();
  return kpsFetch;
}
