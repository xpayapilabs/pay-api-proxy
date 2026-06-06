import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Credential } from "mppx";
import { Mppx, tempo } from "mppx/client";
import { buildApp } from "../../src/api/app.js";
import { testConfig } from "../../src/core/config.js";
import { openDatabase } from "../../src/db/database.js";
import { Repository } from "../../src/db/repository.js";
import { TestPaymentProvider } from "../helpers/test-payment-provider.js";
import { encodePaymentCredential } from "../../src/payments/credential.js";
import { TestAiProvider } from "../helpers/test-ai-provider.js";
import type { AiProvider } from "../../src/providers/types.js";
import { loadLocalPaidApiFixture } from "../helpers/local-paid-api-fixture.js";

function buildHarness(overrides: Parameters<typeof testConfig>[0] = {}, aiProvider: AiProvider = new TestAiProvider()) {
  const config = testConfig(overrides);
  const database = openDatabase(":memory:");
  const repository = new Repository(database.db);
  const paymentProvider = new TestPaymentProvider(config);
  const app = buildApp({
    config,
    repository,
    paymentProvider,
    aiProvider
  });

  return {
    app,
    config,
    database,
    repository,
    paymentProvider,
    async close() {
      await app.close();
      database.close();
    }
  };
}

const sampleBody = {
  model: "test-chat",
  messages: [{ role: "user", content: "hello paid api" }],
  max_tokens: 64
};

async function startTraditionalUpstream(label = "upstream"): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: true,
        upstream: label,
        method: request.method,
        url: request.url,
        body: body ? JSON.parse(body) : undefined
      }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test upstream did not bind to a TCP port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

async function startJsonUpstream(body: unknown): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test upstream did not bind to a TCP port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

async function startOpenApiDocumentServer(document: Record<string, unknown>): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.setHeader("cache-control", "public, max-age=60");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(document));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test OpenAPI server did not bind to a TCP port");

  return {
    url: `http://127.0.0.1:${address.port}/openapi.json`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

describe("API integration", () => {
  it("rejects chat completions without x-mpp-session-id with session_required", async () => {
    const harness = buildHarness();

    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: sampleBody
    });

    expect(response.statusCode).toBe(402);
    expect(response.json().error.code).toBe("session_required");
    expect(response.json().payment_session.create_endpoint).toBe("/v1/payment-sessions");
    expect(response.headers.link).toContain("/v1/payment-sessions");
    expect(response.headers.link).toContain('rel="payment-session-init"');
    expect(response.headers["www-authenticate"]).toBeUndefined();

    await harness.close();
  });

  it("supports fixed per-request charging via session reservation", async () => {
    const harness = buildHarness({
      chargingMethod: "per-request",
      models: [{
        ...testConfig().models[0],
        requestPrice: 2345n
      }]
    });
    const sessionPayload = {
      customer_id: "cust_per_request",
      authorized_max_amount: "100000",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      allowed_models: ["test-chat"]
    };

    const unpaidSession = await harness.app.inject({
      method: "POST",
      url: "/v1/payment-sessions",
      payload: sessionPayload
    });
    const payment = unpaidSession.json().payment;
    const paidSession = await harness.app.inject({
      method: "POST",
      url: "/v1/payment-sessions",
      headers: {
        "x-payment": encodePaymentCredential({
          type: "transaction",
          value: "per-request-session-funding",
          amount: payment.amount,
          chainId: payment.chainId,
          assetAddress: payment.assetAddress,
          recipient: payment.settlementAddress,
          memo: payment.memo
        })
      },
      payload: sessionPayload
    });
    const session = paidSession.json().session;

    const paid = await harness.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "x-customer-id": "cust_per_request",
        "x-mpp-session-id": session.id,
        "x-paid-request-id": "req_per_request_chat"
      },
      payload: sampleBody
    });
    expect(paid.statusCode).toBe(200);

    const record = harness.repository.getRequest("req_per_request_chat");
    expect(record).toBeDefined();
    expect(record!.inputTokensEstimate).toBe(0);
    expect(record!.maxOutputTokens).toBe(0);
    expect(record!.maxCharge).toBe("2345");
    expect(record!.actualInputTokens ?? 0).toBeGreaterThan(0);
    expect(record!.actualUsageAmount).toBe("2345");

    await harness.close();
  });

  it("protects a traditional API with mppx per-request charging", async () => {
    const upstream = await startTraditionalUpstream();
    const harness = buildHarness({
      upstreamProvider: "http",
      apis: [{
        id: "fx",
        upstreamBaseUrl: upstream.baseUrl,
        enabled: true,
        methods: ["GET", "POST"],
        requestPrice: 500n,
        routes: [],
        forwardedHeaders: ["accept", "content-type"],
        upstreamTimeoutMs: 30_000,
        assetSymbol: "pathUSD",
        assetAddress: "0x20c0000000000000000000000000000000000000",
        chainId: 42431
      }]
    });

    const unpaid = await harness.app.inject({
      method: "POST",
      url: "/v1/quote?pair=EURUSD",
      payload: { pair: "EURUSD" }
    });

    expect(unpaid.statusCode).toBe(402);
    expect(unpaid.headers["www-authenticate"]).toContain("Payment ");
    expect(String(unpaid.headers["www-authenticate"])).toContain("intent=\"charge\"");

    const unpaidModelsPath = await harness.app.inject({
      method: "GET",
      url: "/v1/models"
    });
    expect(unpaidModelsPath.statusCode).toBe(402);
    expect(unpaidModelsPath.headers["www-authenticate"]).toContain("Payment ");

    const unpaidOpenAiShapedPath = await harness.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: sampleBody
    });
    expect(unpaidOpenAiShapedPath.statusCode).toBe(402);
    expect(unpaidOpenAiShapedPath.headers["www-authenticate"]).toContain("Payment ");

    const openapi = await harness.app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json().paths["/*"].post["x-payment-info"].offers[0]).toMatchObject({
      amount: "500",
      currency: "0x20c0000000000000000000000000000000000000",
      intent: "charge",
      method: "tempo"
    });

    await harness.close();
    await upstream.close();
  });

  it("exposes refund-grade paid call audits through the admin endpoint", async () => {
    const paidApi = loadLocalPaidApiFixture();
    const harness = buildHarness({
      upstreamProvider: "http",
      apis: [{
        id: paidApi.apiId,
        upstreamBaseUrl: paidApi.upstreamBaseUrl,
        enabled: true,
        methods: [paidApi.method],
        requestPrice: paidApi.defaultRequestPrice,
        routes: [
          {
            id: paidApi.routeId,
            path: paidApi.routePath,
            methods: [paidApi.method],
            requestPrice: paidApi.routeRequestPrice
          }
        ],
        forwardedHeaders: ["content-type"],
        upstreamTimeoutMs: 30_000,
        assetSymbol: paidApi.assetSymbol,
        assetAddress: paidApi.assetAddress,
        chainId: paidApi.chainId
      }]
    });
    harness.repository.recordPaidCallAudit({
      id: "audit_refund_candidate",
      createdAt: "2026-06-06T12:00:00.000Z",
      completedAt: "2026-06-06T12:00:00.430Z",
      apiId: paidApi.apiId,
      routeId: paidApi.routeId,
      method: paidApi.method,
      path: paidApi.routePath,
      upstreamPath: paidApi.routePath,
      status: 500,
      paid: true,
      paymentVerified: true,
      receiptAttached: false,
      paymentMethod: "tempo",
      paymentReference: `0x${"3".repeat(64)}`,
      externalId: paidApi.externalId,
      receiptTimestamp: "2026-06-06T11:59:59.000Z",
      paymentVerifiedAt: "2026-06-06T11:59:59.500Z",
      requestPrice: paidApi.routeRequestPriceText,
      assetSymbol: paidApi.assetSymbol,
      assetAddress: paidApi.assetAddress,
      assetDecimals: paidApi.assetDecimals,
      chainId: paidApi.chainId,
      refundStatus: "pending",
      refundReason: "paid_response_500",
      durationMs: 430
    });

    const unauthorized = await harness.app.inject({ method: "GET", url: "/admin/calls" });
    expect(unauthorized.statusCode).toBe(401);

    const pending = await harness.app.inject({
      method: "GET",
      url: "/admin/calls?refundStatus=pending",
      headers: { authorization: `Bearer ${harness.config.mppx.secretKey}` }
    });

    expect(pending.statusCode).toBe(200);
    expect(pending.json().calls).toEqual([
      expect.objectContaining({
        id: "audit_refund_candidate",
        apiId: paidApi.apiId,
        routeId: paidApi.routeId,
        status: 500,
        paid: true,
        paymentVerified: true,
        receiptAttached: false,
        paymentReference: `0x${"3".repeat(64)}`,
        requestPrice: paidApi.routeRequestPriceText,
        refundStatus: "pending",
        refundReason: "paid_response_500"
      })
    ]);

    const updated = await harness.app.inject({
      method: "PATCH",
      url: "/admin/calls/audit_refund_candidate/refund",
      headers: { authorization: `Bearer ${harness.config.mppx.secretKey}` },
      payload: {
        refundStatus: "refunded",
        refundReference: `0x${"4".repeat(64)}`,
        refundReason: "manual_refund_sent",
        refundNote: "Refunded after upstream 500."
      }
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().call).toMatchObject({
      id: "audit_refund_candidate",
      refundStatus: "refunded",
      refundReference: `0x${"4".repeat(64)}`,
      refundReason: "manual_refund_sent",
      refundNote: "Refunded after upstream 500."
    });
    expect(updated.json().call.refundedAt).toEqual(expect.any(String));

    const noPending = await harness.app.inject({
      method: "GET",
      url: "/admin/calls?refundStatus=pending",
      headers: { authorization: `Bearer ${harness.config.mppx.secretKey}` }
    });
    expect(noPending.statusCode).toBe(200);
    expect(noPending.json().calls).toEqual([]);

    await harness.close();
  });

  it("applies upstream-level request rewrite to every traditional API route", async () => {
    const upstream = await startTraditionalUpstream();
    const harness = buildHarness({
      upstreamProvider: "http",
      apis: [{
        id: "verify",
        upstreamBaseUrl: upstream.baseUrl,
        enabled: true,
        methods: ["POST"],
        requestPrice: 0n,
        routes: [
          { id: "verify-code", path: "/v1/verify", methods: ["POST"], requestPrice: 0n },
          { id: "resend-code", path: "/v1/resend", methods: ["POST"], requestPrice: 0n }
        ],
        allowUnmatchedRoutes: false,
        forwardedHeaders: ["content-type"],
        upstreamTimeoutMs: 30_000,
        requestRewrite: {
          headers: { "content-type": "application/json" },
          body: {
            mode: "mergeJson",
            json: { key: "vendor-key" }
          }
        },
        assetSymbol: "pathUSD",
        assetAddress: "0x20c0000000000000000000000000000000000000",
        chainId: 42431
      }]
    });

    const verify = await harness.app.inject({
      method: "POST",
      url: "/v1/verify",
      payload: { verifycode: "123456" }
    });
    const resend = await harness.app.inject({
      method: "POST",
      url: "/v1/resend",
      payload: { verifycode: "654321" }
    });

    expect(verify.statusCode).toBe(200);
    expect(verify.json().body).toEqual({ key: "vendor-key", verifycode: "123456" });
    expect(resend.statusCode).toBe(200);
    expect(resend.json().body).toEqual({ key: "vendor-key", verifycode: "654321" });

    await harness.close();
    await upstream.close();
  });

  it("sanitizes configured keys from upstream JSON responses", async () => {
    const upstream = await startJsonUpstream({
      ok: true,
      cost: 1,
      remain_money: 2,
      vendor_balance: 3,
      nested: {
        cost: 4,
        value: "kept"
      }
    });
    const harness = buildHarness({
      upstreamProvider: "http",
      apis: [{
        id: "metrics",
        upstreamBaseUrl: upstream.baseUrl,
        enabled: true,
        methods: ["GET"],
        requestPrice: 0n,
        routes: [{ id: "snapshot", path: "/v1/snapshot", methods: ["GET"], requestPrice: 0n }],
        allowUnmatchedRoutes: false,
        forwardedHeaders: ["accept"],
        upstreamTimeoutMs: 30_000,
        responseSanitizer: { removeJsonKeys: ["cost", "remain_money", "vendor_balance"] },
        assetSymbol: "pathUSD",
        assetAddress: "0x20c0000000000000000000000000000000000000",
        chainId: 42431
      }]
    });

    const response = await harness.app.inject({ method: "GET", url: "/v1/snapshot" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({
      ok: true,
      nested: {
        value: "kept"
      }
    });

    await harness.close();
    await upstream.close();
  });

  it("charges route-specific prices for a traditional API", async () => {
    const upstream = await startTraditionalUpstream();
    const harness = buildHarness({
      upstreamProvider: "http",
      apis: [{
        id: "fx",
        upstreamBaseUrl: upstream.baseUrl,
        enabled: true,
        methods: ["GET", "POST"],
        requestPrice: 500n,
        routes: [
          { id: "live", path: "/v1/live/*", methods: ["GET"], requestPrice: 2500n },
          { id: "status", path: "/v1/status", methods: ["GET"], requestPrice: 100n }
        ],
        forwardedHeaders: ["accept", "content-type"],
        upstreamTimeoutMs: 30_000,
        assetSymbol: "pathUSD",
        assetAddress: "0x20c0000000000000000000000000000000000000",
        chainId: 42431
      }]
    });

    const pricing = await harness.app.inject({ method: "GET", url: "/pricing" });
    expect(pricing.statusCode).toBe(200);
    expect(pricing.json().apis[0].path_prefix).toBe("/");
    expect(pricing.json().apis[0].routes).toEqual([
      { id: "live", path: "/v1/live/*", methods: ["GET"], request_price: "2500", request_price_decimal: "0.0025" },
      { id: "status", path: "/v1/status", methods: ["GET"], request_price: "100", request_price_decimal: "0.0001" }
    ]);

    const unpaidLive = await harness.app.inject({
      method: "GET",
      url: "/v1/live/EURUSD"
    });
    expect(unpaidLive.statusCode).toBe(402);
    expect(unpaidLive.headers["www-authenticate"]).toContain("Payment ");

    const openapi = await harness.app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json().paths["/v1/live/*"].get["x-payment-info"].offers[0].amount).toBe("2500");

    const unpaidFallback = await harness.app.inject({
      method: "POST",
      url: "/v1/quote",
      payload: { pair: "EURUSD" }
    });
    expect(unpaidFallback.statusCode).toBe(402);
    expect(unpaidFallback.headers["www-authenticate"]).toContain("Payment ");
    expect(openapi.json().paths["/*"].post["x-payment-info"].offers[0].amount).toBe("500");

    await harness.close();
    await upstream.close();
  });

  it("proxies zero-price traditional API routes without payment", async () => {
    const upstream = await startTraditionalUpstream();
    const harness = buildHarness({
      upstreamProvider: "http",
      apis: [{
        id: "deepl",
        upstreamBaseUrl: upstream.baseUrl,
        enabled: true,
        methods: ["POST"],
        requestPrice: 500n,
        allowUnmatchedRoutes: false,
        routes: [
          { id: "languages", path: "/deepl/languages", methods: ["POST"], requestPrice: 1_000n },
          { id: "rephrase", path: "/deepl/rephrase", methods: ["POST"], requestPrice: 0n },
          { id: "translate", path: "/deepl/translate", methods: ["POST"], requestPrice: 500n }
        ],
        forwardedHeaders: ["accept", "content-type"],
        upstreamTimeoutMs: 30_000,
        assetSymbol: "pathUSD",
        assetAddress: "0x20c0000000000000000000000000000000000000",
        chainId: 42431
      }]
    });

    const free = await harness.app.inject({
      method: "POST",
      url: "/deepl/rephrase",
      payload: { text: "hello" }
    });
    expect(free.statusCode).toBe(200);
    expect(free.json()).toMatchObject({
      ok: true,
      method: "POST",
      url: "/deepl/rephrase"
    });

    const paid = await harness.app.inject({
      method: "POST",
      url: "/deepl/translate",
      payload: { text: "hello" }
    });
    expect(paid.statusCode).toBe(402);
    expect(paid.headers["www-authenticate"]).toContain("Payment ");

    const openapi = await harness.app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json().paths["/deepl/rephrase"].post["x-payment-info"]).toBeUndefined();
    expect(openapi.json().paths["/deepl/translate"].post["x-payment-info"].offers[0].amount).toBe("500");

    const pricing = await harness.app.inject({ method: "GET", url: "/pricing" });
    expect(pricing.json().apis[0].routes.find((route: { id: string }) => route.id === "rephrase")).toMatchObject({
      request_price: "0"
    });

    await harness.close();
    await upstream.close();
  });

  it("supports OpenAPI path templates as allowlisted traditional API routes", async () => {
    const upstream = await startTraditionalUpstream();
    const harness = buildHarness({
      upstreamProvider: "http",
      apis: [{
        id: "users",
        upstreamBaseUrl: upstream.baseUrl,
        enabled: true,
        methods: ["GET", "POST"],
        requestPrice: 500n,
        routes: [
          { id: "user_by_id", path: "/v1/users/{id}", methods: ["GET"], requestPrice: 2500n },
          { id: "user_me", path: "/v1/users/me", methods: ["GET"], requestPrice: 100n }
        ],
        allowUnmatchedRoutes: false,
        forwardedHeaders: ["accept", "content-type"],
        upstreamTimeoutMs: 30_000,
        assetSymbol: "pathUSD",
        assetAddress: "0x20c0000000000000000000000000000000000000",
        chainId: 42431
      }]
    });

    const unpaidTemplate = await harness.app.inject({
      method: "GET",
      url: "/v1/users/123"
    });
    expect(unpaidTemplate.statusCode).toBe(402);
    expect(unpaidTemplate.headers["www-authenticate"]).toContain("Payment ");

    const unpaidExact = await harness.app.inject({
      method: "GET",
      url: "/v1/users/me"
    });
    expect(unpaidExact.statusCode).toBe(402);
    expect(String(unpaidExact.headers["www-authenticate"])).toContain("description=\"users:user_me\"");

    const unmatched = await harness.app.inject({
      method: "POST",
      url: "/v1/users",
      payload: { name: "Ada" }
    });
    expect(unmatched.statusCode).toBe(404);

    const openapi = await harness.app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json().paths["/v1/users/{id}"].get["x-payment-info"].offers[0].amount).toBe("2500");
    expect(openapi.json().paths["/v1/users/me"].get["x-payment-info"].offers[0].amount).toBe("100");
    expect(openapi.json().paths["/*"]).toBeUndefined();

    await harness.close();
    await upstream.close();
  });

  it("injects route payment info into a configured OpenAPI document", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-openapi-doc-"));
    const documentPath = join(directory, "openapi.json");
    writeFileSync(
      documentPath,
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Weather API", version: "1.0.0" },
        servers: [{ url: "https://old.example" }],
        paths: {
          "/v1/forecast/{city}": {
            get: {
              operationId: "forecast",
              summary: "Forecast by city",
              responses: { "200": { description: "OK" } }
            }
          }
        }
      })
    );
    const upstream = await startTraditionalUpstream();
    const harness = buildHarness({
      upstreamProvider: "http",
      apis: [{
        id: "weather",
        upstreamBaseUrl: upstream.baseUrl,
        enabled: true,
        methods: ["GET"],
        requestPrice: 500n,
        routes: [
          { id: "forecast", path: "/v1/forecast/{city}", methods: ["GET"], requestPrice: 2500n }
        ],
        allowUnmatchedRoutes: false,
        openApiDocumentPath: documentPath,
        forwardedHeaders: ["accept", "content-type"],
        upstreamTimeoutMs: 30_000,
        assetSymbol: "pathUSD",
        assetAddress: "0x20c0000000000000000000000000000000000000",
        chainId: 42431
      }]
    });

    const openapi = await harness.app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.statusCode).toBe(200);
    const document = openapi.json();
    expect(document.info.title).toBe("Weather API");
    expect(document.servers).toEqual([{ url: harness.config.publicBaseUrl }]);
    expect(document.paths["/v1/forecast/{city}"].get.summary).toBe("Forecast by city");
    expect(document.paths["/v1/forecast/{city}"].get.responses["402"]).toEqual({ description: "Payment required" });
    expect(document.paths["/v1/forecast/{city}"].get["x-payment-info"].offers[0]).toMatchObject({
      amount: "2500",
      currency: "0x20c0000000000000000000000000000000000000",
      intent: "charge",
      method: "tempo"
    });

    await harness.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("injects default payment info into an OpenAPI document when no routes are configured", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-openapi-default-doc-"));
    const documentPath = join(directory, "openapi.json");
    writeFileSync(
      documentPath,
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Quotes API", version: "1.0.0" },
        paths: {
          "/v1/quote": {
            get: {
              summary: "Get quote",
              responses: { "200": { description: "OK" } }
            }
          }
        }
      })
    );
    const upstream = await startTraditionalUpstream();
    const harness = buildHarness({
      upstreamProvider: "http",
      apis: [{
        id: "quotes",
        upstreamBaseUrl: upstream.baseUrl,
        enabled: true,
        methods: ["GET"],
        requestPrice: 500n,
        routes: [],
        openApiDocumentPath: documentPath,
        forwardedHeaders: ["accept", "content-type"],
        upstreamTimeoutMs: 30_000,
        assetSymbol: "pathUSD",
        assetAddress: "0x20c0000000000000000000000000000000000000",
        chainId: 42431
      }]
    });

    const openapi = await harness.app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json().paths["/v1/quote"].get["x-payment-info"].offers[0]).toMatchObject({
      amount: "500",
      description: "quotes",
      intent: "charge",
      method: "tempo"
    });

    await harness.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("loads an OpenAPI document from a URL and injects payment info", async () => {
    const upstream = await startTraditionalUpstream();
    const openApiServer = await startOpenApiDocumentServer({
      openapi: "3.0.3",
      info: { title: "Remote Docs", version: "1.0.0" },
      paths: {
        "/v1/quote": {
          get: {
            summary: "Get quote",
            responses: { "200": { description: "OK" } }
          }
        }
      }
    });
    const harness = buildHarness({
      upstreamProvider: "http",
      apis: [{
        id: "quotes",
        upstreamBaseUrl: upstream.baseUrl,
        enabled: true,
        methods: ["GET"],
        requestPrice: 500n,
        routes: [],
        openApiDocumentUrl: openApiServer.url,
        forwardedHeaders: ["accept", "content-type"],
        upstreamTimeoutMs: 30_000,
        assetSymbol: "pathUSD",
        assetAddress: "0x20c0000000000000000000000000000000000000",
        chainId: 42431
      }]
    });

    const openapi = await harness.app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.headers["cache-control"]).toBe("public, max-age=60");
    expect(openapi.json().info.title).toBe("Remote Docs");
    expect(openapi.json().paths["/v1/quote"].get["x-payment-info"].offers[0].amount).toBe("500");

    await harness.close();
    await upstream.close();
    await openApiServer.close();
  });

  it("prefers an OpenAPI document URL over a local path when both are configured", async () => {
    const upstream = await startTraditionalUpstream();
    const directory = mkdtempSync(join(tmpdir(), "pay-api-proxy-openapi-path-"));
    const documentPath = join(directory, "openapi.json");
    writeFileSync(
      documentPath,
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Local Docs", version: "1.0.0" },
        paths: {
          "/v1/local": {
            get: { summary: "Local", responses: { "200": { description: "OK" } } }
          }
        }
      })
    );
    const openApiServer = await startOpenApiDocumentServer({
      openapi: "3.0.3",
      info: { title: "Remote Docs", version: "1.0.0" },
      paths: {
        "/v1/quote": {
          get: {
            summary: "Get quote",
            responses: { "200": { description: "OK" } }
          }
        }
      }
    });
    const harness = buildHarness({
      upstreamProvider: "http",
      apis: [{
        id: "quotes",
        upstreamBaseUrl: upstream.baseUrl,
        enabled: true,
        methods: ["GET"],
        requestPrice: 500n,
        routes: [],
        openApiDocumentPath: documentPath,
        openApiDocumentUrl: openApiServer.url,
        forwardedHeaders: ["accept", "content-type"],
        upstreamTimeoutMs: 30_000,
        assetSymbol: "pathUSD",
        assetAddress: "0x20c0000000000000000000000000000000000000",
        chainId: 42431
      }]
    });

    const openapi = await harness.app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json().info.title).toBe("Remote Docs");

    await harness.close();
    await upstream.close();
    await openApiServer.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("supports multiple traditional APIs under /api/{id} prefixes", async () => {
    const fxUpstream = await startTraditionalUpstream("fx");
    const weatherUpstream = await startTraditionalUpstream("weather");
    const harness = buildHarness({
      upstreamProvider: "http",
      apis: [
        {
          id: "fx",
          upstreamBaseUrl: fxUpstream.baseUrl,
          enabled: true,
          methods: ["GET"],
          requestPrice: 500n,
          routes: [
            { id: "free", path: "/v1/free", methods: ["GET"], requestPrice: 0n },
            { id: "quote", path: "/v1/quote", methods: ["GET"], requestPrice: 500n }
          ],
          rateLimit: { max: 3, timeWindowMs: 60_000 },
          assetSymbol: "pathUSD",
          assetAddress: "0x20c0000000000000000000000000000000000000",
          chainId: 42431,
          forwardedHeaders: ["accept"],
          upstreamTimeoutMs: 30_000
        },
        {
          id: "weather",
          upstreamBaseUrl: weatherUpstream.baseUrl,
          enabled: true,
          methods: ["GET"],
          requestPrice: 500n,
          routes: [
            { id: "free", path: "/v1/free", methods: ["GET"], requestPrice: 0n },
            { id: "forecast", path: "/v1/forecast", methods: ["GET"], requestPrice: 700n }
          ],
          rateLimit: { max: 5 },
          assetSymbol: "pathUSD",
          assetAddress: "0x20c0000000000000000000000000000000000000",
          chainId: 42431,
          forwardedHeaders: ["accept"],
          upstreamTimeoutMs: 30_000
        }
      ]
    });

    const fxFree = await harness.app.inject({ method: "GET", url: "/api/fx/v1/free" });
    expect(fxFree.statusCode).toBe(200);
    expect(fxFree.json()).toMatchObject({ upstream: "fx", url: "/v1/free" });

    const weatherFree = await harness.app.inject({ method: "GET", url: "/api/weather/v1/free" });
    expect(weatherFree.statusCode).toBe(200);
    expect(weatherFree.json()).toMatchObject({ upstream: "weather", url: "/v1/free" });

    const rootPath = await harness.app.inject({ method: "GET", url: "/v1/free" });
    expect(rootPath.statusCode).toBe(404);

    const paidFx = await harness.app.inject({ method: "GET", url: "/api/fx/v1/quote" });
    expect(paidFx.statusCode).toBe(402);
    expect(paidFx.headers["www-authenticate"]).toContain("Payment ");

    const pricing = await harness.app.inject({ method: "GET", url: "/pricing" });
    expect(pricing.statusCode).toBe(200);
    expect(pricing.json().apis).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "fx",
        path_prefix: "/api/fx",
        rate_limit: { max: 3, timeWindowMs: 60_000 }
      }),
      expect.objectContaining({
        id: "weather",
        path_prefix: "/api/weather",
        rate_limit: { max: 5, timeWindowMs: 60_000 }
      })
    ]));

    const openapi = await harness.app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json().paths["/api/fx/v1/quote"].get["x-xpayapi-api-id"]).toBe("fx");
    expect(openapi.json().paths["/api/fx/v1/quote"].get["x-payment-info"].offers[0].amount).toBe("500");
    expect(openapi.json().paths["/api/weather/v1/forecast"].get["x-xpayapi-api-id"]).toBe("weather");
    expect(openapi.json().paths["/api/weather/v1/forecast"].get["x-payment-info"].offers[0].amount).toBe("700");

    await harness.close();
    await fxUpstream.close();
    await weatherUpstream.close();
  });

  it("applies per-upstream rate limits independently", async () => {
    const fxUpstream = await startTraditionalUpstream("fx");
    const weatherUpstream = await startTraditionalUpstream("weather");
    const harness = buildHarness({
      upstreamProvider: "http",
      apis: [
        {
          id: "fx",
          upstreamBaseUrl: fxUpstream.baseUrl,
          enabled: true,
          methods: ["GET"],
          requestPrice: 500n,
          routes: [{ id: "free", path: "/v1/free", methods: ["GET"], requestPrice: 0n }],
          rateLimit: { max: 1, timeWindowMs: 60_000 },
          assetSymbol: "pathUSD",
          assetAddress: "0x20c0000000000000000000000000000000000000",
          chainId: 42431,
          forwardedHeaders: ["accept"],
          upstreamTimeoutMs: 30_000
        },
        {
          id: "weather",
          upstreamBaseUrl: weatherUpstream.baseUrl,
          enabled: true,
          methods: ["GET"],
          requestPrice: 500n,
          routes: [{ id: "free", path: "/v1/free", methods: ["GET"], requestPrice: 0n }],
          rateLimit: { max: 2, timeWindowMs: 60_000 },
          assetSymbol: "pathUSD",
          assetAddress: "0x20c0000000000000000000000000000000000000",
          chainId: 42431,
          forwardedHeaders: ["accept"],
          upstreamTimeoutMs: 30_000
        }
      ]
    });

    expect((await harness.app.inject({ method: "GET", url: "/api/fx/v1/free" })).statusCode).toBe(200);
    expect((await harness.app.inject({ method: "GET", url: "/api/fx/v1/free" })).statusCode).toBe(429);
    expect((await harness.app.inject({ method: "GET", url: "/api/weather/v1/free" })).statusCode).toBe(200);

    await harness.close();
    await fxUpstream.close();
    await weatherUpstream.close();
  });

  it("exposes mppx charge discovery for traditional APIs", async () => {
    const upstream = await startTraditionalUpstream();
    const harness = buildHarness({
      upstreamProvider: "http",
      apis: [{
        id: "fx",
        upstreamBaseUrl: upstream.baseUrl,
        enabled: true,
        methods: ["GET", "POST"],
        requestPrice: 500n,
        routes: [
          { id: "live", path: "/v1/live/*", methods: ["GET"], requestPrice: 2500n }
        ],
        forwardedHeaders: ["accept", "content-type"],
        upstreamTimeoutMs: 30_000,
        assetSymbol: "pathUSD",
        assetAddress: "0x20c0000000000000000000000000000000000000",
        chainId: 42431
      }]
    });

    const unpaid = await harness.app.inject({
      method: "GET",
      url: "/v1/live/EURUSD"
    });
    expect(unpaid.statusCode).toBe(402);
    expect(unpaid.headers["www-authenticate"]).toContain("Payment ");
    expect(String(unpaid.headers["www-authenticate"])).toContain("method=\"tempo\"");
    expect(String(unpaid.headers["www-authenticate"])).toContain("intent=\"charge\"");
    expect(String(unpaid.headers["www-authenticate"])).not.toContain("intent=\"session\"");

    const openapi = await harness.app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json().paths["/v1/live/*"].get["x-payment-info"].offers[0]).toMatchObject({
      amount: "2500",
      currency: "0x20c0000000000000000000000000000000000000",
      intent: "charge",
      method: "tempo"
    });
    expect(openapi.json().paths["/v1/live/*"].get["x-payment-info"].offers).toHaveLength(1);

    const apiOpenapi = await harness.app.inject({ method: "GET", url: "/api/openapi.json" });
    expect(apiOpenapi.statusCode).toBe(200);
    expect(apiOpenapi.json().paths["/v1/live/*"].get["x-payment-info"].offers[0].amount).toBe("2500");

    const llms = await harness.app.inject({ method: "GET", url: "/llms.txt" });
    expect(llms.statusCode).toBe(200);
    expect(llms.body).toContain("pay-api-proxy HTTP APIs");

    await harness.close();
    await upstream.close();
  });

  it("is callable by mppx/client for traditional HTTP API charge challenges", async () => {
    const upstream = await startTraditionalUpstream();
    const harness = buildHarness({
      upstreamProvider: "http",
      apis: [{
        id: "fx",
        upstreamBaseUrl: upstream.baseUrl,
        enabled: true,
        methods: ["GET"],
        requestPrice: 500n,
        routes: [],
        forwardedHeaders: ["accept"],
        upstreamTimeoutMs: 30_000,
        assetSymbol: "pathUSD",
        assetAddress: "0x20c0000000000000000000000000000000000000",
        chainId: 42431
      }]
    });
    await harness.app.listen({ host: "127.0.0.1", port: 0 });
    const address = harness.app.server.address();
    if (!address || typeof address === "string") throw new Error("Test app did not bind to a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const seenChallenges: string[] = [];
    const client = Mppx.create({
      fetch,
      methods: [tempo.charge()],
      polyfill: false,
      onChallenge: async (challenge) => {
        seenChallenges.push(`${challenge.method}/${challenge.intent}`);
        return Credential.serialize({
          challenge,
          payload: { signature: "0x00", type: "transaction" }
        });
      }
    });

    const response = await client.fetch(`${baseUrl}/v1/quote`);

    expect(seenChallenges).toEqual(["tempo/charge"]);
    expect(response.status).toBe(402);
    expect(response.headers.get("www-authenticate")).toContain("Payment ");
    expect(await response.text()).toContain("Payment verification failed");

    await harness.close();
    await upstream.close();
  });

  it("creates an MPP session and charges chat completions from actual usage", async () => {
    const harness = buildHarness();
    const sessionPayload = {
      customer_id: "cust_integration",
      authorized_max_amount: "100000",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      allowed_models: ["test-chat"]
    };

    const unpaidSession = await harness.app.inject({
      method: "POST",
      url: "/v1/payment-sessions",
      payload: sessionPayload
    });
    expect(unpaidSession.statusCode).toBe(402);
    const payment = unpaidSession.json().payment;
    expect(payment.memo).toMatch(/^sess_/);

    const paidSession = await harness.app.inject({
      method: "POST",
      url: "/v1/payment-sessions",
      headers: {
        "x-payment": encodePaymentCredential({
          type: "transaction",
          value: "session-funding-transaction",
          amount: payment.amount,
          chainId: payment.chainId,
          assetAddress: payment.assetAddress,
          recipient: payment.settlementAddress,
          memo: payment.memo
        })
      },
      payload: sessionPayload
    });
    expect(paidSession.statusCode).toBe(201);
    const session = paidSession.json().session;
    expect(session.id).toBe(payment.memo);
    expect(session.remaining_authorized_amount).toBe("100000");

    const chat = await harness.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "x-customer-id": "cust_integration",
        "x-mpp-session-id": session.id,
        "x-paid-request-id": "req_session_chat"
      },
      payload: sampleBody
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.headers["x-mpp-session-id"]).toBe(session.id);
    expect(chat.headers["x-mpp-reservation-id"]).toMatch(/^rsv_/);
    expect(chat.headers["x-paid-receipt-id"]).toMatch(/^rcpt_/);

    const record = harness.repository.getRequest("req_session_chat");
    const reservation = harness.repository.getPaymentReservationByRequestId("req_session_chat");
    expect(record).toBeDefined();
    expect(reservation).toBeDefined();
    expect(record!.status).toBe("completed");
    expect(reservation!.sessionId).toBe(session.id);
    expect(reservation!.reservedAmount).toBeDefined();
    expect(reservation!.releasedAmount).toBeDefined();

    const updatedSession = await harness.app.inject({
      method: "GET",
      url: `/v1/payment-sessions/${session.id}`,
      headers: { "x-customer-id": "cust_integration" }
    });
    expect(updatedSession.statusCode).toBe(200);
    expect(updatedSession.json().session.reserved_amount).toBe("0");
    expect(updatedSession.json().session.settled_amount).toBe(record!.actualUsageAmount);
    expect(updatedSession.json().session.remaining_authorized_amount)
      .toBe((100000n - BigInt(record!.actualUsageAmount!)).toString());

    const reservations = await harness.app.inject({
      method: "GET",
      url: `/v1/payment-sessions/${session.id}/reservations`,
      headers: { "x-customer-id": "cust_integration" }
    });
    expect(reservations.statusCode).toBe(200);
    expect(reservations.json().reservations[0].status).toBe("settled");

    const receipt = await harness.app.inject({
      method: "GET",
      url: `/receipts/${chat.headers["x-paid-receipt-id"]}`
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json().receipt.session.session_id).toBe(session.id);
    expect(receipt.json().receipt.pricing.reserved_amount).toBe(reservation!.reservedAmount);
    expect(receipt.json().receipt.pricing.actual_usage_amount).toBe(record!.actualUsageAmount);

    await harness.close();
  });

  it("session-backed image generation reserves the deterministic max and settles to upstream usage", async () => {
    const harness = buildHarness();
    const sessionPayload = {
      customer_id: "cust_image",
      authorized_max_amount: "1000000",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      allowed_models: ["gpt-image-1"]
    };

    const unpaidSession = await harness.app.inject({
      method: "POST",
      url: "/v1/payment-sessions",
      payload: sessionPayload
    });
    expect(unpaidSession.statusCode).toBe(402);
    const payment = unpaidSession.json().payment;

    const paidSession = await harness.app.inject({
      method: "POST",
      url: "/v1/payment-sessions",
      headers: {
        "x-payment": encodePaymentCredential({
          type: "transaction",
          value: "image-session-funding-transaction",
          amount: payment.amount,
          chainId: payment.chainId,
          assetAddress: payment.assetAddress,
          recipient: payment.settlementAddress,
          memo: payment.memo
        })
      },
      payload: sessionPayload
    });
    expect(paidSession.statusCode).toBe(201);
    const session = paidSession.json().session;

    const image = await harness.app.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: {
        "x-customer-id": "cust_image",
        "x-mpp-session-id": session.id,
        "x-paid-request-id": "req_image_chat"
      },
      payload: {
        model: "gpt-image-1",
        prompt: "a small red cube on a white background",
        size: "1024x1024",
        quality: "low",
        n: 1
      }
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers["x-mpp-session-id"]).toBe(session.id);
    expect(image.headers["x-paid-receipt-id"]).toMatch(/^rcpt_/);

    const body = image.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0].url).toBeDefined();

    const record = harness.repository.getRequest("req_image_chat");
    const reservation = harness.repository.getPaymentReservationByRequestId("req_image_chat");
    expect(record).toBeDefined();
    expect(reservation).toBeDefined();
    expect(record!.status).toBe("completed");
    // The test fixture returns deterministic synthetic usage (1024 image-output tokens
    // per requested image), so settled amount must be > 0 and < reserved.
    expect(BigInt(record!.actualUsageAmount!)).toBeGreaterThan(0n);
    expect(BigInt(reservation!.reservedAmount)).toBeGreaterThanOrEqual(BigInt(record!.actualUsageAmount!));

    const receipt = await harness.app.inject({
      method: "GET",
      url: `/receipts/${image.headers["x-paid-receipt-id"]}`
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json().receipt.model).toBe("gpt-image-1");

    await harness.close();
  });

  it("rejects image generation with size_not_supported when size+quality isn't priced", async () => {
    const harness = buildHarness();
    const sessionPayload = {
      customer_id: "cust_image_bad",
      authorized_max_amount: "1000000",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      allowed_models: ["gpt-image-1"]
    };
    const unpaidSession = await harness.app.inject({
      method: "POST",
      url: "/v1/payment-sessions",
      payload: sessionPayload
    });
    const payment = unpaidSession.json().payment;
    const paidSession = await harness.app.inject({
      method: "POST",
      url: "/v1/payment-sessions",
      headers: {
        "x-payment": encodePaymentCredential({
          type: "transaction",
          value: "image-bad-size-funding",
          amount: payment.amount,
          chainId: payment.chainId,
          assetAddress: payment.assetAddress,
          recipient: payment.settlementAddress,
          memo: payment.memo
        })
      },
      payload: sessionPayload
    });
    const session = paidSession.json().session;

    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: {
        "x-customer-id": "cust_image_bad",
        "x-mpp-session-id": session.id
      },
      payload: { model: "gpt-image-1", prompt: "hi", size: "9999x9999", quality: "low" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("size_not_supported");

    await harness.close();
  });

  it("uses configured fixed units for session-backed token settlement", async () => {
    const harness = buildHarness({
      sessionBilling: {
        reserveMode: "max-quote",
        settlementMode: "actual-usage",
        unitAmount: 128n,
        unitType: "usd-micro"
      }
    });

    const pricing = await harness.app.inject({ method: "GET", url: "/pricing" });
    expect(pricing.statusCode).toBe(200);
    expect(pricing.json().session_billing).toEqual({
      reserve_mode: "max-quote",
      settlement_mode: "actual-usage",
      unit_amount: "128",
      unit_type: "usd-micro"
    });

    const sessionPayload = {
      customer_id: "cust_unit_meter",
      authorized_max_amount: "100000",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      allowed_models: ["test-chat"]
    };
    const unpaidSession = await harness.app.inject({
      method: "POST",
      url: "/v1/payment-sessions",
      payload: sessionPayload
    });
    const payment = unpaidSession.json().payment;
    const paidSession = await harness.app.inject({
      method: "POST",
      url: "/v1/payment-sessions",
      headers: {
        "x-payment": encodePaymentCredential({
          type: "transaction",
          value: "session-unit-funding-transaction",
          amount: payment.amount,
          chainId: payment.chainId,
          assetAddress: payment.assetAddress,
          recipient: payment.settlementAddress,
          memo: payment.memo
        })
      },
      payload: sessionPayload
    });
    const session = paidSession.json().session;

    const chat = await harness.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "x-customer-id": "cust_unit_meter",
        "x-mpp-session-id": session.id,
        "x-paid-request-id": "req_session_units"
      },
      payload: sampleBody
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.headers["x-session-billing-unit-type"]).toBe("usd-micro");
    expect(Number(chat.headers["x-session-billing-units"])).toBeGreaterThan(0);

    const record = harness.repository.getRequest("req_session_units");
    const reservation = harness.repository.getPaymentReservationByRequestId("req_session_units");
    expect(record).toBeDefined();
    expect(reservation).toBeDefined();
    expect(BigInt(record!.actualUsageAmount!) % 128n).toBe(0n);
    expect(BigInt(reservation!.reservedAmount) % 128n).toBe(0n);

    await harness.close();
  });

  it("issues a native mppx session challenge when enabled and no legacy session id is present", async () => {
    const harness = buildHarness({
      mppxSession: {
        enabled: true,
        privateKey: `0x${"1".repeat(64)}`,
        secretKey: "mppx-test-secret",
        testnet: true,
        waitForConfirmation: false
      }
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: sampleBody
    });

    expect(response.statusCode).toBe(402);
    expect(response.headers["www-authenticate"]).toContain("Payment ");
    expect(String(response.headers["www-authenticate"])).toContain("intent=\"session\"");

    await harness.close();
  });

  it("releases a session reservation when the upstream request fails", async () => {
    const failingProvider: AiProvider = {
      async chatCompletions() {
        throw new Error("forced upstream failure");
      },
      async images() {
        throw new Error("forced upstream failure");
      }
    };
    const harness = buildHarness({}, failingProvider);
    const sessionPayload = {
      customer_id: "cust_failure",
      authorized_max_amount: "100000",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      allowed_models: ["test-chat"]
    };

    const unpaidSession = await harness.app.inject({
      method: "POST",
      url: "/v1/payment-sessions",
      payload: sessionPayload
    });
    const payment = unpaidSession.json().payment;
    const paidSession = await harness.app.inject({
      method: "POST",
      url: "/v1/payment-sessions",
      headers: {
        "x-payment": encodePaymentCredential({
          type: "transaction",
          value: "failing-session-funding-transaction",
          amount: payment.amount,
          chainId: payment.chainId,
          assetAddress: payment.assetAddress,
          recipient: payment.settlementAddress,
          memo: payment.memo
        })
      },
      payload: sessionPayload
    });
    const session = paidSession.json().session;

    const chat = await harness.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "x-customer-id": "cust_failure",
        "x-mpp-session-id": session.id,
        "x-paid-request-id": "req_session_failure"
      },
      payload: sampleBody
    });
    expect(chat.statusCode).toBe(502);

    const updatedSession = await harness.app.inject({
      method: "GET",
      url: `/v1/payment-sessions/${session.id}`,
      headers: { "x-customer-id": "cust_failure" }
    });
    expect(updatedSession.json().session.remaining_authorized_amount).toBe("100000");
    expect(updatedSession.json().session.reserved_amount).toBe("0");
    expect(updatedSession.json().session.settled_amount).toBe("0");

    const reservations = await harness.app.inject({
      method: "GET",
      url: `/v1/payment-sessions/${session.id}/reservations`,
      headers: { "x-customer-id": "cust_failure" }
    });
    expect(reservations.json().reservations[0].status).toBe("released");

    const record = harness.repository.getRequest("req_session_failure");
    expect(record).toBeDefined();
    expect(record!.status).toBe("failed");
    expect(record!.actualUsageAmount).toBeUndefined();

    const retrySameRequestId = await harness.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "x-customer-id": "cust_failure",
        "x-mpp-session-id": session.id,
        "x-paid-request-id": "req_session_failure"
      },
      payload: sampleBody
    });
    expect(retrySameRequestId.statusCode).toBe(409);
    expect(retrySameRequestId.json().error.code).toBe("request_previously_failed");

    await harness.close();
  });

  it("rejects an unknown model with model_not_found", async () => {
    const harness = buildHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { ...sampleBody, model: "does-not-exist" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("model_not_found");
    await harness.close();
  });

  it("rejects streaming requests with stream_not_supported", async () => {
    const harness = buildHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { ...sampleBody, stream: true }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("stream_not_supported");
    await harness.close();
  });

  it("rejects an invalid x-paid-request-id format", async () => {
    const harness = buildHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-paid-request-id": "not a valid id!" },
      payload: sampleBody
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request_id");
    await harness.close();
  });

  it("returns 404 for unknown receipts", async () => {
    const harness = buildHarness();
    const receipt = await harness.app.inject({ method: "GET", url: "/receipts/rcpt_missing" });
    expect(receipt.statusCode).toBe(404);
    expect(receipt.json().error.code).toBe("receipt_not_found");
    await harness.close();
  });

  it("exposes pricing, models, and well-known discovery", async () => {
    const harness = buildHarness();

    const pricing = await harness.app.inject({ method: "GET", url: "/pricing" });
    expect(pricing.statusCode).toBe(200);
    expect(pricing.json().models[0].model).toBe("test-chat");

    const models = await harness.app.inject({ method: "GET", url: "/v1/models" });
    expect(models.statusCode).toBe(200);
    expect(models.json().data[0].id).toBe("test-chat");

    const mpp = await harness.app.inject({ method: "GET", url: "/.well-known/mpp" });
    expect(mpp.statusCode).toBe(200);
    expect(mpp.json().protocol).toBe("mpp");
    expect(mpp.json().node_id).toBe("localhost:8080");

    const x402 = await harness.app.inject({ method: "GET", url: "/.well-known/x402" });
    expect(x402.statusCode).toBe(200);
    expect(x402.json().discovery).toContain("/.well-known/mpp");

    await harness.close();
  });

  it("exposes configured models from app config", async () => {
    const harness = buildHarness();
    harness.config.models = [
      {
        ...harness.config.models[0],
        id: "model_env_test",
        modelName: "env-upstream-model"
      }
    ];

    const pricing = await harness.app.inject({ method: "GET", url: "/pricing" });
    expect(pricing.statusCode).toBe(200);
    expect(pricing.json().models[0].model).toBe("env-upstream-model");

    const models = await harness.app.inject({ method: "GET", url: "/v1/models" });
    expect(models.statusCode).toBe(200);
    expect(models.json().data[0].id).toBe("env-upstream-model");

    await harness.close();
  });

  it("disables OpenAI-compatible endpoints not in the whitelist", async () => {
    const harness = buildHarness({ openaiEndpointWhitelist: ["models"] });

    const models = await harness.app.inject({ method: "GET", url: "/v1/models" });
    expect(models.statusCode).toBe(200);

    const chat = await harness.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: sampleBody
    });
    expect(chat.statusCode).toBe(404);
    expect(chat.json().error.code).toBe("endpoint_not_enabled");

    await harness.close();
  });
});
