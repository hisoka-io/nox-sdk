import { describe, expect, it } from "vitest";
import {
  parseOraclePriceE8,
  requiredFeeAmount,
} from "./internal/paid_economics.js";

const NOW = 1_800_000_000;

describe("live paid economics", () => {
  it("parses a canonical fresh asset-bound E8 quote", () => {
    expect(
      parseOraclePriceE8(
        {
          ethereum: {
            price_e8: "250012345678",
            observed_at_unix: NOW - 10,
            asset_id: "ethereum",
            source: "aggregate",
          },
        },
        "ethereum",
        NOW,
      ),
    ).toBe(250_012_345_678n);
  });

  it.each([
    { ethereum: { price: 2500 } },
    {
      ethereum: {
        price_e8: "0",
        observed_at_unix: NOW,
        asset_id: "ethereum",
        source: "aggregate",
      },
    },
    {
      ethereum: {
        price_e8: "01",
        observed_at_unix: NOW,
        asset_id: "ethereum",
        source: "aggregate",
      },
    },
    {
      ethereum: {
        price_e8: "1",
        observed_at_unix: NOW - 301,
        asset_id: "ethereum",
        source: "aggregate",
      },
    },
    {
      ethereum: {
        price_e8: "1",
        observed_at_unix: NOW + 31,
        asset_id: "ethereum",
        source: "aggregate",
      },
    },
    {
      ethereum: {
        price_e8: "1",
        observed_at_unix: NOW,
        asset_id: "bitcoin",
        source: "aggregate",
      },
    },
  ])("rejects unsafe oracle response %#", (response) => {
    expect(() => parseOraclePriceE8(response, "ethereum", NOW)).toThrow();
  });

  it("uses buffered integer gas and conservative rounding", () => {
    expect(
      requiredFeeAmount({
        gasEstimate: 100n,
        networkFeePerGas: 100_000_000n,
        nativePriceE8: 100_000_000n,
        feeAssetPriceE8: 100_000_000n,
        nativeDecimals: 18,
        feeAssetDecimals: 18,
        gasLimitBufferBps: 2_000n,
        initialFeeBufferBps: 2_000n,
        marginBps: 1_000n,
      }),
    ).toEqual({
      gasLimit: 120n,
      initialFeePerGas: 120_000_000n,
      plannedCostE8: 2n,
      requiredRevenueE8: 3n,
      feeAmount: 30_000_000_000n,
    });
  });
});
