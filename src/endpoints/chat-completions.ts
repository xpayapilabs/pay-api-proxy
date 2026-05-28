import type { FastifyRequest } from "fastify";
import { findModel, type ModelConfig } from "../core/models.js";
import type { TokenUsage } from "../core/tokenizer.js";
import type { AiProvider, ChatCompletionResult } from "../providers/types.js";
import type { MppxSessionBackend } from "../sessions/index.js";
import { endpointError, type EndpointError, type PaidEndpoint } from "./types.js";

const SUPPORTED_CHAT_FIELDS = new Set([
  "model",
  "messages",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "n",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "user",
  "seed",
  "stream",
  "logit_bias"
]);

const SUPPORTED_MESSAGE_FIELDS = new Set(["role", "content", "name"]);
const SUPPORTED_MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant"]);

export function createChatCompletionsEndpoint(getMppxBackend: () => MppxSessionBackend | undefined): PaidEndpoint<Record<string, unknown>, ChatCompletionResult> {
  return {
    id: "chat_completions",
    method: "POST",
    path: "/v1/chat/completions",
    whitelistKey: "chat_completions",

    validateBody(rawBody: unknown): Record<string, unknown> | EndpointError {
      if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        return endpointError(400, "invalid_body", "Request body must be a JSON object");
      }
      const body = rawBody as Record<string, unknown>;
      if (body.stream === true) {
        return endpointError(400, "stream_not_supported", "Streaming responses are not supported by this node");
      }
      const unsupportedField = Object.keys(body).find((key) => !SUPPORTED_CHAT_FIELDS.has(key));
      if (unsupportedField) {
        return endpointError(
          400,
          "unsupported_chat_feature",
          `${unsupportedField} is not supported by this paid endpoint yet`
        );
      }
      if (body.n !== undefined && body.n !== 1) {
        return endpointError(400, "unsupported_chat_feature", "n must be 1 when provided");
      }
      const messageError = validatePlainTextMessages(body.messages);
      if (messageError) return messageError;
      return body;
    },

    resolveModel(body, models): ModelConfig | EndpointError {
      const modelName = typeof body.model === "string" ? body.model : "";
      const model = findModel(modelName, models);
      if (!model) {
        return endpointError(400, "model_not_found", "Requested model is not enabled");
      }
      return model;
    },

    async callUpstream(provider: AiProvider, body, model): Promise<ChatCompletionResult> {
      return provider.chatCompletions(body, model.modelName);
    },

    extractUsage(upstream: ChatCompletionResult): TokenUsage {
      return upstream.usage;
    },

    responseBody(upstream: ChatCompletionResult): unknown {
      return upstream.body;
    },

    async emptyBodyPreflight(request: FastifyRequest): Promise<Response | undefined> {
      const mppx = getMppxBackend();
      if (!mppx || !hasPaymentAuthorization(request)) return undefined;
      return mppx.preflightEmptyBody(request);
    }
  };
}

function validatePlainTextMessages(messages: unknown): EndpointError | undefined {
  if (!Array.isArray(messages) || messages.length === 0) {
    return endpointError(400, "invalid_messages", "messages must be a non-empty array");
  }

  for (const [index, message] of messages.entries()) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return endpointError(400, "invalid_messages", `messages[${index}] must be an object`);
    }

    const record = message as Record<string, unknown>;
    const unsupportedField = Object.keys(record).find((key) => !SUPPORTED_MESSAGE_FIELDS.has(key));
    if (unsupportedField) {
      return endpointError(
        400,
        "unsupported_chat_feature",
        `messages[${index}].${unsupportedField} is not supported by this paid endpoint yet`
      );
    }

    if (typeof record.role !== "string" || !SUPPORTED_MESSAGE_ROLES.has(record.role)) {
      return endpointError(400, "invalid_messages", `messages[${index}].role must be system, developer, user, or assistant`);
    }
    if (record.name !== undefined && typeof record.name !== "string") {
      return endpointError(400, "invalid_messages", `messages[${index}].name must be a string when provided`);
    }
    if (typeof record.content !== "string") {
      return endpointError(
        400,
        "unsupported_chat_feature",
        `messages[${index}].content must be plain text so the request can be priced safely`
      );
    }
  }

  return undefined;
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
