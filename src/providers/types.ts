import type { TokenUsage } from "../core/tokenizer.js";

export interface ChatCompletionResult {
  body: Record<string, unknown>;
  usage: TokenUsage;
}

export interface ImageGenerationResult {
  body: Record<string, unknown>;
  usage: TokenUsage;
}

export interface AiProvider {
  chatCompletions(body: Record<string, unknown>, upstreamModel: string): Promise<ChatCompletionResult>;
  images(body: Record<string, unknown>, upstreamModel: string): Promise<ImageGenerationResult>;
}
