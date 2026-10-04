import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeExitHttpResponse, encodeExitHttpResponse } from "../../src/bincode-http.js";
import { E2E_ROOT } from "../../src/config.js";
import { ContentStore, keccakName, keccakPath, normalizeHash, parseKeccakPath } from "../../src/content-store.js";
import { TestbedError } from "../../src/errors.js";
import { formatKpsAddress, parseKpsAddress, renderTemplate, splitCommand, type SidecarVars } from "../../src/kps-server.js";
import { meshNodeAddress, parseMeshInfo } from "../../src/mesh.js";
import { assertTcpPortsFree, freeTcpPort, meshPorts } from "../../src/ports.js";
import { percentile } from "../../src/report.js";
import { loadSpecifierArtifact } from "../../src/specifier.js";
import { buildRequest, certhashOf, parseResponse } from "../../shared/kps-http.js";

/** A syntactically valid certhash: multibase "u" + base64url(0x12 0x20 || 32 bytes). */
function certhash(fill: number): string {
  const digest = Buffer.concat([Buffer.from([0x12, 0x20]), Buffer.alloc(32, fill)]);
  return `u${digest.toString("base64url")}`;
}

describe("exit HttpRequest reply (bincode SerializableHttpResponse)", () => {
  it("round-trips", () => {
    const original = {
      status: 200,
      headers: new Map([["content-type", "application/json"], ["x-a", "é"]]),
      body: new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":"0x1"}'),
      truncated: false,
    };
    const decoded = decodeExitHttpResponse(encodeExitHttpResponse(original));
    expect(decoded.status).toBe(200);
    expect([...decoded.headers]).toEqual([...original.headers]);
    expect(decoded.body).toEqual(original.body);
    expect(decoded.truncated).toBe(false);
  });

  it("rejects truncated input, trailing bytes and a bad bool", () => {
    const bytes = encodeExitHttpResponse({ status: 502, headers: new Map(), body: new Uint8Array(3), truncated: true });
    expect(() => decodeExitHttpResponse(bytes.subarray(0, bytes.length - 1))).toThrow(TestbedError);
    expect(() => decodeExitHttpResponse(new Uint8Array([...bytes, 0]))).toThrow(/trailing/u);
    const badBool = bytes.slice();
    badBool[badBool.length - 1] = 7;
    expect(() => decodeExitHttpResponse(badBool)).toThrow(/not 0\/1/u);
  });

  it("refuses a length prefix larger than the payload", () => {
    const bytes = new Uint8Array(2 + 8);
    bytes.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f], 2);
    expect(() => decodeExitHttpResponse(bytes)).toThrow(/exceeds the payload/u);
  });
});

describe("content-addressed resolver store", () => {
  const bytes = new TextEncoder().encode("worker bytes");

  it("stores bundles under keccak256 with the keccak-branch path layout", () => {
    const store = new ContentStore();
    const hash = store.put(bytes);
    expect(hash).toBe(`0x${keccakName(bytes)}`);
    const path = keccakPath(hash);
    expect(path).toMatch(/^\/keccak\/[0-9a-f]{2}\/[0-9a-f]{62}$/u);
    expect(parseKeccakPath(path)).toBe(keccakName(bytes));
    expect(store.get(hash)).toEqual(bytes);
    expect(store.has(hash.toUpperCase().replace("0X", "0x"))).toBe(true);
  });

  it("rejects malformed hashes and paths", () => {
    expect(() => normalizeHash("0x1234")).toThrow(TestbedError);
    expect(parseKeccakPath("/keccak/AB/" + "c".repeat(62))).toBeUndefined();
    expect(parseKeccakPath("/keccak/ab/../" + "c".repeat(59))).toBeUndefined();
  });

  it("only stores mismatched bytes when they really mismatch", () => {
    const store = new ContentStore();
    const hash = `0x${keccakName(bytes)}`;
    expect(() => store.putMismatched(hash, bytes)).toThrow(/do match/u);
    const other = `0x${"11".repeat(32)}`;
    store.putMismatched(other, bytes);
    expect(store.get(other)).toEqual(bytes);
  });
});

describe("KPS addresses", () => {
  it("parses and formats IPv4 and bracketed IPv6 addresses", () => {
    const v4 = `127.0.0.1:15005:${certhash(7)}`;
    expect(formatKpsAddress(parseKpsAddress(v4))).toBe(v4);
    const v6 = `[::1]:443:${certhash(9)}`;
    expect(parseKpsAddress(v6).ip).toBe("::1");
    expect(formatKpsAddress(parseKpsAddress(v6))).toBe(v6);
  });

  it("rejects bad ports, octets and certhashes", () => {
    expect(() => parseKpsAddress(`127.0.0.1:0:${certhash(1)}`)).toThrow(/port/u);
    expect(() => parseKpsAddress(`256.0.0.1:5:${certhash(1)}`)).toThrow(/IPv4/u);
    expect(() => parseKpsAddress(`127.0.0.1:5:u${Buffer.alloc(34).toString("base64url")}`)).toThrow(/sha2-256/u);
    expect(() => parseKpsAddress("kps:127.0.0.1:5:uAA")).toThrow(TestbedError);
  });

  it("extracts the certhash used as the KPS-HTTP Host", () => {
    expect(certhashOf(`[::1]:1:${certhash(2)}`)).toBe(certhash(2));
  });
});

describe("nox-kps sidecar templates", () => {
  const vars: SidecarVars = {
    node: 3,
    node_address: "0x0000000000000000000000000000000000b00003",
    udp_port: 27_035,
    advertise_ip: "127.0.0.1",
    listen: "127.0.0.1:27035",
    ingress_port: 27_032,
    ingress_url: "http://127.0.0.1:27032",
    topology_port: 27_031,
    topology_url: "http://127.0.0.1:27031/topology",
    admin_port: 27_036,
    key_file: "/run/kps/node-3.key",
    config_file: "/run/kps/node-3.conf",
    bundle_dir: "/run/keccak",
  };

  it("substitutes placeholders and splits without a shell", () => {
    const rendered = renderTemplate("/bin/nox-kps --config {config_file} run --port {udp_port}", vars);
    expect(splitCommand(rendered)).toEqual({
      command: "/bin/nox-kps",
      args: ["--config", "/run/kps/node-3.conf", "run", "--port", "27035"],
    });
  });

  it("fails loudly on unknown placeholders and empty commands", () => {
    expect(() => renderTemplate("x {nodes}", vars)).toThrow(/unknown placeholder \{nodes\}/u);
    expect(() => splitCommand("   ")).toThrow(/empty command/u);
  });
});

describe("mesh_info.json", () => {
  const sample = JSON.parse(readFileSync(join(E2E_ROOT, "tests", "unit", "fixtures", "mesh_info.json"), "utf8")) as {
    nodes: Record<string, unknown>[];
  };

  it("parses the file nox_mesh_server writes", () => {
    const info = parseMeshInfo(sample);
    expect(info.nodeCount).toBe(3);
    expect(info.nodes[1]?.ingressUrl).toBe("http://127.0.0.1:27012");
    expect(info.nodes[1]?.topologyUrl).toBe("http://127.0.0.1:27011/topology");
    expect(info.nodes[2]?.address).toBe(meshNodeAddress(2));
  });

  it("matches process_mesh::mesh_node_address", () => {
    expect(meshNodeAddress(0)).toBe("0x0000000000000000000000000000000000b00000");
    expect(meshNodeAddress(9)).toBe("0x0000000000000000000000000000000000b00009");
  });

  it("rejects a node list that disagrees with node_count or carries bad fields", () => {
    expect(() => parseMeshInfo({ ...sample, node_count: 4 })).toThrow(/must list 4 nodes/u);
    const badKey = { ...sample, nodes: sample.nodes.map((n, i) => (i === 0 ? { ...n, sphinx_public_key: "xyz" } : n)) };
    expect(() => parseMeshInfo(badKey)).toThrow(/sphinx_public_key/u);
    const shuffled = { ...sample, nodes: [...sample.nodes].reverse() };
    expect(() => parseMeshInfo(shuffled)).toThrow(/\.id is/u);
  });
});

describe("KPS-HTTP/1 client codec", () => {
  it("builds a request with Host = certhash and an exact Content-Length", () => {
    const body = new TextEncoder().encode("{}");
    const text = new TextDecoder().decode(
      buildRequest({ method: "POST", path: "/api/v1/responses/claim", headers: [["Content-Length", "99"], ["x-a", "1"]], body }, "uHASH"),
    );
    expect(text).toBe("POST /api/v1/responses/claim HTTP/1.1\r\nHost: uHASH\r\nx-a: 1\r\nContent-Length: 2\r\n\r\n{}");
  });

  it("refuses header injection and bad request lines", () => {
    const base = { method: "GET", path: "/topology", headers: [] as [string, string][], body: new Uint8Array(0) };
    expect(() => buildRequest({ ...base, headers: [["x", "a\r\nb: c"]] }, "u")).toThrow(/line break/u);
    expect(() => buildRequest({ ...base, method: "get" }, "u")).toThrow(/invalid method/u);
    expect(() => buildRequest({ ...base, path: "topology" }, "u")).toThrow(/invalid path/u);
  });

  it("parses EOF-delimited responses and enforces the profile", () => {
    const ok = parseResponse(new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: text/plain\r\n\r\nhi"));
    expect(ok.status).toBe(200);
    expect(new TextDecoder().decode(ok.body)).toBe("hi");
    expect(ok.headers).toContainEqual(["content-type", "text/plain"]);
    expect(() => parseResponse(new TextEncoder().encode("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"))).toThrow(
      /Transfer-Encoding/u,
    );
    expect(() => parseResponse(new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhi"))).toThrow(
      /Content-Length 5/u,
    );
    expect(() => parseResponse(new TextEncoder().encode("garbage"))).toThrow(/terminator/u);
  });
});

describe("helpers", () => {
  it("nearest-rank percentile", () => {
    expect(percentile([], 50)).toBeUndefined();
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 100)).toBe(5);
    expect(percentile([10], 1)).toBe(10);
  });

  it("lists the three TCP ports of every mesh node", () => {
    expect(meshPorts(27_000, 2)).toEqual([27_000, 27_001, 27_002, 27_010, 27_011, 27_012]);
  });

  it("detects a busy port", async () => {
    const port = await freeTcpPort();
    await expect(assertTcpPortsFree([port], "probe", "127.0.0.1")).resolves.toBeUndefined();
    const { createServer } = await import("node:net");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      await expect(assertTcpPortsFree([port], "probe", "127.0.0.1")).rejects.toThrow(new RegExp(String(port), "u"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("vendored WorkerSpecifier artifact", () => {
  it("records the sha256 of the vendored source it was compiled from", () => {
    const artifact = loadSpecifierArtifact();
    const source = readFileSync(join(E2E_ROOT, "contracts", "WorkerSpecifier.sol"));
    expect(artifact.source.sha256).toBe(createHash("sha256").update(source).digest("hex"));
    expect(artifact.compiler.solc.startsWith("0.8.28+")).toBe(true);
    expect(artifact.bytecode.length).toBeGreaterThan(1_000);
  });
});
