import { describe, expect, it } from "vitest";
import { castCreateArgs, formatEth, formatGwei, scenarioCost, toJson } from "./report.ts";
import type { TxPlan } from "./plan.ts";

describe("report formatting", () => {
  it("formats wei as ETH and gwei without floating point", () => {
    expect(formatEth(1n)).toBe("0.00000000 ETH");
    expect(formatEth(146_868_549_661_680n)).toBe("0.00014686 ETH");
    expect(formatEth(12n * 10n ** 18n + 5n * 10n ** 17n)).toBe("12.50000000 ETH");
    expect(formatGwei(96_969_643n)).toBe("0.0969 gwei");
    expect(formatGwei(20n * 10n ** 9n)).toBe("20.0000 gwei");
  });

  it("serialises bigints as decimal strings", () => {
    expect(JSON.parse(toJson({ gas: 1_032_324n, nested: [2n ** 70n] }))).toEqual({
      gas: "1032324",
      nested: ["1180591620717411303424"],
    });
  });

  it("builds a cast create command with the planned gas limit and the caller's signer flags", () => {
    const tx = { gasLimit: 1_238_788n } as TxPlan;
    expect(castCreateArgs("$RPC", ["--ledger"], tx, "0x6080")).toEqual([
      "send",
      "--rpc-url",
      "$RPC",
      "--ledger",
      "--gas-limit",
      "1238788",
      "--create",
      "0x6080",
    ]);
  });
});

describe("scenarioCost", () => {
  // Gas figures and tip from the 2026-10-04 mainnet fork plan (block 26,115,996, 6 resolvers, 722 bytes).
  const deploy = { gasUsedOnFork: 1_671_891n, gasLimit: 2_006_269n } as TxPlan;
  const renounce = { gasUsedOnFork: 23_361n, gasLimit: 33_793n } as TxPlan;
  const fees = { priorityFeePerGas: 21_891_683n, maxFeeBaseFeeMultiplier: 2n };
  const gwei = 10n ** 9n;

  it("reports the paid cost from gas used and the balance to hold from gas limit x fee cap", () => {
    const c = scenarioCost([deploy, renounce], 4n * gwei, fees);
    expect(c.maxFeePerGas).toBe(8n * gwei + 21_891_683n);
    expect(c.paid).toBe((1_671_891n + 23_361n) * (4n * gwei + 21_891_683n));
    expect(c.hold).toBe((2_006_269n + 33_793n) * (8n * gwei + 21_891_683n));
    expect(formatEth(c.hold)).toBe("0.01636515 ETH");
  });

  it("shows that 0.007 ETH does not cover the reference deploy at a 4 gwei base fee under cast's default cap", () => {
    const sevenMilliEth = 7n * 10n ** 15n;
    expect(scenarioCost([deploy], 4n * gwei, fees).paid).toBeLessThan(sevenMilliEth);
    expect(scenarioCost([deploy], 4n * gwei, fees).hold).toBeGreaterThan(sevenMilliEth);
    // 0.007 ETH covers the reference deploy only while the base fee stays at or below about 1.73 gwei.
    expect(scenarioCost([deploy], 1_730_000_000n, fees).hold).toBeLessThan(sevenMilliEth);
    expect(scenarioCost([deploy], 1_750_000_000n, fees).hold).toBeGreaterThan(sevenMilliEth);
  });

  it("follows the multiplier of the fee-cap rule", () => {
    const pinned = scenarioCost([deploy], 4n * gwei, { priorityFeePerGas: 0n, maxFeeBaseFeeMultiplier: 1n });
    expect(pinned.hold).toBe(2_006_269n * 4n * gwei);
    expect(scenarioCost([], 4n * gwei, fees)).toEqual({
      baseFeePerGas: 4n * gwei,
      maxFeePerGas: 8n * gwei + 21_891_683n,
      paid: 0n,
      hold: 0n,
    });
  });
});
