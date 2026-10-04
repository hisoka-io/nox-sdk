// End to end on a local anvil chain: deploy both specifier contracts with the sample bundle hash and resolvers,
// then boot-resolve them exactly as a wallet does, through the reference harness's own §4 code
// (readSpecifier -> fetchAndVerifyBundle from @anon-rpc/browser-harness 0.3.2).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAnvil, type Anvil } from "../tools/anvil.ts";
import { loadArtifact, MAINNET_REFERENCE_CODEHASH, PROJECT_ROOT, type Variant } from "../tools/artifacts.ts";
import {
  creationCode,
  renounceOwnershipCalldata,
  setWorkerCalldata,
  transferOwnershipCalldata,
} from "../tools/deployment.ts";
import { fetchAndVerifyBundle, HARNESS_PACKAGE, parseKpsResolver, readSpecifier } from "../tools/harness.ts";
import { harnessProvider, RpcError, waitForReceipt } from "../tools/rpc.ts";
import { inspectSpecifier, type KnownArtifacts } from "../tools/specifier.ts";
import {
  SAMPLE_BUNDLE,
  SAMPLE_CERTHASH,
  SAMPLE_GITHUB,
  SAMPLE_HASH,
  SAMPLE_JSDELIVR,
  SAMPLE_KPS_IPV4,
  SAMPLE_KPS_IPV6,
  SAMPLE_RESOLVERS,
  SAMPLE_UNPKG,
} from "./sample.ts";

const VARIANTS: readonly Variant[] = ["immutable", "reference"];

let anvil: Anvil;
let artifacts: KnownArtifacts;
let deployer: string;
let server: Server;
let origin: string;
const served = new Map<string, Uint8Array>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function send(tx: Record<string, string>): Promise<Record<string, unknown>> {
  const hash = await anvil.rpc.request("eth_sendTransaction", [{ from: deployer, ...tx }]);
  if (typeof hash !== "string") throw new Error(`eth_sendTransaction returned ${JSON.stringify(hash)}`);
  const receipt = await waitForReceipt(anvil.rpc, hash, 15_000);
  if (receipt["status"] !== "0x1") throw new Error(`transaction failed: ${JSON.stringify(receipt)}`);
  return receipt;
}

async function deploy(variant: Variant, hash: string, resolvers: readonly string[]): Promise<string> {
  const receipt = await send({ data: creationCode(artifacts[variant], hash, resolvers) });
  const address = receipt["contractAddress"];
  if (typeof address !== "string") throw new Error("no contract address in receipt");
  return address;
}

/**
 * Runs `fn` with the harness's global fetch routing the sample https: resolvers to the local HTTP server, the same
 * substitution the harness's own tests use (`withFetch` in browser-harness/test/specifier.test.ts). Returns the
 * URLs the harness requested, in order.
 */
async function withRoutedFetch<T>(
  routes: Readonly<Record<string, string>>,
  fn: () => Promise<T>,
): Promise<{ result: T; requested: string[] }> {
  const original = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    const path = routes[url];
    if (path === undefined) return new Response("not routed in this test", { status: 404 });
    return original(`${origin}${path}`, init);
  }) as typeof fetch;
  try {
    return { result: await fn(), requested };
  } finally {
    globalThis.fetch = original;
  }
}

const ROUTES: Readonly<Record<string, string>> = {
  [SAMPLE_JSDELIVR]: "/npm/worker.js",
  [SAMPLE_UNPKG]: "/npm/worker.js",
  [SAMPLE_GITHUB]: `/keccak/${SAMPLE_HASH.slice(2, 4)}/${SAMPLE_HASH.slice(4)}`,
};

beforeAll(async () => {
  artifacts = { reference: await loadArtifact("reference"), immutable: await loadArtifact("immutable") };
  anvil = await startAnvil({ startTimeoutMs: 30_000, rpcTimeoutMs: 15_000 });
  const accounts = await anvil.rpc.request("eth_accounts");
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") throw new Error("anvil has no unlocked account");
  deployer = accounts[0];

  served.set("/npm/worker.js", SAMPLE_BUNDLE);
  served.set(`/keccak/${SAMPLE_HASH.slice(2, 4)}/${SAMPLE_HASH.slice(4)}`, SAMPLE_BUNDLE);
  served.set("/tampered.js", new TextEncoder().encode("// not the pinned bytes\n"));
  server = createServer((req, res) => {
    const body = served.get(req.url ?? "");
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/javascript" }).end(Buffer.from(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("resolver server has no port");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await anvil?.stop();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

describe("the reference harness code under test", () => {
  it("is @anon-rpc/browser-harness 0.3.2 with the §4 sources of ethereum/anon-rpc f2c8a75", async () => {
    const dir = `${PROJECT_ROOT}/node_modules/@anon-rpc/browser-harness`;
    const pkg: unknown = JSON.parse(await readFile(`${dir}/package.json`, "utf8"));
    expect(isRecord(pkg) ? `${String(pkg["name"])}@${String(pkg["version"])}` : null).toBe(HARNESS_PACKAGE);
    const sha256 = async (path: string) =>
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    expect(await sha256(`${dir}/src/host/specifier.ts`)).toBe(
      "3d7eb4febdb2019cf5503e3fc7516c88c7baea27bccb6afa7f910b0d6fba7102",
    );
    expect(await sha256(`${dir}/src/host/kps-http.ts`)).toBe(
      "ee4b5862a9271fa75fda6c1571dcb7a7bca219fcf2dfc2b9fae19f007bc2cff5",
    );
  });
});

describe.each(VARIANTS)("%s specifier, resolved through the harness", (variant) => {
  let address: string;

  beforeAll(async () => {
    address = await deploy(variant, SAMPLE_HASH, SAMPLE_RESOLVERS);
  });

  it("returns the pinned hash and every resolver verbatim, in order", async () => {
    const spec = await readSpecifier(harnessProvider(anvil.rpc), address);
    expect(spec.workerHash).toBe(SAMPLE_HASH);
    expect(spec.resolvers).toEqual(SAMPLE_RESOLVERS);
  });

  it("stores kps: entries that the harness splits into a KPS address and request target", async () => {
    const spec = await readSpecifier(harnessProvider(anvil.rpc), address);
    const path = `/keccak/${SAMPLE_HASH.slice(2, 4)}/${SAMPLE_HASH.slice(4)}`;
    expect(parseKpsResolver(spec.resolvers[0] ?? "")).toEqual({ addr: `203.0.113.10:15005:${SAMPLE_CERTHASH}`, path });
    expect(parseKpsResolver(spec.resolvers[1] ?? "")).toEqual({
      addr: `[2001:db8::10]:15005:${SAMPLE_CERTHASH}`,
      path,
    });
  });

  it("boots the bundle: kps: entries reach the WebRTC dial, then the first https: resolver serves verified bytes", async () => {
    const spec = await readSpecifier(harnessProvider(anvil.rpc), address);
    const { result, requested } = await withRoutedFetch(ROUTES, () => fetchAndVerifyBundle(spec));
    expect(result).toEqual(SAMPLE_BUNDLE);
    expect(requested).toEqual([SAMPLE_JSDELIVR]);
  });

  it("gets past KPS address and certhash parsing for both kps: entries (Node has no RTCPeerConnection)", async () => {
    const spec = await readSpecifier(harnessProvider(anvil.rpc), address);
    const kpsOnly = { workerHash: spec.workerHash, resolvers: spec.resolvers.filter((r) => r.startsWith("kps:")) };
    const failure = fetchAndVerifyBundle(kpsOnly);
    await expect(failure).rejects.toThrow(/no resolver yielded bytes matching workerHash/);
    const message: string = await failure.then(
      () => "",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(message.match(/RTCPeerConnection is not defined/g)?.length).toBe(2);
    expect(message).not.toMatch(/malformed|certhash:|address:/);
  });

  it("skips a resolver that serves other bytes and falls through to the next", async () => {
    const spec = await readSpecifier(harnessProvider(anvil.rpc), address);
    const routes = { ...ROUTES, [SAMPLE_JSDELIVR]: "/tampered.js" };
    const { result, requested } = await withRoutedFetch(routes, () => fetchAndVerifyBundle(spec));
    expect(result).toEqual(SAMPLE_BUNDLE);
    expect(requested).toEqual([SAMPLE_JSDELIVR, SAMPLE_UNPKG]);
  });

  it("is classified, and its update policy stated, by the read-only inspector", async () => {
    const inspection = await inspectSpecifier(anvil.rpc, address, artifacts);
    expect(inspection.workerHash).toBe(SAMPLE_HASH);
    expect(inspection.resolvers).toEqual(SAMPLE_RESOLVERS);
    expect(inspection.resolverReport.errors).toEqual([]);
    if (variant === "immutable") {
      expect(inspection.contract).toBe("ImmutableWorkerSpecifier");
      expect(inspection.owner).toEqual({ kind: "none" });
      expect(inspection.stateChangingOpcodes).toEqual([]);
      expect(inspection.updatePolicy).toMatch(/^immutable: no owner and no setters/);
    } else {
      expect(inspection.contract).toBe("reference WorkerSpecifier");
      expect(inspection.runtimeCodehash).toBe(MAINNET_REFERENCE_CODEHASH);
      expect(inspection.owner).toMatchObject({ kind: "eoa" });
      expect(inspection.stateChangingOpcodes).toContain("SSTORE");
      expect(inspection.updatePolicy).toMatch(/^owner-updatable: EOA/);
    }
  });
});

describe("update behaviour seen through the harness", () => {
  const nextHash = `0x${"ab".repeat(32)}`;
  const nextResolvers = ["https://example.org/next.js", SAMPLE_KPS_IPV4];

  it("immutable: every owner call reverts and the harness keeps reading the original version", async () => {
    const address = await deploy("immutable", SAMPLE_HASH, SAMPLE_RESOLVERS);
    for (const data of [
      setWorkerCalldata(nextHash, nextResolvers),
      transferOwnershipCalldata(deployer),
      renounceOwnershipCalldata(),
    ]) {
      await expect(anvil.rpc.request("eth_call", [{ from: deployer, to: address, data }, "latest"])).rejects.toThrow(
        RpcError,
      );
    }
    const spec = await readSpecifier(harnessProvider(anvil.rpc), address);
    expect(spec).toEqual({ workerHash: SAMPLE_HASH, resolvers: SAMPLE_RESOLVERS });
  });

  it("reference: the owner repoints the same address, then renouncing freezes it", async () => {
    const address = await deploy("reference", SAMPLE_HASH, SAMPLE_RESOLVERS);
    await send({ to: address, data: setWorkerCalldata(nextHash, nextResolvers) });
    expect(await readSpecifier(harnessProvider(anvil.rpc), address)).toEqual({
      workerHash: nextHash,
      resolvers: nextResolvers,
    });
    await send({ to: address, data: renounceOwnershipCalldata() });
    const inspection = await inspectSpecifier(anvil.rpc, address, artifacts);
    expect(inspection.owner).toEqual({ kind: "renounced" });
    expect(inspection.updatePolicy).toMatch(/^frozen/);
  });

  it("reference: ownership handed to a contract is reported as such", async () => {
    const address = await deploy("reference", SAMPLE_HASH, SAMPLE_RESOLVERS);
    const contractOwner = await deploy("immutable", SAMPLE_HASH, SAMPLE_RESOLVERS);
    await send({ to: address, data: transferOwnershipCalldata(contractOwner) });
    const inspection = await inspectSpecifier(anvil.rpc, address, artifacts);
    expect(inspection.owner).toMatchObject({ kind: "contract" });
    expect(inspection.updatePolicy).toMatch(/^owner-updatable through contract/);
  });

  it("both contracts give a harness identical views of the same release", async () => {
    const a = await deploy("immutable", SAMPLE_HASH, SAMPLE_RESOLVERS);
    const b = await deploy("reference", SAMPLE_HASH, SAMPLE_RESOLVERS);
    const provider = harnessProvider(anvil.rpc);
    expect(await readSpecifier(provider, a)).toEqual(await readSpecifier(provider, b));
  });
});
