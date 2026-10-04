import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { kpsAddrFromMetadataUrl, parseKpsAddress } from "../scripts/lib/kps-address.mjs";

function certhashOf(der: string): string {
  const digest = createHash("sha256").update(der).digest();
  return `u${Buffer.concat([Buffer.from([0x12, 0x20]), digest]).toString("base64url")}`;
}

const CERTHASH = certhashOf("test certificate");

describe("parseKpsAddress", () => {
  it("accepts IPv4 and bracketed IPv6 addresses with a sha2-256 certhash", () => {
    expect(CERTHASH).toHaveLength(47);
    expect(CERTHASH.startsWith("uEi")).toBe(true);
    expect(parseKpsAddress(`3.239.73.249:15005:${CERTHASH}`)).toEqual({
      address: `3.239.73.249:15005:${CERTHASH}`,
      ip: "3.239.73.249",
      port: 15005,
      certhash: CERTHASH,
    });
    expect(parseKpsAddress(`[2001:db8::1]:15005:${CERTHASH}`).ip).toBe("2001:db8::1");
  });

  it.each([
    ["an unbracketed IPv6 host", `2001:db8::1:15005:${CERTHASH}`],
    ["a hostname", `nox-4.hisoka.io:15005:${CERTHASH}`],
    ["a port with a leading zero", `3.239.73.249:015005:${CERTHASH}`],
    ["port 0", `3.239.73.249:0:${CERTHASH}`],
    ["a port above 65535", `3.239.73.249:65536:${CERTHASH}`],
    ["a short certhash", `3.239.73.249:15005:${CERTHASH.slice(0, 40)}`],
    ["a certhash with another multihash code", `3.239.73.249:15005:u${Buffer.concat([Buffer.from([0x13, 0x20]), Buffer.alloc(32)]).toString("base64url")}`],
    ["a padded certhash", `3.239.73.249:15005:${CERTHASH}=`],
  ])("rejects %s", (_label, value) => {
    expect(() => parseKpsAddress(value)).toThrow();
  });
});

describe("kpsAddrFromMetadataUrl", () => {
  it("accepts exactly kps:<address>/metadata.json", () => {
    const result = kpsAddrFromMetadataUrl(`kps:3.239.73.249:15005:${CERTHASH}/metadata.json`);
    expect(result.reason).toBeNull();
    expect(result.endpoint?.address).toBe(`3.239.73.249:15005:${CERTHASH}`);
  });

  it("treats non-kps values as no endpoint without a reason", () => {
    expect(kpsAddrFromMetadataUrl("")).toEqual({ endpoint: null, reason: null });
    expect(kpsAddrFromMetadataUrl("https://nox-4.hisoka.io/metadata.json")).toEqual({ endpoint: null, reason: null });
  });

  it.each([
    ["no path", `kps:3.239.73.249:15005:${CERTHASH}`, /missing the "\/metadata.json" path/u],
    ["another path", `kps:3.239.73.249:15005:${CERTHASH}/keccak/ab/cd`, /must be exactly "\/metadata.json"/u],
    ["a trailing query", `kps:3.239.73.249:15005:${CERTHASH}/metadata.json?x=1`, /must be exactly/u],
    ["a bad certhash", "kps:3.239.73.249:15005:uEiBnope/metadata.json", /certhash/u],
  ])("explains a kps: value with %s", (_label, value, reason) => {
    const result = kpsAddrFromMetadataUrl(value);
    expect(result.endpoint).toBeNull();
    expect(result.reason).toMatch(reason);
  });
});
