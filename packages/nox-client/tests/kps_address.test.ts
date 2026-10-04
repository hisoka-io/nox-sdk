import { describe, expect, it } from "vitest";
import {
  isKpsAddress,
  kpsAddrFromMetadataUrl,
  kpsAddressLabel,
  kpsAddressOfEntry,
  kpsEntryEndpoint,
  parseKpsAddress,
  parseKpsEndpoint,
} from "../src/kps/address.js";
import { NoxKpsError } from "../src/kps/errors.js";
import { certhashFor } from "./helpers/fake_kps.js";

const CERTHASH = certhashFor("node-1");

describe("parseKpsAddress", () => {
  it("parses IPv4 and bracketed IPv6 addresses", () => {
    expect(parseKpsAddress(`3.236.170.102:15005:${CERTHASH}`)).toEqual({
      address: `3.236.170.102:15005:${CERTHASH}`,
      host: "3.236.170.102",
      port: 15005,
      certhash: CERTHASH,
      ipv6: false,
    });
    const v6 = parseKpsAddress(`[2400:6180:10:200::cca4:4000]:12298:${CERTHASH}`);
    expect(v6.host).toBe("2400:6180:10:200::cca4:4000");
    expect(v6.ipv6).toBe(true);
    expect(v6.address).toBe(`[2400:6180:10:200::cca4:4000]:12298:${CERTHASH}`);
  });

  it("accepts certhashes in the KPS encoding (multibase u + sha2-256 multihash)", () => {
    for (const label of ["a", "b", "c", "node-9"]) {
      const certhash = certhashFor(label);
      expect(certhash).toMatch(/^uEi[ABCD][A-Za-z0-9_-]{43}$/u);
      expect(parseKpsAddress(`1.2.3.4:1:${certhash}`).port).toBe(1);
    }
  });

  it("rejects malformed hosts, ports and certhashes", () => {
    const bad = [
      "",
      `nox-1.hisoka.io:15005:${CERTHASH}`,
      `256.1.1.1:15005:${CERTHASH}`,
      `1.2.3:15005:${CERTHASH}`,
      `2400:6180::1:15005:${CERTHASH}`,
      `[1.2.3.4]:15005:${CERTHASH}`,
      `[::1:15005:${CERTHASH}`,
      `1.2.3.4:0:${CERTHASH}`,
      `1.2.3.4:65536:${CERTHASH}`,
      `1.2.3.4:015005:${CERTHASH}`,
      `1.2.3.4:0x1bb:${CERTHASH}`,
      `1.2.3.4:15005`,
      `1.2.3.4:15005:`,
      `1.2.3.4:15005:${CERTHASH.slice(1)}`,
      `1.2.3.4:15005:${CERTHASH}A`,
      `1.2.3.4:15005:${CERTHASH.slice(0, -1)}+`,
      // sha2-512 multihash prefix instead of sha2-256.
      `1.2.3.4:15005:u${Buffer.concat([Buffer.from([0x13, 0x20]), Buffer.alloc(32)]).toString("base64url")}`,
    ];
    for (const value of bad) {
      expect(() => parseKpsAddress(value)).toThrow(NoxKpsError);
      expect(isKpsAddress(value)).toBe(false);
    }
  });

  it("rejects a certhash with non-zero padding bits (two spellings of one hash)", () => {
    const last = CERTHASH[CERTHASH.length - 1]!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const bumped = alphabet[(alphabet.indexOf(last) + 1) % 64]!;
    expect(isKpsAddress(`1.2.3.4:15005:${CERTHASH.slice(0, -1)}${bumped}`)).toBe(false);
  });

  it("labels an address by a certhash prefix", () => {
    expect(kpsAddressLabel(`1.2.3.4:15005:${CERTHASH}`)).toBe(`${CERTHASH.slice(0, 12)}…`);
  });
});

describe("parseKpsEndpoint", () => {
  it("splits at the first slash after the address (SPEC §4.1)", () => {
    expect(parseKpsEndpoint(`kps:[2001:db8::1]:15005:${CERTHASH}/api/v1/packets`)).toEqual({
      addr: `[2001:db8::1]:15005:${CERTHASH}`,
      target: "/api/v1/packets",
    });
    expect(parseKpsEndpoint(`kps:1.2.3.4:9:${CERTHASH}/keccak/19/4f04?x=1`)?.target).toBe("/keccak/19/4f04?x=1");
  });

  it("returns null for non-kps input and malformed endpoints", () => {
    for (const value of [
      "https://nox-1.hisoka.io/api/v1/packets",
      "http://127.0.0.1/topology",
      "KPS:x/y",
      `kps:1.2.3.4:9:${CERTHASH}`,
      "kps:/api",
      `kps:1.2.3.4:9:${CERTHASH}/a b`,
      `kps:1.2.3.4:9:${CERTHASH}/a\r\nHost: x`,
      `kps:1.2.3.4:9:${CERTHASH}/a#frag`,
      `kps:1.2.3.4:9:uBAD/x`,
    ]) {
      expect(parseKpsEndpoint(value)).toBeNull();
    }
  });
});

describe("entry endpoints and metadataUrl publication", () => {
  it("builds and reads kps:<address> entry endpoints", () => {
    const endpoint = kpsEntryEndpoint(`1.2.3.4:15005:${CERTHASH}`);
    expect(endpoint).toBe(`kps:1.2.3.4:15005:${CERTHASH}`);
    expect(kpsAddressOfEntry(endpoint)).toBe(`1.2.3.4:15005:${CERTHASH}`);
    expect(kpsAddressOfEntry("https://nox-1.hisoka.io")).toBeNull();
    expect(kpsAddressOfEntry("kps:nonsense")).toBeNull();
    expect(kpsAddressOfEntry("")).toBeNull();
  });

  it("reads exactly kps:<address>/metadata.json (ARCHITECTURE §6)", () => {
    expect(kpsAddrFromMetadataUrl(`kps:3.239.73.249:15005:${CERTHASH}/metadata.json`)).toBe(
      `3.239.73.249:15005:${CERTHASH}`,
    );
  });

  it("treats anything else as 'no KPS endpoint'", () => {
    for (const value of [
      "",
      "https://nox-4.hisoka.io/metadata.json",
      `kps:3.239.73.249:15005:${CERTHASH}`,
      `kps:3.239.73.249:15005:${CERTHASH}/`,
      `kps:3.239.73.249:15005:${CERTHASH}/metadata.json?x`,
      `kps:3.239.73.249:15005:${CERTHASH}/other.json`,
      "kps:3.239.73.249:15005:uBAD/metadata.json",
      `kps:3.239.73.249:015005:${CERTHASH}/metadata.json`,
      ` kps:3.239.73.249:15005:${CERTHASH}/metadata.json`,
    ]) {
      expect(kpsAddrFromMetadataUrl(value)).toBeNull();
    }
  });
});
