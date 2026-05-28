import type { ModelConfig } from "../core/models.js";
import type { TokenUsage } from "../core/tokenizer.js";

export type ChargingMethodName = "ai-token" | "per-request";

export interface PriceQuote {
  requestId: string;
  model: string;
  chargingMethod: ChargingMethodName;
  inputTokensEstimate: number;
  maxOutputTokens: number;
  maxCharge: bigint;
  amountBreakdown?: TokenAmountBreakdown;
  currency: {
    symbol: string;
    assetAddress: string;
    chainId: number;
  };
}

export interface TokenAmountBreakdown {
  inputAmount: bigint;
  outputAmount: bigint;
  minimumAdjustmentAmount: bigint;
  totalAmount: bigint;
}

export interface ActualUsageAmount {
  inputAmount: bigint;
  outputAmount: bigint;
  minimumApplied: boolean;
  totalAmount: bigint;
}

export interface QuoteRequestParams {
  requestId: string;
  body: Record<string, unknown>;
  model: ModelConfig;
}

export interface SettleUsageParams {
  model: ModelConfig;
  usage: TokenUsage;
}

export interface ChargingStrategy {
  name: ChargingMethodName;
  quoteRequest(params: QuoteRequestParams): PriceQuote;
  calculateActualUsage(params: SettleUsageParams): ActualUsageAmount;
}
