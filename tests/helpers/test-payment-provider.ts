import { nanoid } from "nanoid";
import type { PriceQuote } from "../../src/charging/index.js";
import type { AppConfig } from "../../src/core/config.js";
import { hashCredential, parsePaymentHeader } from "../../src/payments/credential.js";
import type { PaymentChallenge, PaymentCredential, PaymentProvider, VerifiedPayment } from "../../src/payments/types.js";
import { validateCredentialAgainstChallenge } from "../../src/payments/validation.js";

export class TestPaymentProvider implements PaymentProvider {
  constructor(private readonly config: AppConfig) {}

  createChallenge(quote: PriceQuote): PaymentChallenge {
    return {
      version: "pay-api-proxy-mvp-1",
      protocol: "mpp",
      chainId: quote.currency.chainId,
      assetAddress: quote.currency.assetAddress,
      settlementAddress: this.config.tempo.settlementAddress,
      amount: quote.maxCharge.toString(),
      memo: quote.requestId,
      memoText: `test:${quote.requestId}`,
      credentialTypes: ["transaction", "hash"]
    };
  }

  parseCredential(header: string | undefined): PaymentCredential | undefined {
    return parsePaymentHeader(header);
  }

  async verifyCredential(credential: PaymentCredential, challenge: PaymentChallenge): Promise<VerifiedPayment> {
    validateCredentialAgainstChallenge(credential, challenge);
    return {
      id: `pay_${nanoid(16)}`,
      protocol: "mpp",
      chainId: credential.chainId,
      assetAddress: credential.assetAddress,
      credentialType: credential.type,
      credentialHash: hashCredential(credential.type, credential.value),
      settlementTx: credential.type === "hash" ? credential.value : `test_tx_${nanoid(12)}`,
      status: "settled",
      settlementVerification: "test",
      prepaidMaxAmount: credential.amount,
      settledAmount: credential.amount
    };
  }
}
