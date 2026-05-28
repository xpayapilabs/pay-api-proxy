import { buildSignedReceipt, hashPayload, stableJson, verifySignature } from "../../src/receipts/receipt.js";
import type { PaymentRecord, RequestRecord } from "../../src/db/repository.js";

describe("receipts", () => {
  it("builds and verifies a signed usage receipt", () => {
    const request: RequestRecord = {
      id: "req_1",
      model: "test-chat",
      status: "completed",
      inputTokensEstimate: 20,
      maxOutputTokens: 100,
      maxCharge: "1000",
      actualInputTokens: 20,
      actualOutputTokens: 10,
      actualUsageAmount: "300",
      createdAt: new Date().toISOString()
    };
    const payment: PaymentRecord = {
      id: "pay_1",
      requestId: "req_1",
      protocol: "mpp",
      chainId: 42431,
      assetAddress: "0x20c0000000000000000000000000000000000000",
      credentialType: "transaction",
      credentialHash: "abc",
      settlementTx: "test_tx",
      status: "settled",
      settlementVerification: "onchain",
      prepaidMaxAmount: "1000",
      settledAmount: "1000",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const receipt = buildSignedReceipt(request, payment, "secret", "rcpt_test");
    expect(receipt.payload.pricing.difference_amount).toBe("700");
    expect(verifySignature(receipt.receiptHash, receipt.signature, "secret")).toBe(true);
    expect(verifySignature(receipt.receiptHash, receipt.signature, "wrong")).toBe(false);
  });

  it("produces canonical JSON that omits undefined fields", () => {
    expect(stableJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(stableJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(stableJson({ nested: { c: undefined, b: 2, a: 1 } })).toBe('{"nested":{"a":1,"b":2}}');
    expect(stableJson([1, undefined, 2])).toBe('[1,null,2]');
  });

  it("hashes payloads with no settlement tx without producing invalid JSON", () => {
    const request: RequestRecord = {
      id: "req_2",
      model: "test-chat",
      status: "completed",
      inputTokensEstimate: 10,
      maxOutputTokens: 64,
      maxCharge: "500",
      actualInputTokens: 10,
      actualOutputTokens: 4,
      actualUsageAmount: "200",
      createdAt: new Date().toISOString()
    };
    const payment: PaymentRecord = {
      id: "pay_2",
      requestId: "req_2",
      protocol: "mpp",
      chainId: 42431,
      assetAddress: "0xasset",
      credentialType: "hash",
      credentialHash: "ddd",
      status: "pending",
      settlementVerification: "test",
      prepaidMaxAmount: "500",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const receipt = buildSignedReceipt(request, payment, "secret", "rcpt_no_tx");
    expect(receipt.payload.settlement.settlement_tx).toBeUndefined();
    expect(() => JSON.parse(stableJson(receipt.payload))).not.toThrow();
    expect(receipt.receiptHash).toBe(hashPayload(receipt.payload));
  });
});
