import { aiTokenChargingStrategy } from "./ai-token.js";
import { perRequestChargingStrategy } from "./per-request.js";
import type { ChargingMethodName, ChargingStrategy } from "./types.js";

const STRATEGIES: Record<ChargingMethodName, ChargingStrategy> = {
  "ai-token": aiTokenChargingStrategy,
  "per-request": perRequestChargingStrategy
};

export function getChargingStrategy(chargingMethod: ChargingMethodName): ChargingStrategy {
  return STRATEGIES[chargingMethod];
}

export type { ActualUsageAmount, ChargingMethodName, ChargingStrategy, PriceQuote, TokenAmountBreakdown } from "./types.js";
export { calculateAiTokenUsageAmount, quoteAiTokenRequest, resolveChatMaxTokens, resolveMaxTokens } from "./ai-token.js";
export { calculatePerRequestUsageAmount, quotePerRequest } from "./per-request.js";
export {
  amountToSessionUnits,
  applySessionUnitCharges,
  buildSessionUnitCharges,
  quoteSessionReservation,
  sessionUnitsToAmount,
  settleSessionUsage
} from "./session-meter.js";
export type {
  SessionBillingConfig,
  SessionChargeComponent,
  SessionReservationQuote,
  SessionReserveMode,
  SessionSettlementAmount,
  SessionSettlementMode,
  SessionUnitCharge,
  SessionUnitChargeSink,
  SessionUnitConfig
} from "./session-meter.js";
