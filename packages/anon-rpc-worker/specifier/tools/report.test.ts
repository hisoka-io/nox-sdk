import { describe, expect, it } from "vitest";
import { castCreateArgs, formatEth, formatGwei, toJson } from "./report.ts";
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
