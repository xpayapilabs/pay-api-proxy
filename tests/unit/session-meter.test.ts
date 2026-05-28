import {
  amountToSessionUnits,
  applySessionUnitCharges,
  buildSessionUnitCharges,
  quoteSessionReservation,
  sessionUnitsToAmount,
  settleSessionUsage
} from "../../src/charging/session-meter.js";
import type { ActualUsageAmount, PriceQuote } from "../../src/charging/types.js";
import {
  rawAmountToDecimalString,
  releaseReservedChannelAuthorization,
  settleReservedChannelUsage
} from "../../src/payments/mppx-session.js";

describe("session meter", () => {
  const billing = {
    reserveMode: "max-quote" as const,
    settlementMode: "actual-usage" as const,
    unitAmount: 100n,
    unitType: "usd-centi-micro"
  };

  it("rounds platform amounts into fixed session units", () => {
    expect(amountToSessionUnits(0n, 100n)).toBe(0n);
    expect(amountToSessionUnits(1n, 100n)).toBe(1n);
    expect(amountToSessionUnits(250n, 100n)).toBe(3n);
    expect(sessionUnitsToAmount(3n, 100n)).toBe(300n);
  });

  it("formats raw token amounts for mppx decimal amount options", () => {
    expect(rawAmountToDecimalString(1n, 6)).toBe("0.000001");
    expect(rawAmountToDecimalString(1000n, 6)).toBe("0.001");
    expect(rawAmountToDecimalString(1000000n, 6)).toBe("1");
    expect(rawAmountToDecimalString(1234500n, 6)).toBe("1.2345");
  });

  it("settles native mppx reserved sessions down to actual usage", async () => {
    let state = {
      authorizedSigner: "0x0000000000000000000000000000000000000001" as `0x${string}`,
      chainId: 42431,
      escrowContract: "0x0000000000000000000000000000000000000002" as `0x${string}`,
      channelId: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as `0x${string}`,
      closeRequestedAt: 0n,
      createdAt: new Date(0).toISOString(),
      deposit: 1000n,
      finalized: false,
      highestVoucher: null,
      highestVoucherAmount: 1000n,
      payee: "0x0000000000000000000000000000000000000003" as `0x${string}`,
      payer: "0x0000000000000000000000000000000000000004" as `0x${string}`,
      settledOnChain: 0n,
      spent: 1000n,
      token: "0x0000000000000000000000000000000000000005" as `0x${string}`,
      units: 1
    };
    const store = {
      async getChannel() {
        return state;
      },
      async updateChannel(_channelId: `0x${string}`, fn: (current: typeof state | null) => typeof state | null) {
        const next = fn(state);
        if (next) state = next;
        return next;
      }
    };
    const settlement = settleSessionUsage({
      inputAmount: 150n,
      outputAmount: 610n,
      minimumApplied: false,
      totalAmount: 760n
    }, billing);

    const updated = await settleReservedChannelUsage(store, state.channelId as `0x${string}`, settlement);

    expect(updated.highestVoucherAmount).toBe(1000n);
    expect(updated.spent).toBe(900n);
    expect(updated.units).toBe(9);
  });

  it("releases native mppx authorization after a failed upstream request", async () => {
    let state = {
      authorizedSigner: "0x0000000000000000000000000000000000000001" as `0x${string}`,
      chainId: 42431,
      escrowContract: "0x0000000000000000000000000000000000000002" as `0x${string}`,
      channelId: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as `0x${string}`,
      closeRequestedAt: 0n,
      createdAt: new Date(0).toISOString(),
      deposit: 1000n,
      finalized: false,
      highestVoucher: null,
      highestVoucherAmount: 1000n,
      payee: "0x0000000000000000000000000000000000000003" as `0x${string}`,
      payer: "0x0000000000000000000000000000000000000004" as `0x${string}`,
      settledOnChain: 0n,
      spent: 1000n,
      token: "0x0000000000000000000000000000000000000005" as `0x${string}`,
      units: 1
    };
    const store = {
      async getChannel() {
        return state;
      },
      async updateChannel(_channelId: `0x${string}`, fn: (current: typeof state | null) => typeof state | null) {
        const next = fn(state);
        if (next) state = next;
        return next;
      }
    };

    const updated = await releaseReservedChannelAuthorization(store, state.channelId, {
      method: "tempo",
      intent: "session",
      status: "success",
      timestamp: new Date(0).toISOString(),
      reference: state.channelId,
      challengeId: "challenge",
      channelId: state.channelId,
      acceptedCumulative: "1000",
      spent: "1000",
      units: 1
    }, 1000n);

    expect(updated.spent).toBe(0n);
    expect(updated.units).toBe(0);
  });

  it("rejects a native mppx release when the channel has advanced since authorization", async () => {
    let state = {
      authorizedSigner: "0x0000000000000000000000000000000000000001" as `0x${string}`,
      chainId: 42431,
      escrowContract: "0x0000000000000000000000000000000000000002" as `0x${string}`,
      channelId: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd" as `0x${string}`,
      closeRequestedAt: 0n,
      createdAt: new Date(0).toISOString(),
      deposit: 5000n,
      finalized: false,
      highestVoucher: null,
      highestVoucherAmount: 5000n,
      payee: "0x0000000000000000000000000000000000000003" as `0x${string}`,
      payer: "0x0000000000000000000000000000000000000004" as `0x${string}`,
      settledOnChain: 0n,
      // Channel has advanced past our authorization (3000) since another reservation landed.
      spent: 3500n,
      token: "0x0000000000000000000000000000000000000005" as `0x${string}`,
      units: 3
    };
    const store = {
      async getChannel() {
        return state;
      },
      async updateChannel(_channelId: `0x${string}`, fn: (current: typeof state | null) => typeof state | null) {
        const next = fn(state);
        if (next) state = next;
        return next;
      }
    };

    await expect(releaseReservedChannelAuthorization(store, state.channelId, {
      method: "tempo",
      intent: "session",
      status: "success",
      timestamp: new Date(0).toISOString(),
      reference: state.channelId,
      challengeId: "challenge",
      channelId: state.channelId,
      acceptedCumulative: "3000",
      spent: "3000",
      units: 2
    }, 1000n)).rejects.toThrow(/channel spent advanced/i);

    // State must be untouched after the rejected release.
    expect(state.spent).toBe(3500n);
    expect(state.units).toBe(3);
  });

  it("rejects a native mppx release when reservedAmount exceeds receipt.spent", async () => {
    const channelId = "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef" as `0x${string}`;
    const store = {
      async getChannel() {
        return null;
      },
      async updateChannel() {
        throw new Error("updateChannel must not be called when preconditions fail");
      }
    };

    await expect(releaseReservedChannelAuthorization(store, channelId, {
      method: "tempo",
      intent: "session",
      status: "success",
      timestamp: new Date(0).toISOString(),
      reference: channelId,
      challengeId: "challenge",
      channelId,
      acceptedCumulative: "100",
      spent: "100",
      units: 1
    }, 500n)).rejects.toThrow(/receipt\.spent .* < reservedAmount/);
  });

  it("reserves max quote amount using the configured session unit", () => {
    const quote: PriceQuote = {
      requestId: "req_session",
      model: "test-chat",
      chargingMethod: "ai-token",
      inputTokensEstimate: 20,
      maxOutputTokens: 300,
      maxCharge: 12_345n,
      currency: {
        symbol: "pathUSD",
        assetAddress: "0x20c0000000000000000000000000000000000000",
        chainId: 42431
      }
    };

    expect(quoteSessionReservation(quote, billing)).toMatchObject({
      reservedAmount: 12_400n,
      reservedUnits: 124n,
      reserveMode: "max-quote",
      unitAmount: 100n,
      unitType: "usd-centi-micro"
    });
  });

  it("reserves component-rounded token quotes when a breakdown is available", () => {
    const quote: PriceQuote = {
      requestId: "req_session",
      model: "test-chat",
      chargingMethod: "ai-token",
      inputTokensEstimate: 20,
      maxOutputTokens: 300,
      maxCharge: 250n,
      amountBreakdown: {
        inputAmount: 10n,
        outputAmount: 20n,
        minimumAdjustmentAmount: 220n,
        totalAmount: 250n
      },
      currency: {
        symbol: "pathUSD",
        assetAddress: "0x20c0000000000000000000000000000000000000",
        chainId: 42431
      }
    };

    expect(quoteSessionReservation(quote, billing)).toMatchObject({
      reservedAmount: 500n,
      reservedUnits: 5n
    });
  });

  it("settles input and output token prices as different unit counts", () => {
    const actual: ActualUsageAmount = {
      inputAmount: 150n,
      outputAmount: 610n,
      minimumApplied: false,
      totalAmount: 760n
    };

    expect(settleSessionUsage(actual, billing)).toMatchObject({
      inputAmount: 150n,
      outputAmount: 610n,
      minimumAdjustmentAmount: 0n,
      inputUnits: 2n,
      outputUnits: 7n,
      totalUnits: 9n,
      totalAmount: 900n
    });
  });

  it("builds adapter-facing unit charges by component", async () => {
    const settlement = settleSessionUsage({
      inputAmount: 150n,
      outputAmount: 610n,
      minimumApplied: false,
      totalAmount: 760n
    }, billing);
    const charges = buildSessionUnitCharges(settlement);

    expect(charges.map((charge) => ({
      component: charge.component,
      units: charge.units
    }))).toEqual([
      { component: "input", units: 2n },
      { component: "output", units: 7n }
    ]);

    const applied: string[] = [];
    await applySessionUnitCharges({
      async charge(units, charge) {
        applied.push(`${charge.component}:${units}:${charge.unitType}`);
      }
    }, charges);

    expect(applied).toEqual(["input:2:usd-centi-micro", "output:7:usd-centi-micro"]);
  });

  it("represents minimum charge as a separate settlement adjustment", () => {
    const actual: ActualUsageAmount = {
      inputAmount: 10n,
      outputAmount: 20n,
      minimumApplied: true,
      totalAmount: 250n
    };

    expect(settleSessionUsage(actual, billing)).toMatchObject({
      inputUnits: 1n,
      outputUnits: 1n,
      minimumAdjustmentAmount: 220n,
      minimumAdjustmentUnits: 3n,
      totalUnits: 5n,
      totalAmount: 500n
    });
  });
});
