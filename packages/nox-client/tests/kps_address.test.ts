import { describe, expect, it } from "vitest";
import {
  canonicalKpsAddress,
  isKpsEntryLocator,
  kpsAddressFromMetadataUrl,
  kpsAddressLabel,
  kpsEntryLocator,
  parseKpsAddress,
  parseKpsLocator,
} from "../src/kps/address.js";
import { NoxKpsError } from "../src/kps/errors.js";
import { certhashFor } from "./helpers/fake_kps.js";

const CERTHASH = certhashFor("node-1");

function expectKpsError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(NoxKpsError);
    expect((error as NoxKpsError).code).toBe(code);
    return;
  }
  throw new Error("expected a NoxKpsError");
}

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

  it("accepts a certhash produced by the KPS encoding (multibase u + sha2-256 multihash)", () => {
    for (const label of ["a", "b", "c", "node-9"]) {
      expect(parseKpsAddress(`1.2.3.4:1:${certhashFor(label)}`).port).toBe(1);
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
    for (const value of bad) expectKpsError(() => parseKpsAddress(value), "protocol-error");
  });

  it("rejects a certhash with non-zero padding bits (two spellings of one hash)", () => {
    const last = CERTHASH[CERTHASH.length - 1]!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const bumped = alphabet[(alphabet.indexOf(last) + 1) % 64]!;
    expectKpsError(
      () => parseKpsAddress(`1.2.3.4:15005:${CERTHASH.slice(0, -1)}${bumped}`),
      "protocol-error",
    );
  });

  it("canonicalizes and labels without exposing the full certhash", () => {
    expect(canonicalKpsAddress(`1.2.3.4:15005:${CERTHASH}`)).toBe(`1.2.3.4:15005:${CERTHASH}`);
    expect(kpsAddressLabel(`1.2.3.4:15005:${CERTHASH}`)).toBe(`${CERTHASH.slice(0, 12)}…`);
  });
});

describe("parseKpsLocator", () => {
  it("splits at the first slash after the address (SPEC §4.1)", () => {
    const locator = parseKpsLocator(`kps:[2001:db8::1]:15005:${CERTHASH}/api/v1/packets`);
    expect(locator.address).toBe(`[2001:db8::1]:15005:${CERTHASH}`);
    expect(locator.path).toBe("/api/v1/packets");
    expect(parseKpsLocator(`kps:1.2.3.4:9:${CERTHASH}/keccak/19/4f04?x=1`).path).toBe("/keccak/19/4f04?x=1");
  });

  it("refuses anything that is not a kps: locator as unsupported", () => {
    for (const value of ["https://nox-1.hisoka.io/api/v1/packets", "http://127.0.0.1/topology", "KPS:x/y"]) {
      expectKpsError(() => parseKpsLocator(value), "unsupported");
    }
  });

  it("rejects locators without a path or with unsafe paths", () => {
    for (const value of [
      `kps:1.2.3.4:9:${CERTHASH}`,
      `kps:/api`,
      `kps:1.2.3.4:9:${CERTHASH}/a b`,
      `kps:1.2.3.4:9:${CERTHASH}/a\r\nHost: x`,
      `kps:1.2.3.4:9:${CERTHASH}/a#frag`,
    ]) {
      expectKpsError(() => parseKpsLocator(value), "protocol-error");
    }
  });
});

describe("entry locators and metadataUrl publication", () => {
  it("builds and recognizes kps:<address> entry locators", () => {
    const locator = kpsEntryLocator(`1.2.3.4:15005:${CERTHASH}`);
    expect(locator).toBe(`kps:1.2.3.4:15005:${CERTHASH}`);
    expect(isKpsEntryLocator(locator)).toBe(true);
    expect(isKpsEntryLocator("https://nox-1.hisoka.io")).toBe(false);
    expect(isKpsEntryLocator("kps:nonsense")).toBe(false);
    expect(isKpsEntryLocator("")).toBe(false);
  });

  it("reads a KPS address from kps:<address> and kps:<address>/<path> metadataUrl values", () => {
    expect(kpsAddressFromMetadataUrl(`kps:1.2.3.4:15005:${CERTHASH}`)).toBe(`1.2.3.4:15005:${CERTHASH}`);
    expect(kpsAddressFromMetadataUrl(`kps:1.2.3.4:15005:${CERTHASH}/metadata.json`)).toBe(
      `1.2.3.4:15005:${CERTHASH}`,
    );
    expect(kpsAddressFromMetadataUrl("")).toBeUndefined();
    expect(kpsAddressFromMetadataUrl(undefined)).toBeUndefined();
    expect(kpsAddressFromMetadataUrl("https://nox-1.hisoka.io/metadata.json")).toBeUndefined();
  });

  it("reports a malformed kps: publication instead of ignoring it", () => {
    expectKpsError(() => kpsAddressFromMetadataUrl("kps:1.2.3.4:15005:uBAD"), "protocol-error");
    expectKpsError(() => kpsAddressFromMetadataUrl(`kps:1.2.3.4:15005:${CERTHASH}/a b`), "protocol-error");
  });
});
