export function bigintToString(value: bigint): string {
  return value.toString(10);
}

export function parseAmount(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error("Amount must be a non-negative integer string");
}

export function rawAmountToDecimalString(amount: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("asset decimals must be a non-negative integer");
  }
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fractional = absolute % scale;
  if (fractional === 0n) return `${negative ? "-" : ""}${whole.toString()}`;
  const fractionText = fractional.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}.${fractionText}`;
}
