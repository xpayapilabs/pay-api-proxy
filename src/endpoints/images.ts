import type { FastifyRequest } from "fastify";
import { findModel, type ModelConfig } from "../core/models.js";
import { countTextTokens, type TokenUsage } from "../core/tokenizer.js";
import type { ActualUsageAmount, PriceQuote } from "../charging/index.js";
import type { AiProvider, ImageGenerationResult } from "../providers/types.js";
import type { MppxSessionBackend } from "../sessions/index.js";
import { endpointError, type EndpointError, type PaidEndpoint } from "./types.js";

export interface ImageGenerationsBody {
  model: string;
  prompt: string;
  size?: string;
  quality?: string;
  n?: number;
  response_format?: string;
  [key: string]: unknown;
}

const DEFAULT_SIZE = "1024x1024";
const DEFAULT_QUALITY = "auto";
const DEFAULT_N = 1;
const MAX_N = 10;
const IMAGE_PROMPT_OVERHEAD_TOKENS = 10;
const FIXED_IMAGE_QUALITIES = new Set(["low", "medium", "high"]);

export function createImagesEndpoint(getMppxBackend: () => MppxSessionBackend | undefined = () => undefined): PaidEndpoint<ImageGenerationsBody, ImageGenerationResult> {
  return {
    id: "images",
    method: "POST",
    path: "/v1/images/generations",
    whitelistKey: "images",

    validateBody(rawBody: unknown): ImageGenerationsBody | EndpointError {
      if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        return endpointError(400, "invalid_body", "Request body must be a JSON object");
      }
      const body = rawBody as Record<string, unknown>;
      if (typeof body.model !== "string" || body.model.length === 0) {
        return endpointError(400, "invalid_model", "model must be a non-empty string");
      }
      if (typeof body.prompt !== "string" || body.prompt.length === 0) {
        return endpointError(400, "invalid_prompt", "prompt must be a non-empty string");
      }
      if (body.size === undefined) {
        return endpointError(400, "invalid_size", "size must be provided so the request can be priced safely");
      }
      if (body.size !== undefined && typeof body.size !== "string") {
        return endpointError(400, "invalid_size", "size must be a string when provided");
      }
      if (body.size === "auto") {
        return endpointError(400, "unsupported_image_feature", "size auto is not supported by this paid endpoint yet");
      }
      if (body.quality === undefined) {
        return endpointError(400, "invalid_quality", "quality must be provided so the request can be priced safely");
      }
      if (body.quality !== undefined && typeof body.quality !== "string") {
        return endpointError(400, "invalid_quality", "quality must be a string when provided");
      }
      if (!FIXED_IMAGE_QUALITIES.has(body.quality)) {
        return endpointError(400, "unsupported_image_feature", "quality must be low, medium, or high");
      }
      if (body.n !== undefined && (
        typeof body.n !== "number" ||
        !Number.isSafeInteger(body.n) ||
        body.n <= 0 ||
        body.n > MAX_N
      )) {
        return endpointError(400, "invalid_n", `n must be a positive integer no greater than ${MAX_N}`);
      }
      if (body.response_format !== undefined && typeof body.response_format !== "string") {
        return endpointError(400, "invalid_response_format", "response_format must be a string when provided");
      }
      return body as ImageGenerationsBody;
    },

    resolveModel(body, models): ModelConfig | EndpointError {
      const model = findModel(body.model, models);
      if (!model) {
        return endpointError(400, "model_not_found", "Requested model is not enabled");
      }
      if (model.imageTextInputPricePerMillion === undefined ||
          model.imageInputPricePerMillion === undefined ||
          model.imageOutputPricePerMillion === undefined ||
          model.imageMaxOutputTokens === undefined ||
          Object.keys(model.imageMaxOutputTokens).length === 0) {
        return endpointError(
          400,
          "model_not_image_capable",
          `Model ${model.modelName} must configure imageTextInputPricePerMillion, imageInputPricePerMillion, imageOutputPricePerMillion, and imageMaxOutputTokens for image generation`
        );
      }
      return model;
    },

    quoteRequest({ requestId, body, model }): PriceQuote | EndpointError {
      const size = body.size ?? DEFAULT_SIZE;
      const quality = body.quality ?? DEFAULT_QUALITY;
      const n = body.n ?? DEFAULT_N;
      const lookupKey = `${size}-${quality}`;
      const maxOutputTokensPerImage = model.imageMaxOutputTokens?.[lookupKey];
      if (maxOutputTokensPerImage === undefined) {
        const supported = Object.keys(model.imageMaxOutputTokens ?? {}).join(", ") || "<none configured>";
        return endpointError(
          400,
          "size_not_supported",
          `size+quality ${lookupKey} is not configured for model ${model.modelName}. Supported: ${supported}`
        );
      }
      const textInputTokens = imagePromptTextTokens(body.prompt);
      const imageOutputTokens = n * maxOutputTokensPerImage;
      const textPrice = model.imageTextInputPricePerMillion!;
      const outputPrice = model.imageOutputPricePerMillion!;
      const inputAmount = charge(textInputTokens, textPrice);
      const outputAmount = charge(imageOutputTokens, outputPrice);
      const rawTotal = inputAmount + outputAmount;
      const totalAmount = rawTotal < model.minimumCharge ? model.minimumCharge : rawTotal;
      const minimumAdjustmentAmount = totalAmount > rawTotal ? totalAmount - rawTotal : 0n;

      return {
        requestId,
        model: model.modelName,
        chargingMethod: "ai-token",
        inputTokensEstimate: textInputTokens,
        maxOutputTokens: imageOutputTokens,
        maxCharge: totalAmount,
        amountBreakdown: {
          inputAmount,
          outputAmount,
          minimumAdjustmentAmount,
          totalAmount
        },
        currency: {
          symbol: model.assetSymbol,
          assetAddress: model.assetAddress,
          chainId: model.chainId
        }
      };
    },

    async callUpstream(provider: AiProvider, body, model): Promise<ImageGenerationResult> {
      return provider.images(body, model.modelName);
    },

    extractUsage(upstream: ImageGenerationResult): TokenUsage {
      return upstream.usage;
    },

    calculateActualUsage({ usage, model, body }): ActualUsageAmount {
      const details = usage.details ?? {};
      if (
        model.imageTextInputPricePerMillion === undefined ||
        model.imageInputPricePerMillion === undefined ||
        model.imageOutputPricePerMillion === undefined
      ) {
        throw new Error(`Model ${model.modelName} is missing image pricing`);
      }
      const textPrice = model.imageTextInputPricePerMillion;
      const imagePrice = model.imageInputPricePerMillion;
      const outputPrice = model.imageOutputPricePerMillion;

      // Prefer upstream-reported per-modality breakdown when present. For
      // /v1/images/generations, current OpenAI top-level input_tokens are text
      // input only. TODO: revisit when /v1/images/edits or variations add mixed
      // image+text input on the same axis.
      //
      // Fall back to the deterministic max (same shape as quoteRequest) so we
      // never under-charge if the upstream omits the usage object.
      const fallback = quoteFallbackTokens(body, model);
      const textTokens = details.textInputTokens ?? (usage.inputTokens > 0 ? usage.inputTokens : fallback.textInputTokens);
      const imageInputTokens = details.imageInputTokens ?? 0;
      const imageOutputTokens = details.imageOutputTokens ?? (usage.outputTokens > 0 ? usage.outputTokens : fallback.imageOutputTokens);

      const textAmount = charge(textTokens, textPrice);
      const imageInAmount = charge(imageInputTokens, imagePrice);
      const imageOutAmount = charge(imageOutputTokens, outputPrice);
      const inputAmount = textAmount + imageInAmount;
      const outputAmount = imageOutAmount;
      const rawTotal = inputAmount + outputAmount;
      const totalAmount = rawTotal < model.minimumCharge ? model.minimumCharge : rawTotal;

      return {
        inputAmount,
        outputAmount,
        minimumApplied: totalAmount !== rawTotal,
        totalAmount
      };
    },

    responseBody(upstream: ImageGenerationResult): unknown {
      return upstream.body;
    },

    // mppx clients may POST a channel-close credential against this URL with no
    // body. Mirror chat-completions' wiring so the close round-trip works.
    async emptyBodyPreflight(request: FastifyRequest): Promise<Response | undefined> {
      const mppx = getMppxBackend();
      if (!mppx || !hasPaymentAuthorization(request)) return undefined;
      return mppx.preflightEmptyBody(request);
    }
  };
}

function hasPaymentAuthorization(request: FastifyRequest): boolean {
  const authorization = firstHeaderValue(request.headers.authorization);
  return authorization?.startsWith("Payment ") ?? false;
}

function firstHeaderValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function charge(tokens: number, pricePerMillion: bigint): bigint {
  // Round up so the operator never under-charges due to integer truncation.
  return (BigInt(Math.max(0, tokens)) * pricePerMillion + 999_999n) / 1_000_000n;
}

function quoteFallbackTokens(body: ImageGenerationsBody, model: ModelConfig): { textInputTokens: number; imageOutputTokens: number } {
  const size = body.size ?? DEFAULT_SIZE;
  const quality = body.quality ?? DEFAULT_QUALITY;
  const n = body.n ?? DEFAULT_N;
  const lookupKey = `${size}-${quality}`;
  const maxOutputTokensPerImage = model.imageMaxOutputTokens?.[lookupKey] ?? 0;
  return {
    textInputTokens: imagePromptTextTokens(body.prompt),
    imageOutputTokens: n * maxOutputTokensPerImage
  };
}

function imagePromptTextTokens(prompt: string): number {
  return countTextTokens(prompt) + IMAGE_PROMPT_OVERHEAD_TOKENS;
}
