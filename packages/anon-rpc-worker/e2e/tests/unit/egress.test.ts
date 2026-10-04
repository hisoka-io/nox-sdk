import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { egressPolicy, isAllowed, violations, type EgressEvent } from "../../src/egress.js";
import { isLoopbackHost, startEgressProxy, type EgressProxy } from "../../src/egress-proxy.js";
import { TestbedError } from "../../src/errors.js";
import { startTrapServer, websocketAccept, type TrapServer } from "../../src/trap-server.js";

function event(kind: EgressEvent["kind"], target: string): EgressEvent {
  return { layer: "proxy", kind, target, atMs: 0 };
}

describe("egress allowlist", () => {
  const policy = egressPolicy([
    "http://127.0.0.1:4000/harness/0.3.2/",
    "http://127.0.0.1:4001",
    "http://127.0.0.1:4002/",
  ]);

  it("allows exactly the listed origins, whatever the path", () => {
    expect(isAllowed(policy, event("http", "http://127.0.0.1:4000/harness/0.3.2/page.js"))).toBe(true);
    expect(isAllowed(policy, event("http", "http://127.0.0.1:4001/keccak/aa/bb"))).toBe(true);
    expect(isAllowed(policy, event("http", "http://127.0.0.1:4002/"))).toBe(true);
  });

  it("flags other ports, other hosts, the localhost alias and https to an allowed host", () => {
    expect(isAllowed(policy, event("http", "http://127.0.0.1:27002/topology"))).toBe(false);
    expect(isAllowed(policy, event("http", "http://localhost:4001/"))).toBe(false);
    expect(isAllowed(policy, event("http", "http://10.255.255.254:4001/"))).toBe(false);
    expect(isAllowed(policy, event("http", "https://127.0.0.1:4001/"))).toBe(false);
    expect(isAllowed(policy, event("http", "https://eth.example/"))).toBe(false);
  });

  it("flags every WebSocket, even to an allowed origin", () => {
    expect(isAllowed(policy, event("websocket", "ws://127.0.0.1:4001/"))).toBe(false);
    expect(isAllowed(policy, event("websocket", "wss://127.0.0.1:27002/api/v1/ws"))).toBe(false);
  });

  it("flags CONNECT tunnels unless an https origin with that authority is allowed", () => {
    expect(isAllowed(policy, event("connect", "127.0.0.1:4001"))).toBe(false);
    expect(isAllowed(policy, event("connect", "public-rpc.invalid:443"))).toBe(false);
    expect(isAllowed(policy, event("connect", "not a target"))).toBe(false);
    const tls = egressPolicy(["https://resolver.example"]);
    expect(isAllowed(tls, event("connect", "resolver.example:443"))).toBe(true);
    expect(isAllowed(tls, event("connect", "resolver.example:8443"))).toBe(false);
  });

  it("allows non-network schemes and flags unknown ones", () => {
    expect(isAllowed(policy, event("http", "blob:null/e38bf8d5-fb5b-4fb8-9a7c-4bf4d240bc18"))).toBe(true);
    expect(isAllowed(policy, event("http", "data:text/plain,hi"))).toBe(true);
    expect(isAllowed(policy, event("http", "about:srcdoc"))).toBe(true);
    expect(isAllowed(policy, event("http", "ftp://127.0.0.1:4001/"))).toBe(false);
    expect(isAllowed(policy, event("http", "origin-form /topology"))).toBe(false);
  });

  it("returns violations in arrival order", () => {
    const events = [
      event("http", "http://127.0.0.1:4000/"),
      event("websocket", "ws://127.0.0.1:27002/api/v1/ws"),
      event("http", "http://127.0.0.1:4001/"),
      event("http", "http://127.0.0.1:8545/"),
    ];
    expect(violations(policy, events).map((e) => e.target)).toEqual([
      "ws://127.0.0.1:27002/api/v1/ws",
      "http://127.0.0.1:8545/",
    ]);
  });

  it("rejects an empty or non-http allowlist", () => {
    expect(() => egressPolicy([])).toThrow(TestbedError);
    expect(() => egressPolicy(["ws://127.0.0.1:1"])).toThrow(/must be http or https/u);
    expect(() => egressPolicy(["127.0.0.1:1"])).toThrow(TestbedError);
  });
});

describe("loopback hosts the proxy forwards to", () => {
  it("accepts 127/8, ::1 and localhost only", () => {
    expect(["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"].every(isLoopbackHost)).toBe(true);
    expect(["10.255.255.254", "0.0.0.0", "public-rpc.invalid", "127.example", "::"].some(isLoopbackHost)).toBe(false);
  });
});

/** Send raw bytes to the proxy and collect the reply until `done` matches or the socket ends. */
function exchange(proxy: EgressProxy, payload: string, done: RegExp): Promise<{ text: string; socket: Socket }> {
  const { port } = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), "127.0.0.1", () => socket.write(payload));
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("latin1");
      if (done.test(text)) resolve({ text, socket });
    });
    socket.on("end", () => resolve({ text, socket }));
    socket.on("error", reject);
  });
}

describe("recording egress proxy", () => {
  let proxy: EgressProxy;
  let trap: TrapServer;

  beforeAll(async () => {
    proxy = await startEgressProxy();
    trap = await startTrapServer();
  });
  afterAll(async () => {
    await proxy.close();
    await trap.close();
  });

  it("records and forwards an absolute-form HTTP request to loopback", async () => {
    const { port } = new URL(proxy.url);
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: Number(port), method: "GET", path: `${trap.origin}/topology?x=1`, headers: { "proxy-connection": "keep-alive" } },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => resolve(`${res.statusCode ?? 0} ${text}`));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(body).toBe(`200 ${JSON.stringify({ trap: true, path: "/topology?x=1" })}`);
    expect(proxy.events.at(-1)).toMatchObject({ layer: "proxy", kind: "http", method: "GET", target: `${trap.origin}/topology?x=1` });
    expect(trap.hits.at(-1)).toMatchObject({ kind: "http", path: "/topology?x=1" });
  });

  it("records a CONNECT tunnel and carries a WebSocket handshake through it", async () => {
    const key = randomBytes(16).toString("base64");
    const tunnel = await exchange(proxy, `CONNECT 127.0.0.1:${trap.port} HTTP/1.1\r\nHost: 127.0.0.1:${trap.port}\r\n\r\n`, /\r\n\r\n/u);
    expect(tunnel.text).toMatch(/^HTTP\/1\.1 200/u);
    const upgraded = await new Promise<string>((resolve, reject) => {
      let text = "";
      tunnel.socket.on("data", (chunk: Buffer) => {
        text += chunk.toString("latin1");
        if (text.includes("\r\n\r\n")) resolve(text);
      });
      tunnel.socket.on("error", reject);
      tunnel.socket.write(
        `GET /api/v1/ws HTTP/1.1\r\nHost: 127.0.0.1:${trap.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    tunnel.socket.destroy();
    expect(upgraded).toMatch(/^HTTP\/1\.1 101/u);
    expect(upgraded.toLowerCase()).toContain(`sec-websocket-accept: ${websocketAccept(key).toLowerCase()}`);
    expect(proxy.events.some((e) => e.kind === "connect" && e.target === `127.0.0.1:${trap.port}`)).toBe(true);
    expect(trap.hits.at(-1)).toMatchObject({ kind: "websocket", path: "/api/v1/ws" });
  });

  it("records an absolute-form WebSocket upgrade as a websocket event and forwards it", async () => {
    const key = randomBytes(16).toString("base64");
    const reply = await exchange(
      proxy,
      `GET ${trap.origin}/api/v1/ws HTTP/1.1\r\nHost: 127.0.0.1:${trap.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      /\r\n\r\n/u,
    );
    reply.socket.destroy();
    expect(reply.text).toMatch(/^HTTP\/1\.1 101/u);
    expect(proxy.events.at(-1)).toMatchObject({ kind: "websocket", target: `ws://127.0.0.1:${trap.port}/api/v1/ws` });
  });

  it("records and refuses non-loopback targets without contacting them", async () => {
    const before = trap.hits.length;
    const tunnel = await exchange(proxy, "CONNECT public-rpc.invalid:443 HTTP/1.1\r\nHost: public-rpc.invalid:443\r\n\r\n", /outside loopback/u);
    tunnel.socket.destroy();
    expect(tunnel.text).toMatch(/^HTTP\/1\.1 403/u);
    const plain = await exchange(proxy, "GET http://10.255.255.254:8545/ HTTP/1.1\r\nHost: 10.255.255.254:8545\r\n\r\n", /outside loopback/u);
    plain.socket.destroy();
    expect(plain.text).toMatch(/^HTTP\/1\.1 403/u);
    expect(proxy.events.slice(-2).map((e) => `${e.kind} ${e.target}`)).toEqual([
      "connect public-rpc.invalid:443",
      "http http://10.255.255.254:8545/",
    ]);
    expect(trap.hits.length).toBe(before);
  });

  it("records an origin-form request (a direct hit on the proxy) and answers 400", async () => {
    const reply = await exchange(proxy, "GET /topology HTTP/1.1\r\nHost: x\r\n\r\n", /expected an absolute-form/u);
    reply.socket.destroy();
    expect(reply.text).toMatch(/^HTTP\/1\.1 400/u);
    expect(proxy.events.at(-1)).toMatchObject({ kind: "http", target: "origin-form /topology" });
  });
});
