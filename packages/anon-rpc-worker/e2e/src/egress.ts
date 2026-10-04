// Egress allowlist for the "worker reaches the network only through KPS" check
// (TEST-PLAN TST-562 .03). Under the anon-rpc trust model the browser itself
// may contact exactly three origins: the host page, the bundle resolver and the
// specifier RPC. Every other HTTP(S) request, every CONNECT tunnel to anything
// but an allowed https origin, and every WebSocket is a violation. WebRTC (the
// KPS transport) does not go through the browser's HTTP stack and is therefore
// outside what this check observes.

import { TestbedError } from "./errors.js";

/** Where an egress event was observed. */
export type EgressLayer =
  /** The recording forward proxy every request of the guarded context goes through. */
  | "proxy"
  /** Playwright's context `request` event (CDP Network, pages, frames, workers). */
  | "cdp-request"
  /** Playwright's page `websocket` event. */
  | "cdp-websocket";

export type EgressKind =
  /** A proxied absolute-form HTTP request or a browser-reported request URL. */
  | "http"
  /** A proxy CONNECT tunnel (https, ws and wss through the proxy). */
  | "connect"
  /** A WebSocket the browser reported or an Upgrade request through the proxy. */
  | "websocket";

export interface EgressEvent {
  readonly layer: EgressLayer;
  readonly kind: EgressKind;
  /** A URL, or `host:port` for a CONNECT tunnel. */
  readonly target: string;
  readonly method?: string;
  /** ms since the monitor started. */
  readonly atMs: number;
}

/** Schemes that never touch the network (blob workers, srcdoc frames, data URLs). */
const LOCAL_SCHEMES = new Set(["blob:", "data:", "about:"]);
const HTTP_SCHEMES = new Set(["http:", "https:"]);
const DEFAULT_PORTS: Readonly<Record<string, string>> = { "http:": "80", "https:": "443" };

export interface EgressPolicy {
  /** Normalised `scheme//host:port` keys of the allowed origins. */
  readonly allowed: ReadonlySet<string>;
}

function originKey(url: URL): string {
  const port = url.port === "" ? (DEFAULT_PORTS[url.protocol] ?? "") : url.port;
  return `${url.protocol}//${url.hostname.toLowerCase()}:${port}`;
}

function parseUrl(raw: string, what: string): URL {
  try {
    return new URL(raw);
  } catch (error) {
    throw new TestbedError("egress", `${what} ${JSON.stringify(raw)} is not an absolute URL`, { cause: error });
  }
}

/** Build the allowlist from origins or URLs (path and query are ignored). */
export function egressPolicy(allowedOrigins: readonly string[]): EgressPolicy {
  if (allowedOrigins.length === 0) throw new TestbedError("egress", "the egress allowlist needs at least one origin");
  const allowed = new Set<string>();
  for (const raw of allowedOrigins) {
    const url = parseUrl(raw, "allowed origin");
    if (!HTTP_SCHEMES.has(url.protocol)) {
      throw new TestbedError("egress", `allowed origin ${raw} must be http or https, got ${url.protocol}`);
    }
    allowed.add(originKey(url));
  }
  return { allowed };
}

/** CONNECT targets are `host:port` (IPv6 hosts in brackets). */
function connectKey(target: string): string | undefined {
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):(\d{1,5})$/u.exec(target);
  if (match === null) return undefined;
  const host = (match[1] ?? "").toLowerCase();
  return `https://${host}:${match[2] ?? ""}`;
}

/** True when `event` stays inside the policy. */
export function isAllowed(policy: EgressPolicy, event: EgressEvent): boolean {
  if (event.kind === "websocket") return false;
  if (event.kind === "connect") {
    const key = connectKey(event.target);
    return key !== undefined && policy.allowed.has(key);
  }
  let url: URL;
  try {
    url = new URL(event.target);
  } catch {
    return false;
  }
  if (LOCAL_SCHEMES.has(url.protocol)) return true;
  if (!HTTP_SCHEMES.has(url.protocol)) return false;
  return policy.allowed.has(originKey(url));
}

/** Events outside the policy, in arrival order. */
export function violations(policy: EgressPolicy, events: readonly EgressEvent[]): EgressEvent[] {
  return events.filter((event) => !isAllowed(policy, event));
}

/** One line per event, for assertion messages and reports. */
export function describeEvents(events: readonly EgressEvent[]): string[] {
  return events.map(
    (event) => `${event.atMs}ms ${event.layer} ${event.kind}${event.method === undefined ? "" : ` ${event.method}`} ${event.target}`,
  );
}
