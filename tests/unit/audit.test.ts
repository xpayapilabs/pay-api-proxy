import { Receipt } from "mppx";
import { buildTraditionalPaidCallAudit } from "../../src/core/paid-http/proxy.js";
import { testConfig } from "../../src/core/config.js";
import { loadLocalPaidApiFixture, localPaidApiRequestUrl } from "../helpers/local-paid-api-fixture.js";

describe("paid call audit", () => {
  it("marks paid traditional API 5xx responses as pending refunds with route pricing", () => {
    const paidApi = loadLocalPaidApiFixture();
    const completedAt = new Date("2026-06-06T12:00:00.000Z");
    const receipt = Receipt.serialize({
      method: "tempo",
      reference: `0x${"1".repeat(64)}`,
      status: "success",
      timestamp: "2026-06-06T11:59:59.000Z"
    });
    const config = testConfig({
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

    const audit = buildTraditionalPaidCallAudit(
      config,
      new Request(localPaidApiRequestUrl(paidApi), { method: paidApi.method }),
      new Response("server error", {
        status: 500,
        headers: { "payment-receipt": receipt }
      }),
      {
        startedAt: completedAt.getTime() - 430,
        now: completedAt
      }
    );

    expect(audit).toMatchObject({
      apiId: paidApi.apiId,
      routeId: paidApi.routeId,
      method: paidApi.method,
      path: paidApi.routePath,
      upstreamPath: paidApi.routePath,
      status: 500,
      paid: true,
      paymentVerified: true,
      receiptAttached: true,
      paymentMethod: "tempo",
      paymentReference: `0x${"1".repeat(64)}`,
      externalId: paidApi.externalId,
      requestPrice: paidApi.routeRequestPriceText,
      refundStatus: "pending",
      refundReason: "paid_response_500",
      durationMs: 430
    });
  });

  it("marks payment-verified proxy failures as pending refunds even without a response receipt", () => {
    const completedAt = new Date("2026-06-06T12:00:00.000Z");
    const config = testConfig({
      upstreamProvider: "http",
      apis: [{
        id: "fx",
        upstreamBaseUrl: "https://upstream.example.com",
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

    const audit = buildTraditionalPaidCallAudit(
      config,
      new Request("https://api.example.com/v1/quote", { method: "GET" }),
      undefined,
      {
        paymentSuccess: {
          receipt: {
            method: "tempo",
            reference: `0x${"2".repeat(64)}`,
            status: "success",
            timestamp: "2026-06-06T11:59:59.000Z"
          },
          verifiedAt: "2026-06-06T11:59:59.500Z"
        },
        startedAt: completedAt.getTime() - 12,
        now: completedAt
      }
    );

    expect(audit).toMatchObject({
      apiId: "fx",
      status: 500,
      paid: true,
      paymentVerified: true,
      receiptAttached: false,
      paymentReference: `0x${"2".repeat(64)}`,
      externalId: "api:fx",
      requestPrice: "500",
      refundStatus: "pending"
    });
  });
});
