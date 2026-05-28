import { DEFAULT_MODELS } from "../../src/core/models.js";
import {
  calculateAiTokenUsageAmount as calculateActualUsageAmount,
  calculatePerRequestUsageAmount,
  quoteAiTokenRequest as quoteChatRequest,
  quotePerRequest,
  resolveChatMaxTokens,
  resolveMaxTokens
} from "../../src/charging/index.js";

describe("pricing", () => {
  const model = DEFAULT_MODELS[0];

  it("resolves default max tokens when omitted", () => {
    expect(resolveMaxTokens(undefined, model)).toBe(model.defaultMaxTokens);
  });

  it("rejects max tokens over model limit", () => {
    expect(() => resolveMaxTokens(model.maxTokensLimit + 1, model)).toThrow(/exceeds/);
  });

  it("resolves chat max tokens from max_completion_tokens", () => {
    expect(resolveChatMaxTokens({ max_completion_tokens: 123 }, model)).toBe(123);
  });

  it("rejects conflicting chat max token fields", () => {
    expect(() => resolveChatMaxTokens({ max_tokens: 100, max_completion_tokens: 200 }, model)).toThrow(/must match/);
  });

  it("quotes max_completion_tokens instead of falling back to the default", () => {
    const quote = quoteChatRequest("req_completion_tokens", {
      model: model.modelName,
      messages: [{ role: "user", content: "hello world" }],
      max_completion_tokens: 100
    }, model);

    expect(quote.maxOutputTokens).toBe(100);
  });

  it("calculates actual usage amount with minimum charge", () => {
    const amount = calculateActualUsageAmount(model, 1, 1);
    expect(amount.totalAmount).toBe(model.minimumCharge);
    expect(amount.minimumApplied).toBe(true);
  });

  it("charges cached input tokens at the cached input price when configured", () => {
    const pricedModel = {
      ...model,
      inputPricePerMillion: 1_000_000n,
      cachedInputPricePerMillion: 100_000n,
      outputPricePerMillion: 2_000_000n,
      minimumCharge: 0n
    };

    const amount = calculateActualUsageAmount(pricedModel, 100, 10, 40);

    expect(amount.inputAmount).toBe(64n);
    expect(amount.outputAmount).toBe(20n);
    expect(amount.totalAmount).toBe(84n);
  });

  it("quotes max charge from input estimate plus max output tokens", () => {
    const quote = quoteChatRequest("req_test", {
      model: model.modelName,
      messages: [{ role: "user", content: "hello world" }],
      max_tokens: 100
    }, model);

    expect(quote.requestId).toBe("req_test");
    expect(quote.chargingMethod).toBe("ai-token");
    expect(quote.inputTokensEstimate).toBeGreaterThan(0);
    expect(quote.maxOutputTokens).toBe(100);
    expect(quote.maxCharge).toBeGreaterThan(0n);
    expect(quote.amountBreakdown?.totalAmount).toBe(quote.maxCharge);
  });

  it("quotes a fixed amount for per-request charging", () => {
    const perRequestModel = { ...model, requestPrice: 1234n };
    const quote = quotePerRequest("req_fixed", perRequestModel);
    const actual = calculatePerRequestUsageAmount(perRequestModel);

    expect(quote.requestId).toBe("req_fixed");
    expect(quote.chargingMethod).toBe("per-request");
    expect(quote.inputTokensEstimate).toBe(0);
    expect(quote.maxOutputTokens).toBe(0);
    expect(quote.maxCharge).toBe(1234n);
    expect(actual.totalAmount).toBe(1234n);
  });
});
