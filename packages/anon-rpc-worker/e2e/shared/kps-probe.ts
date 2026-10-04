// Echo plans over one KPS connection with per-stream deadlines. Works with both
// @kpstreams/webrtc-client connections (host page) and harness KpsConn objects
// (inside a worker), which share this structural shape.

import { describe, echoOverStream, type ByteStream, type EchoSample } from "./kps-echo.js";

export interface ClosableStream extends ByteStream {
  close(): Promise<void>;
}

export interface StreamOpener {
  openStream(options?: { signal?: AbortSignal }): Promise<ClosableStream>;
}

export interface EchoPlan {
  readonly sizes: readonly number[];
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

/** Open one stream and echo `size` bytes, failing (not hanging) past `timeoutMs`. */
export async function timedEcho(
  conn: StreamOpener,
  size: number,
  seed: number,
  timeoutMs: number,
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
      () => resolve({ bytes: size, ms: elapsed(), ok: false, error: `echo did not finish within ${timeoutMs} ms` }),
      Math.max(0, timeoutMs - elapsed()),
    );
  });
  const result = await Promise.race([echoOverStream(stream, size, seed), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  await stream.close().catch(() => undefined);
  return { ...result, ms: elapsed() };
}

export async function runEchoPlan(conn: StreamOpener, plan: EchoPlan): Promise<EchoPlanResult> {
  const samples: EchoSample[] = [];
  let seed = 1;
  for (const size of plan.sizes) samples.push(await timedEcho(conn, size, seed++, plan.streamTimeoutMs));
  const cycleSize = plan.sizes[0] ?? 32;
  const sequential: EchoSample[] = [];
  for (let i = 0; i < plan.sequentialStreams; i++) {
    sequential.push(await timedEcho(conn, cycleSize, seed++, plan.streamTimeoutMs));
  }
  const parallel = await Promise.all(
    Array.from({ length: plan.parallelStreams }, (_, i) =>
      timedEcho(conn, cycleSize, 100 + i, plan.streamTimeoutMs)),
  );
  const ok = [...samples, ...sequential, ...parallel].every((sample) => sample.ok);
  return { ok, samples, sequential, parallel };
}
