import type { Store } from "mppx/server";
import { parseRefundStatus } from "../../core/audit.js";
import { createPaidHttpProxy, type PaidHttpProxy } from "../../core/paid-http/proxy.js";
import { buildPricingPayload } from "../../core/pricing.js";
import { consumeAtomicRateLimit, isRateLimitExempt, rateLimitForRequest } from "../../core/rate-limit.js";
import {
  createDurableObjectMppxStore,
  mppxStoreStub,
  type DurableObjectNamespaceLike,
  type DurableObjectStubLike
} from "./storage-durable-object.js";
import { queryPaidCalls, recordPaidCall } from "./audit-log.js";
import { loadCloudflareWorkerConfig, type CloudflareWorkerConfigEnv } from "./env-config.js";

export interface CloudflareWorkerEnv extends CloudflareWorkerConfigEnv {
  MPPX_STORE: DurableObjectNamespaceLike;
}

type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
};

export default {
  async fetch(request: Request, env: CloudflareWorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
    try {
      return await handleFetch(request, env, ctx);
    } catch (error) {
      console.error("pay-api-proxy Worker request failed", error);
      return Response.json({
        error: {
          code: "worker_internal_error",
          message: publicWorkerErrorMessage(error)
        }
      }, { status: 500 });
    }
  }
};

async function handleFetch(request: Request, env: CloudflareWorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
  const config = loadCloudflareWorkerConfig(env);
  if (!env.MPPX_STORE) {
    throw new Error("MPPX_STORE Durable Object binding is missing; deploy with deployment_phase=normal after bootstrap migration");
  }
  const storeHandle = createDurableObjectMppxStore(env.MPPX_STORE);
  const auditStub = mppxStoreStub(env.MPPX_STORE);
  const proxy = createPaidHttpProxy(config, {
    storeHandle,
    auditSink: {
      record(audit) {
        ctx.waitUntil(recordPaidCall(auditStub, audit).catch((error) => {
          console.error("pay-api-proxy: failed to record paid-call audit", error);
        }));
      }
    },
    fetch: globalThis.fetch.bind(globalThis)
  });

  if (!proxy) {
    return Response.json({
      error: {
        code: "no_enabled_apis",
        message: "No enabled paid HTTP APIs are configured"
      }
    }, { status: 503 });
  }

  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/admin/calls") {
    return serveAuditQuery(request, env, auditStub);
  }

  const platformResponse = await servePlatformRoute(request, config, proxy);
  if (platformResponse) return platformResponse;

  const rateLimit = await enforceRateLimit(request, config, storeHandle.store);
  if (rateLimit) return rateLimit;

  return proxy.fetch(request);
}

export { MppxStoreDurableObject } from "./storage-durable-object.js";

function publicWorkerErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Worker failed before handling the request";
}

async function servePlatformRoute(
  request: Request,
  config: ReturnType<typeof loadCloudflareWorkerConfig>,
  proxy: PaidHttpProxy
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ status: "OK", message: "Worker is running" });
  }

  if (request.method === "GET" && url.pathname === "/.well-known/mpp") {
    return Response.json({
      protocol: "mpp",
      node_id: paymentRealm(config.publicBaseUrl),
      public_base_url: config.publicBaseUrl,
      supported_chains: [config.tempo.chainId],
      accepted_assets: [config.tempo.acceptedAsset],
      credential_types: ["transaction", "hash"],
      settlement_address: config.tempo.settlementAddress
    });
  }

  if (request.method === "GET" && url.pathname === "/.well-known/x402") {
    return Response.json({
      protocols: ["mpp"],
      payment_required_status: 402,
      discovery: `${config.publicBaseUrl}/.well-known/mpp`
    });
  }

  if (request.method === "GET" && url.pathname === "/pricing") {
    return Response.json(buildPricingPayload(config));
  }

  if (request.method === "GET" && (url.pathname === "/openapi.json" || url.pathname === "/api/openapi.json")) {
    return proxy.openApiResponse(config.publicBaseUrl);
  }

  if (request.method === "GET" && (url.pathname === "/llms.txt" || url.pathname === "/api/llms.txt")) {
    return proxy.llmsResponse(config.publicBaseUrl);
  }

  return undefined;
}

async function enforceRateLimit(
  request: Request,
  config: ReturnType<typeof loadCloudflareWorkerConfig>,
  store: Store.AtomicStore
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (isRateLimitExempt(`${url.pathname}${url.search}`)) return undefined;

  const ip = clientIpOf(request);
  const rule = rateLimitForRequest(config, `${url.pathname}${url.search}`);
  const verdict = await consumeAtomicRateLimit(store, rule.key(ip), rule.max, rule.timeWindowMs);
  if (verdict.ok) return undefined;

  return Response.json({
    error: {
      code: "rate_limited",
      message: "Too many requests; slow down or contact the operator."
    }
  }, {
    status: 429,
    headers: {
      "retry-after": Math.ceil((verdict.retryAfterMs ?? rule.timeWindowMs) / 1000).toString()
    }
  });
}

async function serveAuditQuery(
  request: Request,
  env: CloudflareWorkerEnv,
  stub: DurableObjectStubLike
): Promise<Response> {
  if (!isAuthorizedAdmin(request, env)) {
    return Response.json({
      error: {
        code: "unauthorized",
        message: "GET /admin/calls requires Authorization: Bearer <MPP_SECRET_KEY>"
      }
    }, { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  const url = new URL(request.url);
  const calls = await queryPaidCalls(stub, {
    since: url.searchParams.get("since") ?? undefined,
    apiId: url.searchParams.get("apiId") ?? undefined,
    reference: url.searchParams.get("reference") ?? undefined,
    refundStatus: parseRefundStatus(url.searchParams.get("refundStatus")),
    limit: parseAuditLimit(url.searchParams.get("limit"))
  });
  return Response.json({ calls });
}

function isAuthorizedAdmin(request: Request, env: CloudflareWorkerEnv): boolean {
  const secret = env.MPP_SECRET_KEY;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return token.length > 0 && constantTimeEqual(token, secret);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

function parseAuditLimit(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function clientIpOf(request: Request): string {
  const cfConnectingIp = request.headers.get("cf-connecting-ip");
  if (cfConnectingIp) return cfConnectingIp;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

function paymentRealm(publicBaseUrl: string): string {
  try {
    return new URL(publicBaseUrl).host || "localhost";
  } catch {
    return "localhost";
  }
}
