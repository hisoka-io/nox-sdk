// Echo plans over one KPS connection with per-stream deadlines. Works with both
// @kpstreams/webrtc-client connections (host page) and harness KpsConn objects
// (inside a worker), which share this structural shape.

import { describe, downloadOverStream, echoOverStream, type ByteStream, type EchoSample } from "./kps-echo.js";

export interface ClosableStream extends ByteStream {
  close(): Promise<void>;
}

export interface StreamOpener {
  openStream(options?: { signal?: AbortSignal }): Promise<ClosableStream>;
}

/** "echo": write N bytes and read them back; "download": small request, N-byte response. */
export type TransferKind = "echo" | "download";

export interface EchoPlan {
  readonly sizes: readonly number[];
  /** Defaults to "echo". */
  readonly transfer?: TransferKind;
  readonly sequentialStreams: number;
  readonly parallelStreams: number;
  readonly streamTimeoutMs: number;
}

export interface EchoPlanResult {
  readonly ok: boolean;
  readonly samples: EchoSample[];
  readonly sequential: EchoSample[];
  readonly parallel: EchoSample[];
}

/** Open one stream and transfer `size` bytes, failing (not hanging) past `timeoutMs`. */
export async function timedEcho(
  conn: StreamOpener,
  size: number,
  seed: number,
  timeoutMs: number,
  transfer: TransferKind = "echo",
): Promise<EchoSample> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  let stream: ClosableStream;
  try {
    stream = await conn.openStream({ signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { bytes: size, ms: elapsed(), ok: false, error: `openStream: ${describe(error)}` };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<EchoSample>((resolve) => {
    timer = setTimeout(
      () => resolve({ bytes: size, ms: elapsed(), ok: false, error: `${transfer} did not finish within ${timeoutMs} ms` }),
      Math.max(0, timeoutMs - elapsed()),
    );
  });
  const run = transfer === "download" ? downloadOverStream(stream, size, seed) : echoOverStream(stream, size, seed);
  const result = await Promise.race([run, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  await stream.close().catch(() => undefined);
  return { ...result, ms: elapsed() };
}

export async function runEchoPlan(conn: StreamOpener, plan: EchoPlan): Promise<EchoPlanResult> {
  const transfer = plan.transfer ?? "echo";
  const samples: EchoSample[] = [];
  let seed = 1;
  for (const size of plan.sizes) samples.push(await timedEcho(conn, size, seed++, plan.streamTimeoutMs, transfer));
  const cycleSize = plan.sizes[0] ?? 32;
  const sequential: EchoSample[] = [];
  for (let i = 0; i < plan.sequentialStreams; i++) {
    sequential.push(await timedEcho(conn, cycleSize, seed++, plan.streamTimeoutMs, transfer));
  }
  const parallel = await Promise.all(
    Array.from({ length: plan.parallelStreams }, (_, i) =>
      timedEcho(conn, cycleSize, 100 + i, plan.streamTimeoutMs, transfer)),
  );
  const ok = [...samples, ...sequential, ...parallel].every((sample) => sample.ok);
  return { ok, samples, sequential, parallel };
}
