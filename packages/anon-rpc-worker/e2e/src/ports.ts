// Port helpers: pick free ephemeral ports and refuse to start on busy ones, so a
// leftover mesh from another run fails fast with the port named.

import { createServer } from "node:net";
import { TestbedError } from "./errors.js";

/** A TCP port that was free a moment ago on `host` (bind to 0, read, close). */
export function freeTcpPort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new TestbedError("port", `cannot read an ephemeral port on ${host}`));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function tcpPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

/** Throw a "port" error naming every port in `ports` that is already bound. */
export async function assertTcpPortsFree(
  ports: readonly number[],
  purpose: string,
  host = "0.0.0.0",
): Promise<void> {
  const busy: number[] = [];
  for (const port of ports) {
    if (!(await tcpPortFree(port, host))) busy.push(port);
  }
  if (busy.length > 0) {
    throw new TestbedError(
      "port",
      `${purpose}: TCP ports already in use: ${busy.join(", ")}. ` +
        "Stop the process holding them (a leftover mesh?) or pick another range with E2E_BASE_PORT.",
    );
  }
}

/** Every TCP port a mesh of `nodes` nodes binds: p2p, metrics and ingress per node. */
export function meshPorts(basePort: number, nodes: number): number[] {
  const ports: number[] = [];
  for (let i = 0; i < nodes; i++) {
    const p2p = basePort + i * 10;
    ports.push(p2p, p2p + 1, p2p + 2);
  }
  return ports;
}
