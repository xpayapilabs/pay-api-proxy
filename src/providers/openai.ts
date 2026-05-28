import type { AppConfig } from "../core/config.js";
import { logUpstreamResponse, sanitizeImageResponseBody } from "../core/log.js";
import { countTextTokens, estimateChatInputTokens, estimateTokensFromText } from "../core/tokenizer.js";
import type { AiProvider, ChatCompletionResult, ImageGenerationResult } from "./types.js";

export interface OpenAiModelSummary {
  id: string;
  ownedBy?: string;
  created?: number;
}

export type OpenAiEndpointProbeStatus = "available" | "auth_error" | "not_available" | "request_error";

export interface OpenAiEndpointProbe {
  name: string;
  method: string;
  path: string;
  live: boolean;
  status: OpenAiEndpointProbeStatus;
  statusCode?: number;
  detail?: string;
}

export interface ProbeOpenAiEndpointsOptions {
  live?: boolean;
  chatModel?: string;
  responsesModel?: string;
  embeddingModel?: string;
}

export class OpenAiCompatibleProvider implements AiProvider {
  constructor(private readonly config: AppConfig) {}

  async chatCompletions(body: Record<string, unknown>, upstreamModel: string): Promise<ChatCompletionResult> {
    if (!this.config.openaiApiKey) {
      throw new Error("OPENAI_API_KEY is required for openai upstream provider");
    }

    const start = Date.now();
    const response = await fetch(`${this.config.openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.openaiApiKey}`
      },
      body: JSON.stringify(buildOpenAiChatRequest(body, upstreamModel))
    });

    const responseBody = (await response.json()) as Record<string, unknown>;
    const elapsedMs = Date.now() - start;
    if (!response.ok) {
      logUpstreamResponse("chat_completions", {
        upstreamModel,
        status: response.status,
        elapsedMs,
        ok: false,
        body: responseBody
      });
      throw new Error(`Upstream provider error: ${response.status}${upstreamErrorDetail(responseBody)}`);
    }

    const usage = responseBody.usage && typeof responseBody.usage === "object"
      ? (responseBody.usage as Record<string, unknown>)
      : undefined;
    const promptTokenDetails = usage?.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : undefined;
    const promptTokens = Number(usage?.prompt_tokens ?? estimateChatInputTokens(body.messages));
    const cachedInputTokens = Number(promptTokenDetails?.cached_tokens ?? 0);
    const completionTokens = Number(usage?.completion_tokens ?? estimateCompletionTokensFromBody(responseBody));

    logUpstreamResponse("chat_completions", {
      upstreamModel,
      status: response.status,
      elapsedMs,
      ok: true,
      usage,
      body: responseBody
    });

    return {
      body: responseBody,
      usage: {
        inputTokens: promptTokens,
        cachedInputTokens: Number.isFinite(cachedInputTokens) && cachedInputTokens > 0 ? cachedInputTokens : undefined,
        outputTokens: completionTokens,
        totalTokens: promptTokens + completionTokens,
        source: usage ? "upstream" : "estimate"
      }
    };
  }

  async images(body: Record<string, unknown>, upstreamModel: string): Promise<ImageGenerationResult> {
    if (!this.config.openaiApiKey) {
      throw new Error("OPENAI_API_KEY is required for openai upstream provider");
    }

    const start = Date.now();
    const response = await fetch(`${this.config.openaiBaseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.openaiApiKey}`
      },
      body: JSON.stringify({ ...body, model: upstreamModel })
    });

    const responseBody = (await response.json()) as Record<string, unknown>;
    const elapsedMs = Date.now() - start;
    if (!response.ok) {
      logUpstreamResponse("images", {
        upstreamModel,
        status: response.status,
        elapsedMs,
        ok: false,
        body: responseBody
      });
      throw new Error(`Upstream provider error: ${response.status}${upstreamErrorDetail(responseBody)}`);
    }

    const usage = responseBody.usage && typeof responseBody.usage === "object"
      ? (responseBody.usage as Record<string, unknown>)
      : undefined;
    const inputDetails = usage?.input_tokens_details && typeof usage.input_tokens_details === "object"
      ? (usage.input_tokens_details as Record<string, unknown>)
      : undefined;
    const outputDetails = usage?.output_tokens_details && typeof usage.output_tokens_details === "object"
      ? (usage.output_tokens_details as Record<string, unknown>)
      : undefined;

    const promptText = typeof body.prompt === "string" ? body.prompt : "";
    const textInputTokens = numberOrZero(inputDetails?.text_tokens);
    const imageInputTokens = numberOrZero(inputDetails?.image_tokens);
    const imageOutputTokens = numberOrZero(outputDetails?.image_tokens);
    const details = textInputTokens !== undefined || imageInputTokens !== undefined || imageOutputTokens !== undefined
      ? {
          textInputTokens,
          imageInputTokens,
          imageOutputTokens
        }
      : undefined;

    const inputTokens = numberOrZero(usage?.input_tokens) ??
      ((textInputTokens ?? countTextTokens(promptText)) + (imageInputTokens ?? 0));
    const outputTokens = numberOrZero(usage?.output_tokens) ?? imageOutputTokens ?? 0;

    logUpstreamResponse("images", {
      upstreamModel,
      status: response.status,
      elapsedMs,
      ok: true,
      usage,
      body: sanitizeImageResponseBody(responseBody)
    });

    return {
      body: responseBody,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        source: usage ? "upstream" : "estimate",
        details
      }
    };
  }
}

function numberOrZero(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function listOpenAiModels(config: Pick<AppConfig, "openaiApiKey" | "openaiBaseUrl">): Promise<OpenAiModelSummary[]> {
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required to list OpenAI models");
  }

  const response = await fetch(`${config.openaiBaseUrl}/models`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${config.openaiApiKey}`
    }
  });

  const responseBody = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`OpenAI models request failed: ${response.status}${upstreamErrorDetail(responseBody)}`);
  }

  const data = Array.isArray(responseBody.data) ? responseBody.data : [];
  return data
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const model = entry as Record<string, unknown>;
      if (typeof model.id !== "string" || model.id.length === 0) return [];
      return [{
        id: model.id,
        ownedBy: typeof model.owned_by === "string" ? model.owned_by : undefined,
        created: typeof model.created === "number" ? model.created : undefined
      }];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function probeOpenAiEndpoints(
  config: Pick<AppConfig, "openaiApiKey" | "openaiBaseUrl">,
  options: ProbeOpenAiEndpointsOptions = {}
): Promise<OpenAiEndpointProbe[]> {
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required to probe OpenAI endpoints");
  }

  const probes: EndpointProbeRequest[] = [
    {
      name: "models",
      method: "GET",
      path: "/models",
      live: false
    },
    {
      name: "files",
      method: "GET",
      path: "/files",
      live: false
    }
  ];

  if (options.live) {
    probes.push(
      {
        name: "responses",
        method: "POST",
        path: "/responses",
        live: true,
        body: {
          model: requiredProbeModel("responses", options.responsesModel ?? options.chatModel),
          input: "ping",
          max_output_tokens: 1,
          store: false
        }
      },
      {
        name: "chat_completions",
        method: "POST",
        path: "/chat/completions",
        live: true,
        body: {
          model: requiredProbeModel("chat completions", options.chatModel ?? options.responsesModel),
          messages: [{ role: "user", content: "ping" }],
          max_completion_tokens: 1,
          stream: false
        }
      },
      {
        name: "embeddings",
        method: "POST",
        path: "/embeddings",
        live: true,
        body: {
          model: requiredProbeModel("embeddings", options.embeddingModel),
          input: "ping"
        }
      }
    );
  }

  const results: OpenAiEndpointProbe[] = [];
  for (const probe of probes) {
    results.push(await runEndpointProbe(config, probe));
  }
  return results;
}

export function buildOpenAiChatRequest(body: Record<string, unknown>, upstreamModel: string): Record<string, unknown> {
  const forwarded: Record<string, unknown> = {
    ...body,
    model: upstreamModel,
    stream: false
  };

  if (forwarded.max_tokens !== undefined && forwarded.max_completion_tokens === undefined) {
    forwarded.max_completion_tokens = forwarded.max_tokens;
  }
  delete forwarded.max_tokens;

  return forwarded;
}

interface EndpointProbeRequest {
  name: string;
  method: string;
  path: string;
  live: boolean;
  body?: Record<string, unknown>;
}

function requiredProbeModel(endpointName: string, model: string | undefined): string {
  if (!model) {
    throw new Error(`A model is required to probe ${endpointName}`);
  }
  return model;
}

async function runEndpointProbe(
  config: Pick<AppConfig, "openaiApiKey" | "openaiBaseUrl">,
  probe: EndpointProbeRequest
): Promise<OpenAiEndpointProbe> {
  const response = await fetch(`${config.openaiBaseUrl}${probe.path}`, {
    method: probe.method,
    headers: {
      authorization: `Bearer ${config.openaiApiKey}`,
      ...(probe.body ? { "content-type": "application/json" } : {})
    },
    body: probe.body ? JSON.stringify(probe.body) : undefined
  });
  const responseBody = await readResponseJson(response);

  return {
    name: probe.name,
    method: probe.method,
    path: probe.path,
    live: probe.live,
    status: probeStatus(response),
    statusCode: response.status,
    detail: upstreamErrorDetail(responseBody)
      .replace(/^: /, "")
      .trim() || undefined
  };
}

async function readResponseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json() as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function probeStatus(response: Response): OpenAiEndpointProbeStatus {
  if (response.ok) return "available";
  if (response.status === 401 || response.status === 403) return "auth_error";
  if (response.status === 404) return "not_available";
  return "request_error";
}

function upstreamErrorDetail(responseBody: Record<string, unknown>): string {
  const error = responseBody.error;
  if (!error || typeof error !== "object") return "";
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" && message.length > 0 ? `: ${message}` : "";
}

function estimateCompletionTokensFromBody(responseBody: Record<string, unknown>): number {
  const choices = Array.isArray(responseBody.choices) ? responseBody.choices : [];
  return choices.reduce<number>((acc, choice) => {
    const message = (choice as { message?: { content?: unknown } } | undefined)?.message;
    const content = message?.content;
    if (typeof content === "string") return acc + countTextTokens(content);
    if (Array.isArray(content)) return acc + countTextTokens(JSON.stringify(content));
    return acc;
  }, 0);
}
