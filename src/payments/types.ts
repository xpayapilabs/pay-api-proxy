import type { PriceQuote } from "../charging/index.js";

export interface PaymentChallenge {
  version: "pay-api-proxy-mvp-1";
  protocol: "mpp";
  chainId: number;
  assetAddress: string;
  settlementAddress: string;
  amount: string;
  memo: string;
  memoText: string;
  memoHex?: string;
  credentialTypes: Array<"transaction" | "hash">;
}

export interface PaymentCredential {
  type: "transaction" | "hash";
  value: string;
  amount: string;
  chainId: number;
  assetAddress: string;
  recipient: string;
  memo: string;
  expiresAt?: string;
}

export interface VerifiedPayment {
  id: string;
  protocol: "mpp";
  chainId: number;
  assetAddress: string;
  credentialType: "transaction" | "hash";
  credentialHash: string;
  settlementTx?: string;
  status: "settled" | "pending";
  settlementVerification: "test" | "onchain";
  prepaidMaxAmount: string;
  settledAmount?: string;
}

export interface PaymentProvider {
  createChallenge(quote: PriceQuote): PaymentChallenge;
  parseCredential(header: string | undefined): PaymentCredential | undefined;
  verifyCredential(credential: PaymentCredential, challenge: PaymentChallenge): Promise<VerifiedPayment>;
}
