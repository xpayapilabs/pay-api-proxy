import { vi } from "vitest";
import { testConfig } from "../../src/core/config.js";
import type { ModelConfig } from "../../src/core/models.js";
import { openDatabase } from "../../src/db/database.js";
import { Repository } from "../../src/db/repository.js";
import type { MppxSessionAdapter } from "../../src/payments/mppx-session.js";
import { MppxSessionBackend } from "../../src/sessions/mppx.js";

const model: ModelConfig = {
  id: "model_test",
  modelName: "test-model",
  enabled: true,
  supportsStreaming: false,
  inputPricePerMillion: 1_000_000n,
  outputPricePerMillion: 1_000_000n,
  minimumCharge: 0n,
  defaultMaxTokens: 100,
  maxTokensLimit: 1000,
  assetSymbol: "pathUSD",
  assetAddress: "0x20c0000000000000000000000000000000000000",
  chainId: 42431
};

describe("MppxSessionBackend", () => {
  it("caps over-budget settlements consistently in mppx, db, receipt, and headers", async () => {
    const database = openDatabase(":memory:");
    try {
      const repository = new Repository(database.db);
      repository.createRequest({
        id: "req_mppx_cap",
        model: model.modelName,
        status: "running",
        inputTokensEstimate: 1,
        maxOutputTokens: 10,
        maxCharge: "1000"
      });

      const finalizeUsage = vi.fn(async (_receipt: unknown, settlement: unknown) => ({
        channelId: "0x1111111111111111111111111111111111111111111111111111111111111111",
        challengeId: "challenge_test",
        serialized: "unused",
        txHash: "0xabc",
        settlement
      }));
      const adapter = {
        finalizeUsage,
        serializeReceipt: vi.fn(() => "serialized-final-receipt"),
        releaseAuthorization: vi.fn(),
        authorizeRequest: vi.fn()
      } as unknown as MppxSessionAdapter;

      const backend = new MppxSessionBackend(adapter, repository);
      const authorization = {
        kind: "mppx" as const,
        receipt: { channelId: "0x1111111111111111111111111111111111111111111111111111111111111111" },
        reservedAmount: 1000n
      };
      const settlement = {
        inputAmount: 300n,
        outputAmount: 900n,
        minimumAdjustmentAmount: 0n,
        totalAmount: 1200n,
        inputUnits: 3n,
        outputUnits: 9n,
        minimumAdjustmentUnits: 0n,
        totalUnits: 12n,
        settlementMode: "actual-usage" as const,
        unitAmount: 100n,
        unitType: "asset-smallest-unit"
      };

      const settle = await backend.settle({
        authorization,
        settlement,
        usage: { inputTokens: 3, outputTokens: 9, totalTokens: 12, source: "upstream" },
        requestId: "req_mppx_cap"
      });

      expect(finalizeUsage).toHaveBeenCalledTimes(1);
      expect(finalizeUsage.mock.calls[0]?.[1]).toMatchObject({
        totalAmount: 1000n,
        totalUnits: 10n
      });
      expect(repository.getRequest("req_mppx_cap")?.actualUsageAmount).toBe("1000");

      const receipt = backend.buildReceiptAndHeaders({
        authorization,
        settle,
        settlement,
        actual: { inputAmount: 300n, outputAmount: 900n, minimumApplied: false, totalAmount: 1200n },
        usage: { inputTokens: 3, outputTokens: 9, totalTokens: 12, source: "upstream" },
        requestId: "req_mppx_cap",
        model,
        config: testConfig()
      });
      const payload = JSON.parse(receipt.payloadJson) as {
        pricing: { actual_usage_amount: string; difference_amount: string; prepaid_max_amount: string };
      };
      expect(payload.pricing).toEqual({
        actual_usage_amount: "1000",
        difference_amount: "0",
        prepaid_max_amount: "1000"
      });

      const headers = new Map<string, string>();
      const reply = {
        header: (name: string, value: string) => {
          headers.set(name, value);
          return reply;
        }
      };
      receipt.applyHeaders(reply as never);
      expect(headers.get("payment-receipt")).toBe("serialized-final-receipt");
      expect(headers.get("x-session-billing-units")).toBe("10");
    } finally {
      database.close();
    }
  });
});
