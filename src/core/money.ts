export function bigintToString(value: bigint): string {
  return value.toString(10);
}

export function parseAmount(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error("Amount must be a non-negative integer string");
}
