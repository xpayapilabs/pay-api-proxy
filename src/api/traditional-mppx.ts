import { readFileSync } from "node:fs";
import type { FastifyRequest } from "fastify";
import { createSqliteMppxStore } from "../adapters/node-container/mppx-store-sqlite.js";
import type { AppConfig } from "../core/config.js";
import {
  createPaidHttpProxy,
  enabledTraditionalApis,
  httpApisUsePrefixedMount,
  prepareTraditionalUpstreamRequest,
  traditionalApiForPublicPath,
  traditionalApiPublicPathPrefix,
  type PaidHttpProxy
} from "../core/paid-http/proxy.js";

export {
  enabledTraditionalApis,
  httpApisUsePrefixedMount,
  prepareTraditionalUpstreamRequest,
  traditionalApiForPublicPath,
  traditionalApiPublicPathPrefix
};

export type TraditionalMppxProxy = PaidHttpProxy;

export function createTraditionalMppxProxy(config: AppConfig): TraditionalMppxProxy | undefined {
  return createPaidHttpProxy(config, {
    storeHandle: createSqliteMppxStore(config.databasePath),
    loadOpenApiDocument: readImportedOpenApiDocument
  });
}

export function toFetchRequest(request: FastifyRequest, publicBaseUrl: string): Request {
  const url = new URL(request.url, publicBaseUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else headers.set(key, String(value));
  }
  if (!headers.has("content-type") && request.body !== undefined && request.body !== null) {
    headers.set("content-type", "application/json");
  }

  const method = request.method.toUpperCase();
  return new Request(url, {
    method: request.method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : serializeBody(request.body)
  });
}

function readImportedOpenApiDocument(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`OpenAPI document at ${path} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function serializeBody(body: unknown): string | URLSearchParams | Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || body instanceof URLSearchParams || Buffer.isBuffer(body)) return body;
  return JSON.stringify(body);
}
