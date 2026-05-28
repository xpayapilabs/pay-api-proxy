import { createImagesEndpoint } from "../../src/endpoints/images.js";
import { isEndpointError } from "../../src/endpoints/types.js";
import type { ModelConfig } from "../../src/core/models.js";
import type { TokenUsage } from "../../src/core/tokenizer.js";
import type { ImageGenerationResult } from "../../src/providers/types.js";

const imageModel: ModelConfig = {
  id: "model_test_image",
  modelName: "test-image-1",
  enabled: true,
  supportsStreaming: false,
  inputPricePerMillion: 5_000_000n,
  outputPricePerMillion: 40_000_000n,
  imageTextInputPricePerMillion: 5_000_000n,
  imageInputPricePerMillion: 10_000_000n,
  imageOutputPricePerMillion: 40_000_000n,
  imageMaxOutputTokens: {
    "1024x1024-low": 272,
    "1024x1024-high": 4160
  },
  minimumCharge: 1_000n,
  defaultMaxTokens: 1,
  maxTokensLimit: 1,
  assetSymbol: "pathUSD",
  assetAddress: "0x20c0000000000000000000000000000000000000",
  chainId: 42431
};

const chatOnlyModel: ModelConfig = {
  ...imageModel,
  id: "model_chat_only",
  modelName: "chat-only",
  imageTextInputPricePerMillion: undefined,
  imageInputPricePerMillion: undefined,
  imageOutputPricePerMillion: undefined,
  imageMaxOutputTokens: undefined
};

describe("images endpoint", () => {
  const endpoint = createImagesEndpoint();

  it("rejects bodies missing prompt or model", () => {
    expect(isEndpointError(endpoint.validateBody({}))).toBe(true);
    expect(isEndpointError(endpoint.validateBody({ model: "test-image-1" }))).toBe(true);
    expect(isEndpointError(endpoint.validateBody({ prompt: "hi" }))).toBe(true);
    expect(isEndpointError(endpoint.validateBody({ model: "test-image-1", prompt: "" }))).toBe(true);
    expect(isEndpointError(endpoint.validateBody({ model: "test-image-1", prompt: "hi" }))).toBe(true);
    expect(isEndpointError(endpoint.validateBody({ model: "test-image-1", prompt: "hi", size: "1024x1024" }))).toBe(true);
    expect(isEndpointError(endpoint.validateBody({ model: "test-image-1", prompt: "hi", size: "1024x1024", quality: "low", n: 0 }))).toBe(true);
    expect(isEndpointError(endpoint.validateBody({ model: "test-image-1", prompt: "hi", size: "1024x1024", quality: "low", n: 11 }))).toBe(true);
  });

  it("rejects auto image settings until they have fixed pricing support", () => {
    expect(isEndpointError(endpoint.validateBody({
      model: "test-image-1",
      prompt: "hi",
      size: "auto",
      quality: "low"
    }))).toBe(true);
    const autoQuality = endpoint.validateBody({
      model: "test-image-1",
      prompt: "hi",
      size: "1024x1024",
      quality: "auto"
    });
    expect(isEndpointError(autoQuality)).toBe(true);
    expect((autoQuality as ReturnType<typeof isError>).code).toBe("unsupported_image_feature");
  });

  it("rejects models that aren't image-capable", () => {
    const body = endpoint.validateBody({ model: "chat-only", prompt: "hi", size: "1024x1024", quality: "low" });
    expect(isEndpointError(body)).toBe(false);
    const resolved = endpoint.resolveModel(body as never, [chatOnlyModel]);
    expect(isEndpointError(resolved)).toBe(true);
    expect((resolved as ReturnType<typeof isError>).code).toBe("model_not_image_capable");
  });

  it("rejects partially configured image models", () => {
    const body = endpoint.validateBody({ model: "partial-image", prompt: "hi", size: "1024x1024", quality: "low" });
    expect(isEndpointError(body)).toBe(false);
    const resolved = endpoint.resolveModel(body as never, [{
      ...imageModel,
      modelName: "partial-image",
      imageInputPricePerMillion: undefined
    }]);
    expect(isEndpointError(resolved)).toBe(true);
    expect((resolved as ReturnType<typeof isError>).code).toBe("model_not_image_capable");
  });

  it("rejects unconfigured size+quality combinations with size_not_supported", () => {
    const body = endpoint.validateBody({ model: "test-image-1", prompt: "hi", size: "9999x9999", quality: "low" });
    const result = endpoint.quoteRequest!({
      requestId: "req_test",
      body: body as never,
      model: imageModel
    });
    expect(isEndpointError(result)).toBe(true);
    expect((result as ReturnType<typeof isError>).code).toBe("size_not_supported");
  });

  it("quotes the deterministic max for an in-table size+quality", () => {
    const body = endpoint.validateBody({
      model: "test-image-1",
      prompt: "a small cube",
      size: "1024x1024",
      quality: "low",
      n: 2
    });
    const quote = endpoint.quoteRequest!({
      requestId: "req_quote",
      body: body as never,
      model: imageModel
    });
    if (isEndpointError(quote)) throw new Error("expected quote");
    // text input tokens: exact o200k token count 3 + 10 image prompt overhead = 13
    // 13 * 5_000_000 / 1_000_000 = 65
    // image output tokens: 2 * 272 = 544 → 544 * 40_000_000 / 1_000_000 = 21_760
    expect(quote.inputTokensEstimate).toBe(13);
    expect(quote.maxOutputTokens).toBe(544);
    expect(quote.amountBreakdown!.inputAmount).toBe(65n);
    expect(quote.amountBreakdown!.outputAmount).toBe(21_760n);
    expect(quote.maxCharge).toBe(21_825n);
  });

  it("applies the minimum charge floor in quoteRequest", () => {
    const cheapModel: ModelConfig = { ...imageModel, minimumCharge: 50_000n };
    const body = endpoint.validateBody({
      model: "test-image-1",
      prompt: "x",
      size: "1024x1024",
      quality: "low",
      n: 1
    });
    const quote = endpoint.quoteRequest!({
      requestId: "req_min",
      body: body as never,
      model: cheapModel
    });
    if (isEndpointError(quote)) throw new Error("expected quote");
    expect(quote.maxCharge).toBe(50_000n);
    expect(quote.amountBreakdown!.minimumAdjustmentAmount).toBeGreaterThan(0n);
  });

  it("settles to the upstream-reported per-modality breakdown", () => {
    const body = endpoint.validateBody({
      model: "test-image-1",
      prompt: "anything",
      size: "1024x1024",
      quality: "low",
      n: 1
    }) as never;
    const upstreamUsage: TokenUsage = {
      inputTokens: 50,
      outputTokens: 200,
      totalTokens: 250,
      source: "upstream",
      details: {
        textInputTokens: 10,
        imageInputTokens: 40,
        imageOutputTokens: 200
      }
    };
    const actual = endpoint.calculateActualUsage!({
      usage: upstreamUsage,
      model: imageModel,
      body
    });
    // text: 10 * 5_000_000 / 1M = 50
    // image input: 40 * 10_000_000 / 1M = 400
    // image output: 200 * 40_000_000 / 1M = 8_000
    expect(actual.inputAmount).toBe(450n);
    expect(actual.outputAmount).toBe(8_000n);
    expect(actual.totalAmount).toBe(8_450n);
    expect(actual.minimumApplied).toBe(false);
  });

  it("falls back to the deterministic max when upstream omits the usage details", () => {
    const body = endpoint.validateBody({
      model: "test-image-1",
      prompt: "a small cube",
      size: "1024x1024",
      quality: "low",
      n: 1
    }) as never;
    const upstreamUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      source: "estimate"
      // no details
    };
    const actual = endpoint.calculateActualUsage!({
      usage: upstreamUsage,
      model: imageModel,
      body
    });
    // text fallback: exact o200k token count 3 + 10 image prompt overhead = 13
    // 13 tokens at $5/M = 65
    // image output fallback: 272 tokens at $40/M = 10_880
    expect(actual.inputAmount).toBe(65n);
    expect(actual.outputAmount).toBe(10_880n);
    expect(actual.totalAmount).toBe(10_945n);
  });

  it("falls back to top-level upstream usage when per-modality details are missing", () => {
    const body = endpoint.validateBody({
      model: "test-image-1",
      prompt: "a small cube",
      size: "1024x1024",
      quality: "low",
      n: 1
    }) as never;
    const upstreamUsage: TokenUsage = {
      inputTokens: 12,
      outputTokens: 123,
      totalTokens: 135,
      source: "upstream"
    };

    const actual = endpoint.calculateActualUsage!({
      usage: upstreamUsage,
      model: imageModel,
      body
    });

    expect(actual.inputAmount).toBe(60n);
    expect(actual.outputAmount).toBe(4_920n);
    expect(actual.totalAmount).toBe(4_980n);
  });

  it("extracts usage directly from the upstream result", () => {
    const upstream: ImageGenerationResult = {
      body: { data: [] },
      usage: {
        inputTokens: 11,
        outputTokens: 22,
        totalTokens: 33,
        source: "upstream",
        details: { textInputTokens: 11, imageInputTokens: 0, imageOutputTokens: 22 }
      }
    };
    expect(endpoint.extractUsage(upstream)).toBe(upstream.usage);
    expect(endpoint.responseBody(upstream)).toBe(upstream.body);
  });
});

// Helper for the type cast in the assertion above.
function isError(value: unknown): { code: string } {
  return value as { code: string };
}
