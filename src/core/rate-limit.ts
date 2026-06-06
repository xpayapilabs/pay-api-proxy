import type { Store } from "mppx/server";
import type { AppConfig } from "./config.js";
import { effectiveTraditionalApiRateLimit } from "./pricing.js";
import { traditionalApiForPublicPath } from "./paid-http/proxy.js";

export interface RateLimitVerdict {
  ok: boolean;
  retryAfterMs?: number;
}

export interface RateLimitRule {
  max: number;
  timeWindowMs: number;
  key(ip: string): string;
}

export function isRateLimitExempt(url: string): boolean {
  const path = url.split("?")[0];
  return path === "/health" || path === "/pricing" || path === "/admin/calls" || path.startsWith("/.well-known/");
}

export function rateLimitForRequest(config: AppConfig, url: string): RateLimitRule {
  const path = url.split("?")[0] || "/";
  const traditionalApi = traditionalApiForPublicPath(config, path);
  if (traditionalApi) {
    const effective = effectiveTraditionalApiRateLimit(config, traditionalApi);
    return {
      ...effective,
      key: (ip) => `traditional:${traditionalApi.id}:${ip}`
    };
  }

  const bucket = rateLimitBucket(url);
  return {
    max: bucket === "images" ? config.rateLimit.imageMax : config.rateLimit.max,
    timeWindowMs: config.rateLimit.timeWindowMs,
    key: (ip) => `${bucket}:${ip}`
  };
}

export async function consumeAtomicRateLimit(
  store: Store.AtomicStore,
  key: string,
  max: number,
  timeWindowMs: number,
  now = Date.now()
): Promise<RateLimitVerdict> {
  return store.update(`rate-limit:${key}`, (current): Store.Change<unknown, RateLimitVerdict> => {
    const bucket = isRateLimitBucket(current) ? current : undefined;
    if (!bucket || bucket.resetAt <= now) {
      return {
        op: "set",
        value: { count: 1, resetAt: now + timeWindowMs },
        result: { ok: true }
      };
    }
    if (bucket.count >= max) {
      return {
        op: "noop",
        result: { ok: false, retryAfterMs: Math.max(0, bucket.resetAt - now) }
      };
    }
    return {
      op: "set",
      value: { count: bucket.count + 1, resetAt: bucket.resetAt },
      result: { ok: true }
    };
  });
}

function rateLimitBucket(url: string): "images" | "default" {
  const path = url.split("?")[0];
  return path === "/v1/images/generations" ? "images" : "default";
}

function isRateLimitBucket(value: unknown): value is { count: number; resetAt: number } {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { count?: unknown }).count === "number" &&
    typeof (value as { resetAt?: unknown }).resetAt === "number";
}
