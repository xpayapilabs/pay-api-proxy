import { Proxy, Service } from "mppx/proxy";
import { Mppx, tempo } from "mppx/server";
import type { AppConfig, TraditionalApiConfig, TraditionalApiRouteConfig } from "../config.js";
import { rawAmountToDecimalString } from "../money.js";
import type { MppxStoreHandle } from "../../ports/mppx-store.js";

export interface PaidHttpProxy {
  fetch(request: Request): Promise<Response>;
  openApiResponse(publicBaseUrl: string): Promise<Response>;
  llmsResponse(publicBaseUrl: string): Promise<Response>;
  close(): void;
}

export interface PaidHttpProxyDeps {
  storeHandle: MppxStoreHandle;
  fetch?: typeof fetch;
  loadOpenApiDocument?: (path: string) => Record<string, unknown>;
}

interface TraditionalMppx {
  tempo: {
    charge(options: Record<string, unknown>): Service.IntentHandler;
  };
}

const OPENAPI_HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export function enabledTraditionalApis(config: AppConfig): TraditionalApiConfig[] {
  return config.apis.filter((api) => api.enabled);
}

export function httpApisUsePrefixedMount(config: AppConfig): boolean {
  return enabledTraditionalApis(config).length > 1;
}

export function traditionalApiPublicPathPrefix(config: AppConfig, api: TraditionalApiConfig): string {
  return httpApisUsePrefixedMount(config) ? `/api/${api.id}` : "/";
}

export function traditionalApiForPublicPath(
  config: AppConfig,
  path: string
): TraditionalApiConfig | undefined {
  const apis = enabledTraditionalApis(config);
  if (apis.length === 0 || isAlwaysPlatformPath(path)) return undefined;
  if (config.upstreamProvider === "openai" && isOpenAiPlatformPath(path)) return undefined;
  if (apis.length === 1) return apis[0];

  const match = /^\/api\/([^/?#]+)(?:\/|$)/.exec(path);
  if (!match) return undefined;
  return apis.find((api) => api.id === match[1]);
}

export function createPaidHttpProxy(config: AppConfig, deps: PaidHttpProxyDeps): PaidHttpProxy | undefined {
  const apis = enabledTraditionalApis(config);
  if (apis.length === 0) return undefined;
  const prefixedMount = apis.length > 1;
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  const mppx = Mppx.create({
    realm: paymentRealm(config.publicBaseUrl),
    secretKey: config.mppx.secretKey,
    methods: [
      tempo.charge({
        currency: config.tempo.acceptedAsset as `0x${string}`,
        decimals: config.tempo.assetDecimals,
        recipient: config.tempo.settlementAddress as `0x${string}`,
        rpcUrl: { [config.tempo.chainId]: config.tempo.rpcUrl },
        store: deps.storeHandle.store,
        testnet: config.mppx.testnet,
        waitForConfirmation: config.mppx.waitForConfirmation
      } as unknown as Parameters<typeof tempo.charge>[0])
    ]
  });

  const proxy = Proxy.create({
    basePath: "/api",
    description: "Configured paid HTTP APIs, protected by mppx Payment authentication.",
    fetch: fetchImpl,
    services: apis.map((api) => createTraditionalService(api, config, mppx as unknown as TraditionalMppx)),
    title: "pay-api-proxy HTTP APIs",
    version: "1.0.0"
  });

  return {
    fetch: (request) => {
      const url = new URL(request.url);
      const api = traditionalApiForPublicPath(config, url.pathname);
      if (!api) {
        return Promise.resolve(Response.json({
          error: {
            code: "traditional_api_not_found",
            message: prefixedMount
              ? "Use /api/{id}/... for configured paid HTTP APIs"
              : "No matching paid HTTP API route was found"
          }
        }, { status: 404 }));
      }
      const internalRequest = prefixedMount ? request : toInternalProxyRequest(request, api.id);
      return fetchWithUpstreamTimeout(proxy, internalRequest, api.upstreamTimeoutMs);
    },
    openApiResponse: (publicBaseUrl) => publicOpenApiResponse(proxy, apis, config, publicBaseUrl, {
      fetch: fetchImpl,
      loadOpenApiDocument: deps.loadOpenApiDocument
    }),
    llmsResponse: (publicBaseUrl) => publicLlmsResponse(proxy, apis, publicBaseUrl),
    close: () => deps.storeHandle.close()
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
  const entries: Array<[string, Service.Endpoint]> = [];
  const addRoute = (
    method: string,
    path: string,
    requestPrice: bigint,
    route?: TraditionalApiRouteConfig
  ) => {
    const routeKey = `${method.toUpperCase()} ${toUrlPatternPath(path)}`;
    if (requestPrice === 0n) {
      entries.push([routeKey, true]);
      return;
    }
    const options = traditionalEndpointOptions(route);
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
    entries.push([routeKey, options ? { pay, options } : pay]);
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

  entries.sort((left, right) => routeKeySpecificity(right[0]) - routeKeySpecificity(left[0]));
  return Object.fromEntries(entries) as Service.EndpointMap;
}

function routeKeySpecificity(routeKey: string): number {
  const tokens = routeKey.trim().split(/\s+/);
  const pattern = tokens.length >= 2 ? tokens.slice(1).join(" ") : routeKey;
  if (pattern === "/*" || pattern === "*") return 0;
  const wildcardCount = pattern.match(/\*/g)?.length ?? 0;
  const parameterCount = pattern.match(/\{[^}]+\}|:[A-Za-z_][A-Za-z0-9_]*/g)?.length ?? 0;
  const staticLength = pattern
    .replace(/\{[^}]+\}/g, "")
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "")
    .replace(/\*/g, "")
    .length;
  return staticLength * 100 - parameterCount * 10 - wildcardCount * 50 + pattern.length;
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
  apis: TraditionalApiConfig[],
  config: AppConfig,
  publicBaseUrl: string,
  deps: {
    fetch: typeof fetch;
    loadOpenApiDocument?: (path: string) => Record<string, unknown>;
  }
): Promise<Response> {
  if (apis.length === 1) {
    const result = await publicOpenApiDocumentForApi(proxy, apis[0]!, config, publicBaseUrl, false, deps);
    if (result instanceof Response) return result;
    return Response.json(result.document, {
      headers: { "cache-control": result.cacheControl ?? "public, max-age=300" }
    });
  }

  const paths: Record<string, unknown> = {};
  let cacheControl = "public, max-age=300";
  for (const api of apis) {
    const result = await publicOpenApiDocumentForApi(proxy, api, config, publicBaseUrl, true, deps);
    if (result instanceof Response) return result;
    cacheControl = result.cacheControl ?? cacheControl;
    Object.assign(paths, isRecord(result.document.paths) ? result.document.paths : {});
  }

  return Response.json({
    openapi: "3.0.3",
    info: {
      title: "pay-api-proxy HTTP APIs",
      description: "Configured paid HTTP APIs exposed by this node."
    },
    servers: [{ url: publicBaseUrl }],
    paths,
    "x-service-info": {
      docs: {
        openapi: `${publicBaseUrl}/openapi.json`,
        llms: `${publicBaseUrl}/llms.txt`
      }
    }
  }, {
    headers: { "cache-control": cacheControl }
  });
}

async function publicOpenApiDocumentForApi(
  proxy: Proxy.Proxy,
  api: TraditionalApiConfig,
  config: AppConfig,
  publicBaseUrl: string,
  prefixed: boolean,
  deps: {
    fetch: typeof fetch;
    loadOpenApiDocument?: (path: string) => Record<string, unknown>;
  }
): Promise<{ document: Record<string, unknown>; cacheControl?: string } | Response> {
  if (api.openApiDocumentUrl) {
    return importedOpenApiDocumentFromUrl(api, config, publicBaseUrl, prefixed, deps.fetch);
  }
  if (api.openApiDocumentPath) {
    if (!deps.loadOpenApiDocument) {
      return Response.json({
        error: {
          code: "openapi_document_loader_unavailable",
          message: "This runtime cannot load OpenAPI documents from local filesystem paths"
        }
      }, { status: 500 });
    }
    return {
      document: importedOpenApiDocument(
        api,
        config,
        publicBaseUrl,
        deps.loadOpenApiDocument(api.openApiDocumentPath),
        prefixed
      )
    };
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
    if (!pathBelongsToInternalService(path, prefix)) continue;
    const publicPath = stripInternalServicePrefix(path, prefix);
    const configuredPath = toConfiguredOpenApiPath(publicPath, api);
    paths[prefixed ? prefixedOpenApiPath(api, configuredPath) : configuredPath] =
      annotatePaidOpenApiOperationsWithApiId(value, api.id);
  }

  return {
    document: {
      ...document,
      servers: [{ url: publicBaseUrl }],
      paths
    },
    cacheControl: response.headers.get("cache-control") ?? undefined
  };
}

function toConfiguredOpenApiPath(path: string, api: TraditionalApiConfig): string {
  for (const route of api.routes) {
    if (path === toUrlPatternPath(route.path)) return route.path;
  }
  return path;
}

function pathBelongsToInternalService(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function prefixedOpenApiPath(api: TraditionalApiConfig, path: string): string {
  if (path === "*" || path === "/*") return `/api/${api.id}/*`;
  if (path === "/") return `/api/${api.id}`;
  return `/api/${api.id}${path.startsWith("/") ? path : `/${path}`}`;
}

function prefixOpenApiPaths(api: TraditionalApiConfig, paths: Record<string, unknown>): Record<string, unknown> {
  const prefixed: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(paths)) {
    prefixed[prefixedOpenApiPath(api, path)] = value;
  }
  return prefixed;
}

function annotatePaidOpenApiOperationsWithApiId(pathItemValue: unknown, apiId: string): unknown {
  if (!isRecord(pathItemValue)) return pathItemValue;
  const pathItem = { ...pathItemValue };
  for (const [methodKey, operation] of Object.entries(pathItem)) {
    if (!OPENAPI_HTTP_METHODS.has(methodKey.toLowerCase()) || !isRecord(operation)) continue;
    if (!isRecord(operation["x-payment-info"])) continue;
    pathItem[methodKey] = {
      ...operation,
      "x-xpayapi-api-id": apiId
    };
  }
  return pathItem;
}

async function importedOpenApiDocumentFromUrl(
  api: TraditionalApiConfig,
  config: AppConfig,
  publicBaseUrl: string,
  prefixed: boolean,
  fetchImpl: typeof fetch
): Promise<{ document: Record<string, unknown>; cacheControl?: string } | Response> {
  const response = await fetchImpl(api.openApiDocumentUrl!, {
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
  return {
    document: importedOpenApiDocument(api, config, publicBaseUrl, document, prefixed),
    cacheControl: response.headers.get("cache-control") ?? undefined
  };
}

function importedOpenApiDocument(
  api: TraditionalApiConfig,
  config: AppConfig,
  publicBaseUrl: string,
  document: Record<string, unknown>,
  prefixed: boolean
): Record<string, unknown> {
  const originalPaths = isRecord(document.paths) ? document.paths : {};
  const paths: Record<string, unknown> = { ...originalPaths };

  if (api.routes.length === 0) {
    for (const [path, pathItemValue] of Object.entries(paths)) {
      if (!path.startsWith("/") || !isRecord(pathItemValue)) continue;
      const pathItem = { ...pathItemValue };
      for (const [methodKey, operation] of Object.entries(pathItem)) {
        if (!OPENAPI_HTTP_METHODS.has(methodKey.toLowerCase()) || !isRecord(operation)) continue;
        pathItem[methodKey] = paidOpenApiOperation(
          operation,
          routePaymentInfo(api, config, api.requestPrice),
          api.id
        );
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
      const existingOperation = isRecord(pathItem[methodKey])
        ? { ...(pathItem[methodKey] as Record<string, unknown>) }
        : {};
      pathItem[methodKey] = route.requestPrice === 0n
        ? freeOpenApiOperation(
          existingOperation,
          route.id ?? `${method.toUpperCase()} ${route.path}`,
          route.id
        )
        : paidOpenApiOperation(
          existingOperation,
          routePaymentInfo(api, config, route.requestPrice, route.id),
          api.id,
          route.id ?? `${method.toUpperCase()} ${route.path}`,
          route.id
        );
    }
    paths[route.path] = pathItem;
  }

  return {
    ...document,
    servers: [{ url: publicBaseUrl }],
    paths: prefixed ? prefixOpenApiPaths(api, paths) : paths
  };
}

function paidOpenApiOperation(
  operation: Record<string, unknown>,
  paymentInfo: Record<string, unknown>,
  apiId: string,
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
    "x-xpayapi-api-id": apiId,
    "x-payment-info": paymentInfo
  };
}

function freeOpenApiOperation(
  operation: Record<string, unknown>,
  fallbackSummary?: string,
  fallbackOperationId?: string
): Record<string, unknown> {
  return {
    ...operation,
    ...(!operation.summary && fallbackSummary ? { summary: fallbackSummary } : {}),
    ...(!operation.operationId && fallbackOperationId ? { operationId: fallbackOperationId } : {})
  };
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
  apis: TraditionalApiConfig[],
  publicBaseUrl: string
): Promise<Response> {
  if (apis.length > 1) {
    const lines = [
      "# pay-api-proxy HTTP APIs",
      "",
      `OpenAPI: ${publicBaseUrl}/openapi.json`,
      "",
      ...apis.map((api) => `- ${api.id}: ${publicBaseUrl}/api/${api.id}`)
    ];
    return new Response(lines.join("\n"), {
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }

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

function isAlwaysPlatformPath(path: string): boolean {
  return path === "/openapi.json" ||
    path === "/llms.txt" ||
    path === "/api/openapi.json" ||
    path === "/api/llms.txt" ||
    path.startsWith("/receipts/");
}

function isOpenAiPlatformPath(path: string): boolean {
  return path === "/v1/models" ||
    path === "/v1/chat/completions" ||
    path === "/v1/images/generations" ||
    path === "/v1/payment-sessions" ||
    path.startsWith("/v1/payment-sessions/");
}

function paymentRealm(publicBaseUrl: string): string {
  try {
    return new URL(publicBaseUrl).host || "localhost";
  } catch {
    return "localhost";
  }
}
