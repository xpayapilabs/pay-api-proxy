import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";
import type { PaymentRecord, PaymentReservationRecord, PaymentSessionRecord, RequestRecord } from "../db/repository.js";

export interface UsageReceiptPayload {
  receipt_id: string;
  request_id: string;
  payment_id: string;
  issued_at: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  pricing: {
    prepaid_max_amount: string;
    actual_usage_amount: string;
    difference_amount: string;
    reserved_amount?: string;
    released_amount?: string;
  };
  session?: {
    session_id: string;
    reservation_id: string;
    customer_id: string;
  };
  settlement: {
    protocol: string;
    chain_id: number;
    asset_address: string;
    credential_type: string;
    credential_hash: string;
    settlement_tx?: string;
  };
}

export interface SignedReceipt {
  payload: UsageReceiptPayload;
  receiptHash: string;
  signature: string;
}

export function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export function hashPayload(payload: UsageReceiptPayload): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

export function signHash(hash: string, secret: string): string {
  return createHmac("sha256", secret).update(hash).digest("hex");
}

/**
 * Generic sign-and-hash helper for any stable-JSON-serializable receipt payload.
 * Used by both the standard session receipt and the native-mppx receipt; both go
 * through the same stableJson → sha256 → HMAC pipeline so consumers can verify
 * with one routine regardless of which session backend issued the receipt.
 */
export function signReceiptPayload<T>(payload: T, secret: string): { receiptHash: string; signature: string } {
  const receiptHash = createHash("sha256").update(stableJson(payload)).digest("hex");
  return {
    receiptHash,
    signature: signHash(receiptHash, secret)
  };
}

export function verifySignature(hash: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(signHash(hash, secret), "hex");
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function buildSignedReceipt(
  request: RequestRecord,
  payment: PaymentRecord,
  secret: string,
  receiptId = `rcpt_${nanoid(16)}`,
  session?: PaymentSessionRecord,
  reservation?: PaymentReservationRecord
): SignedReceipt {
  if (request.actualInputTokens === undefined || request.actualOutputTokens === undefined || !request.actualUsageAmount) {
    throw new Error("Cannot generate receipt before request usage is recorded");
  }

  const prepaid = BigInt(reservation?.reservedAmount ?? payment.prepaidMaxAmount);
  const actual = BigInt(request.actualUsageAmount);
  const difference = prepaid > actual ? prepaid - actual : 0n;
  const payload: UsageReceiptPayload = {
    receipt_id: receiptId,
    request_id: request.id,
    payment_id: payment.id,
    issued_at: new Date().toISOString(),
    model: request.model,
    usage: {
      input_tokens: request.actualInputTokens,
      output_tokens: request.actualOutputTokens,
      total_tokens: request.actualInputTokens + request.actualOutputTokens
    },
    pricing: {
      prepaid_max_amount: (reservation?.reservedAmount ?? payment.prepaidMaxAmount),
      actual_usage_amount: request.actualUsageAmount,
      difference_amount: difference.toString(),
      reserved_amount: reservation?.reservedAmount,
      released_amount: reservation?.releasedAmount
    },
    session: session && reservation ? {
      session_id: session.id,
      reservation_id: reservation.id,
      customer_id: session.customerId
    } : undefined,
    settlement: {
      protocol: payment.protocol,
      chain_id: payment.chainId,
      asset_address: payment.assetAddress,
      credential_type: payment.credentialType,
      credential_hash: payment.credentialHash,
      settlement_tx: payment.settlementTx
    }
  };

  const receiptHash = hashPayload(payload);
  return {
    payload,
    receiptHash,
    signature: signHash(receiptHash, secret)
  };
}
