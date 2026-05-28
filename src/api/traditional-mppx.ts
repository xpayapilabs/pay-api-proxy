import { readFileSync } from "node:fs";
import type { FastifyRequest } from "fastify";
import { Proxy, Service } from "mppx/proxy";
import { Mppx, tempo } from "mppx/server";
import type { AppConfig, TraditionalApiConfig, TraditionalApiRouteConfig } from "../core/config.js";
import { rawAmountToDecimalString, createMppxStore } from "../payments/mppx-session.js";

export interface TraditionalMppxProxy {
  fetch(request: Request): Promise<Response>;
  openApiResponse(publicBaseUrl: string): Promise<Response>;
  llmsResponse(publicBaseUrl: string): Promise<Response>;
  close(): void;
}

interface TraditionalMppx {
  tempo: {
    charge(options: Record<string, unknown>): Service.IntentHandler;
  };
}

const OPENAPI_HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export function createTraditionalMppxProxy(config: AppConfig): TraditionalMppxProxy | undefined {
  const apis = config.traditionalApis.filter((api) => api.enabled);
  if (apis.length === 0) return undefined;
  if (apis.length > 1) {
    throw new Error("single-API mount mode supports exactly one enabled traditionalApi");
  }
  const api = apis[0]!;

  const storeHandle = createMppxStore(config);
  const mppx = Mppx.create({
    realm: paymentRealm(config.publicBaseUrl),
    secretKey: config.mppx.secretKey,
    methods: [
      tempo.charge({
        currency: config.tempo.acceptedAsset as `0x${string}`,
        decimals: config.tempo.assetDecimals,
        recipient: config.tempo.settlementAddress as `0x${string}`,
        rpcUrl: { [config.tempo.chainId]: config.tempo.rpcUrl },
        store: storeHandle.store,
        testnet: config.mppx.testnet,
        waitForConfirmation: config.mppx.waitForConfirmation
      } as unknown as Parameters<typeof tempo.charge>[0])
    ]
  });

  const proxy = Proxy.create({
    basePath: "/api",
    description: "Configured paid HTTP APIs, protected by mppx Payment authentication.",
    services: [createTraditionalService(api, config, mppx as unknown as TraditionalMppx)],
    title: "pay-api-proxy HTTP APIs",
    version: "1.0.0"
  });

  return {
    fetch: (request) => fetchWithUpstreamTimeout(proxy, toInternalProxyRequest(request, api.id), api.upstreamTimeoutMs),
    openApiResponse: (publicBaseUrl) => publicOpenApiResponse(proxy, api, config, publicBaseUrl),
    llmsResponse: (publicBaseUrl) => publicLlmsResponse(proxy, publicBaseUrl),
    close: () => storeHandle.close()
  };
}

async function fetchWithUpstreamTimeout(proxy: Proxy.Proxy, request: Request, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await proxy.fetch(new Request(request, { signal: controller.signal }));
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return Response.json({
        error: {
          code: "upstream_timeout",
          message: `Upstream request timed out after ${timeoutMs}ms`
        }
      }, { status: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

function createTraditionalService(
  api: TraditionalApiConfig,
  config: AppConfig,
  mppx: TraditionalMppx
) {
  return Service.custom(api.id, {
    baseUrl: api.upstreamBaseUrl,
    categories: ["paid-api"],
    description: `${api.id} paid HTTP API`,
    rewriteRequest(request, ctx) {
      return prepareTraditionalUpstreamRequest(request, api, ctx);
    },
    routes: createTraditionalRoutes(api, config, mppx),
    title: api.id
  });
}

function createTraditionalRoutes(
  api: TraditionalApiConfig,
  config: AppConfig,
  mppx: TraditionalMppx
) {
  const routes: Service.EndpointMap = {};
  const addRoute = (
    method: string,
    path: string,
    requestPrice: bigint,
    route?: TraditionalApiRouteConfig
  ) => {
    const routeScope = `${method.toUpperCase()} ${toDisplayPath(path)}`;
    const pay = mppx.tempo.charge({
      amount: rawAmountToDecimalString(requestPrice, config.tempo.assetDecimals),
      chainId: api.chainId,
      currency: api.assetAddress,
      decimals: config.tempo.assetDecimals,
      description: route?.id ? `${api.id}:${route.id}` : api.id,
      externalId: route?.id ? `api:${api.id}:${route.id}` : `api:${api.id}`,
      recipient: config.tempo.settlementAddress,
      scope: routeScope,
      supportedModes: ["pull", "push"]
    });
    const options = traditionalEndpointOptions(route);
    routes[`${method.toUpperCase()} ${toUrlPatternPath(path)}`] = options ? { pay, options } : pay;
  };

  const sortedRoutes = [...api.routes].sort((left, right) =>
    traditionalRouteSpecificity(right) - traditionalRouteSpecificity(left)
  );
  for (const route of sortedRoutes) {
    for (const method of route.methods) addRoute(method, route.path, route.requestPrice, route);
  }
  if (api.allowUnmatchedRoutes !== false) {
    for (const method of api.methods) addRoute(method, "*", api.requestPrice);
  }
  return routes;
}

export function prepareTraditionalUpstreamRequest(
  request: Request,
  api: Pick<TraditionalApiConfig, "bearer" | "forwardedHeaders" | "headers">,
  options: Record<string, unknown> = {}
): Request {
  const filtered = filterForwardedHeaders(request, api.forwardedHeaders);
  const headers = new Headers(filtered.headers);
  const routeHeaders = isHeaderMap(options.headers) ? options.headers : undefined;
  const configuredHeaders = {
    ...(api.headers ?? {}),
    ...(routeHeaders ?? {})
  };
  for (const [name, value] of Object.entries(configuredHeaders)) {
    headers.set(name, value);
  }
  const bearer = typeof options.bearer === "string" ? options.bearer : api.bearer;
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  return new Request(filtered, { headers });
}

function traditionalEndpointOptions(
  route: TraditionalApiRouteConfig | undefined
): Service.EndpointOptions | undefined {
  if (!route?.bearer && !route?.headers) return undefined;
  return {
    ...(route.bearer ? { bearer: route.bearer } : {}),
    ...(route.headers ? { headers: route.headers } : {})
  };
}

function isHeaderMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function filterForwardedHeaders(request: Request, allowedHeaders: string[]): Request {
  const allowed = new Set(allowedHeaders.map((entry) => entry.toLowerCase()));
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (allowed.has(key.toLowerCase())) headers.set(key, value);
  }
  return new Request(request, { headers });
}

function toUrlPatternPath(path: string): string {
  const urlPatternPath = path === "*"
    ? "/*"
    : path.endsWith("/*")
      ? `${path.slice(0, -1)}*`
      : path;
  return urlPatternPath.replace(/\{([^}/]+)\}/g, (_match, name: string) => `:${urlPatternParamName(name)}`);
}

function urlPatternParamName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return "param";
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `p_${cleaned}`;
}

function toDisplayPath(path: string): string {
  return path === "*" ? "/*" : path;
}

function traditionalRouteSpecificity(route: TraditionalApiRouteConfig): number {
  if (route.path === "*") return 0;
  const wildcardCount = route.path.match(/\*/g)?.length ?? 0;
  const parameterCount = route.path.match(/\{[^}]+\}|:[A-Za-z_][A-Za-z0-9_]*/g)?.length ?? 0;
  const staticLength = route.path
    .replace(/\{[^}]+\}/g, "")
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "")
    .replace(/\*/g, "")
    .length;
  return staticLength * 100 - parameterCount * 10 - wildcardCount * 50 + route.path.length;
}

function toInternalProxyRequest(request: Request, apiId: string): Request {
  const url = new URL(request.url);
  url.pathname = `/api/${apiId}${url.pathname === "/" ? "" : url.pathname}`;
  return new Request(url, request);
}

async function publicOpenApiResponse(
  proxy: Proxy.Proxy,
  api: TraditionalApiConfig,
  config: AppConfig,
  publicBaseUrl: string
): Promise<Response> {
  if (api.openApiDocumentUrl) {
    return importedOpenApiResponseFromUrl(api, config, publicBaseUrl);
  }
  if (api.openApiDocumentPath) {
    return importedOpenApiResponse(api, config, publicBaseUrl);
  }

  const response = await proxy.fetch(new Request(new URL("/api/openapi.json", publicBaseUrl)));
  if (!response.ok) return response;

  const document = await response.json() as {
    paths?: Record<string, unknown>;
    [key: string]: unknown;
  };
  const prefix = `/api/${api.id}`;
  const paths: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(document.paths ?? {})) {
    const publicPath = stripInternalServicePrefix(path, prefix);
    paths[toConfiguredOpenApiPath(publicPath, api)] = value;
  }

  return Response.json({ ...document, paths }, {
    headers: {
      "cache-control": response.headers.get("cache-control") ?? "public, max-age=300"
    }
  });
}

function toConfiguredOpenApiPath(path: string, api: TraditionalApiConfig): string {
  for (const route of api.routes) {
    if (path === toUrlPatternPath(route.path)) return route.path;
  }
  return path;
}

function importedOpenApiResponse(
  api: TraditionalApiConfig,
  config: AppConfig,
  publicBaseUrl: string
): Response {
  const document = readImportedOpenApiDocument(api.openApiDocumentPath!);
  return Response.json(importedOpenApiDocument(api, config, publicBaseUrl, document), {
    headers: { "cache-control": "public, max-age=300" }
  });
}

async function importedOpenApiResponseFromUrl(
  api: TraditionalApiConfig,
  config: AppConfig,
  publicBaseUrl: string
): Promise<Response> {
  const response = await fetch(api.openApiDocumentUrl!, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    return Response.json({
      error: {
        code: "openapi_document_fetch_failed",
        message: `OpenAPI document URL returned ${response.status}`
      }
    }, { status: 502 });
  }
  const document = await response.json() as unknown;
  if (!isRecord(document)) {
    return Response.json({
      error: {
        code: "invalid_openapi_document",
        message: "OpenAPI document URL did not return a JSON object"
      }
    }, { status: 502 });
  }
  return Response.json(importedOpenApiDocument(api, config, publicBaseUrl, document), {
    headers: { "cache-control": response.headers.get("cache-control") ?? "public, max-age=300" }
  });
}

function importedOpenApiDocument(
  api: TraditionalApiConfig,
  config: AppConfig,
  publicBaseUrl: string,
  document: Record<string, unknown>
): Record<string, unknown> {
  const originalPaths = isRecord(document.paths) ? document.paths : {};
  const paths: Record<string, unknown> = { ...originalPaths };

  if (api.routes.length === 0) {
    for (const [path, pathItemValue] of Object.entries(paths)) {
      if (!path.startsWith("/") || !isRecord(pathItemValue)) continue;
      const pathItem = { ...pathItemValue };
      for (const [methodKey, operation] of Object.entries(pathItem)) {
        if (!OPENAPI_HTTP_METHODS.has(methodKey.toLowerCase()) || !isRecord(operation)) continue;
        pathItem[methodKey] = paidOpenApiOperation(operation, routePaymentInfo(api, config, api.requestPrice));
      }
      paths[path] = pathItem;
    }
  }

  for (const route of api.routes) {
    if (!isRecord(paths[route.path])) {
      // Imported OpenAPI is authoritative for route surface; do not append missing paths.
      continue;
    }
    const pathItem = { ...(paths[route.path] as Record<string, unknown>) };
    for (const method of route.methods) {
      const methodKey = method.toLowerCase();
      if (!isRecord(pathItem[methodKey])) continue;
      const existingOperation = { ...(pathItem[methodKey] as Record<string, unknown>) };
      pathItem[methodKey] = paidOpenApiOperation(
        existingOperation,
        routePaymentInfo(api, config, route.requestPrice, route.id),
        route.id ?? `${method.toUpperCase()} ${route.path}`,
        route.id
      );
    }
    paths[route.path] = pathItem;
  }

  return {
    ...document,
    servers: [{ url: publicBaseUrl }],
    paths
  };
}

function paidOpenApiOperation(
  operation: Record<string, unknown>,
  paymentInfo: Record<string, unknown>,
  fallbackSummary?: string,
  fallbackOperationId?: string
): Record<string, unknown> {
  const responses = isRecord(operation.responses)
    ? { ...(operation.responses as Record<string, unknown>) }
    : {};
  if (!responses["402"]) {
    responses["402"] = { description: "Payment required" };
  }
  return {
    ...operation,
    ...(!operation.summary && fallbackSummary ? { summary: fallbackSummary } : {}),
    ...(!operation.operationId && fallbackOperationId ? { operationId: fallbackOperationId } : {}),
    responses,
    "x-payment-info": paymentInfo
  };
}

function readImportedOpenApiDocument(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`OpenAPI document at ${path} must be a JSON object`);
  }
  return parsed;
}

function routePaymentInfo(
  api: TraditionalApiConfig,
  config: AppConfig,
  requestPrice: bigint,
  routeId?: string
): Record<string, unknown> {
  return {
    offers: [{
      amount: requestPrice.toString(),
      chainId: api.chainId,
      currency: api.assetAddress,
      decimals: config.tempo.assetDecimals,
      description: routeId ? `${api.id}:${routeId}` : api.id,
      intent: "charge",
      method: "tempo",
      recipient: config.tempo.settlementAddress
    }]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function publicLlmsResponse(
  proxy: Proxy.Proxy,
  publicBaseUrl: string
): Promise<Response> {
  const response = await proxy.fetch(new Request(new URL("/api/llms.txt", publicBaseUrl)));
  if (!response.ok) return response;
  const text = await response.text();
  return new Response(text.replaceAll("/api/openapi.json", "/openapi.json"), {
    headers: { "content-type": response.headers.get("content-type") ?? "text/plain; charset=utf-8" }
  });
}

function stripInternalServicePrefix(path: string, prefix: string): string {
  if (path === prefix) return "/";
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
  return path;
}

function serializeBody(body: unknown): string | URLSearchParams | Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || body instanceof URLSearchParams || Buffer.isBuffer(body)) return body;
  return JSON.stringify(body);
}

function paymentRealm(publicBaseUrl: string): string {
  try {
    return new URL(publicBaseUrl).host || "localhost";
  } catch {
    return "localhost";
  }
}
