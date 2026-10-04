import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessProvider, localChainRpc, readOnlyRpc, redactUrl, RpcError } from "./rpc.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown, status = 200) {
  const fake = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fake);
  return fake;
}

describe("readOnlyRpc", () => {
  it.each(["eth_sendTransaction", "eth_sendRawTransaction", "anvil_setBalance", "personal_sign", "eth_sign"])(
    "refuses %s before anything is sent",
    async (method) => {
      const fake = stubFetch({ jsonrpc: "2.0", id: 1, result: "0x1" });
      await expect(readOnlyRpc("https://rpc.example").request(method, [])).rejects.toThrow(/refused: not a read-only/);
      expect(fake).not.toHaveBeenCalled();
    },
  );

  it("forwards read methods and returns the result", async () => {
    const fake = stubFetch({ jsonrpc: "2.0", id: 1, result: "0x1" });
    await expect(readOnlyRpc("https://rpc.example").request("eth_chainId")).resolves.toBe("0x1");
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("reports JSON-RPC errors with method, host and code, without the URL path", async () => {
    stubFetch({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "header not found" } });
    const failure = readOnlyRpc("https://rpc.example/v2/SECRET-KEY").request("eth_call", []);
    await expect(failure).rejects.toThrow(RpcError);
    await expect(failure).rejects.toThrow("eth_call via https://rpc.example/… failed: code -32000: header not found");
    await expect(failure).rejects.not.toThrow(/SECRET-KEY/);
  });

  it("reports HTTP failures and non-JSON bodies", async () => {
    stubFetch("rate limited", 429);
    await expect(readOnlyRpc("https://rpc.example").request("eth_chainId")).rejects.toThrow(/HTTP 429/);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>", { status: 200 })),
    );
    await expect(readOnlyRpc("https://rpc.example").request("eth_chainId")).rejects.toThrow(/not JSON/);
  });
});

describe("localChainRpc", () => {
  it("accepts loopback URLs only", () => {
    expect(localChainRpc("http://127.0.0.1:8545").url).toBe("http://127.0.0.1:8545");
    expect(localChainRpc("http://localhost:8545").url).toBe("http://localhost:8545");
    expect(() => localChainRpc("https://ethereum-rpc.publicnode.com")).toThrow(/not a loopback host/);
    expect(() => localChainRpc("http://10.0.0.5:8545")).toThrow(/not a loopback host/);
  });
});

describe("helpers", () => {
  it("redacts paths and queries from RPC URLs", () => {
    expect(redactUrl("https://eth-mainnet.example/v2/abc123")).toBe("https://eth-mainnet.example/…");
    expect(redactUrl("https://rpc.example/?key=abc")).toBe("https://rpc.example/…");
    expect(redactUrl("https://rpc.example")).toBe("https://rpc.example");
  });

  it("adapts a client to the harness provider shape", async () => {
    const calls: unknown[] = [];
    const provider = harnessProvider({
      url: "test",
      request: async (method, params) => {
        calls.push([method, params]);
        return "0x";
      },
    });
    await provider.request({ method: "eth_call", params: [{ to: "0x01", data: "0x" }, "latest"] });
    await provider.request({ method: "eth_chainId" });
    expect(calls).toEqual([
      ["eth_call", [{ to: "0x01", data: "0x" }, "latest"]],
      ["eth_chainId", []],
    ]);
  });
});
