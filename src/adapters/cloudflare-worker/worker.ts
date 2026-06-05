import type { Store } from "mppx/server";
import { createPaidHttpProxy, type PaidHttpProxy } from "../../core/paid-http/proxy.js";
import { buildPricingPayload } from "../../core/pricing.js";
import { consumeAtomicRateLimit, isRateLimitExempt, rateLimitForRequest } from "../../core/rate-limit.js";
import { createDurableObjectMppxStore, type DurableObjectNamespaceLike } from "./storage-durable-object.js";
import { loadCloudflareWorkerConfig, type CloudflareWorkerConfigEnv } from "./env-config.js";

export interface CloudflareWorkerEnv extends CloudflareWorkerConfigEnv {
  MPPX_STORE: DurableObjectNamespaceLike;
}

type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
};

export default {
  async fetch(request: Request, env: CloudflareWorkerEnv, _ctx: ExecutionContextLike): Promise<Response> {
    const config = loadCloudflareWorkerConfig(env);
    const storeHandle = createDurableObjectMppxStore(env.MPPX_STORE);
    const proxy = createPaidHttpProxy(config, {
      storeHandle,
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

    const platformResponse = await servePlatformRoute(request, config, proxy);
    if (platformResponse) return platformResponse;

    const rateLimit = await enforceRateLimit(request, config, storeHandle.store);
    if (rateLimit) return rateLimit;

    return proxy.fetch(request);
  }
};

export { MppxStoreDurableObject } from "./storage-durable-object.js";

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
