import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import type { PriceQuote } from "../charging/types.js";
import type { AppConfig, OpenAiCompatibleEndpoint } from "../core/config.js";
import { parseAmount } from "../core/money.js";
import type { PaymentReservationRecord, Repository } from "../db/repository.js";
import type { PaymentProvider } from "../payments/types.js";
import type { AiProvider } from "../providers/types.js";
import { createSessionBackends } from "../sessions/index.js";
import { registerPaidEndpoints } from "../endpoints/index.js";
import { sendOpenAiError } from "./errors.js";
import { createRequestTracker, type RequestTracker } from "./request-tracker.js";
import { buildPricingPayload } from "../core/pricing.js";
import { isRateLimitExempt, rateLimitForRequest } from "../core/rate-limit.js";
import {
  createTraditionalMppxProxy,
  toFetchRequest,
  traditionalApiForPublicPath,
  type TraditionalMppxProxy
} from "./traditional-mppx.js";

const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9_-]{1,64}$/;
const CUSTOMER_ID_PATTERN = /^cust_[A-Za-z0-9_-]{1,64}$/;

export interface AppDeps {
  config: AppConfig;
  repository: Repository;
  paymentProvider: PaymentProvider;
  aiProvider: AiProvider;
  requestTracker?: RequestTracker;
}

export function buildApp(deps: AppDeps) {
  const sessions = createSessionBackends(deps.config, deps.repository);
  const traditionalMppxProxy = createTraditionalMppxProxy(deps.config);
  const requestTracker = deps.requestTracker ?? createRequestTracker();
  const app = Fastify({
    logger: deps.config.nodeEnv === "test" ? false : { level: "info" },
    bodyLimit: deps.config.maxRequestBodyBytes
  });
  requestTracker.attach(app);

  app.register(cors, { origin: parseCorsOrigin(deps.config.corsAllowOrigin) });

  if (sessions.mppxAdapter) {
    const adapter = sessions.mppxAdapter;
    app.addHook("onClose", async () => {
      adapter.close();
    });
  }
  if (traditionalMppxProxy) {
    app.addHook("onClose", async () => {
      traditionalMppxProxy.close();
    });
  }

  const rateLimiter = createRateLimiter();
  app.addHook("onRequest", async (request, reply) => {
    if (isRateLimitExempt(request.url)) return;
    const ip = clientIpOf(request);
    const rateLimit = rateLimitForRequest(deps.config, request.url);
    const verdict = rateLimiter.check(rateLimit.key(ip), rateLimit.max, rateLimit.timeWindowMs);
    if (!verdict.ok) {
      reply.header("retry-after", Math.ceil(verdict.retryAfterMs / 1000).toString());
      sendOpenAiError(reply, 429, "rate_limited", "Too many requests; slow down or contact the operator.");
    }
  });

  app.get("/health", async (_request, reply) => {
    if (requestTracker.isDraining()) {
      reply.status(503);
      return {
        status: "DRAINING",
        message: "Server is shutting down"
      };
    }
    return {
      status: "OK",
      message: "Server is running"
    };
  });

  app.get("/v1/models", async (request, reply) => {
    requestTracker.setPhase(request, "serving_models");
    if (await serveTraditionalProxyWhenOpenAiDisabled(deps.config, traditionalMppxProxy, request, reply)) return;
    if (!openAiEndpointEnabled(deps.config, "models", reply)) return;

    return {
      object: "list",
      data: deps.config.models.filter((model) => model.enabled).map((model) => ({
        id: model.modelName,
        object: "model",
        created: 0,
        owned_by: "pay-api-proxy"
      }))
    };
  });

  app.get("/.well-known/mpp", async () => ({
    protocol: "mpp",
    node_id: paymentRealm(deps.config.publicBaseUrl),
    public_base_url: deps.config.publicBaseUrl,
    supported_chains: [deps.config.tempo.chainId],
    accepted_assets: [deps.config.tempo.acceptedAsset],
    credential_types: ["transaction", "hash"],
    settlement_address: deps.config.tempo.settlementAddress
  }));

  app.get("/.well-known/x402", async () => ({
    protocols: ["mpp"],
    payment_required_status: 402,
    discovery: `${deps.config.publicBaseUrl}/.well-known/mpp`
  }));

  app.get("/pricing", async () => buildPricingPayload(deps.config));

  app.get("/openapi.json", async (request, reply) => {
    if (!traditionalMppxProxy) {
      sendOpenAiError(reply, 404, "discovery_not_available", "No mppx-backed HTTP APIs are enabled");
      return;
    }
    await sendFetchResponse(reply, await traditionalMppxProxy.openApiResponse(deps.config.publicBaseUrl));
  });

  app.get("/llms.txt", async (request, reply) => {
    if (!traditionalMppxProxy) {
      sendOpenAiError(reply, 404, "discovery_not_available", "No mppx-backed HTTP APIs are enabled");
      return;
    }
    await sendFetchResponse(reply, await traditionalMppxProxy.llmsResponse(deps.config.publicBaseUrl));
  });

  app.get("/api/openapi.json", async (request, reply) => {
    if (!traditionalMppxProxy) {
      sendOpenAiError(reply, 404, "discovery_not_available", "No mppx-backed HTTP APIs are enabled");
      return;
    }
    await sendFetchResponse(reply, await traditionalMppxProxy.openApiResponse(deps.config.publicBaseUrl));
  });

  app.get("/api/llms.txt", async (request, reply) => {
    if (!traditionalMppxProxy) {
      sendOpenAiError(reply, 404, "discovery_not_available", "No mppx-backed HTTP APIs are enabled");
      return;
    }
    await sendFetchResponse(reply, await traditionalMppxProxy.llmsResponse(deps.config.publicBaseUrl));
  });

  app.post("/v1/payment-sessions", async (request, reply) => {
    requestTracker.setPhase(request, "creating_payment_session");
    if (await serveTraditionalProxyWhenOpenAiDisabled(deps.config, traditionalMppxProxy, request, reply)) return;

    const body = request.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") {
      if (sessions.mppxAdapter && hasPaymentAuthorization(request)) {
        const authorization = await sessions.mppxAdapter.authorizeRequest({
          request,
          body: {}
        });
        if (authorization.kind === "challenge" || authorization.kind === "management") {
          await sendFetchResponse(reply, authorization.response);
          return;
        }
        // mppx returned an authorized debit but we have no body to actually serve.
        // Roll the debit back so a malformed-body retry doesn't bill the customer.
        try {
          await sessions.mppxAdapter.releaseAuthorization(authorization.receipt, authorization.reservedAmount);
        } catch {
          // Release is best-effort; the upstream invalid_body response is more important.
        }
      }

      sendOpenAiError(reply, 400, "invalid_body", "Request body must be a JSON object");
      return;
    }

    const customerId = typeof body.customer_id === "string" ? body.customer_id : "";
    if (!CUSTOMER_ID_PATTERN.test(customerId)) {
      sendOpenAiError(reply, 400, "invalid_customer_id", "customer_id must match cust_[A-Za-z0-9_-]{1,64}");
      return;
    }

    let authorizedAmount: bigint;
    try {
      authorizedAmount = parseAmount(body.authorized_max_amount);
      if (authorizedAmount <= 0n) throw new Error("authorized_max_amount must be greater than zero");
    } catch (error) {
      sendOpenAiError(reply, 400, "invalid_authorized_amount", error instanceof Error ? error.message : "Invalid amount");
      return;
    }

    const expiresAt = typeof body.expires_at === "string" ? body.expires_at : "";
    if (!expiresAt || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
      sendOpenAiError(reply, 400, "invalid_expires_at", "expires_at must be a future ISO timestamp");
      return;
    }

    const allowedModels = parseAllowedModels(body.allowed_models, deps.config);
    if (!allowedModels) {
      sendOpenAiError(reply, 400, "invalid_allowed_models", "allowed_models must be an array of enabled model names");
      return;
    }

    let credential;
    try {
      credential = deps.paymentProvider.parseCredential(paymentCredentialHeader(request.headers));
    } catch (error) {
      sendOpenAiError(reply, 402, "invalid_payment", error instanceof Error ? error.message : "Invalid payment");
      return;
    }

    const sessionId = credential?.memo && SESSION_ID_PATTERN.test(credential.memo)
      ? credential.memo
      : `sess_${nanoid(16)}`;
    const quote = buildSessionFundingQuote(sessionId, authorizedAmount, deps.config);
    const challenge = deps.paymentProvider.createChallenge(quote);

    if (!credential) {
      reply.header("www-authenticate", buildPaymentAuthenticateHeader(challenge, deps.config));
      reply.header("cache-control", "no-store");
      reply.status(402).send({
        error: {
          message: "Payment required",
          type: "payment_required",
          code: "payment_required"
        },
        payment: challenge
      });
      return;
    }

    let verifiedPayment;
    try {
      requestTracker.setPhase(request, "verifying_payment");
      verifiedPayment = await deps.paymentProvider.verifyCredential(credential, challenge);
    } catch (error) {
      reply.header("www-authenticate", buildPaymentAuthenticateHeader(challenge, deps.config));
      reply.header("cache-control", "no-store");
      reply.status(402).send({
        error: {
          message: error instanceof Error ? error.message : "Payment verification failed",
          type: "payment_required",
          code: "payment_verification_failed"
        },
        payment: challenge
      });
      return;
    }

    const outcome = deps.repository.transaction(() => {
      requestTracker.setPhase(request, "storing_payment_session");
      if (deps.repository.findPaymentByCredentialHash(verifiedPayment.credentialHash)) {
        return { kind: "reused" as const };
      }
      if (deps.repository.getPaymentSession(sessionId)) {
        return { kind: "duplicate_session" as const };
      }
      const payment = deps.repository.createPayment({
        id: verifiedPayment.id,
        protocol: verifiedPayment.protocol,
        chainId: verifiedPayment.chainId,
        assetAddress: verifiedPayment.assetAddress,
        credentialType: verifiedPayment.credentialType,
        credentialHash: verifiedPayment.credentialHash,
        settlementTx: verifiedPayment.settlementTx,
        status: verifiedPayment.status,
        settlementVerification: verifiedPayment.settlementVerification,
        prepaidMaxAmount: verifiedPayment.prepaidMaxAmount,
        settledAmount: verifiedPayment.settledAmount
      });
      const session = deps.repository.createPaymentSession({
        id: sessionId,
        customerId,
        paymentId: payment.id,
        protocol: verifiedPayment.protocol,
        chainId: verifiedPayment.chainId,
        assetAddress: verifiedPayment.assetAddress,
        settlementAddress: deps.config.tempo.settlementAddress,
        credentialHash: verifiedPayment.credentialHash,
        authorizedMaxAmount: verifiedPayment.prepaidMaxAmount,
        remainingAuthorizedAmount: verifiedPayment.prepaidMaxAmount,
        reservedAmount: "0",
        settledAmount: "0",
        expiresAt,
        allowedModels,
        status: "active"
      });
      return { kind: "ok" as const, session };
    });

    if (outcome.kind === "reused") {
      sendOpenAiError(reply, 402, "payment_reused", "Payment credential has already been used");
      return;
    }
    if (outcome.kind === "duplicate_session") {
      sendOpenAiError(reply, 409, "session_id_already_used", "Session id has already been used");
      return;
    }

    reply.status(201).send({ session: serializePaymentSession(outcome.session) });
  });

  app.get("/v1/payment-sessions/:sessionId", async (request, reply) => {
    requestTracker.setPhase(request, "reading_payment_session");
    if (await serveTraditionalProxyWhenOpenAiDisabled(deps.config, traditionalMppxProxy, request, reply)) return;

    const { sessionId } = request.params as { sessionId: string };
    const customerId = firstHeaderValue(request.headers["x-customer-id"]);
    if (!customerId) {
      sendOpenAiError(reply, 400, "missing_customer_id", "x-customer-id is required");
      return;
    }

    const session = deps.repository.getPaymentSession(sessionId);
    if (!session || session.customerId !== customerId) {
      sendOpenAiError(reply, 404, "session_not_found", "Payment session not found");
      return;
    }

    reply.send({ session: serializePaymentSession(session) });
  });

  app.post("/v1/payment-sessions/:sessionId/revoke", async (request, reply) => {
    requestTracker.setPhase(request, "revoking_payment_session");
    if (await serveTraditionalProxyWhenOpenAiDisabled(deps.config, traditionalMppxProxy, request, reply)) return;

    const { sessionId } = request.params as { sessionId: string };
    const customerId = firstHeaderValue(request.headers["x-customer-id"]);
    if (!customerId) {
      sendOpenAiError(reply, 400, "missing_customer_id", "x-customer-id is required");
      return;
    }

    const revoked = deps.repository.revokePaymentSession(sessionId, customerId);
    if (!revoked) {
      sendOpenAiError(reply, 404, "session_not_found", "Active payment session not found");
      return;
    }

    const session = deps.repository.getPaymentSession(sessionId);
    reply.send({ session: session ? serializePaymentSession(session) : undefined });
  });

  app.get("/v1/payment-sessions/:sessionId/reservations", async (request, reply) => {
    requestTracker.setPhase(request, "reading_reservations");
    if (await serveTraditionalProxyWhenOpenAiDisabled(deps.config, traditionalMppxProxy, request, reply)) return;

    const { sessionId } = request.params as { sessionId: string };
    const customerId = firstHeaderValue(request.headers["x-customer-id"]);
    if (!customerId) {
      sendOpenAiError(reply, 400, "missing_customer_id", "x-customer-id is required");
      return;
    }

    const session = deps.repository.getPaymentSession(sessionId);
    if (!session || session.customerId !== customerId) {
      sendOpenAiError(reply, 404, "session_not_found", "Payment session not found");
      return;
    }

    reply.send({
      reservations: deps.repository.listPaymentReservations(sessionId, customerId).map(serializePaymentReservation)
    });
  });

  app.get("/receipts/:receiptId", async (request, reply) => {
    requestTracker.setPhase(request, "reading_receipt");
    const { receiptId } = request.params as { receiptId: string };
    const receipt = deps.repository.getReceipt(receiptId);
    if (!receipt) {
      sendOpenAiError(reply, 404, "receipt_not_found", "Receipt not found");
      return;
    }

    reply.send({
      receipt: JSON.parse(receipt.receiptJson),
      receipt_hash: receipt.receiptHash,
      signature: receipt.signature,
      status: receipt.status
    });
  });

  if (deps.config.upstreamProvider === "openai") {
    registerPaidEndpoints(app, {
      config: deps.config,
      repository: deps.repository,
      aiProvider: deps.aiProvider,
      sessions,
      requestTracker
    });
  }

  if (traditionalMppxProxy) {
    app.route({
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
      url: "/*",
      handler: async (request, reply) => {
        requestTracker.setPhase(request, "proxying_mpp_request");
        await sendFetchResponse(reply, await traditionalMppxProxy.fetch(
          toFetchRequest(request, deps.config.publicBaseUrl)
        ));
      }
    });
  }

  return app;
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

async function serveTraditionalProxyWhenOpenAiDisabled(
  config: AppConfig,
  traditionalMppxProxy: TraditionalMppxProxy | undefined,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  if (config.upstreamProvider === "openai") return false;
  if (!traditionalMppxProxy) {
    sendOpenAiError(reply, 404, "endpoint_not_enabled", "OpenAI-compatible upstream is not enabled");
    return true;
  }
  await sendFetchResponse(reply, await traditionalMppxProxy.fetch(
    toFetchRequest(request, config.publicBaseUrl)
  ));
  return true;
}

function parseCorsOrigin(value: string): string | string[] | boolean {
  const trimmed = value.trim();
  if (trimmed === "*") return "*";
  if (trimmed === "false" || trimmed === "") return false;
  return trimmed.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function buildPaymentAuthenticateHeader(challenge: ReturnType<PaymentProvider["createChallenge"]>, config: AppConfig): string {
  const request = Buffer.from(JSON.stringify({
    amount: challenge.amount,
    currency: challenge.assetAddress,
    methodDetails: {
      chainId: challenge.chainId,
      memo: challenge.memoHex ?? challenge.memoText,
      supportedModes: supportedTempoModes(challenge.credentialTypes)
    },
    recipient: challenge.settlementAddress,
    unitType: "request"
  })).toString("base64url");
  const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  return formatAuthHeader("Payment", {
    id: challenge.memo,
    realm: paymentRealm(config.publicBaseUrl),
    method: "tempo",
    intent: "charge",
    request,
    description: "pay-api-proxy chat completion",
    expires
  });
}

function buildSessionFundingQuote(sessionId: string, amount: bigint, config: AppConfig): PriceQuote {
  return {
    requestId: sessionId,
    model: "payment-session",
    chargingMethod: config.chargingMethod,
    inputTokensEstimate: 0,
    maxOutputTokens: 0,
    maxCharge: amount,
    currency: {
      symbol: config.models[0]?.assetSymbol ?? "USDC",
      assetAddress: config.tempo.acceptedAsset,
      chainId: config.tempo.chainId
    }
  };
}

async function sendFetchResponse(reply: FastifyReply, response: Response): Promise<void> {
  for (const [key, value] of response.headers) {
    reply.header(key, value);
  }
  reply.status(response.status).send(Buffer.from(await response.arrayBuffer()));
}

function parseAllowedModels(value: unknown, config: AppConfig): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const enabled = new Set(config.models.filter((model) => model.enabled).map((model) => model.modelName));
  const models = value.filter((entry): entry is string => typeof entry === "string");
  if (models.length !== value.length) return undefined;
  if (models.some((model) => !enabled.has(model))) return undefined;
  return [...new Set(models)];
}

function serializePaymentSession(session: {
  id: string;
  customerId: string;
  chainId: number;
  assetAddress: string;
  settlementAddress: string;
  authorizedMaxAmount: string;
  remainingAuthorizedAmount: string;
  reservedAmount: string;
  settledAmount: string;
  expiresAt: string;
  allowedModels: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: session.id,
    customer_id: session.customerId,
    chain_id: session.chainId,
    asset_address: session.assetAddress,
    settlement_address: session.settlementAddress,
    authorized_max_amount: session.authorizedMaxAmount,
    remaining_authorized_amount: session.remainingAuthorizedAmount,
    reserved_amount: session.reservedAmount,
    settled_amount: session.settledAmount,
    expires_at: session.expiresAt,
    allowed_models: session.allowedModels,
    status: session.status,
    created_at: session.createdAt,
    updated_at: session.updatedAt
  };
}

function serializePaymentReservation(reservation: PaymentReservationRecord) {
  return {
    id: reservation.id,
    session_id: reservation.sessionId,
    request_id: reservation.requestId,
    customer_id: reservation.customerId,
    request_hash: reservation.requestHash,
    reserved_amount: reservation.reservedAmount,
    actual_amount: reservation.actualAmount,
    released_amount: reservation.releasedAmount,
    status: reservation.status,
    created_at: reservation.createdAt,
    settled_at: reservation.settledAt
  };
}

function supportedTempoModes(credentialTypes: Array<"transaction" | "hash">): string[] {
  const modes: string[] = [];
  if (credentialTypes.includes("transaction")) modes.push("pull");
  if (credentialTypes.includes("hash")) modes.push("push");
  return modes;
}

function paymentCredentialHeader(headers: Record<string, unknown>): string | undefined {
  const authorization = firstHeaderValue(headers.authorization);
  if (authorization?.startsWith("Payment ")) return authorization;
  return firstHeaderValue(headers["x-payment"]);
}

function firstHeaderValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function hasPaymentAuthorization(request: FastifyRequest): boolean {
  const authorization = firstHeaderValue(request.headers.authorization);
  return authorization?.startsWith("Payment ") ?? false;
}

function paymentRealm(publicBaseUrl: string): string {
  try {
    return new URL(publicBaseUrl).host || "localhost";
  } catch {
    return "localhost";
  }
}

function formatAuthHeader(scheme: string, params: Record<string, string>): string {
  return `${scheme} ${Object.entries(params)
    .map(([key, value]) => `${key}="${escapeAuthParam(value)}"`)
    .join(", ")}`;
}

function escapeAuthParam(value: string): string {
  return value.replace(/[\r\n]/g, "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

interface RateLimiter {
  check(key: string, max: number, timeWindowMs: number): { ok: true } | { ok: false; retryAfterMs: number };
}

/**
 * Fixed-window per-IP limiter. Cheap, in-memory, and gives us defense-in-depth
 * against unauthenticated 402 spam without adding a dependency. An operator's
 * reverse proxy should still set its own coarser limit at the edge.
 */
function createRateLimiter(): RateLimiter {
  const counts = new Map<string, { count: number; resetAt: number }>();
  return {
    check(key, max, timeWindowMs) {
      const now = Date.now();
      const existing = counts.get(key);
      if (!existing || existing.resetAt <= now) {
        counts.set(key, { count: 1, resetAt: now + timeWindowMs });
        return { ok: true };
      }
      if (existing.count >= max) {
        return { ok: false, retryAfterMs: Math.max(0, existing.resetAt - now) };
      }
      existing.count += 1;
      return { ok: true };
    }
  };
}

function clientIpOf(request: FastifyRequest): string {
  const forwarded = firstHeaderValue(request.headers["x-forwarded-for"]);
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.ip ?? "unknown";
}
