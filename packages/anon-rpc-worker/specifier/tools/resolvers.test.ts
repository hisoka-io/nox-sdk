import { describe, expect, it } from "vitest";
import { SAMPLE_CERTHASH, SAMPLE_HASH, SAMPLE_KPS_IPV4, SAMPLE_RESOLVERS, TORJS_MAINNET } from "../itest/sample.ts";
import { checkResolver, checkResolvers, DEFAULT_RESOLVER_POLICY, orderResolvers } from "./resolvers.ts";

const path = `/keccak/${SAMPLE_HASH.slice(2, 4)}/${SAMPLE_HASH.slice(4)}`;
const errorsOf = (entry: string, hash: string | undefined = SAMPLE_HASH) => checkResolver(entry, hash).errors;

describe("checkResolvers", () => {
  it("accepts the sample Nox resolver list, and warns that its kps: entries come before https: ones", () => {
    const report = checkResolvers(SAMPLE_RESOLVERS, SAMPLE_HASH);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([expect.stringMatching(/^resolver 0 \(kps:\) comes before resolver 2 \(https:\)/)]);
    expect(report.checks.map((c) => c.kind)).toEqual(["kps", "kps", "https", "https", "https"]);
    expect(report.totalBytes).toBe(SAMPLE_RESOLVERS.reduce((s, r) => s + r.length, 0));
  });

  it("publishes https: resolvers first by default, keeping each kind's order (stable)", () => {
    const ordered = orderResolvers(SAMPLE_RESOLVERS);
    expect(ordered.map((entry) => entry.slice(0, entry.indexOf(":")))).toEqual(["https", "https", "https", "kps", "kps"]);
    expect(ordered.filter((entry) => entry.startsWith("https:"))).toEqual(SAMPLE_RESOLVERS.filter((entry) => entry.startsWith("https:")));
    expect(ordered.filter((entry) => entry.startsWith("kps:"))).toEqual(SAMPLE_RESOLVERS.filter((entry) => entry.startsWith("kps:")));
    expect(checkResolvers(ordered, SAMPLE_HASH).warnings).toEqual([]);
    expect(orderResolvers(SAMPLE_RESOLVERS, "as-given")).toEqual(SAMPLE_RESOLVERS);
  });

  it("accepts the five resolvers of the tor-js mainnet specifier", () => {
    const report = checkResolvers(TORJS_MAINNET.resolvers, TORJS_MAINNET.workerHash);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("rejects an empty list and warns on a single resolver", () => {
    expect(checkResolvers([], SAMPLE_HASH).errors).toEqual([expect.stringMatching(/^no resolvers/)]);
    const single = checkResolvers([SAMPLE_KPS_IPV4], SAMPLE_HASH);
    expect(single.errors).toEqual([]);
    expect(single.warnings).toEqual([expect.stringMatching(/asks for 2 or more/)]);
  });

  it("rejects duplicates", () => {
    expect(checkResolvers([SAMPLE_KPS_IPV4, SAMPLE_KPS_IPV4], SAMPLE_HASH).errors).toEqual([
      expect.stringMatching(/^duplicate resolver/),
    ]);
  });
});

describe("checkResolver: kinds", () => {
  it("rejects http:, blob:, empty and whitespace entries", () => {
    expect(errorsOf("http://example.org/w.js")).toEqual([expect.stringMatching(/http: is a local-development/)]);
    expect(errorsOf("blob:https://example.org/1234")).toEqual([expect.stringMatching(/blob:/)]);
    expect(errorsOf("")).toEqual(["empty entry"]);
    expect(errorsOf(` ${SAMPLE_KPS_IPV4}`)).toEqual([expect.stringMatching(/whitespace/)]);
  });

  it("requires lowercase schemes, as harnesses match them case-sensitively", () => {
    for (const entry of [
      "HTTPS://cdn.jsdelivr.net/npm/x@1.0.0/w.js",
      "Https://unpkg.com/x@1.0.0/w.js",
      "KPS:1.2.3.4:15005:x/w",
    ]) {
      const check = checkResolver(entry, undefined);
      expect(check.errors.join(" "), entry).toMatch(/must be lowercase/u);
    }
  });

  it("treats unknown kinds as errors unless explicitly allowed", () => {
    expect(errorsOf("ipfs://bafyexample")).toEqual([expect.stringMatching(/unrecognized kind/)]);
    const allowed = checkResolver("ipfs://bafyexample", SAMPLE_HASH, {
      ...DEFAULT_RESOLVER_POLICY,
      allowUnknownKinds: true,
    });
    expect(allowed.errors).toEqual([]);
    expect(allowed.warnings).toEqual([expect.stringMatching(/harnesses ignore it/)]);
  });
});

describe("checkResolver: https", () => {
  it("rejects credentials and flags fragments and floating npm versions", () => {
    expect(errorsOf("https://user:pw@example.org/w.js")).toEqual(["must not carry credentials"]);
    expect(checkResolver("https://example.org/w.js#x", SAMPLE_HASH).warnings).toEqual([
      expect.stringMatching(/#fragment/),
    ]);
    expect(
      checkResolver("https://cdn.jsdelivr.net/npm/@hisoka-io/anon-rpc-worker@latest/dist/w.js", SAMPLE_HASH).warnings,
    ).toEqual([expect.stringMatching(/not an exact version/)]);
    expect(
      checkResolver("https://unpkg.com/@hisoka-io/anon-rpc-worker@^0.1.0/dist/w.js", SAMPLE_HASH).warnings,
    ).toEqual([expect.stringMatching(/not an exact version/)]);
    expect(checkResolver("https://unpkg.com/@hisoka-io/anon-rpc-worker/dist/w.js", SAMPLE_HASH).warnings).toEqual([
      expect.stringMatching(/pins no version/),
    ]);
    expect(
      checkResolver("https://unpkg.com/@hisoka-io/anon-rpc-worker@0.1.0-rc.1/dist/w.js", SAMPLE_HASH).warnings,
    ).toEqual([]);
    expect(checkResolver("https://example.org/npm/pkg@latest/w.js", SAMPLE_HASH).warnings).toEqual([]);
  });

  it("checks content-addressed paths against the worker hash", () => {
    const other = `0x${"cd".repeat(32)}`;
    expect(errorsOf(`https://raw.githubusercontent.com/o/r/keccak${path}`)).toEqual([]);
    expect(errorsOf(`https://raw.githubusercontent.com/o/r/keccak${path}`, other)).toEqual([
      expect.stringMatching(/content-addressed path names 0x/),
    ]);
    expect(
      errorsOf(`https://raw.githubusercontent.com/o/r/keccak${path.toUpperCase().replace("/KECCAK/", "/keccak/")}`),
    ).toEqual([expect.stringMatching(/not <2 hex>\/<62 hex> lowercase/)]);
  });
});

describe("checkResolver: kps", () => {
  const kps = (addr: string, p = path) => `kps:${addr}${p}`;

  it("accepts IPv4 and bracketed IPv6 entry nodes", () => {
    expect(errorsOf(kps(`203.0.113.10:15005:${SAMPLE_CERTHASH}`))).toEqual([]);
    expect(errorsOf(kps(`[2001:db8::10]:15005:${SAMPLE_CERTHASH}`))).toEqual([]);
  });

  it("rejects what the harness or the KPS client library would reject", () => {
    expect(errorsOf(`kps:203.0.113.10:15005:${SAMPLE_CERTHASH}`)).toEqual([expect.stringMatching(/missing \/path/)]);
    expect(errorsOf(kps(`203.0.113.10:0:${SAMPLE_CERTHASH}`))).toEqual([expect.stringMatching(/port out of range/)]);
    expect(errorsOf(kps(`203.0.113.10:0x3a9d:${SAMPLE_CERTHASH}`))).toEqual([expect.stringMatching(/malformed/)]);
    expect(errorsOf(kps("203.0.113.10:15005:mEiBfU3p"))).toEqual([expect.stringMatching(/multibase prefix/)]);
    expect(errorsOf(kps("203.0.113.10:15005:uEiBfU3p"))).toEqual([expect.stringMatching(/expected 34 bytes/)]);
  });

  it("requires an IP literal and a canonical certhash", () => {
    expect(errorsOf(kps(`entry.nox.example:15005:${SAMPLE_CERTHASH}`))).toEqual([
      expect.stringMatching(/not an IPv4 literal/),
    ]);
    expect(errorsOf(kps(`[entry.nox.example]:15005:${SAMPLE_CERTHASH}`))).toEqual([
      expect.stringMatching(/not an IPv6 literal/),
    ]);
    // Same digest, but the final character carries non-zero padding bits: decodes, yet is not canonical.
    const nonCanonical = `${SAMPLE_CERTHASH.slice(0, -1)}R`;
    expect(errorsOf(kps(`203.0.113.10:15005:${nonCanonical}`))).toEqual([expect.stringMatching(/not the canonical/)]);
  });

  it("checks the request target", () => {
    expect(errorsOf(kps(`203.0.113.10:15005:${SAMPLE_CERTHASH}`, `//keccak${path.slice(7)}`))).toEqual([
      expect.stringMatching(/must not start with \/\//),
    ]);
    expect(errorsOf(kps(`203.0.113.10:15005:${SAMPLE_CERTHASH}`), `0x${"cd".repeat(32)}`)).toEqual([
      expect.stringMatching(/content-addressed path names/),
    ]);
  });
});
