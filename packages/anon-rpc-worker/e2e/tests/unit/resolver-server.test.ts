import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContentStore } from "../../src/content-store.js";
import { startResolverServer, type ResolverServer } from "../../src/resolver-server.js";

describe("local keccak resolver server", () => {
  const store = new ContentStore();
  const bytes = new TextEncoder().encode("(()=>{anonRpcWorker.signalReady()})();");
  const hash = store.put(bytes);
  let server: ResolverServer;

  beforeAll(async () => {
    server = await startResolverServer(store);
  });
  afterAll(async () => {
    await server.close();
  });

  it("serves stored bytes at the keccak path, CORS-open and immutable", async () => {
    const response = await fetch(server.urlFor(hash));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(server.requests.at(-1)).toBe(new URL(server.urlFor(hash)).pathname);
  });

  it("answers 404 for unknown hashes and malformed paths, 405 for writes", async () => {
    expect((await fetch(server.urlFor(`0x${"00".repeat(32)}`))).status).toBe(404);
    expect((await fetch(`${server.origin}/keccak/zz/abc`)).status).toBe(404);
    expect((await fetch(server.urlFor(hash), { method: "POST", body: "x" })).status).toBe(405);
  });
});
