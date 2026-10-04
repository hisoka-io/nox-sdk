// KPS endpoints for the test bed: the reference echo servers from ethereum/kps
// (Rust and Go), and nox-kps sidecars in front of the local mesh nodes.
//
// Every KPS server prints its dialable address (ip:port:certhash); the test bed
// reads it from the process output, so any implementation that prints the
// address works, whatever else it logs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestbedError } from "./errors.js";
import { ManagedProcess } from "./process.js";

export interface KpsAddress {
  readonly ip: string;
  readonly port: number;
  readonly certhash: string;
}

/** Multihash header of a sha2-256 digest: code 0x12, length 0x20. */
const SHA256_MULTIHASH_PREFIX = [0x12, 0x20] as const;
const SHA256_MULTIHASH_BYTES = 34;

/** First KPS address (IPv4 form) in a block of text, e.g. a server's startup line. */
export const KPS_ADDRESS_PATTERN = /(\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}:u[A-Za-z0-9_-]{40,})/u;

function base64UrlDecode(text: string): Uint8Array {
  const standard = text.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}

/** Parse and validate `<ip>:<port>:<certhash>` or `[v6]:<port>:<certhash>` (KPS SPEC §3). */
export function parseKpsAddress(text: string): KpsAddress {
  const match = /^(?:\[([0-9a-fA-F:.]+)\]|(\d{1,3}(?:\.\d{1,3}){3})):(\d{1,5}):(u[A-Za-z0-9_-]+)$/u.exec(text);
  if (match === null) throw new TestbedError("decode", `not a KPS address: ${text}`);
  const ip = match[1] ?? match[2] ?? "";
  const port = Number(match[3]);
  const certhash = match[4] ?? "";
  if (port < 1 || port > 65_535) throw new TestbedError("decode", `KPS address port out of range: ${text}`);
  if (match[2] !== undefined && ip.split(".").some((octet) => Number(octet) > 255)) {
    throw new TestbedError("decode", `KPS address has an invalid IPv4 address: ${text}`);
  }
  const digest = base64UrlDecode(certhash.slice(1));
  if (
    digest.length !== SHA256_MULTIHASH_BYTES ||
    digest[0] !== SHA256_MULTIHASH_PREFIX[0] ||
    digest[1] !== SHA256_MULTIHASH_PREFIX[1]
  ) {
    throw new TestbedError(
      "decode",
      `KPS certhash must be multibase "u" of a sha2-256 multihash (34 bytes, 0x1220...): ${certhash}`,
    );
  }
  return { ip, port, certhash };
}

export function formatKpsAddress(address: KpsAddress): string {
  const host = address.ip.includes(":") ? `[${address.ip}]` : address.ip;
  return `${host}:${address.port}:${address.certhash}`;
}

export interface RunningKpsServer {
  readonly label: string;
  readonly address: string;
  readonly logFile: string;
  stop(): Promise<void>;
}

/** Reference echo servers, plus "go-bulk" (tools/kps-bulk-server: small request, large response). */
export type EchoServerKind = "rust" | "rust-ipfilter" | "go" | "go-bulk";

/** Binary names produced by scripts/build-kps-servers.sh and build-kps-ipfilter-probe.sh. */
export const ECHO_SERVER_BINARIES: Readonly<Record<EchoServerKind, string>> = {
  rust: "kps-rust-server",
  "rust-ipfilter": "kps-rust-server-ipfilter",
  go: "kps-go-server",
  "go-bulk": "kps-go-bulk-server",
};

export interface StartEchoServerOptions {
  readonly kind: EchoServerKind;
  readonly binDir: string;
  readonly bindIp: string;
  readonly stateDir: string;
  readonly logDir: string;
  readonly addressTimeoutMs: number;
  /** Extra environment (e.g. RUST_LOG, KPS_DEBUG) for diagnosis. */
  readonly env?: Readonly<Record<string, string>>;
}

export function echoServerBinary(binDir: string, kind: EchoServerKind): string {
  return join(binDir, ECHO_SERVER_BINARIES[kind]);
}

/** Start one reference echo server (`-listen ip:0 -key file -ip ip`) and read its address. */
export async function startEchoServer(options: StartEchoServerOptions): Promise<RunningKpsServer> {
  const bin = echoServerBinary(options.binDir, options.kind);
  if (!existsSync(bin)) {
    throw new TestbedError(
      "prerequisite",
      `${bin} not found; run scripts/build-kps-servers.sh` +
        (options.kind === "rust-ipfilter" ? " and scripts/build-kps-ipfilter-probe.sh" : ""),
    );
  }
  mkdirSync(options.stateDir, { recursive: true });
  const label = `kps-echo(${options.kind}@${options.bindIp})`;
  const logFile = join(options.logDir, `kps-echo-${options.kind}-${options.bindIp}.log`);
  const proc = ManagedProcess.start({
    label,
    command: bin,
    args: [
      "-listen", `${options.bindIp}:0`,
      "-key", join(options.stateDir, `${options.kind}-${options.bindIp}.key`),
      "-ip", options.bindIp,
    ],
    logFile,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const match = await proc.waitForOutput(KPS_ADDRESS_PATTERN, options.addressTimeoutMs, "KPS address");
  const address = formatKpsAddress(parseKpsAddress(match[1] ?? ""));
  return { label, address, logFile, stop: () => proc.stop("SIGTERM") };
}

/** Values substituted into NOX_KPS_CMD and NOX_KPS_CONFIG_TEMPLATE for mesh node N. */
export interface SidecarVars {
  readonly node: number;
  /** Registry-style address of the mesh node (informational, /metadata.json). */
  readonly node_address: string;
  readonly udp_port: number;
  readonly advertise_ip: string;
  readonly listen: string;
  readonly ingress_port: number;
  readonly ingress_url: string;
  readonly topology_port: number;
  readonly topology_url: string;
  readonly admin_port: number;
  readonly key_file: string;
  readonly config_file: string;
  readonly bundle_dir: string;
}

const PLACEHOLDER = /\{([a-z_]+)\}/gu;

/** Replace {name} placeholders; unknown names are an error so typos fail loudly. */
export function renderTemplate(template: string, vars: SidecarVars): string {
  const values = vars as unknown as Readonly<Record<string, string | number>>;
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new TestbedError(
        "config",
        `unknown placeholder ${whole} in nox-kps template; known: ${Object.keys(vars).join(", ")}`,
      );
    }
    return String(value);
  });
}

/** Split a rendered command line on whitespace (no shell); values must not contain spaces. */
export function splitCommand(rendered: string): { command: string; args: string[] } {
  const parts = rendered.trim().split(/\s+/u).filter((part) => part.length > 0);
  const command = parts[0];
  if (command === undefined) throw new TestbedError("config", "NOX_KPS_CMD renders to an empty command");
  return { command, args: parts.slice(1) };
}

export interface StartSidecarOptions {
  readonly commandTemplate: string;
  readonly initCommandTemplate: string | undefined;
  readonly configTemplate: string | undefined;
  readonly vars: SidecarVars;
  readonly logDir: string;
  readonly addressTimeoutMs: number;
}

/** Start one nox-kps sidecar for a mesh node and read the address it prints. */
export async function startSidecar(options: StartSidecarOptions): Promise<RunningKpsServer> {
  for (const [name, value] of Object.entries(options.vars)) {
    if (/\s/u.test(String(value))) {
      throw new TestbedError("config", `nox-kps placeholder {${name}} contains whitespace: ${String(value)}`);
    }
  }
  if (options.configTemplate !== undefined) {
    const template = readFileSync(options.configTemplate, "utf8");
    writeFileSync(options.vars.config_file, renderTemplate(template, options.vars));
  }
  const label = `nox-kps(node ${options.vars.node})`;
  const logFile = join(options.logDir, `nox-kps-node-${options.vars.node}.log`);
  if (options.initCommandTemplate !== undefined) {
    const init = splitCommand(renderTemplate(options.initCommandTemplate, options.vars));
    const initProc = ManagedProcess.start({ label: `${label} init`, command: init.command, args: init.args, logFile });
    const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), options.addressTimeoutMs));
    const outcome = await Promise.race([initProc.exited, timer]);
    await initProc.stop();
    if (outcome === "timeout" || outcome.code !== 0) {
      throw new TestbedError(
        outcome === "timeout" ? "timeout" : "process-exit",
        `${label}: NOX_KPS_INIT_CMD ${outcome === "timeout" ? `did not finish within ${options.addressTimeoutMs} ms` : `exited with code ${String(outcome.code)}`} (log: ${logFile})\n${initProc.tail()}`,
      );
    }
  }
  const { command, args } = splitCommand(renderTemplate(options.commandTemplate, options.vars));
  const proc = ManagedProcess.start({ label, command, args, logFile });
  const match = await proc.waitForOutput(KPS_ADDRESS_PATTERN, options.addressTimeoutMs, "KPS address");
  const address = formatKpsAddress(parseKpsAddress(match[1] ?? ""));
  return { label, address, logFile, stop: () => proc.stop("SIGTERM") };
}
