import type { AiProvider, ChatCompletionResult, ImageGenerationResult } from "./types.js";

export class DisabledAiProvider implements AiProvider {
  async chatCompletions(): Promise<ChatCompletionResult> {
    throw new Error("OpenAI-compatible upstream is not enabled");
  }

  async images(): Promise<ImageGenerationResult> {
    throw new Error("OpenAI-compatible upstream is not enabled");
  }
}
