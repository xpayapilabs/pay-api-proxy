import { parseAmount } from "../core/money.js";
import type { PaymentChallenge, PaymentCredential } from "./types.js";

export function validateCredentialAgainstChallenge(
  credential: PaymentCredential,
  challenge: PaymentChallenge
): void {
  if (credential.chainId !== challenge.chainId) {
    throw new Error("Payment credential uses the wrong chain");
  }

  if (credential.assetAddress.toLowerCase() !== challenge.assetAddress.toLowerCase()) {
    throw new Error("Payment credential uses the wrong asset");
  }

  if (credential.recipient.toLowerCase() !== challenge.settlementAddress.toLowerCase()) {
    throw new Error("Payment credential uses the wrong recipient");
  }

  if (credential.memo !== challenge.memo) {
    throw new Error("Payment credential memo does not match request");
  }

  if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) {
    throw new Error("Payment credential is expired");
  }

  if (parseAmount(credential.amount) < parseAmount(challenge.amount)) {
    throw new Error("Payment amount is insufficient");
  }
}
