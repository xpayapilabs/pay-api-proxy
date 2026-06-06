import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ChargingMethodName } from "../charging/types.js";
import { DEFAULT_APP_SETTINGS } from "./default-config.js";
import { parseJsoncObject } from "./jsonc.js";
import { DEFAULT_MODELS, type ModelConfig } from "./models.js";
import { parseRequestRewriteConfig, type RequestRewriteConfig } from "./request-rewrite.js";
import {
  DEFAULT_RESPONSE_SANITIZER_REMOVE_JSON_KEYS,
  type ResponseSanitizerConfig
} from "./response-sanitizer.js";

export type PaymentProviderName = "tempo-testnet" | "tempo-mainnet";
export type UpstreamProviderName = "http" | "openai";
export type OpenAiCompatibleEndpoint = "models" | "chat_completions" | "images";
export type SessionReserveMode = "max-quote";
export type SessionSettlementMode = "actual-usage";

export const ALL_OPENAI_COMPATIBLE_ENDPOINTS: OpenAiCompatibleEndpoint[] = [
  "models",
  "chat_completions",
  "images"
];

export interface AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  databasePath: string;
  paymentProvider: PaymentProviderName;
  publicBaseUrl: string;
  nodeSigningSecret: string;
  corsAllowOrigin: string;
  maxRequestBodyBytes: number;
  upstreamProvider: UpstreamProviderName;
  chargingMethod: ChargingMethodName;
  sessionBilling: SessionBillingConfig;
  mppx: MppxConfig;
  mppxSession: MppxSessionConfig;
  openaiApiKey?: string;
  openaiBaseUrl: string;
  openaiEndpointWhitelist: OpenAiCompatibleEndpoint[];
  apis: TraditionalApiConfig[];
  models: ModelConfig[];
  rateLimit: RateLimitConfig;
  tempo: {
    rpcUrl: string;
    chainId: number;
    settlementAddress: string;
    acceptedAsset: string;
    assetDecimals: number;
  };
}

export interface MppxSessionConfig {
  enabled: boolean;
  privateKey?: `0x${string}`;
  secretKey: string;
  testnet: boolean;
  waitForConfirmation: boolean;
}

export interface MppxConfig {
  secretKey: string;
  testnet: boolean;
  waitForConfirmation: boolean;
}

export interface SessionBillingConfig {
  reserveMode: SessionReserveMode;
  settlementMode: SessionSettlementMode;
  unitAmount: bigint;
  unitType: string;
}

export interface RateLimitConfig {
  max: number;
  imageMax: number;
  timeWindowMs: number;
}

export interface TraditionalApiRateLimitConfig {
  max?: number;
  timeWindowMs?: number;
}

export interface TraditionalApiConfig {
  id: string;
  upstreamBaseUrl: string;
  enabled: boolean;
  methods: string[];
  requestPrice: bigint;
  routes: TraditionalApiRouteConfig[];
  allowUnmatchedRoutes?: boolean;
  openApiDocumentPath?: string;
  openApiDocumentUrl?: string;
  assetSymbol: string;
  assetAddress: string;
  chainId: number;
  forwardedHeaders: string[];
  upstreamTimeoutMs: number;
  rateLimit?: TraditionalApiRateLimitConfig;
  requestRewrite?: RequestRewriteConfig;
  responseSanitizer?: ResponseSanitizerConfig;
  bearer?: string;
  headers?: Record<string, string>;
}

export interface TraditionalApiRouteConfig {
  id?: string;
  path: string;
  methods: string[];
  requestPrice: bigint;
  bearer?: string;
  headers?: Record<string, string>;
}

export const DEV_SIGNING_SECRET = "dev-node-signing-secret-change-me";

const TEST_MODEL: ModelConfig = {
  id: "model_test_chat",
  modelName: "test-chat",
  enabled: true,
  supportsStreaming: true,
  inputPricePerMillion: 1_000_000n,
  outputPricePerMillion: 4_000_000n,
  minimumCharge: 1_000n,
  defaultMaxTokens: 512,
  maxTokensLimit: 4096,
  assetSymbol: "pathUSD",
  assetAddress: "0x20c0000000000000000000000000000000000000",
  chainId: 42431
};

const DOCKER_HOST_GATEWAY = "host.docker.internal";
const LOCALHOST_NAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);
const API_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const SINGLE_HTTP_API_ENV_OVERRIDES = [
  "UPSTREAM_BASE_URL",
  "DEFAULT_REQUEST_PRICE",
  "ROUTE_PRICES",
  "ROUTE_ALLOWLIST",
  "OPENAPI_DOCUMENT_URL",
  "OPENAPI_DOCUMENT_PATH",
  "TRADITIONAL_API_ROUTES",
  "TRADITIONAL_API_ROUTES_ONLY",
  "TRADITIONAL_OPENAPI_DOCUMENT_URL",
  "TRADITIONAL_OPENAPI_DOCUMENT_PATH"
];

export interface WorkerConfig {
  nodeEnv: string;
  databasePath: string;
  directoryPublish: DirectoryPublishConfig;
}

export interface DirectoryPublishConfig {
  enabled: boolean;
  directoryUrl: string;
  publicBaseUrl: string;
}

interface ConfigFileSettings {
  nodeEnv?: string;
  host?: string;
  port?: number;
  databasePath?: string;
  paymentProvider?: PaymentProviderName;
  paymentRecipientAddress?: string;
  publicBaseUrl?: string;
  corsAllowOrigin?: string;
  maxRequestBodyBytes?: number;
  upstreamProvider?: UpstreamProviderName;
  chargingMethod?: ChargingMethodName;
  sessionBilling?: {
    reserveMode?: SessionReserveMode;
    settlementMode?: SessionSettlementMode;
    unitAmount?: string | number;
    unitType?: string;
  };
  mppx?: {
    secretKey?: string;
    testnet?: boolean;
    waitForConfirmation?: boolean;
  };
  mppxSession?: {
    enabled?: boolean;
    secretKey?: string;
    testnet?: boolean;
    waitForConfirmation?: boolean;
  };
  rateLimit?: {
    max?: number;
    imageMax?: number;
    timeWindowMs?: number;
  };
  openaiBaseUrl?: string;
  openaiEndpointWhitelist?: OpenAiCompatibleEndpoint[];
  apis?: unknown[];
  models?: unknown[];
  tempo?: {
    rpcUrl?: string;
    chainId?: number;
    settlementAddress?: string;
    acceptedAsset?: string;
    assetDecimals?: number;
  };
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnvWithLegacy(primary: string, legacy: string): string | undefined {
  return optionalEnv(primary) ?? optionalEnv(legacy);
}

function loadDotEnv(path: string): void {
  if (optionalEnvWithLegacy("PAY_API_PROXY_SKIP_DOTENV", "PAID_API_NODE_SKIP_DOTENV") === "1") return;
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!key || process.env[key] !== undefined) continue;

    process.env[key] = unquoteEnvValue(trimmed.slice(separator + 1).trim());
  }
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function isDockerRuntime(): boolean {
  return optionalEnvWithLegacy("PAY_API_PROXY_DOCKER_RUNTIME", "PAID_API_NODE_DOCKER_RUNTIME") === "1" || existsSync("/.dockerenv");
}

function normalizeUpstreamBaseUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  if (!isDockerRuntime()) return trimmed;

  try {
    const parsed = new URL(trimmed);
    if (!LOCALHOST_NAMES.has(parsed.hostname)) return trimmed;
    parsed.hostname = DOCKER_HOST_GATEWAY;
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

function normalizeServerReachableUrl(value: string): string {
  return normalizeUpstreamBaseUrl(value);
}

function optionalBoolEnv(name: string): boolean | undefined {
  const value = optionalEnv(name);
  if (value === undefined) return undefined;
  return parseBool(name, value);
}

function optionalBoolEnvWithLegacy(primary: string, legacy: string): boolean | undefined {
  return optionalBoolEnv(primary) ?? optionalBoolEnv(legacy);
}

function envFromFile(name: string): string | undefined {
  const filePath = optionalEnv(`${name}_FILE`);
  if (!filePath) return undefined;
  return readFileSync(filePath, "utf8").trimEnd();
}

function requiredSecret(name: string, fallback?: string): string {
  const direct = optionalEnv(name);
  if (direct) return direct;
  const fromFile = envFromFile(name);
  if (fromFile && fromFile.length > 0) return fromFile;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

function optionalSecret(name: string): string | undefined {
  const direct = optionalEnv(name);
  if (direct) return direct;
  const fromFile = envFromFile(name);
  return fromFile && fromFile.length > 0 ? fromFile : undefined;
}

function loadOrCreateGeneratedSigningSecret(databasePath: string): string {
  const secretPath = generatedSigningSecretPath(databasePath);
  if (existsSync(secretPath)) {
    const value = readFileSync(secretPath, "utf8").trim();
    if (value.length > 0) return value;
  }

  mkdirSync(dirname(secretPath), { recursive: true });
  const value = randomBytes(32).toString("hex");
  try {
    writeFileSync(secretPath, `${value}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return value;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      const existing = readFileSync(secretPath, "utf8").trim();
      if (existing.length > 0) return existing;
    }
    throw error;
  }
}

function generatedSigningSecretPath(databasePath: string): string {
  const baseDirectory = databasePath === ":memory:"
    ? resolve("data")
    : dirname(resolve(databasePath));
  return resolve(baseDirectory, "node-signing-secret");
}

function resolveNodeSigningSecret(nodeEnv: string, databasePath: string): string {
  const configured = optionalSecret("NODE_SIGNING_SECRET");
  if (configured) return configured;
  if (nodeEnv !== "production") return DEV_SIGNING_SECRET;
  return loadOrCreateGeneratedSigningSecret(databasePath);
}

function derivePublicBaseUrlFromDomainName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const firstAddress = value.split(",")[0]?.trim();
  if (!firstAddress || firstAddress.startsWith(":")) return undefined;
  if (firstAddress.includes("://")) return firstAddress.replace(/\/+$/, "");

  const isLocal =
    firstAddress === "localhost" ||
    firstAddress.startsWith("localhost:") ||
    /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/.test(firstAddress);

  return `${isLocal ? "http" : "https"}://${firstAddress}`;
}

function resolveDefaultConfigPath(): string {
  for (const name of [
    "pay-api-proxy.config.jsonc",
    "pay-api-proxy.config.json",
    "paid-api-node.config.jsonc",
    "paid-api-node.config.json"
  ]) {
    const path = resolve(name);
    if (existsSync(path)) return path;
  }
  return resolve("pay-api-proxy.config.jsonc");
}

function readConfigFile(): ConfigFileSettings {
  const configuredPath = optionalEnvWithLegacy("PAY_API_PROXY_CONFIG", "PAID_API_NODE_CONFIG");
  const configPath = configuredPath ? resolve(configuredPath) : resolveDefaultConfigPath();
  if (!existsSync(configPath)) return {};

  try {
    return parseJsoncObject(readFileSync(configPath, "utf8"), "config file") as ConfigFileSettings;
  } catch (error) {
    throw new Error(
      `Failed to load pay-api-proxy config file at ${configPath}: ` +
      `${error instanceof Error ? error.message : "unknown error"}`
    );
  }
}

function readOpenAiModelsConfigFile(): Pick<ConfigFileSettings, "models"> {
  const configPath = resolve("openai-models.config.jsonc");
  if (!existsSync(configPath)) return {};

  try {
    return parseJsoncObject(readFileSync(configPath, "utf8"), "OpenAI models config file") as Pick<ConfigFileSettings, "models">;
  } catch (error) {
    throw new Error(
      `Failed to load OpenAI models config file at ${configPath}: ` +
      `${error instanceof Error ? error.message : "unknown error"}`
    );
  }
}

function parseProvider(value: string): PaymentProviderName {
  if (value === "tempo-testnet" || value === "tempo-mainnet") return value;
  throw new Error(`Unsupported PAYMENT_PROVIDER: ${value}`);
}

function assertTempoProviderChain(provider: PaymentProviderName, chainId: number): void {
  const expected = provider === "tempo-mainnet" ? 4217 : 42431;
  if (chainId !== expected) {
    throw new Error(`${provider} requires TEMPO_CHAIN_ID/tempo.chainId ${expected}; got ${chainId}`);
  }
}

function parseUpstream(value: string): UpstreamProviderName {
  if (value === "http" || value === "openai") return value;
  throw new Error(`Unsupported UPSTREAM_PROVIDER: ${value}`);
}

function parseChargingMethod(value: string): ChargingMethodName {
  if (value === "ai-token" || value === "per-request") return value;
  throw new Error(`Unsupported CHARGING_METHOD: ${value}`);
}

function parseSessionReserveMode(value: string): SessionReserveMode {
  if (value === "max-quote") return value;
  throw new Error(`Unsupported sessionBilling.reserveMode: ${value}`);
}

function parseSessionSettlementMode(value: string): SessionSettlementMode {
  if (value === "actual-usage") return value;
  throw new Error(`Unsupported sessionBilling.settlementMode: ${value}`);
}

function parsePositiveBigint(name: string, value: unknown): bigint {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d+$/.test(text)) {
    throw new Error(`${name} must be a positive integer string`);
  }
  const parsed = BigInt(text);
  if (parsed <= 0n) {
    throw new Error(`${name} must be greater than zero`);
  }
  return parsed;
}

function parseSessionBillingConfig(fileConfig: ConfigFileSettings): SessionBillingConfig {
  const configured = fileConfig.sessionBilling ?? {};
  return {
    reserveMode: parseSessionReserveMode(
      configured.reserveMode ?? DEFAULT_APP_SETTINGS.sessionBilling.reserveMode
    ),
    settlementMode: parseSessionSettlementMode(
      configured.settlementMode ?? DEFAULT_APP_SETTINGS.sessionBilling.settlementMode
    ),
    unitAmount: parsePositiveBigint(
      "SESSION_BILLING_UNIT_AMOUNT",
      optionalEnv("SESSION_BILLING_UNIT_AMOUNT") ??
        configured.unitAmount ??
        DEFAULT_APP_SETTINGS.sessionBilling.unitAmount
    ),
    unitType: env(
      "SESSION_BILLING_UNIT_TYPE",
      configured.unitType ?? DEFAULT_APP_SETTINGS.sessionBilling.unitType
    )
  };
}

function parsePositiveInt(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseOptionalPositiveIntField(
  record: Record<string, unknown>,
  fieldName: string,
  errorName: string
): number | undefined {
  const value = record[fieldName];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`${errorName}.${fieldName} must be a positive integer`);
  }
  return value;
}

function parseBool(name: string, value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "1" || value.toLowerCase() === "true") return true;
    if (value === "0" || value.toLowerCase() === "false") return false;
  }
  throw new Error(`${name} must be true or false`);
}

function parseOptionalPrivateKey(name: string, value: string | undefined): `0x${string}` | undefined {
  if (!value) return undefined;
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte 0x-prefixed private key`);
  }
  return value as `0x${string}`;
}

function parseMppxConfig(
  fileConfig: ConfigFileSettings,
  nodeSigningSecret: string,
  chainId: number
): MppxConfig {
  const configured = fileConfig.mppx ?? {};
  return {
    secretKey: requiredSecret("MPP_SECRET_KEY", configured.secretKey ?? deriveMppSecret(nodeSigningSecret)),
    testnet: optionalBoolEnv("MPPX_TESTNET") ??
      configured.testnet ??
      chainId === 42431,
    waitForConfirmation: optionalBoolEnv("MPPX_WAIT_FOR_CONFIRMATION") ??
      configured.waitForConfirmation ??
      true
  };
}

function parseMppxSessionConfig(
  fileConfig: ConfigFileSettings,
  mppx: MppxConfig
): MppxSessionConfig {
  const configured = fileConfig.mppxSession ?? {};
  const enabled = optionalBoolEnv("MPPX_SESSION_ENABLED") ?? configured.enabled ?? false;
  const privateKey = parseOptionalPrivateKey(
    "MPPX_SESSION_PRIVATE_KEY",
    optionalSecret("MPPX_SESSION_PRIVATE_KEY")
  );

  if (enabled && !privateKey) {
    throw new Error("MPPX_SESSION_PRIVATE_KEY is required when mppxSession.enabled is true");
  }

  return {
    enabled,
    privateKey,
    secretKey: configured.secretKey ?? mppx.secretKey,
    testnet: optionalBoolEnv("MPPX_SESSION_TESTNET") ??
      configured.testnet ??
      mppx.testnet,
    waitForConfirmation: optionalBoolEnv("MPPX_SESSION_WAIT_FOR_CONFIRMATION") ??
      configured.waitForConfirmation ??
      mppx.waitForConfirmation
  };
}

function parseRateLimitConfig(fileConfig: ConfigFileSettings): RateLimitConfig {
  const configured = fileConfig.rateLimit ?? {};
  const max = parsePositiveInt(
    "RATE_LIMIT_MAX",
    env("RATE_LIMIT_MAX", String(configured.max ?? 120))
  );
  const timeWindowMs = parsePositiveInt(
    "RATE_LIMIT_WINDOW_MS",
    env("RATE_LIMIT_WINDOW_MS", String(configured.timeWindowMs ?? 60_000))
  );
  const imageMax = parsePositiveInt(
    "RATE_LIMIT_IMAGE_MAX",
    env("RATE_LIMIT_IMAGE_MAX", String(configured.imageMax ?? Math.max(1, Math.floor(max / 6))))
  );
  return { max, imageMax, timeWindowMs };
}

function parseOpenAiEndpointWhitelist(value: string | undefined): OpenAiCompatibleEndpoint[] {
  if (!value) return [...ALL_OPENAI_COMPATIBLE_ENDPOINTS];
  return parseOpenAiEndpointWhitelistEntries(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    "OPENAI_ENDPOINT_WHITELIST"
  );
}

function parseOpenAiEndpointWhitelistEntries(entries: unknown, name: string): OpenAiCompatibleEndpoint[] {
  if (!Array.isArray(entries)) {
    throw new Error(`${name} must be an array`);
  }

  const aliases: Record<string, OpenAiCompatibleEndpoint> = {
    models: "models",
    "/v1/models": "models",
    chat_completions: "chat_completions",
    chat: "chat_completions",
    "/v1/chat/completions": "chat_completions",
    images: "images",
    image_generations: "images",
    "/v1/images/generations": "images"
  };

  const endpoints = entries
    .map((entry) => {
      if (typeof entry !== "string") {
        throw new Error(`${name} entries must be strings`);
      }
      const endpoint = aliases[entry];
      if (!endpoint) {
        throw new Error(
          `Unsupported ${name} entry: ${entry}. ` +
          `Supported entries: ${ALL_OPENAI_COMPATIBLE_ENDPOINTS.join(", ")}`
        );
      }
      return endpoint;
    });

  return [...new Set(endpoints)];
}

function parseModelList(value: string, assetDecimals: number): ModelConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`MODELS must be valid JSON: ${error instanceof Error ? error.message : "parse failed"}`);
  }

  return parseModelConfigList(parsed, "MODELS", assetDecimals);
}

function parseModelConfigList(parsed: unknown, name: string, assetDecimals: number): ModelConfig[] {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${name} must be a non-empty JSON array`);
  }

  return parsed.map((entry, index) => parseModelConfig(entry, index, assetDecimals, name));
}

function parseTraditionalApiConfigList(
  parsed: unknown,
  name: string,
  models: ModelConfig[],
  assetDecimals: number
): TraditionalApiConfig[] {
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be an array`);
  }

  const apis = parsed.map((entry, index) => parseTraditionalApiConfig(entry, index, name, models, assetDecimals));
  const enabledIds = new Set<string>();
  for (const api of apis) {
    if (!API_ID_PATTERN.test(api.id)) {
      throw new Error(`${name}[].id must be a URL-safe lowercase slug (a-z, 0-9, "_" or "-")`);
    }
    if (!api.enabled) continue;
    if (enabledIds.has(api.id)) {
      throw new Error(`${name} contains duplicate enabled id: ${api.id}`);
    }
    enabledIds.add(api.id);
  }

  if (enabledIds.size > 1) {
    const configuredOverrides = SINGLE_HTTP_API_ENV_OVERRIDES.filter((name) => optionalEnv(name) !== undefined);
    if (configuredOverrides.length > 0) {
      throw new Error(
        `Multiple enabled APIs require per-API JSONC configuration; ` +
        `unset single-upstream env override(s): ${configuredOverrides.join(", ")}`
      );
    }
  }

  return apis;
}

function parseTraditionalApiConfig(
  entry: unknown,
  index: number,
  collectionName: string,
  models: ModelConfig[],
  assetDecimals: number
): TraditionalApiConfig {
  if (!entry || typeof entry !== "object") {
    throw new Error(`${collectionName}[${index}] must be an object`);
  }

  const api = entry as Record<string, unknown>;
  const fallbackModel = models[0];
  const stringValue = (fieldName: string): string => {
    const value = api[fieldName];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${collectionName}[${index}].${fieldName} must be a string`);
    }
    return value;
  };
  const optionalStringValue = (fieldName: string, fallback: string): string => {
    const value = api[fieldName];
    if (value === undefined) return fallback;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${collectionName}[${index}].${fieldName} must be a string`);
    }
    return value;
  };
  const requestPriceValue = (record: Record<string, unknown>, errorName: string): bigint =>
    parseTraditionalRequestPrice(record, errorName, assetDecimals);
  const boolValue = (fieldName: string, fallback: boolean): boolean => {
    const value = api[fieldName];
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new Error(`${collectionName}[${index}].${fieldName} must be a boolean`);
    return value;
  };
  const methodsValue = (): string[] => {
    const value = api.methods;
    if (value === undefined) return ["GET", "POST", "PUT", "PATCH", "DELETE"];
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`${collectionName}[${index}].methods must be a non-empty array`);
    }
    return [...new Set(value.map((method) => {
      if (typeof method !== "string" || method.length === 0) {
        throw new Error(`${collectionName}[${index}].methods entries must be strings`);
      }
      return method.toUpperCase();
    }))];
  };
  const routeMethodsValue = (route: Record<string, unknown>, routeName: string): string[] => {
    const value = route.methods;
    if (value === undefined) return methodsValue();
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`${routeName}.methods must be a non-empty array`);
    }
    return [...new Set(value.map((method) => {
      if (typeof method !== "string" || method.length === 0) {
        throw new Error(`${routeName}.methods entries must be strings`);
      }
      return method.toUpperCase();
    }))];
  };
  const parsedRoutes = ((): TraditionalApiRouteConfig[] => {
    const routesEnv = optionalEnvWithLegacy("ROUTE_PRICES", "TRADITIONAL_API_ROUTES");
    let value = api.routes;
    let routesName = `${collectionName}[${index}].routes`;
    if (routesEnv !== undefined) {
      routesName = optionalEnv("ROUTE_PRICES") !== undefined ? "ROUTE_PRICES" : "TRADITIONAL_API_ROUTES";
      try {
        value = parseTraditionalApiRoutesEnv(routesEnv, routesName);
      } catch (error) {
        throw new Error(
          `${routesName} must be valid JSON or compact METHOD:/path=price entries: ` +
          `${error instanceof Error ? error.message : "parse failed"}`
        );
      }
    }
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new Error(`${routesName} must be an array`);
    }
    return value.map((entry, routeIndex) => {
      const routeName = `${routesName}[${routeIndex}]`;
      if (!entry || typeof entry !== "object") {
        throw new Error(`${routeName} must be an object`);
      }
      const route = entry as Record<string, unknown>;
      const routePath = route.path;
      if (typeof routePath !== "string" || routePath.length === 0 || (!routePath.startsWith("/") && routePath !== "*")) {
        throw new Error(`${routeName}.path must be "*" or start with "/"`);
      }
      const routeId = route.id;
      if (routeId !== undefined && (typeof routeId !== "string" || routeId.length === 0)) {
        throw new Error(`${routeName}.id must be a string`);
      }
      return {
        id: routeId,
        path: routePath,
        methods: routeMethodsValue(route, routeName),
        requestPrice: requestPriceValue(route, routeName),
        bearer: optionalStringValueFrom(route, `${routeName}.bearer`, "bearer"),
        headers: headersValue(route, `${routeName}.headers`)
      };
    });
  })();
  const chainIdValue = (): number => {
    const value = api.chainId ?? fallbackModel?.chainId ?? DEFAULT_APP_SETTINGS.tempo.chainId;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`${collectionName}[${index}].chainId must be a positive integer`);
    }
    return value;
  };
  const forwardedHeadersValue = (): string[] => {
    const value = api.forwardedHeaders;
    if (value === undefined) return [...DEFAULT_FORWARDED_HEADERS];
    if (!Array.isArray(value)) {
      throw new Error(`${collectionName}[${index}].forwardedHeaders must be an array of header names`);
    }
    return [...new Set(value.map((entry) => {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new Error(`${collectionName}[${index}].forwardedHeaders entries must be non-empty strings`);
      }
      return entry.toLowerCase();
    }))];
  };
  const upstreamTimeoutMsValue = (): number => {
    const value = api.upstreamTimeoutMs;
    if (value === undefined) return 30_000;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`${collectionName}[${index}].upstreamTimeoutMs must be a positive integer`);
    }
    return value;
  };
  const rateLimitValue = (): TraditionalApiRateLimitConfig | undefined => {
    const value = api.rateLimit;
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${collectionName}[${index}].rateLimit must be an object`);
    }
    const rateLimit = value as Record<string, unknown>;
    const max = parseOptionalPositiveIntField(rateLimit, "max", `${collectionName}[${index}].rateLimit`);
    const timeWindowMs = parseOptionalPositiveIntField(
      rateLimit,
      "timeWindowMs",
      `${collectionName}[${index}].rateLimit`
    );
    if (max === undefined && timeWindowMs === undefined) return undefined;
    return {
      ...(max !== undefined ? { max } : {}),
      ...(timeWindowMs !== undefined ? { timeWindowMs } : {})
    };
  };
  const responseSanitizerValue = (): ResponseSanitizerConfig => {
    const value = api.responseSanitizer;
    if (value === undefined) {
      return { removeJsonKeys: [...DEFAULT_RESPONSE_SANITIZER_REMOVE_JSON_KEYS] };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${collectionName}[${index}].responseSanitizer must be an object`);
    }
    return {
      removeJsonKeys: jsonKeyArrayValue(
        value as Record<string, unknown>,
        "removeJsonKeys",
        `${collectionName}[${index}].responseSanitizer.removeJsonKeys`,
        [...DEFAULT_RESPONSE_SANITIZER_REMOVE_JSON_KEYS]
      )
    };
  };

  const upstreamBaseUrlFromEnv = optionalEnv("UPSTREAM_BASE_URL");
  const upstreamBaseUrl = normalizeUpstreamBaseUrl(upstreamBaseUrlFromEnv ?? stringValue("upstreamBaseUrl"));
  const routesOnly = optionalBoolEnvWithLegacy("ROUTE_ALLOWLIST", "TRADITIONAL_API_ROUTES_ONLY");
  const openApiDocumentUrl = optionalEnvWithLegacy("OPENAPI_DOCUMENT_URL", "TRADITIONAL_OPENAPI_DOCUMENT_URL") ??
    optionalStringValueFrom(api, `${collectionName}[${index}].openApiDocumentUrl`, "openApiDocumentUrl");
  const normalizedOpenApiDocumentUrl = openApiDocumentUrl ? normalizeServerReachableUrl(openApiDocumentUrl) : undefined;
  try {
    new URL(upstreamBaseUrl);
  } catch {
    throw new Error(
      upstreamBaseUrlFromEnv
        ? "UPSTREAM_BASE_URL must be a valid URL"
        : `${collectionName}[${index}].upstreamBaseUrl must be a valid URL`
    );
  }
  if (normalizedOpenApiDocumentUrl) {
    try {
      new URL(normalizedOpenApiDocumentUrl);
    } catch {
      throw new Error("OPENAPI_DOCUMENT_URL/apis[].openApiDocumentUrl must be a valid URL");
    }
  }

  return {
    id: stringValue("id"),
    upstreamBaseUrl,
    enabled: boolValue("enabled", true),
    methods: methodsValue(),
    requestPrice: optionalEnv("DEFAULT_REQUEST_PRICE")
      ? parseTraditionalRequestPrice({ pricing: { request: optionalEnv("DEFAULT_REQUEST_PRICE") } }, "DEFAULT_REQUEST_PRICE", assetDecimals)
      : requestPriceValue(api, `${collectionName}[${index}]`),
    routes: parsedRoutes,
    allowUnmatchedRoutes: routesOnly === undefined
      ? boolValue("allowUnmatchedRoutes", parsedRoutes.length === 0)
      : !routesOnly,
    openApiDocumentPath: optionalEnvWithLegacy("OPENAPI_DOCUMENT_PATH", "TRADITIONAL_OPENAPI_DOCUMENT_PATH") ??
      optionalStringValueFrom(api, `${collectionName}[${index}].openApiDocumentPath`, "openApiDocumentPath"),
    openApiDocumentUrl: normalizedOpenApiDocumentUrl,
    assetSymbol: optionalStringValue("assetSymbol", fallbackModel?.assetSymbol ?? "USDC"),
    assetAddress: optionalStringValue("assetAddress", fallbackModel?.assetAddress ?? DEFAULT_APP_SETTINGS.tempo.acceptedAsset),
    chainId: chainIdValue(),
    forwardedHeaders: forwardedHeadersValue(),
    upstreamTimeoutMs: upstreamTimeoutMsValue(),
    rateLimit: rateLimitValue(),
    requestRewrite: parseRequestRewriteConfig(
      api.requestRewrite,
      `${collectionName}[${index}].requestRewrite`,
      optionalEnv
    ),
    responseSanitizer: responseSanitizerValue(),
    bearer: optionalStringValueFrom(api, `${collectionName}[${index}].bearer`, "bearer") ?? optionalEnv("UPSTREAM_BEARER_TOKEN"),
    headers: headersValue(api, `${collectionName}[${index}].headers`) ?? upstreamHeaderFromEnv()
  };
}

function jsonKeyArrayValue(
  record: Record<string, unknown>,
  fieldName: string,
  errorName: string,
  fallback: string[]
): string[] {
  const value = record[fieldName];
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    throw new Error(`${errorName} must be an array of JSON key names`);
  }
  return [...new Set(value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`${errorName} entries must be non-empty strings`);
    }
    return entry;
  }))];
}

/**
 * ROUTE_PRICES env supports:
 * - JSON array (full objects with path, methods, pricing.request)
 * - Compact comma-separated rules: GET:/v1/quote=0.0005,POST+PUT:/v1/items=0.001
 * Legacy alias: TRADITIONAL_API_ROUTES
 */
function parseTraditionalApiRoutesEnv(routesEnv: string, envName = "ROUTE_PRICES"): unknown[] {
  const trimmed = routesEnv.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error(`${envName} JSON must be an array`);
    }
    return parsed;
  }

  return trimmed.split(",").filter((segment) => segment.length > 0).map((segment, index) => {
    const eq = segment.lastIndexOf("=");
    if (eq <= 0) {
      throw new Error(`${envName} compact segment[${index}] must be METHOD:/path=price`);
    }
    const price = segment.slice(eq + 1).trim();
    const left = segment.slice(0, eq);
    const colon = left.indexOf(":");
    if (colon <= 0) {
      throw new Error(`${envName} compact segment[${index}] must be METHOD:/path=price`);
    }
    const methods = left
      .slice(0, colon)
      .split("+")
      .map((method) => method.trim().toUpperCase())
      .filter((method) => method.length > 0);
    const path = left.slice(colon + 1).trim();
    if (!path.startsWith("/") && path !== "*") {
      throw new Error(`${envName} compact segment[${index}].path must start with "/"`);
    }
    if (!methods.length) {
      throw new Error(`${envName} compact segment[${index}] must include at least one method`);
    }
    return {
      path,
      methods,
      pricing: { request: price }
    };
  });
}

function parseTraditionalRequestPrice(
  record: Record<string, unknown>,
  errorName: string,
  assetDecimals: number
): bigint {
  const legacyPrice = record.requestPrice;
  if (legacyPrice !== undefined) {
    const text = typeof legacyPrice === "number" ? String(legacyPrice) : legacyPrice;
    if (typeof text !== "string" || !/^\d+$/.test(text)) {
      throw new Error(`${errorName}.requestPrice must be a positive integer string`);
    }
    const parsed = BigInt(text);
    if (parsed < 0n) throw new Error(`${errorName}.requestPrice must be zero or greater`);
    return parsed;
  }

  const pricing = record.pricing;
  if (pricing === undefined) {
    throw new Error(`${errorName} must define requestPrice or pricing.request`);
  }
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) {
    throw new Error(`${errorName}.pricing must be an object`);
  }

  const parsed = optionalDecimalAssetAmount(
    (pricing as Record<string, unknown>).request,
    `${errorName}.pricing.request`,
    assetDecimals
  );
  if (parsed === undefined) {
    throw new Error(`${errorName} must define requestPrice or pricing.request`);
  }
  if (parsed < 0n) {
    throw new Error(`${errorName}.pricing.request must be zero or greater`);
  }
  return parsed;
}

function optionalStringValueFrom(record: Record<string, unknown>, errorName: string, fieldName: string): string | undefined {
  const value = record[fieldName];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${errorName} must be a non-empty string`);
  }
  return value;
}

function headersValue(record: Record<string, unknown>, errorName: string): Record<string, string> | undefined {
  const value = record.headers;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${errorName} must be an object`);
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (name.length === 0) {
      throw new Error(`${errorName} header names must be non-empty strings`);
    }
    if (typeof headerValue !== "string" || headerValue.length === 0) {
      throw new Error(`${errorName}.${name} must be a non-empty string`);
    }
    headers[name] = headerValue;
  }
  return headers;
}

function upstreamHeaderFromEnv(): Record<string, string> | undefined {
  const name = optionalEnv("UPSTREAM_AUTH_HEADER");
  const value = optionalEnv("UPSTREAM_AUTH_HEADER_VALUE");
  if (name === undefined && value === undefined) return undefined;
  if (name === undefined || value === undefined) {
    throw new Error("UPSTREAM_AUTH_HEADER and UPSTREAM_AUTH_HEADER_VALUE must be set together");
  }
  return { [name]: value };
}

export const DEFAULT_FORWARDED_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "idempotency-key",
  "x-correlation-id",
  "x-request-id",
  "if-match",
  "if-none-match"
];

function parseModelConfig(entry: unknown, index: number, assetDecimals: number, collectionName = "MODELS"): ModelConfig {
  if (!entry || typeof entry !== "object") {
    throw new Error(`${collectionName}[${index}] must be an object`);
  }
  const model = entry as Record<string, unknown>;
  const fallbackModel = findFallbackModel(model);
  const optionalStringValue = (fieldName: string, fallback: string): string => {
    const value = model[fieldName];
    if (value === undefined) return fallback;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${collectionName}[${index}].${fieldName} must be a string`);
    }
    return value;
  };
  const bigintValue = (fieldName: string): bigint => {
    const value = model[fieldName];
    const text = typeof value === "number" ? String(value) : value;
    if (typeof text !== "string" || !/^\d+$/.test(text)) {
      throw new Error(`${collectionName}[${index}].${fieldName} must be a non-negative integer string`);
    }
    return BigInt(text);
  };
  const optionalBigintValue = (fieldName: string): bigint | undefined => {
    if (model[fieldName] === undefined) return undefined;
    return bigintValue(fieldName);
  };
  const intValue = (fieldName: string, fallback?: number): number => {
    const value = model[fieldName];
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`${collectionName}[${index}].${fieldName} must be a positive integer`);
    }
    return value;
  };
  const boolValue = (fieldName: string, fallback?: boolean): boolean => {
    const value = model[fieldName];
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== "boolean") throw new Error(`${collectionName}[${index}].${fieldName} must be a boolean`);
    return value;
  };
  const legacyUpstreamName = typeof model.upstreamName === "string" ? model.upstreamName : undefined;
  const legacyPublicName = typeof model.publicName === "string" ? model.publicName : undefined;
  const modelName = optionalStringValue("modelName", legacyUpstreamName ?? legacyPublicName ?? fallbackModel?.modelName ?? "");
  if (!modelName) {
    throw new Error(`${collectionName}[${index}].modelName must be a string`);
  }
  const pricing = parseModelPricing(model.pricing, `${collectionName}[${index}].pricing`, assetDecimals);
  const inputPricePerMillion = pricing.inputPricePerMillion ??
    optionalBigintValue("inputPricePerMillion") ??
    fallbackModel?.inputPricePerMillion;
  const cachedInputPricePerMillion = pricing.cachedInputPricePerMillion ??
    optionalBigintValue("cachedInputPricePerMillion") ??
    fallbackModel?.cachedInputPricePerMillion;
  const outputPricePerMillion = pricing.outputPricePerMillion ??
    optionalBigintValue("outputPricePerMillion") ??
    fallbackModel?.outputPricePerMillion;
  const minimumCharge = pricing.minimumCharge ??
    optionalBigintValue("minimumCharge") ??
    fallbackModel?.minimumCharge;
  const imageTextInputPricePerMillion = pricing.imageTextInputPricePerMillion ??
    optionalBigintValue("imageTextInputPricePerMillion") ??
    fallbackModel?.imageTextInputPricePerMillion;
  const imageInputPricePerMillion = pricing.imageInputPricePerMillion ??
    optionalBigintValue("imageInputPricePerMillion") ??
    fallbackModel?.imageInputPricePerMillion;
  const imageOutputPricePerMillion = pricing.imageOutputPricePerMillion ??
    optionalBigintValue("imageOutputPricePerMillion") ??
    fallbackModel?.imageOutputPricePerMillion;
  const imageMaxOutputTokens = parseImageMaxOutputTokens(
    model.imageMaxOutputTokens,
    `${collectionName}[${index}].imageMaxOutputTokens`
  ) ?? fallbackModel?.imageMaxOutputTokens;
  if (inputPricePerMillion === undefined) {
    throw new Error(`${collectionName}[${index}] must define pricing.inputPerMillion or inputPricePerMillion`);
  }
  if (outputPricePerMillion === undefined) {
    throw new Error(`${collectionName}[${index}] must define pricing.outputPerMillion or outputPricePerMillion`);
  }
  if (minimumCharge === undefined) {
    throw new Error(`${collectionName}[${index}] must define pricing.minimum or minimumCharge`);
  }
  return {
    id: optionalStringValue("id", fallbackModel?.id ?? `model_${modelName.replace(/[^A-Za-z0-9]+/g, "_")}`),
    modelName,
    enabled: boolValue("enabled", fallbackModel?.enabled ?? true),
    supportsStreaming: boolValue("supportsStreaming", fallbackModel?.supportsStreaming ?? false),
    inputPricePerMillion,
    cachedInputPricePerMillion,
    outputPricePerMillion,
    requestPrice: pricing.requestPrice ?? optionalBigintValue("requestPrice") ?? fallbackModel?.requestPrice,
    minimumCharge,
    defaultMaxTokens: intValue("defaultMaxTokens", fallbackModel?.defaultMaxTokens ?? 512),
    maxTokensLimit: intValue("maxTokensLimit", fallbackModel?.maxTokensLimit ?? 4096),
    contextWindow: optionalIntValue(model.contextWindow, `${collectionName}[${index}].contextWindow`, fallbackModel?.contextWindow),
    knowledgeCutoff: optionalStringValue("knowledgeCutoff", fallbackModel?.knowledgeCutoff ?? ""),
    imageTextInputPricePerMillion,
    imageInputPricePerMillion,
    imageOutputPricePerMillion,
    imageMaxOutputTokens,
    assetSymbol: optionalStringValue("assetSymbol", fallbackModel?.assetSymbol ?? "pathUSD"),
    assetAddress: optionalStringValue("assetAddress", fallbackModel?.assetAddress ?? DEFAULT_APP_SETTINGS.tempo.acceptedAsset),
    chainId: intValue("chainId", fallbackModel?.chainId ?? DEFAULT_APP_SETTINGS.tempo.chainId)
  };
}

function findFallbackModel(model: Record<string, unknown>): ModelConfig | undefined {
  const modelName = typeof model.modelName === "string" ? model.modelName : undefined;
  const publicName = typeof model.publicName === "string" ? model.publicName : undefined;
  const id = typeof model.id === "string" ? model.id : undefined;
  const upstreamName = typeof model.upstreamName === "string" ? model.upstreamName : undefined;
  return DEFAULT_MODELS.find((candidate) =>
    candidate.modelName === modelName ||
    candidate.modelName === publicName ||
    candidate.id === id ||
    candidate.modelName === upstreamName
  );
}

function parseModelPricing(value: unknown, name: string, assetDecimals: number): {
  inputPricePerMillion?: bigint;
  cachedInputPricePerMillion?: bigint;
  outputPricePerMillion?: bigint;
  requestPrice?: bigint;
  minimumCharge?: bigint;
  imageTextInputPricePerMillion?: bigint;
  imageInputPricePerMillion?: bigint;
  imageOutputPricePerMillion?: bigint;
} {
  if (value === undefined) return {};
  if (!value || typeof value !== "object") {
    throw new Error(`${name} must be an object`);
  }
  const pricing = value as Record<string, unknown>;
  return {
    inputPricePerMillion: optionalDecimalAssetAmount(pricing.inputPerMillion, `${name}.inputPerMillion`, assetDecimals),
    cachedInputPricePerMillion: optionalDecimalAssetAmount(pricing.cachedInputPerMillion, `${name}.cachedInputPerMillion`, assetDecimals),
    outputPricePerMillion: optionalDecimalAssetAmount(pricing.outputPerMillion, `${name}.outputPerMillion`, assetDecimals),
    requestPrice: optionalDecimalAssetAmount(pricing.request, `${name}.request`, assetDecimals),
    minimumCharge: optionalDecimalAssetAmount(pricing.minimum, `${name}.minimum`, assetDecimals),
    imageTextInputPricePerMillion: optionalDecimalAssetAmount(pricing.imageTextInputPerMillion, `${name}.imageTextInputPerMillion`, assetDecimals),
    imageInputPricePerMillion: optionalDecimalAssetAmount(pricing.imageInputPerMillion, `${name}.imageInputPerMillion`, assetDecimals),
    imageOutputPricePerMillion: optionalDecimalAssetAmount(pricing.imageOutputPerMillion, `${name}.imageOutputPerMillion`, assetDecimals)
  };
}

function parseImageMaxOutputTokens(value: unknown, name: string): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object mapping size-quality keys to positive integers`);
  }
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
      throw new Error(`${name}["${key}"] must be a positive integer`);
    }
    result[key] = raw;
  }
  return result;
}

function optionalIntValue(value: unknown, name: string, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function optionalDecimalAssetAmount(value: unknown, name: string, decimals: number): bigint | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`${name}: asset decimals must be a non-negative integer (got ${decimals})`);
  }
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

function deriveMppSecret(nodeSigningSecret: string): string {
  return createHmac("sha256", nodeSigningSecret)
    .update("pay-api-proxy:mppx-session-secret:v1")
    .digest("hex");
}

function publicBaseUrlFromConfig(fileConfig: ConfigFileSettings): string {
  const fallback =
    fileConfig.publicBaseUrl ??
    derivePublicBaseUrlFromDomainName(
      optionalEnv("DOMAIN_NAME") ?? optionalEnv("PUBLIC_HOST") ?? optionalEnv("CADDY_SITE_ADDRESS")
    ) ??
    DEFAULT_APP_SETTINGS.publicBaseUrl;
  return env("PUBLIC_BASE_URL", fallback).replace(/\/+$/, "");
}

function assertNoLegacyApiListField(fileConfig: ConfigFileSettings): void {
  const legacyApiListField = "traditional" + "Apis";
  if (Object.prototype.hasOwnProperty.call(fileConfig as Record<string, unknown>, legacyApiListField)) {
    throw new Error('Configure upstream APIs with top-level "apis".');
  }
}

export function loadConfig(): AppConfig {
  loadDotEnv(".env");
  const fileConfig = readConfigFile();
  assertNoLegacyApiListField(fileConfig);
  const nodeEnv = env("NODE_ENV", fileConfig.nodeEnv ?? DEFAULT_APP_SETTINGS.nodeEnv);
  const databasePath = env("DATABASE_PATH", fileConfig.databasePath ?? DEFAULT_APP_SETTINGS.databasePath);
  const nodeSigningSecret = resolveNodeSigningSecret(nodeEnv, databasePath);
  const publicBaseUrl = publicBaseUrlFromConfig(fileConfig);
  const paymentProvider = parseProvider(env(
    "PAYMENT_PROVIDER",
    fileConfig.paymentProvider ?? DEFAULT_APP_SETTINGS.paymentProvider
  ));

  if (nodeEnv === "production" && nodeSigningSecret === DEV_SIGNING_SECRET) {
    throw new Error(
      "NODE_SIGNING_SECRET is optional, but it must not be the development default when NODE_ENV=production"
    );
  }

  const assetDecimals = parsePositiveInt(
    "TEMPO_ASSET_DECIMALS",
    env("TEMPO_ASSET_DECIMALS", String(fileConfig.tempo?.assetDecimals ?? DEFAULT_APP_SETTINGS.tempo.assetDecimals))
  );
  const chainId = Number(env("TEMPO_CHAIN_ID", String(fileConfig.tempo?.chainId ?? DEFAULT_APP_SETTINGS.tempo.chainId)));
  assertTempoProviderChain(paymentProvider, chainId);
  const upstreamProvider = parseUpstream(env(
    "UPSTREAM_PROVIDER",
    fileConfig.upstreamProvider ?? DEFAULT_APP_SETTINGS.upstreamProvider
  ));
  const openAiModelsConfig = upstreamProvider === "openai" && !optionalEnv("MODELS") && !fileConfig.models
    ? readOpenAiModelsConfigFile()
    : {};
  const models = optionalEnv("MODELS")
    ? parseModelList(optionalEnv("MODELS")!, assetDecimals)
    : fileConfig.models
      ? parseModelConfigList(fileConfig.models, "models", assetDecimals)
      : openAiModelsConfig.models
        ? parseModelConfigList(openAiModelsConfig.models, "openai-models.config.jsonc.models", assetDecimals)
      : DEFAULT_MODELS;
  const mppx = parseMppxConfig(fileConfig, nodeSigningSecret, chainId);

  return {
    nodeEnv,
    host: env("HOST", fileConfig.host ?? DEFAULT_APP_SETTINGS.host),
    port: parsePositiveInt("PORT", env("PORT", String(fileConfig.port ?? DEFAULT_APP_SETTINGS.port))),
    databasePath,
    paymentProvider,
    publicBaseUrl,
    nodeSigningSecret,
    corsAllowOrigin: env("CORS_ALLOW_ORIGIN", fileConfig.corsAllowOrigin ?? DEFAULT_APP_SETTINGS.corsAllowOrigin),
    maxRequestBodyBytes: parsePositiveInt(
      "MAX_REQUEST_BODY_BYTES",
      env("MAX_REQUEST_BODY_BYTES", String(fileConfig.maxRequestBodyBytes ?? DEFAULT_APP_SETTINGS.maxRequestBodyBytes))
    ),
    upstreamProvider,
    chargingMethod: parseChargingMethod(env("CHARGING_METHOD", fileConfig.chargingMethod ?? DEFAULT_APP_SETTINGS.chargingMethod)),
    sessionBilling: parseSessionBillingConfig(fileConfig),
    mppx,
    mppxSession: parseMppxSessionConfig(fileConfig, mppx),
    openaiApiKey: optionalSecret("OPENAI_API_KEY"),
    openaiBaseUrl: env("OPENAI_BASE_URL", fileConfig.openaiBaseUrl ?? DEFAULT_APP_SETTINGS.openaiBaseUrl),
    openaiEndpointWhitelist: optionalEnv("OPENAI_ENDPOINT_WHITELIST")
      ? parseOpenAiEndpointWhitelist(optionalEnv("OPENAI_ENDPOINT_WHITELIST"))
      : fileConfig.openaiEndpointWhitelist
        ? parseOpenAiEndpointWhitelistEntries(fileConfig.openaiEndpointWhitelist, "openaiEndpointWhitelist")
        : DEFAULT_APP_SETTINGS.openaiEndpointWhitelist,
    apis: fileConfig.apis
      ? parseTraditionalApiConfigList(fileConfig.apis, "apis", models, assetDecimals)
      : [],
    models,
    rateLimit: parseRateLimitConfig(fileConfig),
    tempo: {
      rpcUrl: env("TEMPO_RPC_URL", fileConfig.tempo?.rpcUrl ?? DEFAULT_APP_SETTINGS.tempo.rpcUrl),
      chainId,
      settlementAddress: env(
        "PAYMENT_RECIPIENT_ADDRESS",
        optionalEnv("TEMPO_SETTLEMENT_ADDRESS") ??
          fileConfig.paymentRecipientAddress ??
          fileConfig.tempo?.settlementAddress ??
          DEFAULT_APP_SETTINGS.tempo.settlementAddress
      ),
      acceptedAsset: env("TEMPO_ACCEPTED_ASSET", fileConfig.tempo?.acceptedAsset ?? DEFAULT_APP_SETTINGS.tempo.acceptedAsset),
      assetDecimals
    }
  };
}

export function loadWorkerConfig(): WorkerConfig {
  loadDotEnv(".env");
  const fileConfig = readConfigFile();
  const publicBaseUrl = publicBaseUrlFromConfig(fileConfig);
  const directoryPublish: DirectoryPublishConfig = {
    enabled: optionalBoolEnv("XPAYAPI_PUBLISH_ENABLED") ?? true,
    directoryUrl: env("XPAYAPI_DIRECTORY_URL", "https://api.xpayapi.com"),
    publicBaseUrl
  };
  return {
    nodeEnv: env("NODE_ENV", fileConfig.nodeEnv ?? DEFAULT_APP_SETTINGS.nodeEnv),
    databasePath: env("DATABASE_PATH", fileConfig.databasePath ?? DEFAULT_APP_SETTINGS.databasePath),
    directoryPublish
  };
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    databasePath: ":memory:",
    paymentProvider: DEFAULT_APP_SETTINGS.paymentProvider,
    publicBaseUrl: "http://localhost:8080",
    nodeSigningSecret: "test-secret",
    corsAllowOrigin: DEFAULT_APP_SETTINGS.corsAllowOrigin,
    maxRequestBodyBytes: DEFAULT_APP_SETTINGS.maxRequestBodyBytes,
    upstreamProvider: "openai",
    chargingMethod: DEFAULT_APP_SETTINGS.chargingMethod,
    sessionBilling: {
      reserveMode: DEFAULT_APP_SETTINGS.sessionBilling.reserveMode,
      settlementMode: DEFAULT_APP_SETTINGS.sessionBilling.settlementMode,
      unitAmount: BigInt(DEFAULT_APP_SETTINGS.sessionBilling.unitAmount),
      unitType: DEFAULT_APP_SETTINGS.sessionBilling.unitType
    },
    mppxSession: {
      enabled: false,
      secretKey: "test-secret",
      testnet: true,
      waitForConfirmation: true
    },
    mppx: {
      secretKey: "test-secret",
      testnet: true,
      waitForConfirmation: true
    },
    openaiBaseUrl: DEFAULT_APP_SETTINGS.openaiBaseUrl,
    openaiEndpointWhitelist: DEFAULT_APP_SETTINGS.openaiEndpointWhitelist,
    apis: [],
    models: [TEST_MODEL, ...DEFAULT_MODELS],
    rateLimit: { max: 10_000, imageMax: 10_000, timeWindowMs: 60_000 },
    tempo: {
      ...DEFAULT_APP_SETTINGS.tempo
    }
  };

  return {
    ...base,
    ...overrides,
    sessionBilling: {
      ...base.sessionBilling,
      ...(overrides.sessionBilling ?? {})
    },
    mppxSession: {
      ...base.mppxSession,
      ...(overrides.mppxSession ?? {})
    },
    mppx: {
      ...base.mppx,
      ...(overrides.mppx ?? {})
    },
    tempo: {
      ...base.tempo,
      ...(overrides.tempo ?? {})
    }
  };
}
