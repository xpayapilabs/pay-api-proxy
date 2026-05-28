import type { ActualUsageAmount, PriceQuote } from "./types.js";

export type SessionReserveMode = "max-quote";
export type SessionSettlementMode = "actual-usage";

export interface SessionUnitConfig {
  unitAmount: bigint;
  unitType: string;
}

export interface SessionBillingConfig extends SessionUnitConfig {
  reserveMode: SessionReserveMode;
  settlementMode: SessionSettlementMode;
}

export interface SessionReservationQuote {
  reservedAmount: bigint;
  reservedUnits: bigint;
  reserveMode: SessionReserveMode;
  unitAmount: bigint;
  unitType: string;
}

export interface SessionSettlementAmount {
  inputAmount: bigint;
  outputAmount: bigint;
  minimumAdjustmentAmount: bigint;
  totalAmount: bigint;
  inputUnits: bigint;
  outputUnits: bigint;
  minimumAdjustmentUnits: bigint;
  totalUnits: bigint;
  settlementMode: SessionSettlementMode;
  unitAmount: bigint;
  unitType: string;
}

export type SessionChargeComponent = "input" | "output" | "minimum-adjustment";

export interface SessionUnitCharge {
  component: SessionChargeComponent;
  amount: bigint;
  units: bigint;
  unitAmount: bigint;
  unitType: string;
}

export interface SessionUnitChargeSink {
  charge(units: bigint, charge: SessionUnitCharge): Promise<void>;
}

export function amountToSessionUnits(amount: bigint, unitAmount: bigint): bigint {
  if (amount <= 0n) return 0n;
  if (unitAmount <= 0n) throw new Error("session unitAmount must be greater than zero");
  return (amount + unitAmount - 1n) / unitAmount;
}

export function sessionUnitsToAmount(units: bigint, unitAmount: bigint): bigint {
  if (units <= 0n) return 0n;
  if (unitAmount <= 0n) throw new Error("session unitAmount must be greater than zero");
  return units * unitAmount;
}

export function quoteSessionReservation(
  quote: PriceQuote,
  billing: SessionBillingConfig
): SessionReservationQuote {
  const reservedUnits = quote.amountBreakdown
    ? amountToSessionUnits(quote.amountBreakdown.inputAmount, billing.unitAmount) +
      amountToSessionUnits(quote.amountBreakdown.outputAmount, billing.unitAmount) +
      amountToSessionUnits(quote.amountBreakdown.minimumAdjustmentAmount, billing.unitAmount)
    : amountToSessionUnits(quote.maxCharge, billing.unitAmount);

  return {
    reservedAmount: sessionUnitsToAmount(reservedUnits, billing.unitAmount),
    reservedUnits,
    reserveMode: billing.reserveMode,
    unitAmount: billing.unitAmount,
    unitType: billing.unitType
  };
}

export function settleSessionUsage(
  actual: ActualUsageAmount,
  billing: SessionBillingConfig
): SessionSettlementAmount {
  const minimumAdjustmentAmount = actual.totalAmount > actual.inputAmount + actual.outputAmount
    ? actual.totalAmount - actual.inputAmount - actual.outputAmount
    : 0n;

  const inputUnits = amountToSessionUnits(actual.inputAmount, billing.unitAmount);
  const outputUnits = amountToSessionUnits(actual.outputAmount, billing.unitAmount);
  const minimumAdjustmentUnits = amountToSessionUnits(minimumAdjustmentAmount, billing.unitAmount);
  const totalUnits = inputUnits + outputUnits + minimumAdjustmentUnits;

  return {
    inputAmount: actual.inputAmount,
    outputAmount: actual.outputAmount,
    minimumAdjustmentAmount,
    totalAmount: sessionUnitsToAmount(totalUnits, billing.unitAmount),
    inputUnits,
    outputUnits,
    minimumAdjustmentUnits,
    totalUnits,
    settlementMode: billing.settlementMode,
    unitAmount: billing.unitAmount,
    unitType: billing.unitType
  };
}

export function buildSessionUnitCharges(settlement: SessionSettlementAmount): SessionUnitCharge[] {
  const charges: SessionUnitCharge[] = [
    {
      component: "input",
      amount: settlement.inputAmount,
      units: settlement.inputUnits,
      unitAmount: settlement.unitAmount,
      unitType: settlement.unitType
    },
    {
      component: "output",
      amount: settlement.outputAmount,
      units: settlement.outputUnits,
      unitAmount: settlement.unitAmount,
      unitType: settlement.unitType
    },
    {
      component: "minimum-adjustment",
      amount: settlement.minimumAdjustmentAmount,
      units: settlement.minimumAdjustmentUnits,
      unitAmount: settlement.unitAmount,
      unitType: settlement.unitType
    }
  ];
  return charges.filter((charge) => charge.units > 0n);
}

export async function applySessionUnitCharges(
  sink: SessionUnitChargeSink,
  charges: SessionUnitCharge[]
): Promise<void> {
  for (const charge of charges) {
    await sink.charge(charge.units, charge);
  }
}
