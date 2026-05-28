import type { ActualUsageAmount, ChargingStrategy, PriceQuote } from "./types.js";

export function quotePerRequest(requestId: string, model: {
  modelName: string;
  requestPrice?: bigint;
  minimumCharge: bigint;
  assetSymbol: string;
  assetAddress: string;
  chainId: number;
}): PriceQuote {
  const amount = model.requestPrice ?? model.minimumCharge;

  return {
    requestId,
    model: model.modelName,
    chargingMethod: "per-request",
    inputTokensEstimate: 0,
    maxOutputTokens: 0,
    maxCharge: amount,
    currency: {
      symbol: model.assetSymbol,
      assetAddress: model.assetAddress,
      chainId: model.chainId
    }
  };
}

export function calculatePerRequestUsageAmount(model: {
  requestPrice?: bigint;
  minimumCharge: bigint;
}): ActualUsageAmount {
  return {
    inputAmount: 0n,
    outputAmount: 0n,
    minimumApplied: false,
    totalAmount: model.requestPrice ?? model.minimumCharge
  };
}

export const perRequestChargingStrategy: ChargingStrategy = {
  name: "per-request",
  quoteRequest({ requestId, model }) {
    return quotePerRequest(requestId, model);
  },
  calculateActualUsage({ model }) {
    return calculatePerRequestUsageAmount(model);
  }
};
