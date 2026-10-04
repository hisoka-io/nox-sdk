// Child processes owned by the test bed (anvil, nox_mesh_server, KPS servers).
// Output goes to a log file and a bounded in-memory buffer, so readiness can be
// detected from a printed line and failures can quote the last lines.

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { TestbedError } from "./errors.js";

/** Bytes of combined stdout/stderr kept in memory for matching and error context. */
const OUTPUT_BUFFER_BYTES = 512 * 1024;
/** Lines of output quoted in error messages. */
const ERROR_TAIL_LINES = 25;

export interface ManagedProcessOptions {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly logFile: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Start the child as the leader of a new process group so that stop() also
   * reaches the processes it spawns (nox_mesh_server spawns one nox per node).
   */
  readonly processGroup?: boolean;
}

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface Waiter {
  readonly pattern: RegExp;
  readonly resolve: (match: RegExpMatchArray) => void;
}

export class ManagedProcess {
  readonly label: string;
  readonly logFile: string;
  readonly child: ChildProcess;
  readonly #processGroup: boolean;
  readonly #log: WriteStream;
  readonly #exit: Promise<ExitInfo>;
  #exitInfo: ExitInfo | undefined;
  #spawnError: Error | undefined;
  #output = "";
  #waiters: Waiter[] = [];

  private constructor(options: ManagedProcessOptions) {
    this.label = options.label;
    this.logFile = options.logFile;
    this.#processGroup = options.processGroup ?? false;
    mkdirSync(dirname(options.logFile), { recursive: true });
    this.#log = createWriteStream(options.logFile, { flags: "a" });
    // A failing log file must never take the test runner down with it.
    this.#log.on("error", () => undefined);
    this.#log.write(`$ ${options.command} ${options.args.join(" ")}\n`);

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...options.env })) {
      if (value !== undefined) env[key] = value;
    }
    this.child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: this.#processGroup,
    });
    this.#exit = new Promise<ExitInfo>((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.#exitInfo = { code, signal };
        resolve(this.#exitInfo);
      });
      this.child.once("error", (error) => {
        this.#spawnError = error;
        this.#exitInfo = { code: null, signal: null };
        resolve(this.#exitInfo);
      });
    });
    const onData = (chunk: Buffer): void => this.#append(chunk.toString("utf8"));
    this.child.stdout?.on("data", onData);
    this.child.stderr?.on("data", onData);
  }

  static start(options: ManagedProcessOptions): ManagedProcess {
    return new ManagedProcess(options);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get exitInfo(): ExitInfo | undefined {
    return this.#exitInfo;
  }

  /** Resolves when the process has exited (or failed to spawn). */
  get exited(): Promise<ExitInfo> {
    return this.#exit;
  }

  /** The last `lines` lines of combined output. */
  tail(lines: number = ERROR_TAIL_LINES): string {
    return this.#output.split("\n").slice(-lines).join("\n");
  }

  /** Text printed so far (bounded to the most recent 512 KiB). */
  get output(): string {
    return this.#output;
  }

  /**
   * Wait until the combined output matches `pattern`. Rejects when the process
   * exits first or the deadline passes, quoting the last lines of output.
   */
  waitForOutput(pattern: RegExp, timeoutMs: number, what: string): Promise<RegExpMatchArray> {
    const existing = this.#output.match(pattern);
    if (existing !== null) return Promise.resolve(existing);
    return new Promise<RegExpMatchArray>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new TestbedError(
            "timeout",
            `${this.label}: no ${what} within ${timeoutMs} ms (log: ${this.logFile})\n${this.tail()}`,
          ),
        );
      }, timeoutMs);
      const waiter: Waiter = {
        pattern,
        resolve: (match) => {
          cleanup();
          resolve(match);
        },
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
      };
      this.#waiters.push(waiter);
      void this.#exit.then((info) => {
        if (!this.#waiters.includes(waiter)) return;
        cleanup();
        reject(this.#exitError(info, `before printing ${what}`));
      });
    });
  }

  /** Reject if the process has already exited; used while polling for readiness. */
  assertRunning(context: string): void {
    if (this.#exitInfo !== undefined) throw this.#exitError(this.#exitInfo, context);
  }

  /**
   * Stop the process (and its group when started with processGroup): send
   * `signal`, wait `graceMs`, then SIGKILL. Safe to call more than once.
   */
  async stop(signal: NodeJS.Signals = "SIGTERM", graceMs = 5_000): Promise<void> {
    if (this.#exitInfo === undefined) {
      this.#signal(signal);
      const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), graceMs));
      if ((await Promise.race([this.#exit, timer])) === "timeout") {
        this.#signal("SIGKILL");
        await this.#exit;
      }
    }
    if (this.#processGroup) this.#signal("SIGKILL");
    if (!this.#log.writableEnded) await new Promise<void>((resolve) => this.#log.end(() => resolve()));
  }

  #signal(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      if (this.#processGroup) process.kill(-pid, signal);
      else this.child.kill(signal);
    } catch {
      // ESRCH: the process (group) is already gone.
    }
  }

  #exitError(info: ExitInfo, context: string): TestbedError {
    if (this.#spawnError !== undefined) {
      return new TestbedError(
        "prerequisite",
        `${this.label}: cannot start (${this.#spawnError.message}); is it installed and on PATH?`,
        { cause: this.#spawnError },
      );
    }
    const how = info.signal !== null ? `signal ${info.signal}` : `code ${String(info.code)}`;
    return new TestbedError(
      "process-exit",
      `${this.label} exited with ${how} ${context} (log: ${this.logFile})\n${this.tail()}`,
    );
  }

  #append(text: string): void {
    if (!this.#log.writableEnded) this.#log.write(text);
    this.#output += text;
    if (this.#output.length > OUTPUT_BUFFER_BYTES) {
      this.#output = this.#output.slice(this.#output.length - OUTPUT_BUFFER_BYTES);
    }
    for (const waiter of [...this.#waiters]) {
      const match = this.#output.match(waiter.pattern);
      if (match !== null) waiter.resolve(match);
    }
  }
}

/** Resolve after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
