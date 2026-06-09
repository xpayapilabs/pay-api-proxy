import type {
  AppConfig,
  MppxConfig,
  RateLimitConfig,
  TraditionalApiConfig,
  TraditionalApiRateLimitConfig,
  TraditionalApiRouteConfig
} from "../../core/config.js";
import { routeIdFromPath } from "../../core/config.js";
import { DEFAULT_APP_SETTINGS } from "../../core/default-config.js";
import { parseJsoncObject } from "../../core/jsonc.js";
import { parseRequestRewriteConfig } from "../../core/request-rewrite.js";
import { DEFAULT_RESPONSE_SANITIZER_REMOVE_JSON_KEYS } from "../../core/response-sanitizer.js";

export interface CloudflareWorkerConfigEnv {
  PAY_API_PROXY_CONFIG?: string;
  PUBLIC_BASE_URL?: string;
  MPP_SECRET_KEY?: string;
  TEMPO_RPC_URL?: string;
  TEMPO_CHAIN_ID?: string;
  TEMPO_SETTLEMENT_ADDRESS?: string;
  TEMPO_ACCEPTED_ASSET?: string;
  TEMPO_ASSET_DECIMALS?: string;
  [name: string]: unknown;
}

const API_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const DEFAULT_FORWARDED_HEADERS = ["accept", "content-type"];

export function loadCloudflareWorkerConfig(env: CloudflareWorkerConfigEnv): AppConfig {
  const fileConfig = env.PAY_API_PROXY_CONFIG
    ? parseJsoncObject(env.PAY_API_PROXY_CONFIG, "PAY_API_PROXY_CONFIG")
    : {};
  const tempo = parseTempoConfig(fileConfig, env);
  const nodeEnv = stringField(fileConfig, "nodeEnv", "production");
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? stringField(
    fileConfig,
    "publicBaseUrl",
    DEFAULT_APP_SETTINGS.publicBaseUrl
  )).replace(/\/+$/, "");
  const mppx = parseMppxConfig(fileConfig, env, tempo.chainId);

  return {
    nodeEnv,
    host: DEFAULT_APP_SETTINGS.host,
    port: DEFAULT_APP_SETTINGS.port,
    databasePath: ":worker:",
    paymentProvider: mppx.testnet ? "tempo-testnet" : "tempo-mainnet",
    publicBaseUrl,
    nodeSigningSecret: "",
    corsAllowOrigin: stringField(fileConfig, "corsAllowOrigin", DEFAULT_APP_SETTINGS.corsAllowOrigin),
    maxRequestBodyBytes: positiveIntField(
      fileConfig,
      "maxRequestBodyBytes",
      DEFAULT_APP_SETTINGS.maxRequestBodyBytes
    ),
    upstreamProvider: "http",
    chargingMethod: "per-request",
    sessionBilling: {
      reserveMode: "max-quote",
      settlementMode: "actual-usage",
      unitAmount: BigInt(DEFAULT_APP_SETTINGS.sessionBilling.unitAmount),
      unitType: DEFAULT_APP_SETTINGS.sessionBilling.unitType
    },
    mppx,
    mppxSession: {
      enabled: false,
      secretKey: mppx.secretKey,
      testnet: mppx.testnet,
      waitForConfirmation: mppx.waitForConfirmation
    },
    openaiBaseUrl: DEFAULT_APP_SETTINGS.openaiBaseUrl,
    openaiEndpointWhitelist: [...DEFAULT_APP_SETTINGS.openaiEndpointWhitelist],
    apis: parseApis(fileConfig.apis, tempo.assetDecimals, tempo, env),
    models: [],
    rateLimit: parseRateLimitConfig(fileConfig),
    tempo
  };
}

const TEMPO_MAINNET_CHAIN_ID = 4217;

function parseMppxConfig(
  fileConfig: Record<string, unknown>,
  env: CloudflareWorkerConfigEnv,
  chainId: number
): MppxConfig {
  const configured = objectField(fileConfig, "mppx", {});
  const secretKey = env.MPP_SECRET_KEY ?? stringField(configured, "secretKey", "");
  if (!secretKey) {
    throw new Error("MPP_SECRET_KEY or PAY_API_PROXY_CONFIG.mppx.secretKey is required");
  }
  // Derive the network from the chain id (mainnet 4217 -> live, anything else -> testnet)
  // so operators only set the chain once. An explicit `mppx.testnet` still wins, but warn
  // when it contradicts the configured chain to catch "mainnet chain but testnet flag" mistakes.
  const derivedTestnet = chainId !== TEMPO_MAINNET_CHAIN_ID;
  const explicitTestnet = configured.testnet === undefined
    ? undefined
    : booleanField(configured, "testnet", true);
  if (explicitTestnet !== undefined && explicitTestnet !== derivedTestnet) {
    console.warn(
      `pay-api-proxy: mppx.testnet=${explicitTestnet} contradicts chainId=${chainId} ` +
      `(${derivedTestnet ? "a testnet" : "the mainnet"} chain). Using the explicit value.`
    );
  }
  return {
    secretKey,
    testnet: explicitTestnet ?? derivedTestnet,
    waitForConfirmation: booleanField(configured, "waitForConfirmation", true)
  };
}

function parseTempoConfig(fileConfig: Record<string, unknown>, env: CloudflareWorkerConfigEnv): AppConfig["tempo"] {
  const configured = objectField(fileConfig, "tempo", {});
  return {
    rpcUrl: env.TEMPO_RPC_URL ?? stringField(configured, "rpcUrl", DEFAULT_APP_SETTINGS.tempo.rpcUrl),
    chainId: env.TEMPO_CHAIN_ID
      ? positiveIntString("TEMPO_CHAIN_ID", env.TEMPO_CHAIN_ID)
      : positiveIntField(configured, "chainId", DEFAULT_APP_SETTINGS.tempo.chainId),
    settlementAddress: env.TEMPO_SETTLEMENT_ADDRESS ??
      stringField(configured, "settlementAddress", DEFAULT_APP_SETTINGS.tempo.settlementAddress),
    acceptedAsset: env.TEMPO_ACCEPTED_ASSET ??
      stringField(configured, "acceptedAsset", DEFAULT_APP_SETTINGS.tempo.acceptedAsset),
    assetDecimals: env.TEMPO_ASSET_DECIMALS
      ? positiveIntString("TEMPO_ASSET_DECIMALS", env.TEMPO_ASSET_DECIMALS, { allowZero: true })
      : positiveIntField(configured, "assetDecimals", DEFAULT_APP_SETTINGS.tempo.assetDecimals, { allowZero: true })
  };
}

function parseRateLimitConfig(fileConfig: Record<string, unknown>): RateLimitConfig {
  const configured = objectField(fileConfig, "rateLimit", {});
  const max = positiveIntField(configured, "max", 120);
  return {
    max,
    imageMax: positiveIntField(configured, "imageMax", Math.max(1, Math.floor(max / 6))),
    timeWindowMs: positiveIntField(configured, "timeWindowMs", 60_000)
  };
}

function parseApis(
  value: unknown,
  assetDecimals: number,
  tempo: AppConfig["tempo"],
  env: CloudflareWorkerConfigEnv
): TraditionalApiConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("apis must be an array");

  const apis = value.map((entry, index) => parseApi(entry, index, assetDecimals, tempo, env));
  const enabledIds = new Set<string>();
  for (const api of apis) {
    if (!API_ID_PATTERN.test(api.id)) {
      throw new Error("apis[].id must be a URL-safe lowercase slug (a-z, 0-9, \"_\" or \"-\")");
    }
    if (!api.enabled) continue;
    if (enabledIds.has(api.id)) throw new Error(`apis contains duplicate enabled id: ${api.id}`);
    enabledIds.add(api.id);
  }
  return apis;
}

function parseApi(
  entry: unknown,
  index: number,
  assetDecimals: number,
  tempo: AppConfig["tempo"],
  env: CloudflareWorkerConfigEnv
): TraditionalApiConfig {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`apis[${index}] must be an object`);
  }
  const api = entry as Record<string, unknown>;
  const methods = methodsField(api, `apis[${index}].methods`, ["GET", "POST", "PUT", "PATCH", "DELETE"]);
  const routes = routesField(api.routes, `apis[${index}].routes`, methods, assetDecimals);
  const openApiDocumentPath = optionalStringField(api, "openApiDocumentPath");
  if (openApiDocumentPath) {
    throw new Error("Cloudflare Worker config does not support apis[].openApiDocumentPath; use openApiDocumentUrl");
  }

  return {
    id: requiredStringField(api, "id", `apis[${index}].id`),
    upstreamBaseUrl: requiredUrlField(api, "upstreamBaseUrl", `apis[${index}].upstreamBaseUrl`),
    enabled: booleanField(api, "enabled", true),
    methods,
    requestPrice: priceField(api, `apis[${index}]`, assetDecimals),
    routes,
    allowUnmatchedRoutes: booleanField(api, "allowUnmatchedRoutes", routes.length === 0),
    openApiDocumentUrl: optionalUrlField(api, "openApiDocumentUrl", `apis[${index}].openApiDocumentUrl`),
    assetSymbol: stringField(api, "assetSymbol", "USDC"),
    assetAddress: stringField(api, "assetAddress", tempo.acceptedAsset),
    chainId: positiveIntField(api, "chainId", tempo.chainId),
    forwardedHeaders: stringArrayField(api, "forwardedHeaders", DEFAULT_FORWARDED_HEADERS),
    upstreamTimeoutMs: positiveIntField(api, "upstreamTimeoutMs", 30_000),
    rateLimit: optionalRateLimit(api, `apis[${index}].rateLimit`),
    requestRewrite: parseRequestRewriteConfig(
      api.requestRewrite,
      `apis[${index}].requestRewrite`,
      (name) => optionalEnvString(env, name)
    ),
    responseSanitizer: responseSanitizer(api, `apis[${index}].responseSanitizer`),
    bearer: optionalStringField(api, "bearer"),
    headers: optionalHeaders(api, `apis[${index}].headers`)
  };
}

function routesField(
  value: unknown,
  name: string,
  fallbackMethods: string[],
  assetDecimals: number
): TraditionalApiRouteConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const seenPaths = new Set<string>();
  const seenIds = new Set<string>();
  return value.map((entry, index) => {
    const routeName = `${name}[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${routeName} must be an object`);
    }
    const route = entry as Record<string, unknown>;
    const path = requiredStringField(route, "path", `${routeName}.path`);
    if (path !== "*" && !path.startsWith("/")) throw new Error(`${routeName}.path must be "*" or start with "/"`);
    if (seenPaths.has(path)) throw new Error(`${name} must not contain duplicate route paths: ${path}`);
    seenPaths.add(path);
    const id = optionalStringField(route, "id") ?? routeIdFromPath(path);
    if (seenIds.has(id)) throw new Error(`${name} must not contain duplicate route ids: ${id}`);
    seenIds.add(id);
    return {
      id,
      path,
      methods: methodsField(route, `${routeName}.methods`, fallbackMethods),
      requestPrice: priceField(route, routeName, assetDecimals),
      bearer: optionalStringField(route, "bearer"),
      headers: optionalHeaders(route, `${routeName}.headers`)
    };
  });
}

function priceField(record: Record<string, unknown>, name: string, decimals: number): bigint {
  const pricing = objectField(record, "pricing", {});
  const value = pricing.request ?? record.requestPrice;
  if (value === undefined) throw new Error(`${name}.pricing.request is required`);
  return parseDecimalAssetAmount(value, `${name}.pricing.request`, decimals);
}

function parseDecimalAssetAmount(value: unknown, name: string, decimals: number): bigint {
  const text = typeof value === "number" ? String(value) : value;
  const fractionPattern = decimals === 0 ? "" : `(\\.\\d{1,${decimals}})?`;
  const pattern = new RegExp(`^\\d+${fractionPattern}$`);
  if (typeof text !== "string" || !pattern.test(text)) {
    throw new Error(`${name} must be a decimal string with up to ${decimals} fractional digits`);
  }
  const [whole, fractional = ""] = text.split(".");
  const scale = 10n ** BigInt(decimals);
  const fractionScaled = decimals === 0 ? 0n : BigInt(fractional.padEnd(decimals, "0"));
  return BigInt(whole) * scale + fractionScaled;
}

function methodsField(record: Record<string, unknown>, name: string, fallback: string[]): string[] {
  const value = name.split(".").pop() === "methods" ? record.methods : undefined;
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty array`);
  return [...new Set(value.map((method) => {
    if (typeof method !== "string" || method.length === 0) throw new Error(`${name} entries must be strings`);
    return method.toUpperCase();
  }))];
}

function optionalRateLimit(record: Record<string, unknown>, name: string): TraditionalApiRateLimitConfig | undefined {
  const value = record.rateLimit;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const rateLimit = value as Record<string, unknown>;
  const max = optionalPositiveIntField(rateLimit, "max", `${name}.max`);
  const timeWindowMs = optionalPositiveIntField(rateLimit, "timeWindowMs", `${name}.timeWindowMs`);
  if (max === undefined && timeWindowMs === undefined) return undefined;
  return {
    ...(max !== undefined ? { max } : {}),
    ...(timeWindowMs !== undefined ? { timeWindowMs } : {})
  };
}

function responseSanitizer(record: Record<string, unknown>, name: string): TraditionalApiConfig["responseSanitizer"] {
  const value = record.responseSanitizer;
  if (value === undefined) return { removeJsonKeys: [...DEFAULT_RESPONSE_SANITIZER_REMOVE_JSON_KEYS] };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return {
    removeJsonKeys: jsonKeyArrayField(
      value as Record<string, unknown>,
      "removeJsonKeys",
      `${name}.removeJsonKeys`,
      [...DEFAULT_RESPONSE_SANITIZER_REMOVE_JSON_KEYS]
    )
  };
}

function jsonKeyArrayField(
  record: Record<string, unknown>,
  field: string,
  name: string,
  fallback: string[]
): string[] {
  const value = record[field];
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return [...new Set(value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0) throw new Error(`${name} entries must be strings`);
    return entry;
  }))];
}

function objectField(record: Record<string, unknown>, field: string, fallback: Record<string, unknown>): Record<string, unknown> {
  const value = record[field];
  if (value === undefined) return fallback;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function requiredStringField(record: Record<string, unknown>, field: string, name: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a string`);
  return value;
}

function stringField(record: Record<string, unknown>, field: string, fallback: string): string {
  const value = record[field];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a string`);
  return value;
}

function optionalStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a string`);
  return value;
}

function optionalEnvString(env: CloudflareWorkerConfigEnv, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredUrlField(record: Record<string, unknown>, field: string, name: string): string {
  const value = requiredStringField(record, field, name);
  new URL(value);
  return value.replace(/\/+$/, "");
}

function optionalUrlField(record: Record<string, unknown>, field: string, name: string): string | undefined {
  const value = optionalStringField(record, field);
  if (!value) return undefined;
  new URL(value);
  return value;
}

function stringArrayField(record: Record<string, unknown>, field: string, fallback: string[]): string[] {
  const value = record[field];
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return [...new Set(value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0) throw new Error(`${field} entries must be strings`);
    return entry.toLowerCase();
  }))];
}

function optionalHeaders(record: Record<string, unknown>, name: string): Record<string, string> | undefined {
  const value = record.headers;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const headers = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(headers)) {
    if (typeof entry !== "string") throw new Error(`${name}.${key} must be a string`);
    result[key] = entry;
  }
  return result;
}

function booleanField(record: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = record[field];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function optionalPositiveIntField(record: Record<string, unknown>, field: string, name: string): number | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function positiveIntField(
  record: Record<string, unknown>,
  field: string,
  fallback: number,
  options: { allowZero?: boolean } = {}
): number {
  const value = record[field];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < (options.allowZero ? 0 : 1)) {
    throw new Error(`${field} must be ${options.allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return value;
}

function positiveIntString(
  name: string,
  value: string,
  options: { allowZero?: boolean } = {}
): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (options.allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${options.allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}
