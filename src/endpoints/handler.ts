import type { FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { sendOpenAiError } from "../api/errors.js";
import { getChargingStrategy, quoteSessionReservation, settleSessionUsage } from "../charging/index.js";
import type { AppConfig, OpenAiCompatibleEndpoint } from "../core/config.js";
import type { Repository } from "../db/repository.js";
import type { AiProvider } from "../providers/types.js";
import type { SessionBackends } from "../sessions/index.js";
import type { RequestTracker } from "../api/request-tracker.js";
import { isEndpointError, type PaidEndpoint } from "./types.js";

const REQUEST_ID_PATTERN = /^req_[A-Za-z0-9_-]{1,64}$/;

export interface HandlerDeps {
  config: AppConfig;
  repository: Repository;
  aiProvider: AiProvider;
  sessions: SessionBackends;
  requestTracker?: RequestTracker;
}

/**
 * Generic billed-request handler. Shared between every paid endpoint: it owns
 * body validation glue, request-id resolution, quoting, session dispatch,
 * upstream call, settlement, receipt persistence, and response framing.
 *
 * Per-endpoint logic (body shape, upstream method, response body) lives in
 * the PaidEndpoint implementation; per-backend logic (reservation, settlement,
 * receipt shape, headers) lives in the SessionBackend.
 */
export async function handleBilledRequest(
  endpoint: PaidEndpoint,
  deps: HandlerDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  deps.requestTracker?.setPhase(request, "validating_request");
  if (!openAiEndpointEnabled(deps.config, endpoint.whitelistKey, reply)) return;

  const rawBody = request.body;
  if (!rawBody || typeof rawBody !== "object") {
    if (endpoint.emptyBodyPreflight) {
      const preflight = await endpoint.emptyBodyPreflight(request, deps.config);
      if (preflight) {
        await sendFetchResponse(reply, preflight);
        return;
      }
    }
    sendOpenAiError(reply, 400, "invalid_body", "Request body must be a JSON object");
    return;
  }

  const validated = endpoint.validateBody(rawBody);
  if (isEndpointError(validated)) {
    sendOpenAiError(reply, validated.status, validated.code, validated.message);
    return;
  }

  const model = endpoint.resolveModel(validated as Record<string, unknown>, deps.config.models);
  if (isEndpointError(model)) {
    sendOpenAiError(reply, model.status, model.code, model.message);
    return;
  }

  const requestIdHeader = request.headers["x-paid-request-id"];
  let requestId: string;
  if (typeof requestIdHeader === "string") {
    if (!REQUEST_ID_PATTERN.test(requestIdHeader)) {
      sendOpenAiError(reply, 400, "invalid_request_id", "x-paid-request-id must match req_[A-Za-z0-9_-]{1,64}");
      return;
    }
    requestId = requestIdHeader;
  } else {
    requestId = `req_${nanoid(16)}`;
  }

  const chargingStrategy = getChargingStrategy(deps.config.chargingMethod);
  let quote;
  try {
    deps.requestTracker?.setPhase(request, "quoting_request");
    if (endpoint.quoteRequest) {
      const result = endpoint.quoteRequest({ requestId, body: validated, model });
      if (isEndpointError(result)) {
        sendOpenAiError(reply, result.status, result.code, result.message);
        return;
      }
      quote = result;
    } else {
      quote = chargingStrategy.quoteRequest({ requestId, body: validated as Record<string, unknown>, model });
    }
  } catch (error) {
    sendOpenAiError(reply, 400, "invalid_max_tokens", error instanceof Error ? error.message : "Invalid max_tokens");
    return;
  }
  const sessionQuote = quoteSessionReservation(quote, deps.config.sessionBilling);

  const backend = deps.sessions.select(request);
  if (!backend) {
    deps.requestTracker?.setPhase(request, "sending_payment_challenge");
    reply.header("link", `<${deps.config.publicBaseUrl}/v1/payment-sessions>; rel="payment-session-init"`);
    reply.header("cache-control", "no-store");
    reply.status(402).send({
      error: {
        message: "x-mpp-session-id is required. Create a session via POST /v1/payment-sessions, then retry with the session id.",
        type: "payment_required",
        code: "session_required"
      },
      payment_session: {
        create_endpoint: "/v1/payment-sessions",
        method: "POST"
      }
    });
    return;
  }

  deps.requestTracker?.setPhase(request, "reserving_payment");
  const reserveOutcome = await backend.reserve({
    request,
    body: validated as Record<string, unknown>,
    model,
    requestId,
    quote,
    sessionQuote,
    endpoint: endpoint.path
  });
  if (reserveOutcome.kind === "raw_response") {
    await sendFetchResponse(reply, reserveOutcome.response);
    return;
  }
  if (reserveOutcome.kind === "error") {
    sendOpenAiError(reply, reserveOutcome.status, reserveOutcome.code, reserveOutcome.message);
    return;
  }

  let upstream;
  try {
    deps.requestTracker?.setPhase(request, "calling_upstream");
    upstream = await endpoint.callUpstream(deps.aiProvider, validated, model);
  } catch (error) {
    await backend.release(reserveOutcome.authorization, requestId);
    sendOpenAiError(reply, 502, "upstream_error", error instanceof Error ? error.message : "Upstream request failed");
    return;
  }

  const usage = endpoint.extractUsage(upstream);
  const actual = endpoint.calculateActualUsage
    ? endpoint.calculateActualUsage({ usage, model, body: validated })
    : chargingStrategy.calculateActualUsage({ model, usage });
  const settlement = settleSessionUsage(actual, deps.config.sessionBilling);

  let settleOutcome;
  try {
    deps.requestTracker?.setPhase(request, "settling_payment");
    settleOutcome = await backend.settle({
      authorization: reserveOutcome.authorization,
      settlement,
      usage,
      requestId
    });
  } catch (error) {
    await backend.release(reserveOutcome.authorization, requestId);
    sendOpenAiError(reply, 502, "settlement_error", error instanceof Error ? error.message : "Settlement failed");
    return;
  }

  deps.requestTracker?.setPhase(request, "building_receipt");
  const receipt = backend.buildReceiptAndHeaders({
    authorization: reserveOutcome.authorization,
    settle: settleOutcome,
    settlement,
    actual,
    usage,
    requestId,
    model,
    config: deps.config
  });

  deps.repository.createReceipt({
    id: receipt.receiptId,
    requestId,
    paymentId: receipt.paymentId,
    receiptJson: receipt.payloadJson,
    receiptHash: receipt.receiptHash,
    signature: receipt.signature,
    status: receipt.status
  });

  deps.requestTracker?.setPhase(request, "sending_response");
  reply.header("x-paid-request-id", requestId);
  receipt.applyHeaders(reply);
  reply.send(endpoint.responseBody(upstream));
}

function openAiEndpointEnabled(config: AppConfig, endpoint: OpenAiCompatibleEndpoint, reply: FastifyReply): boolean {
  if (config.upstreamProvider !== "openai") {
    sendOpenAiError(reply, 404, "endpoint_not_enabled", "OpenAI-compatible upstream is not enabled");
    return false;
  }
  if (config.openaiEndpointWhitelist.includes(endpoint)) return true;
  sendOpenAiError(reply, 404, "endpoint_not_enabled", "OpenAI-compatible endpoint is not enabled");
  return false;
}

async function sendFetchResponse(reply: FastifyReply, response: Response): Promise<void> {
  for (const [key, value] of response.headers) {
    reply.header(key, value);
  }
  reply.status(response.status).send(Buffer.from(await response.arrayBuffer()));
}
