// Typed errors for the test bed. Every message names the component, the input
// that failed, and where to look next (a log file, an env var, a build command).

export type TestbedErrorCode =
  /** An environment variable or option is missing or malformed. */
  | "config"
  /** A required tool or binary is absent (anvil, nox, nox_mesh_server, ...). */
  | "prerequisite"
  /** A child process exited before it became ready. */
  | "process-exit"
  /** Waiting for readiness or a reply exceeded its deadline. */
  | "timeout"
  /** A JSON-RPC endpoint returned an error or malformed data. */
  | "rpc"
  /** ABI encoding or decoding failed. */
  | "abi"
  /** mesh_info.json or a topology document has an unexpected shape. */
  | "mesh-info"
  /** The content-addressed resolver store was given inconsistent input. */
  | "resolver"
  /** A port the test bed needs is already bound. */
  | "port"
  /** A binary payload (bincode, KPS address) could not be decoded. */
  | "decode"
  /** The recording egress proxy or its allowlist was given unusable input. */
  | "egress";

export class TestbedError extends Error {
  readonly code: TestbedErrorCode;

  constructor(code: TestbedErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TestbedError";
    this.code = code;
  }
}

/** Render any thrown value as one line, for logs and error context. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const prefix = typeof code === "string" && code.length > 0 ? `${error.name}[${code}]` : error.name;
    return `${prefix}: ${error.message}`;
  }
  return String(error);
}
