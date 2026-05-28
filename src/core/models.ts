export interface ModelConfig {
  id: string;
  modelName: string;
  enabled: boolean;
  supportsStreaming: boolean;
  inputPricePerMillion: bigint;
  cachedInputPricePerMillion?: bigint;
  outputPricePerMillion: bigint;
  requestPrice?: bigint;
  minimumCharge: bigint;
  defaultMaxTokens: number;
  maxTokensLimit: number;
  contextWindow?: number;
  knowledgeCutoff?: string;
  // Image pricing (only required for models served on /v1/images/generations).
  // Text input is the prompt; image input is reference / edit images; image
  // output is what the model generates. Maxima are bounded per (size, quality)
  // so we can quote a deterministic upper bound before calling upstream.
  imageTextInputPricePerMillion?: bigint;
  imageInputPricePerMillion?: bigint;
  imageOutputPricePerMillion?: bigint;
  imageMaxOutputTokens?: Record<string, number>;
  assetSymbol: string;
  assetAddress: string;
  chainId: number;
}

// Default model prices match OpenAI's list pricing as of 2026-01 in USD-cent micro-units
// (asset has 6 decimals: $0.15 per million tokens = 150_000n). Operators are expected to
// override the models array if they want to add a margin or use a different asset/decimals.
export const DEFAULT_MODELS: ModelConfig[] = [
  {
    id: "model_gpt_4o_mini",
    modelName: "gpt-4o-mini",
    enabled: true,
    supportsStreaming: false,
    inputPricePerMillion: 150_000n,
    cachedInputPricePerMillion: 75_000n,
    outputPricePerMillion: 600_000n,
    minimumCharge: 1_000n,
    defaultMaxTokens: 512,
    maxTokensLimit: 16_384,
    assetSymbol: "pathUSD",
    assetAddress: "0x20c0000000000000000000000000000000000000",
    chainId: 42431
  },
  {
    id: "model_gpt_4o",
    modelName: "gpt-4o",
    enabled: true,
    supportsStreaming: false,
    inputPricePerMillion: 2_500_000n,
    cachedInputPricePerMillion: 1_250_000n,
    outputPricePerMillion: 10_000_000n,
    minimumCharge: 1_000n,
    defaultMaxTokens: 512,
    maxTokensLimit: 16_384,
    assetSymbol: "pathUSD",
    assetAddress: "0x20c0000000000000000000000000000000000000",
    chainId: 42431
  },
  {
    id: "model_gpt_4_1_mini",
    modelName: "gpt-4.1-mini",
    enabled: true,
    supportsStreaming: false,
    inputPricePerMillion: 400_000n,
    cachedInputPricePerMillion: 100_000n,
    outputPricePerMillion: 1_600_000n,
    minimumCharge: 1_000n,
    defaultMaxTokens: 512,
    maxTokensLimit: 16_384,
    assetSymbol: "pathUSD",
    assetAddress: "0x20c0000000000000000000000000000000000000",
    chainId: 42431
  },
  {
    id: "model_gpt_4_1_nano",
    modelName: "gpt-4.1-nano",
    enabled: true,
    supportsStreaming: false,
    inputPricePerMillion: 100_000n,
    cachedInputPricePerMillion: 25_000n,
    outputPricePerMillion: 400_000n,
    minimumCharge: 1_000n,
    defaultMaxTokens: 512,
    maxTokensLimit: 16_384,
    assetSymbol: "pathUSD",
    assetAddress: "0x20c0000000000000000000000000000000000000",
    chainId: 42431
  },
  {
    // GPT Image 1 prices (per OpenAI list, USD per 1M tokens):
    //   text input: $5, image input: $10, image output: $40.
    // imageMaxOutputTokens is the worst-case per-image output bound used to
    // compute the deterministic reservation; actual settlement uses the
    // upstream usage object when present.
    id: "model_gpt_image_1",
    modelName: "gpt-image-1",
    enabled: true,
    supportsStreaming: false,
    inputPricePerMillion: 5_000_000n,
    outputPricePerMillion: 40_000_000n,
    imageTextInputPricePerMillion: 5_000_000n,
    imageInputPricePerMillion: 10_000_000n,
    imageOutputPricePerMillion: 40_000_000n,
    imageMaxOutputTokens: {
      "1024x1024-low": 272,
      "1024x1024-medium": 1056,
      "1024x1024-high": 4160,
      "1024x1024-auto": 4160,
      "1024x1536-low": 408,
      "1024x1536-medium": 1584,
      "1024x1536-high": 6240,
      "1024x1536-auto": 6240,
      "1536x1024-low": 400,
      "1536x1024-medium": 1568,
      "1536x1024-high": 6208,
      "1536x1024-auto": 6208,
      "auto-auto": 6240
    },
    minimumCharge: 1_000n,
    defaultMaxTokens: 1,
    maxTokensLimit: 1,
    assetSymbol: "pathUSD",
    assetAddress: "0x20c0000000000000000000000000000000000000",
    chainId: 42431
  }
];

export function findModel(name: string, models: ModelConfig[] = DEFAULT_MODELS): ModelConfig | undefined {
  return models.find((model) => model.enabled && model.modelName === name);
}
