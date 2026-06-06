import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { loadCloudflareWorkerConfig } from "../../src/adapters/cloudflare-worker/env-config.js";
import { DEV_SIGNING_SECRET, loadConfig, loadWorkerConfig } from "../../src/core/config.js";

const SAVED_KEYS = [
  "NODE_ENV",
  "NODE_SIGNING_SECRET",
  "NODE_SIGNING_SECRET_FILE",
  "OPENAI_API_KEY",
  "OPENAI_API_KEY_FILE",
  "PAYMENT_RECIPIENT_ADDRESS",
  "TEMPO_SETTLEMENT_ADDRESS",
  "PAYMENT_PROVIDER",
  "UPSTREAM_PROVIDER",
  "UPSTREAM_BASE_URL",
  "UPSTREAM_BEARER_TOKEN",
  "UPSTREAM_AUTH_HEADER",
  "UPSTREAM_AUTH_HEADER_VALUE",
  "DEFAULT_REQUEST_PRICE",
  "ROUTE_PRICES",
  "ROUTE_ALLOWLIST",
  "TRADITIONAL_API_ROUTES",
  "TRADITIONAL_API_ROUTES_ONLY",
  "OPENAPI_DOCUMENT_URL",
  "OPENAPI_DOCUMENT_PATH",
  "TRADITIONAL_OPENAPI_DOCUMENT_URL",
  "TRADITIONAL_OPENAPI_DOCUMENT_PATH",
  "CHARGING_METHOD",
  "SESSION_BILLING_UNIT_AMOUNT",
  "SESSION_BILLING_UNIT_TYPE",
  "RATE_LIMIT_MAX",
  "RATE_LIMIT_IMAGE_MAX",
  "RATE_LIMIT_WINDOW_MS",
  "MPPX_SESSION_ENABLED",
  "MPPX_TESTNET",
  "MPPX_WAIT_FOR_CONFIRMATION",
  "MPPX_SESSION_PRIVATE_KEY",
  "MPP_SECRET_KEY",
  "TEMPO_ASSET_DECIMALS",
  "TEMPO_CHAIN_ID",
  "TEMPO_RPC_URL",
  "TEMPO_ACCEPTED_ASSET",
  "MPPX_SESSION_TESTNET",
  "MPPX_SESSION_WAIT_FOR_CONFIRMATION",
  "MAX_REQUEST_BODY_BYTES",
  "PUBLIC_BASE_URL",
  "DOMAIN_NAME",
  "PUBLIC_HOST",
  "CADDY_SITE_ADDRESS",
  "OPENAI_ENDPOINT_WHITELIST",
  "MODELS",
  "PAY_API_PROXY_CONFIG",
  "PAY_API_PROXY_SKIP_DOTENV",
  "PAY_API_PROXY_DOCKER_RUNTIME",
  "XPAYAPI_PUBLISH_ENABLED",
  "VENDOR_VERIFY_KEY"
];

describe("config", () => {
  const saved: Record<string, string | undefined> = {};
  const rootOpenAiModelsConfigPath = "openai-models.config.jsonc";
  const hiddenOpenAiModelsConfigPath = "openai-models.config.jsonc.test-hidden";

  beforeEach(() => {
    for (const key of SAVED_KEYS) saved[key] = process.env[key];
    process.env.PAY_API_PROXY_SKIP_DOTENV = "1";
    process.env.MPPX_SESSION_ENABLED = "false";
    if (existsSync(rootOpenAiModelsConfigPath)) {
      renameSync(rootOpenAiModelsConfigPath, hiddenOpenAiModelsConfigPath);
    }
  });

  afterEach(() => {
    rmSync(rootOpenAiModelsConfigPath, { force: true });
    if (existsSync(hiddenOpenAiModelsConfigPath)) {
      renameSync(hiddenOpenAiModelsConfigPath, rootOpenAiModelsConfigPath);
    }
    for (const key of SAVED_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("refuses to boot in production with the dev signing secret", () => {
    process.env.NODE_ENV = "production";
    process.env.NODE_SIGNING_SECRET = DEV_SIGNING_SECRET;
    expect(() => loadConfig()).toThrow(/NODE_SIGNING_SECRET/);
  });

  it("loads in production when a real signing secret is set", () => {
    process.env.NODE_ENV = "production";
    process.env.NODE_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
    const config = loadConfig();
    expect(config.nodeSigningSecret).toBe("0123456789abcdef0123456789abcdef");
  });

  it("generates a persistent signing secret in production when none is configured", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-generated-secret-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    const databasePath = join(directory, "data", "pay-api-proxy.sqlite");
    const secretPath = join(directory, "data", "node-signing-secret");
    writeFileSync(configPath, JSON.stringify({ databasePath }));

    process.env.NODE_ENV = "production";
    process.env.PAY_API_PROXY_CONFIG = configPath;
    delete process.env.NODE_SIGNING_SECRET;
    delete process.env.NODE_SIGNING_SECRET_FILE;

    const first = loadConfig();
    const second = loadConfig();

    expect(first.nodeSigningSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(second.nodeSigningSecret).toBe(first.nodeSigningSecret);
    expect(readFileSync(secretPath, "utf8").trim()).toBe(first.nodeSigningSecret);

    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects non-positive MAX_REQUEST_BODY_BYTES", () => {
    process.env.NODE_ENV = "development";
    process.env.MAX_REQUEST_BODY_BYTES = "0";
    expect(() => loadConfig()).toThrow(/MAX_REQUEST_BODY_BYTES/);
  });

  it("loads secrets from *_FILE paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-config-"));
    const signingSecretPath = join(directory, "node_signing_secret");
    const openAiKeyPath = join(directory, "openai_api_key");
    writeFileSync(signingSecretPath, "file-signing-secret\n");
    writeFileSync(openAiKeyPath, "sk-from-file\n");

    process.env.NODE_ENV = "production";
    delete process.env.NODE_SIGNING_SECRET;
    delete process.env.OPENAI_API_KEY;
    process.env.NODE_SIGNING_SECRET_FILE = signingSecretPath;
    process.env.OPENAI_API_KEY_FILE = openAiKeyPath;

    const config = loadConfig();
    expect(config.nodeSigningSecret).toBe("file-signing-secret");
    expect(config.openaiApiKey).toBe("sk-from-file");

    rmSync(directory, { recursive: true, force: true });
  });

  it("loads model configuration from MODELS JSON", () => {
    process.env.MODELS = JSON.stringify([
      {
        id: "model_env_chat",
        modelName: "gpt-4o-mini",
        enabled: true,
        supportsStreaming: false,
        inputPricePerMillion: "1000000",
        outputPricePerMillion: "4000000",
        minimumCharge: "1000",
        defaultMaxTokens: 512,
        maxTokensLimit: 4096,
        assetSymbol: "pathUSD",
        assetAddress: "0x20c0000000000000000000000000000000000000",
        chainId: 42431
      }
    ]);

    const config = loadConfig();
    expect(config.models[0].modelName).toBe("gpt-4o-mini");
    expect(config.models[0].inputPricePerMillion).toBe(1_000_000n);
  });

  it("loads friendly model pricing from PAY_API_PROXY_CONFIG", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-model-pricing-config-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        models: [
          {
            modelName: "gpt-4o-mini",
            pricing: {
              inputPerMillion: "1.25",
              cachedInputPerMillion: "0.125",
              outputPerMillion: "5.50",
              minimum: "0.0025"
            },
            defaultMaxTokens: 256,
            maxTokensLimit: 8192,
            contextWindow: 128000,
            knowledgeCutoff: "2025-08-31"
          }
        ]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;

    const config = loadConfig();
    expect(config.models[0].id).toBe("model_gpt_4o_mini");
    expect(config.models[0].inputPricePerMillion).toBe(1_250_000n);
    expect(config.models[0].cachedInputPricePerMillion).toBe(125_000n);
    expect(config.models[0].outputPricePerMillion).toBe(5_500_000n);
    expect(config.models[0].minimumCharge).toBe(2_500n);
    expect(config.models[0].defaultMaxTokens).toBe(256);
    expect(config.models[0].maxTokensLimit).toBe(8192);
    expect(config.models[0].contextWindow).toBe(128000);
    expect(config.models[0].knowledgeCutoff).toBe("2025-08-31");
    expect(config.models[0].assetSymbol).toBe("pathUSD");

    rmSync(directory, { recursive: true, force: true });
  });

  it("auto-loads root openai-models config for openai upstream when models are not inline", () => {
    writeFileSync(
      rootOpenAiModelsConfigPath,
      JSON.stringify({
        models: [
          {
            modelName: "gpt-root-config",
            pricing: {
              inputPerMillion: "1.00",
              outputPerMillion: "2.00",
              minimum: "0.001"
            },
            defaultMaxTokens: 256,
            maxTokensLimit: 8192
          }
        ]
      })
    );

    process.env.UPSTREAM_PROVIDER = "openai";

    const config = loadConfig();
    expect(config.models.map((model) => model.modelName)).toEqual(["gpt-root-config"]);
    expect(config.models[0].inputPricePerMillion).toBe(1_000_000n);
  });

  it("does not auto-load root openai-models config for http upstream", () => {
    writeFileSync(
      rootOpenAiModelsConfigPath,
      JSON.stringify({
        models: [
          {
            modelName: "gpt-root-config",
            pricing: {
              inputPerMillion: "1.00",
              outputPerMillion: "2.00",
              minimum: "0.001"
            },
            defaultMaxTokens: 256,
            maxTokensLimit: 8192
          }
        ]
      })
    );

    process.env.UPSTREAM_PROVIDER = "http";

    const config = loadConfig();
    expect(config.models.map((model) => model.modelName)).toContain("gpt-4o-mini");
    expect(config.models.map((model) => model.modelName)).not.toContain("gpt-root-config");
  });

  it("loads charging method once from top-level config", () => {
    process.env.CHARGING_METHOD = "ai-token";

    const config = loadConfig();
    expect(config.chargingMethod).toBe("ai-token");
  });

  it("loads per-request charging method from top-level config", () => {
    process.env.CHARGING_METHOD = "per-request";

    const config = loadConfig();
    expect(config.chargingMethod).toBe("per-request");
  });

  it("loads session billing unit configuration from PAY_API_PROXY_CONFIG and env", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-session-config-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        sessionBilling: {
          reserveMode: "max-quote",
          settlementMode: "actual-usage",
          unitAmount: "50",
          unitType: "usd-micro"
        }
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;
    process.env.SESSION_BILLING_UNIT_AMOUNT = "100";

    const config = loadConfig();
    expect(config.sessionBilling.reserveMode).toBe("max-quote");
    expect(config.sessionBilling.settlementMode).toBe("actual-usage");
    expect(config.sessionBilling.unitAmount).toBe(100n);
    expect(config.sessionBilling.unitType).toBe("usd-micro");

    rmSync(directory, { recursive: true, force: true });
  });

  it("requires a private key when native mppx sessions are enabled", () => {
    process.env.MPPX_SESSION_ENABLED = "true";

    expect(() => loadConfig()).toThrow(/MPPX_SESSION_PRIVATE_KEY/);
  });

  it("loads native mppx session configuration", () => {
    process.env.MPPX_SESSION_ENABLED = "true";
    process.env.MPPX_SESSION_PRIVATE_KEY = `0x${"1".repeat(64)}`;
    process.env.MPP_SECRET_KEY = "mpp-test-secret";
    process.env.TEMPO_ASSET_DECIMALS = "6";
    process.env.MPPX_SESSION_TESTNET = "false";
    process.env.MPPX_SESSION_WAIT_FOR_CONFIRMATION = "false";

    const config = loadConfig();
    expect(config.mppxSession.enabled).toBe(true);
    expect(config.mppxSession.privateKey).toBe(`0x${"1".repeat(64)}`);
    expect(config.mppxSession.secretKey).toBe("mpp-test-secret");
    expect(config.mppxSession.testnet).toBe(false);
    expect(config.mppxSession.waitForConfirmation).toBe(false);
    expect(config.tempo.assetDecimals).toBe(6);
  });

  it("loads fixed-charge mppx configuration separately from native sessions", () => {
    process.env.MPP_SECRET_KEY = "charge-secret";
    process.env.MPPX_TESTNET = "false";
    process.env.MPPX_WAIT_FOR_CONFIRMATION = "false";

    const config = loadConfig();
    expect(config.mppx.secretKey).toBe("charge-secret");
    expect(config.mppx.testnet).toBe(false);
    expect(config.mppx.waitForConfirmation).toBe(false);
    expect(config.mppxSession.enabled).toBe(false);
    expect(config.mppxSession.secretKey).toBe("charge-secret");
  });

  it("loads traditional per-request API configuration from PAY_API_PROXY_CONFIG", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-traditional-config-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        apis: [{
          id: "fx",
          upstreamBaseUrl: "https://demo-fx.example",
          methods: ["GET"],
          requestPrice: "500",
          upstreamTimeoutMs: 1234,
          rateLimit: { max: 25, timeWindowMs: 10_000 },
          requestRewrite: {
            headers: { "content-type": "application/json" },
            body: {
              mode: "mergeJson",
              json: {
                key: { env: "VENDOR_VERIFY_KEY" }
              }
            }
          },
          responseSanitizer: { removeJsonKeys: ["cost", "remain_money", "vendor_balance"] },
          bearer: "service-token",
          headers: { "x-api-key": "service-key" },
          routes: [
            {
              id: "live",
              path: "/v1/live/*",
              methods: ["GET"],
              requestPrice: "2500",
              bearer: "live-token",
              headers: { "x-api-key": "live-key" }
            },
            { id: "status", path: "/v1/status", requestPrice: "100" }
          ],
          assetSymbol: "USDC",
          assetAddress: "0x20c0000000000000000000000000000000000000",
          chainId: 42431
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;
    process.env.VENDOR_VERIFY_KEY = "vendor-secret";

    const config = loadConfig();
    expect(config.apis[0].id).toBe("fx");
    expect(config.apis[0].methods).toEqual(["GET"]);
    expect(config.apis[0].requestPrice).toBe(500n);
    expect(config.apis[0].upstreamTimeoutMs).toBe(1234);
    expect(config.apis[0].rateLimit).toEqual({ max: 25, timeWindowMs: 10_000 });
    expect(config.apis[0].requestRewrite).toEqual({
      headers: { "content-type": "application/json" },
      body: {
        mode: "mergeJson",
        json: { key: "vendor-secret" }
      }
    });
    expect(config.apis[0].responseSanitizer).toEqual({
      removeJsonKeys: ["cost", "remain_money", "vendor_balance"]
    });
    expect(config.apis[0].bearer).toBe("service-token");
    expect(config.apis[0].headers).toEqual({ "x-api-key": "service-key" });
    expect(config.apis[0].routes[0].path).toBe("/v1/live/*");
    expect(config.apis[0].routes[0].requestPrice).toBe(2500n);
    expect(config.apis[0].routes[0].bearer).toBe("live-token");
    expect(config.apis[0].routes[0].headers).toEqual({ "x-api-key": "live-key" });
    expect(config.apis[0].routes[1].methods).toEqual(["GET"]);

    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects the legacy API list field", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-legacy-api-list-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        ["traditional" + "Apis"]: [{
          id: "fx",
          upstreamBaseUrl: "https://demo-fx.example",
          pricing: { request: "0.0005" }
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;

    expect(() => loadConfig()).toThrow(/top-level "apis"/);

    rmSync(directory, { recursive: true, force: true });
  });

  it("loads friendly decimal request pricing for traditional APIs", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-traditional-friendly-pricing-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        apis: [{
          id: "weather",
          upstreamBaseUrl: "https://weather.example",
          pricing: { request: "0.001" },
          routes: [
            { id: "forecast", path: "/v1/forecast/*", pricing: { request: "0.0025" } }
          ]
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;

    const config = loadConfig();
    expect(config.apis[0].requestPrice).toBe(1_000n);
    expect(config.apis[0].routes[0].requestPrice).toBe(2_500n);
    expect(config.apis[0].methods).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE"]);
    expect(config.apis[0].upstreamTimeoutMs).toBe(30_000);
    expect(config.apis[0].responseSanitizer).toEqual({ removeJsonKeys: ["cost", "remain_money"] });

    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects invalid traditional API response sanitizer configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-response-sanitizer-invalid-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        apis: [{
          id: "weather",
          upstreamBaseUrl: "https://weather.example",
          pricing: { request: "0.001" },
          responseSanitizer: { removeJsonKeys: ["cost", 123] }
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;

    expect(() => loadConfig()).toThrow(/responseSanitizer\.removeJsonKeys/);

    rmSync(directory, { recursive: true, force: true });
  });

  it("loads Cloudflare Worker response sanitizer configuration", () => {
    const config = loadCloudflareWorkerConfig({
      MPP_SECRET_KEY: "worker-secret",
      PUBLIC_BASE_URL: "https://api.example.com",
      PAY_API_PROXY_CONFIG: JSON.stringify({
        apis: [{
          id: "weather",
          upstreamBaseUrl: "https://weather.example",
          pricing: { request: "0.001" },
          responseSanitizer: { removeJsonKeys: ["cost", "remain_money", "quota"] }
        }]
      })
    });

    expect(config.apis[0].responseSanitizer).toEqual({
      removeJsonKeys: ["cost", "remain_money", "quota"]
    });
  });

  it("loads partial per-upstream rate limit configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-traditional-rate-limit-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        apis: [{
          id: "weather",
          upstreamBaseUrl: "https://weather.example",
          pricing: { request: "0.001" },
          rateLimit: { max: 12 }
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;

    const config = loadConfig();
    expect(config.apis[0].rateLimit).toEqual({ max: 12 });

    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects invalid and duplicate traditional API ids", () => {
    const invalidDirectory = mkdtempSync(join(tmpdir(), "pay-api-proxy-invalid-api-id-"));
    const invalidConfigPath = join(invalidDirectory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      invalidConfigPath,
      JSON.stringify({
        apis: [{
          id: "Bad Id",
          upstreamBaseUrl: "https://weather.example",
          pricing: { request: "0.001" }
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = invalidConfigPath;
    expect(() => loadConfig()).toThrow(/URL-safe lowercase slug/);
    rmSync(invalidDirectory, { recursive: true, force: true });

    const duplicateDirectory = mkdtempSync(join(tmpdir(), "pay-api-proxy-duplicate-api-id-"));
    const duplicateConfigPath = join(duplicateDirectory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      duplicateConfigPath,
      JSON.stringify({
        apis: [
          { id: "weather", upstreamBaseUrl: "https://weather.example", pricing: { request: "0.001" } },
          { id: "weather", upstreamBaseUrl: "https://weather-2.example", pricing: { request: "0.001" } }
        ]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = duplicateConfigPath;
    expect(() => loadConfig()).toThrow(/duplicate enabled id: weather/);
    rmSync(duplicateDirectory, { recursive: true, force: true });
  });

  it("rejects single-upstream env shortcuts when multiple traditional APIs are enabled", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-multi-env-shortcut-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        apis: [
          { id: "fx", upstreamBaseUrl: "https://fx.example", pricing: { request: "0.001" } },
          { id: "weather", upstreamBaseUrl: "https://weather.example", pricing: { request: "0.001" } }
        ]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;
    process.env.ROUTE_PRICES = "GET:/v1/quote=0.0005";

    expect(() => loadConfig()).toThrow(/Multiple enabled APIs require per-API JSONC/);

    rmSync(directory, { recursive: true, force: true });
  });

  it("uses UPSTREAM_BASE_URL for traditional API upstream when set in env", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-traditional-env-upstream-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        apis: [{
          id: "weather",
          upstreamBaseUrl: "https://weather.example",
          pricing: { request: "0.001" }
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;
    process.env.UPSTREAM_BASE_URL = "http://host.docker.internal:8000";

    const config = loadConfig();
    expect(config.apis[0].upstreamBaseUrl).toBe("http://host.docker.internal:8000");

    rmSync(directory, { recursive: true, force: true });
  });

  it("maps localhost upstream URLs to the Docker host gateway in Docker runtime", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-traditional-localhost-upstream-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        apis: [{
          id: "weather",
          upstreamBaseUrl: "https://weather.example",
          pricing: { request: "0.001" }
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;
    process.env.PAY_API_PROXY_DOCKER_RUNTIME = "1";
    process.env.UPSTREAM_BASE_URL = "http://localhost:8000";

    const config = loadConfig();
    expect(config.apis[0].upstreamBaseUrl).toBe("http://host.docker.internal:8000");

    rmSync(directory, { recursive: true, force: true });
  });

  it("uses UPSTREAM_BEARER_TOKEN for traditional API bearer auth when config omits bearer", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-traditional-env-bearer-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        apis: [{
          id: "weather",
          upstreamBaseUrl: "https://weather.example",
          pricing: { request: "0.001" }
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;
    process.env.UPSTREAM_BEARER_TOKEN = "env-upstream-token";

    const config = loadConfig();
    expect(config.apis[0].bearer).toBe("env-upstream-token");

    rmSync(directory, { recursive: true, force: true });
  });

  it("uses upstream header env vars for traditional API header auth when config omits headers", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-traditional-env-header-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        apis: [{
          id: "weather",
          upstreamBaseUrl: "https://weather.example",
          pricing: { request: "0.001" }
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;
    process.env.UPSTREAM_AUTH_HEADER = "x-api-key";
    process.env.UPSTREAM_AUTH_HEADER_VALUE = "env-upstream-key";

    const config = loadConfig();
    expect(config.apis[0].headers).toEqual({ "x-api-key": "env-upstream-key" });

    rmSync(directory, { recursive: true, force: true });
  });

  it("uses DEFAULT_REQUEST_PRICE for traditional API default pricing", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-traditional-env-price-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        apis: [{
          id: "weather",
          upstreamBaseUrl: "https://weather.example",
          pricing: { request: "0.001" }
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;
    process.env.DEFAULT_REQUEST_PRICE = "0.0025";

    const config = loadConfig();
    expect(config.apis[0].requestPrice).toBe(2_500n);

    rmSync(directory, { recursive: true, force: true });
  });

  it("uses ROUTE_PRICES env JSON for generated route pricing", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-traditional-env-routes-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        apis: [{
          id: "weather",
          upstreamBaseUrl: "https://weather.example",
          pricing: { request: "0.001" },
          routes: [
            { id: "old", path: "/old", pricing: { request: "0.001" } }
          ]
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;
    process.env.ROUTE_PRICES = JSON.stringify([
      { id: "forecast", path: "/v1/forecast/{city}", methods: ["GET"], pricing: { request: "0.0025" } },
      { id: "search", path: "/v1/search", methods: ["POST"], pricing: { request: "0.003" } }
    ]);
    process.env.ROUTE_ALLOWLIST = "true";
    process.env.OPENAPI_DOCUMENT_URL = "http://localhost:8000/openapi.json";
    process.env.OPENAPI_DOCUMENT_PATH = "/srv/openapi.json";

    const config = loadConfig();
    expect(config.apis[0].routes).toHaveLength(2);
    expect(config.apis[0].routes[0]).toMatchObject({
      id: "forecast",
      path: "/v1/forecast/{city}",
      methods: ["GET"]
    });
    expect(config.apis[0].routes[0].requestPrice).toBe(2_500n);
    expect(config.apis[0].routes[1].requestPrice).toBe(3_000n);
    expect(config.apis[0].allowUnmatchedRoutes).toBe(false);
    expect(config.apis[0].openApiDocumentUrl).toBe("http://localhost:8000/openapi.json");
    expect(config.apis[0].openApiDocumentPath).toBe("/srv/openapi.json");

    rmSync(directory, { recursive: true, force: true });
  });

  it("reads legacy TRADITIONAL_* env names for route pricing and OpenAPI settings", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-traditional-legacy-env-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        apis: [{
          id: "weather",
          upstreamBaseUrl: "https://weather.example",
          pricing: { request: "0.001" }
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;
    process.env.TRADITIONAL_API_ROUTES = "GET:/v1/quote=0.0005";
    process.env.TRADITIONAL_API_ROUTES_ONLY = "true";
    process.env.TRADITIONAL_OPENAPI_DOCUMENT_URL = "http://localhost:8000/openapi.json";
    process.env.TRADITIONAL_OPENAPI_DOCUMENT_PATH = "/srv/openapi.json";

    const config = loadConfig();
    expect(config.apis[0].routes).toHaveLength(1);
    expect(config.apis[0].allowUnmatchedRoutes).toBe(false);
    expect(config.apis[0].openApiDocumentUrl).toBe("http://localhost:8000/openapi.json");
    expect(config.apis[0].openApiDocumentPath).toBe("/srv/openapi.json");

    rmSync(directory, { recursive: true, force: true });
  });

  it("reads OPENAPI_DOCUMENT_URL for OpenAPI discovery", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-openapi-url-alias-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        apis: [{
          id: "weather",
          upstreamBaseUrl: "https://weather.example",
          pricing: { request: "0.001" }
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;
    process.env.OPENAPI_DOCUMENT_URL = "http://host.docker.internal:8000/openapi.json";
    delete process.env.TRADITIONAL_OPENAPI_DOCUMENT_URL;

    const config = loadConfig();
    expect(config.apis[0].openApiDocumentUrl).toBe("http://host.docker.internal:8000/openapi.json");

    rmSync(directory, { recursive: true, force: true });
  });

  it("uses compact ROUTE_PRICES env format", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-traditional-env-routes-compact-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        apis: [{
          id: "weather",
          upstreamBaseUrl: "https://weather.example",
          pricing: { request: "0.001" }
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;
    process.env.ROUTE_PRICES = "GET:/v1/quote=0.0005,POST:/v1/search=0.003";
    process.env.ROUTE_ALLOWLIST = "true";

    const config = loadConfig();
    expect(config.apis[0].routes).toHaveLength(2);
    expect(config.apis[0].routes[0]).toMatchObject({
      path: "/v1/quote",
      methods: ["GET"]
    });
    expect(config.apis[0].routes[0].requestPrice).toBe(500n);
    expect(config.apis[0].routes[1].requestPrice).toBe(3_000n);

    rmSync(directory, { recursive: true, force: true });
  });

  it("loads compact ROUTE_PRICES with a zero-price free route", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-route-prices-free-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        apis: [{
          id: "deepl",
          upstreamBaseUrl: "https://deepl.example",
          pricing: { request: "0.001" }
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;
    process.env.ROUTE_PRICES =
      "POST:/deepl/languages=0.001,POST:/deepl/rephrase=0,POST:/deepl/translate=0.0005";
    process.env.ROUTE_ALLOWLIST = "true";

    const config = loadConfig();
    expect(config.apis[0].routes).toHaveLength(3);
    expect(config.apis[0].routes[1]).toMatchObject({
      path: "/deepl/rephrase",
      methods: ["POST"]
    });
    expect(config.apis[0].routes[1].requestPrice).toBe(0n);

    rmSync(directory, { recursive: true, force: true });
  });

  it("disables catch-all pricing by default when ROUTE_PRICES is configured", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-route-prices-allowlist-default-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        apis: [{
          id: "deepl",
          upstreamBaseUrl: "https://deepl.example",
          pricing: { request: "0.001" }
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;
    process.env.ROUTE_PRICES =
      "POST:/deepl/languages=0.01,POST:/deepl/rephrase=0,POST:/deepl/translate=0.0005";
    delete process.env.ROUTE_ALLOWLIST;

    const config = loadConfig();
    expect(config.apis[0].routes).toHaveLength(3);
    expect(config.apis[0].allowUnmatchedRoutes).toBe(false);
    expect(config.apis[0].routes[2].requestPrice).toBe(500n);

    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects invalid ROUTE_PRICES JSON", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-traditional-env-routes-invalid-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        apis: [{
          id: "weather",
          upstreamBaseUrl: "https://weather.example",
          pricing: { request: "0.001" }
        }]
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;
    process.env.ROUTE_PRICES = "{";

    expect(() => loadConfig()).toThrow(/ROUTE_PRICES must be valid JSON/);

    rmSync(directory, { recursive: true, force: true });
  });

  it("loads non-secret settings from PAY_API_PROXY_CONFIG", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-file-config-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        port: 9090,
        paymentProvider: "tempo-testnet",
        upstreamProvider: "openai",
        publicBaseUrl: "https://paid.example.com",
        openaiEndpointWhitelist: ["models", "/v1/chat/completions"],
        tempo: {
          chainId: 42431,
          settlementAddress: "0x0000000000000000000000000000000000000001"
        }
      })
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;

    const config = loadConfig();
    expect(config.port).toBe(9090);
    expect(config.paymentProvider).toBe("tempo-testnet");
    expect(config.upstreamProvider).toBe("openai");
    expect(config.publicBaseUrl).toBe("https://paid.example.com");
    expect(config.openaiEndpointWhitelist).toEqual(["models", "chat_completions"]);
    expect(config.tempo.rpcUrl).toBe("https://rpc.moderato.tempo.xyz");
    expect(config.tempo.settlementAddress).toBe("0x0000000000000000000000000000000000000001");

    rmSync(directory, { recursive: true, force: true });
  });

  it("loads payment recipient address from env", () => {
    process.env.PAYMENT_RECIPIENT_ADDRESS = "0x1111111111111111111111111111111111111111";

    const config = loadConfig();
    expect(config.tempo.settlementAddress).toBe("0x1111111111111111111111111111111111111111");
  });

  it("loads payment recipient address from .env", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-env-config-"));
    writeFileSync(join(directory, ".env"), "PAYMENT_RECIPIENT_ADDRESS=0x3333333333333333333333333333333333333333\n");

    const currentDirectory = process.cwd();
    process.chdir(directory);
    try {
      delete process.env.PAY_API_PROXY_SKIP_DOTENV;
      delete process.env.PAYMENT_RECIPIENT_ADDRESS;
      const config = loadConfig();
      expect(config.tempo.settlementAddress).toBe("0x3333333333333333333333333333333333333333");
    } finally {
      process.chdir(currentDirectory);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps TEMPO_SETTLEMENT_ADDRESS as a compatibility fallback", () => {
    delete process.env.PAYMENT_RECIPIENT_ADDRESS;
    process.env.TEMPO_SETTLEMENT_ADDRESS = "0x2222222222222222222222222222222222222222";

    const config = loadConfig();
    expect(config.tempo.settlementAddress).toBe("0x2222222222222222222222222222222222222222");
  });

  it("loads Tempo mainnet mode when chain id is mainnet", () => {
    process.env.PAYMENT_PROVIDER = "tempo-mainnet";
    process.env.TEMPO_CHAIN_ID = "4217";

    const config = loadConfig();
    expect(config.paymentProvider).toBe("tempo-mainnet");
    expect(config.tempo.chainId).toBe(4217);
    expect(config.mppx.testnet).toBe(false);
  });

  it("rejects mismatched Tempo provider and chain id", () => {
    process.env.PAYMENT_PROVIDER = "tempo-mainnet";
    process.env.TEMPO_CHAIN_ID = "42431";

    expect(() => loadConfig()).toThrow(/tempo-mainnet requires/);
  });

  it("allows comments in PAY_API_PROXY_CONFIG", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-comment-config-"));
    const configPath = join(directory, "pay-api-proxy.config.jsonc");
    writeFileSync(
      configPath,
      `{
        // This URL must not be mistaken for a comment.
        "publicBaseUrl": "https://commented.example.com",
        "port": 9191,
        /*
         * Operators can keep notes in this file.
         */
        "tempo": {
          "rpcUrl": "https://rpc.example.com"
        }
      }`
    );

    process.env.PAY_API_PROXY_CONFIG = configPath;

    const config = loadConfig();
    expect(config.publicBaseUrl).toBe("https://commented.example.com");
    expect(config.port).toBe(9191);
    expect(config.tempo.rpcUrl).toBe("https://rpc.example.com");

    rmSync(directory, { recursive: true, force: true });
  });

  it("falls back to legacy paid-api-node.config.json filename", () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-legacy-config-"));
    const configPath = join(directory, "paid-api-node.config.json");
    writeFileSync(configPath, JSON.stringify({ port: 9292 }));

    const currentDirectory = process.cwd();
    process.chdir(directory);
    try {
      const config = loadConfig();
      expect(config.port).toBe(9292);
    } finally {
      process.chdir(currentDirectory);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("derives PUBLIC_BASE_URL from DOMAIN_NAME when unset", () => {
    delete process.env.PUBLIC_BASE_URL;
    process.env.DOMAIN_NAME = "api.example.com";

    const config = loadConfig();
    expect(config.publicBaseUrl).toBe("https://api.example.com");
  });

  it("derives local PUBLIC_BASE_URL from localhost DOMAIN_NAME", () => {
    delete process.env.PUBLIC_BASE_URL;
    process.env.DOMAIN_NAME = "localhost";

    const config = loadConfig();
    expect(config.publicBaseUrl).toBe("http://localhost");
  });

  it("keeps PUBLIC_HOST as a compatibility fallback", () => {
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.DOMAIN_NAME;
    process.env.PUBLIC_HOST = "api.example.com";

    const config = loadConfig();
    expect(config.publicBaseUrl).toBe("https://api.example.com");
  });

  it("keeps CADDY_SITE_ADDRESS as a compatibility fallback", () => {
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.DOMAIN_NAME;
    delete process.env.PUBLIC_HOST;
    process.env.CADDY_SITE_ADDRESS = "api.example.com";

    const config = loadConfig();
    expect(config.publicBaseUrl).toBe("https://api.example.com");
  });

  it("keeps explicit PUBLIC_BASE_URL override", () => {
    process.env.DOMAIN_NAME = "api.example.com";
    process.env.PUBLIC_BASE_URL = "https://proxy.example.net";

    const config = loadConfig();
    expect(config.publicBaseUrl).toBe("https://proxy.example.net");
  });

  it("enables all built-in models when MODELS is unset", () => {
    delete process.env.MODELS;

    const config = loadConfig();
    expect(config.models.length).toBeGreaterThan(1);
    expect(config.models.every((model) => model.enabled)).toBe(true);
    expect(config.models.map((model) => model.modelName)).toContain("gpt-4o-mini");
    expect(config.models.map((model) => model.modelName)).toContain("gpt-image-1");
  });

  it("enables the default OpenAI-compatible endpoints when OPENAI_ENDPOINT_WHITELIST is unset", () => {
    delete process.env.OPENAI_ENDPOINT_WHITELIST;

    const config = loadConfig();
    expect(config.openaiEndpointWhitelist).toEqual(["models", "chat_completions", "images"]);
  });

  it("loads OpenAI-compatible endpoint whitelist from env", () => {
    process.env.OPENAI_ENDPOINT_WHITELIST = "models,/v1/chat/completions";

    const config = loadConfig();
    expect(config.openaiEndpointWhitelist).toEqual(["models", "chat_completions"]);
  });

  it("rejects unknown OpenAI-compatible endpoint whitelist entries", () => {
    process.env.OPENAI_ENDPOINT_WHITELIST = "models,embeddings";

    expect(() => loadConfig()).toThrow(/OPENAI_ENDPOINT_WHITELIST/);
  });

  it("enables directory publishing by default unless explicitly disabled", () => {
    const enabled = loadWorkerConfig();
    expect(enabled.directoryPublish.enabled).toBe(true);

    process.env.XPAYAPI_PUBLISH_ENABLED = "false";
    const disabled = loadWorkerConfig();
    expect(disabled.directoryPublish.enabled).toBe(false);
  });
});
