const BASIS_POINTS = 10_000n;
const U128_MAX = (1n << 128n) - 1n;

export const ORACLE_MAX_OBSERVATION_AGE_SECS = 300;
export const ORACLE_MAX_FUTURE_SKEW_SECS = 30;

interface FeePlanInput {
  readonly gasEstimate: bigint;
  readonly networkFeePerGas: bigint;
  readonly nativePriceE8: bigint;
  readonly feeAssetPriceE8: bigint;
  readonly nativeDecimals: number;
  readonly feeAssetDecimals: number;
  readonly gasLimitBufferBps: bigint;
  readonly initialFeeBufferBps: bigint;
  readonly marginBps: bigint;
}

interface FeePlan {
  readonly gasLimit: bigint;
  readonly initialFeePerGas: bigint;
  readonly plannedCostE8: bigint;
  readonly requiredRevenueE8: bigint;
  readonly feeAmount: bigint;
}

export function parseOraclePriceE8(
  response: unknown,
  assetId: string,
  nowUnix: number,
): bigint {
  if (!isRecord(response)) {
    throw new Error("oracle response must be an object");
  }
  const entry = response[assetId];
  if (!isRecord(entry)) {
    throw new Error(`oracle response is missing asset ${assetId}`);
  }
  if (
    typeof entry.price_e8 !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(entry.price_e8)
  ) {
    throw new Error(`oracle price_e8 for ${assetId} is not canonical`);
  }
  const priceE8 = BigInt(entry.price_e8);
  if (priceE8 <= 0n || priceE8 > U128_MAX) {
    throw new Error(`oracle price_e8 for ${assetId} is out of range`);
  }
  if (entry.asset_id !== assetId) {
    throw new Error(`oracle asset_id does not match ${assetId}`);
  }
  if (typeof entry.source !== "string" || entry.source.length === 0) {
    throw new Error(`oracle source for ${assetId} is missing`);
  }
  if (
    typeof entry.observed_at_unix !== "number" ||
    !Number.isSafeInteger(entry.observed_at_unix) ||
    entry.observed_at_unix < 0
  ) {
    throw new Error(`oracle timestamp for ${assetId} is invalid`);
  }
  if (entry.observed_at_unix > nowUnix + ORACLE_MAX_FUTURE_SKEW_SECS) {
    throw new Error(`oracle timestamp for ${assetId} is too far in the future`);
  }
  if (nowUnix - entry.observed_at_unix > ORACLE_MAX_OBSERVATION_AGE_SECS) {
    throw new Error(`oracle price for ${assetId} is stale`);
  }
  return priceE8;
}

export function requiredFeeAmount(input: FeePlanInput): FeePlan {
  if (
    input.gasEstimate <= 0n ||
    input.networkFeePerGas <= 0n ||
    input.nativePriceE8 <= 0n ||
    input.nativePriceE8 >= U128_MAX ||
    input.feeAssetPriceE8 <= 0n
  ) {
    throw new Error("fee plan requires positive bounded gas and prices");
  }
  const nativeScale = decimalScale(input.nativeDecimals);
  const feeAssetScale = decimalScale(input.feeAssetDecimals);
  const gasLimit = buffered(input.gasEstimate, input.gasLimitBufferBps);
  const initialFeePerGas = buffered(
    input.networkFeePerGas,
    input.initialFeeBufferBps,
  );
  const plannedCostE8 = ceilDiv(
    gasLimit * initialFeePerGas * (input.nativePriceE8 + 1n),
    nativeScale,
  );
  const requiredRevenueE8 = ceilDiv(
    plannedCostE8 * (BASIS_POINTS + input.marginBps),
    BASIS_POINTS,
  );
  const feeAmount = ceilDiv(
    requiredRevenueE8 * feeAssetScale,
    input.feeAssetPriceE8,
  );
  return {
    gasLimit,
    initialFeePerGas,
    plannedCostE8,
    requiredRevenueE8,
    feeAmount,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buffered(value: bigint, bufferBps: bigint): bigint {
  if (bufferBps < 0n) {
    throw new Error("fee plan buffer cannot be negative");
  }
  return ceilDiv(value * (BASIS_POINTS + bufferBps), BASIS_POINTS);
}

function decimalScale(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("fee plan decimals must be in 0..=36");
  }
  return 10n ** BigInt(decimals);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("fee plan divisor must be positive");
  }
  return (numerator + denominator - 1n) / denominator;
}
