import { nanoid } from "nanoid";
import { logUpstreamResponse, sanitizeImageResponseBody } from "../../src/core/log.js";
import { estimateChatInputTokens, estimateTokensFromText } from "../../src/core/tokenizer.js";
import type { AiProvider, ChatCompletionResult, ImageGenerationResult } from "../../src/providers/types.js";

export class TestAiProvider implements AiProvider {
  async chatCompletions(body: Record<string, unknown>, upstreamModel: string): Promise<ChatCompletionResult> {
    const content = "This is a pay-api-proxy test response.";
    const inputTokens = estimateChatInputTokens(body.messages);
    const outputTokens = estimateTokensFromText(content);

    const responseBody = {
      id: `chatcmpl_${nanoid(16)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content
          },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens
      },
      upstream_model: upstreamModel
    };

    logUpstreamResponse("chat_completions", {
      upstreamModel,
      status: 200,
      ok: true,
      source: "test",
      usage: responseBody.usage,
      body: responseBody
    });

    return {
      body: responseBody,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        source: "estimate"
      }
    };
  }

  async images(body: Record<string, unknown>, upstreamModel: string): Promise<ImageGenerationResult> {
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const n = typeof body.n === "number" && Number.isFinite(body.n) && body.n > 0 ? Math.floor(body.n) : 1;
    const textInputTokens = estimateTokensFromText(prompt);
    // Deterministic synthetic image-output tokens so tests can assert exact amounts.
    const imageOutputTokens = n * 1024;
    const inputTokens = textInputTokens;
    const outputTokens = imageOutputTokens;

    const data = Array.from({ length: n }, (_, index) => ({
      url: `https://test.invalid/images/${nanoid(16)}.png`,
      revised_prompt: `test(${index}): ${prompt}`
    }));

    const responseBody = {
      created: Math.floor(Date.now() / 1000),
      data,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        input_tokens_details: {
          text_tokens: textInputTokens,
          image_tokens: 0
        },
        output_tokens_details: {
          image_tokens: imageOutputTokens
        }
      },
      upstream_model: upstreamModel
    };

    logUpstreamResponse("images", {
      upstreamModel,
      status: 200,
      ok: true,
      source: "test",
      usage: responseBody.usage,
      body: sanitizeImageResponseBody(responseBody)
    });

    return {
      body: responseBody,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        source: "estimate",
        details: {
          textInputTokens,
          imageInputTokens: 0,
          imageOutputTokens
        }
      }
    };
  }
}
