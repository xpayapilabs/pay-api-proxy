import type { ModelConfig } from "../core/models.js";
import { estimateChatInputTokens } from "../core/tokenizer.js";
import type { ActualUsageAmount, ChargingStrategy, PriceQuote } from "./types.js";

function charge(tokens: number, pricePerMillion: bigint): bigint {
  // Round up so the operator never under-charges due to integer truncation.
  return (BigInt(Math.max(0, tokens)) * pricePerMillion + 999_999n) / 1_000_000n;
}

export function resolveMaxTokens(requested: unknown, model: ModelConfig, fieldName = "max_tokens"): number {
  if (requested === undefined) {
    return model.defaultMaxTokens;
  }

  if (typeof requested !== "number" || !Number.isFinite(requested) || !Number.isSafeInteger(requested)) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  const value = requested;

  if (value <= 0) {
    throw new Error(`${fieldName} must be greater than zero`);
  }

  if (value > model.maxTokensLimit) {
    throw new Error(`${fieldName} exceeds model limit ${model.maxTokensLimit}`);
  }

  return value;
}

export function resolveChatMaxTokens(body: Record<string, unknown>, model: ModelConfig): number {
  const legacyMaxTokens = body.max_tokens;
  const completionMaxTokens = body.max_completion_tokens;

  if (legacyMaxTokens !== undefined && completionMaxTokens !== undefined) {
    const legacy = resolveMaxTokens(legacyMaxTokens, model, "max_tokens");
    const completion = resolveMaxTokens(completionMaxTokens, model, "max_completion_tokens");
    if (legacy !== completion) {
      throw new Error("max_tokens and max_completion_tokens must match when both are provided");
    }
    return completion;
  }

  return completionMaxTokens !== undefined
    ? resolveMaxTokens(completionMaxTokens, model, "max_completion_tokens")
    : resolveMaxTokens(legacyMaxTokens, model, "max_tokens");
}

export function calculateAiTokenUsageAmount(
  model: ModelConfig,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0
): ActualUsageAmount {
  const billableCachedInputTokens = Math.min(Math.max(0, cachedInputTokens), Math.max(0, inputTokens));
  const uncachedInputTokens = Math.max(0, inputTokens - billableCachedInputTokens);
  const inputAmount =
    charge(uncachedInputTokens, model.inputPricePerMillion) +
    charge(billableCachedInputTokens, model.cachedInputPricePerMillion ?? model.inputPricePerMillion);
  const outputAmount = charge(outputTokens, model.outputPricePerMillion);
  const rawTotal = inputAmount + outputAmount;
  const totalAmount = rawTotal < model.minimumCharge ? model.minimumCharge : rawTotal;

  return {
    inputAmount,
    outputAmount,
    minimumApplied: totalAmount !== rawTotal,
    totalAmount
  };
}

export function quoteAiTokenRequest(requestId: string, body: Record<string, unknown>, model: ModelConfig): PriceQuote {
  const maxOutputTokens = resolveChatMaxTokens(body, model);
  const inputTokensEstimate = estimateChatInputTokens(body.messages);
  const actual = calculateAiTokenUsageAmount(model, inputTokensEstimate, maxOutputTokens);
  const minimumAdjustmentAmount = actual.totalAmount > actual.inputAmount + actual.outputAmount
    ? actual.totalAmount - actual.inputAmount - actual.outputAmount
    : 0n;

  return {
    requestId,
    model: model.modelName,
    chargingMethod: "ai-token",
    inputTokensEstimate,
    maxOutputTokens,
    maxCharge: actual.totalAmount,
    amountBreakdown: {
      inputAmount: actual.inputAmount,
      outputAmount: actual.outputAmount,
      minimumAdjustmentAmount,
      totalAmount: actual.totalAmount
    },
    currency: {
      symbol: model.assetSymbol,
      assetAddress: model.assetAddress,
      chainId: model.chainId
    }
  };
}

export const aiTokenChargingStrategy: ChargingStrategy = {
  name: "ai-token",
  quoteRequest({ requestId, body, model }) {
    return quoteAiTokenRequest(requestId, body, model);
  },
  calculateActualUsage({ model, usage }) {
    return calculateAiTokenUsageAmount(model, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens);
  }
};
