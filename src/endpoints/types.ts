import type { FastifyReply, FastifyRequest } from "fastify";
import type { ActualUsageAmount, PriceQuote } from "../charging/index.js";
import type { AppConfig, OpenAiCompatibleEndpoint } from "../core/config.js";
import type { ModelConfig } from "../core/models.js";
import type { TokenUsage } from "../core/tokenizer.js";
import type { AiProvider } from "../providers/types.js";

/**
 * A PaidEndpoint describes an OpenAI-shaped billable HTTP route. The generic
 * handler owns the session/reservation/receipt machinery; the endpoint owns
 * what the body looks like, which model it resolves, how the upstream call
 * is made, and what response shape is returned.
 *
 * To add a new endpoint (e.g. /v1/embeddings):
 *   1. Implement this interface, including `callUpstream` that hits the
 *      relevant AiProvider method.
 *   2. Add it to the default registry in src/endpoints/index.ts.
 *   3. Add the whitelist key in src/core/config.ts and the wizard.
 */
export interface PaidEndpoint<TBody = Record<string, unknown>, TUpstream = UpstreamResult> {
  readonly id: string;
  readonly method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly whitelistKey: OpenAiCompatibleEndpoint;

  /**
   * Validate the parsed request body. Returns the typed body on success or an
   * OpenAI-style error tuple on failure (status, code, message). Throw is fine
   * for unexpected errors; the handler turns those into 502.
   */
  validateBody(rawBody: unknown): TBody | EndpointError;

  /**
   * Resolve the public model name from the body to a configured ModelConfig.
   * Returns an OpenAI-style error tuple on failure.
   */
  resolveModel(body: TBody, models: ModelConfig[]): ModelConfig | EndpointError;

  /** Call the upstream provider and capture both the body and token usage. */
  callUpstream(provider: AiProvider, body: TBody, model: ModelConfig): Promise<TUpstream>;

  /** Token usage extracted from the upstream result, used for actual-usage billing. */
  extractUsage(upstream: TUpstream): TokenUsage;

  /** Body to send back to the caller. */
  responseBody(upstream: TUpstream): unknown;

  /**
   * Empty-body preflight (optional). If the request body is missing/invalid,
   * the handler asks the endpoint whether to delegate to a side flow (e.g. the
   * mppx empty-body channel-management preflight) before returning 400. Return
   * a Response to forward verbatim, or undefined to fall through to invalid_body.
   */
  emptyBodyPreflight?(request: FastifyRequest, config: AppConfig): Promise<Response | undefined>;

  /**
   * Optional: override the deterministic max-charge quote. If absent, the handler
   * uses the configured ChargingStrategy (ai-token or per-request). Endpoints
   * with non-token pricing (images, video) override this to compute a quote from
   * their own body shape (size, quality, duration, etc.) and may also return
   * EndpointError when the request can't be priced (e.g. unsupported size).
   */
  quoteRequest?(input: { requestId: string; body: TBody; model: ModelConfig }): PriceQuote | EndpointError;

  /**
   * Optional: override the actual-usage settlement amount. If absent, the
   * handler delegates to the ChargingStrategy. Endpoints with per-modality
   * pricing implement this to charge each token category at its own price.
   */
  calculateActualUsage?(input: { usage: TokenUsage; model: ModelConfig; body: TBody }): ActualUsageAmount;
}

export interface EndpointError {
  __endpointError: true;
  status: number;
  code: string;
  message: string;
}

export function endpointError(status: number, code: string, message: string): EndpointError {
  return { __endpointError: true, status, code, message };
}

export function isEndpointError(value: unknown): value is EndpointError {
  return typeof value === "object" && value !== null && (value as EndpointError).__endpointError === true;
}

export interface UpstreamResult {
  body: unknown;
  usage: TokenUsage;
}

/**
 * Helper used by the generic handler to send the per-endpoint response. Kept
 * here (rather than as a method on PaidEndpoint) because endpoints don't need
 * to know about Fastify reply ergonomics.
 */
export function sendUpstreamBody(reply: FastifyReply, body: unknown): void {
  reply.send(body);
}
