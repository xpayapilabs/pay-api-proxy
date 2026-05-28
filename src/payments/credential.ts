import { createHash } from "node:crypto";
import type { PaymentCredential } from "./types.js";

export function hashCredential(type: string, value: string): string {
  return createHash("sha256").update(`${type}:${value}`).digest("hex");
}

export function memoTextToBytes32(memoText: string): string {
  return `0x${createHash("sha256").update(memoText).digest("hex")}`;
}

function asNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Payment credential missing ${name}`);
  }
  return value;
}

export function parsePaymentHeader(header: string | undefined): PaymentCredential | undefined {
  if (!header) return undefined;
  if (header.startsWith("Payment ")) return parseAuthorizationPaymentHeader(header);

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  } catch {
    throw new Error("Payment header must be base64url encoded JSON");
  }

  if (!decoded || typeof decoded !== "object") {
    throw new Error("Payment credential must be an object");
  }

  const candidate = decoded as Record<string, unknown>;
  if (candidate.type !== "transaction" && candidate.type !== "hash") {
    throw new Error("Payment credential type must be transaction or hash");
  }

  if (typeof candidate.chainId !== "number" || !Number.isInteger(candidate.chainId)) {
    throw new Error("Payment credential missing chainId");
  }

  if (candidate.expiresAt !== undefined && typeof candidate.expiresAt !== "string") {
    throw new Error("Payment credential expiresAt must be a string");
  }

  return {
    type: candidate.type,
    value: asNonEmptyString(candidate.value, "value"),
    amount: asNonEmptyString(candidate.amount, "amount"),
    chainId: candidate.chainId,
    assetAddress: asNonEmptyString(candidate.assetAddress, "assetAddress"),
    recipient: asNonEmptyString(candidate.recipient, "recipient"),
    memo: asNonEmptyString(candidate.memo, "memo"),
    expiresAt: candidate.expiresAt
  };
}

export function encodePaymentCredential(credential: PaymentCredential): string {
  return Buffer.from(JSON.stringify(credential)).toString("base64url");
}

function parseAuthorizationPaymentHeader(header: string): PaymentCredential {
  const encoded = header.slice("Payment ".length).trim();
  if (!encoded) throw new Error("Authorization Payment credential is empty");

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Authorization Payment credential must be base64url encoded JSON");
  }

  if (!decoded || typeof decoded !== "object") {
    throw new Error("Authorization Payment credential must be an object");
  }

  const candidate = decoded as Record<string, unknown>;
  if (!candidate.challenge || typeof candidate.challenge !== "object") {
    throw new Error("Authorization Payment credential missing challenge");
  }
  if (!candidate.payload || typeof candidate.payload !== "object") {
    throw new Error("Authorization Payment credential missing payload");
  }

  const challenge = candidate.challenge as Record<string, unknown>;
  const payload = candidate.payload as Record<string, unknown>;
  const request = parseAuthorizationPaymentRequest(asNonEmptyString(challenge.request, "challenge.request"));
  const type = payload.type;
  if (type !== "transaction" && type !== "hash") {
    throw new Error("Authorization Payment payload type must be transaction or hash");
  }

  return {
    type,
    value:
      type === "hash"
        ? asNonEmptyString(payload.hash, "payload.hash")
        : asNonEmptyString(payload.signature, "payload.signature"),
    amount: request.amount,
    chainId: request.chainId,
    assetAddress: request.assetAddress,
    recipient: request.recipient,
    memo: asNonEmptyString(challenge.id, "challenge.id"),
    expiresAt: typeof challenge.expires === "string" ? challenge.expires : undefined
  };
}

function parseAuthorizationPaymentRequest(encoded: string): {
  amount: string;
  chainId: number;
  assetAddress: string;
  recipient: string;
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Authorization Payment challenge request must be base64url encoded JSON");
  }

  if (!decoded || typeof decoded !== "object") {
    throw new Error("Authorization Payment challenge request must be an object");
  }
  const request = decoded as Record<string, unknown>;
  const methodDetails = request.methodDetails;
  if (!methodDetails || typeof methodDetails !== "object") {
    throw new Error("Authorization Payment challenge request missing methodDetails");
  }
  const chainId = (methodDetails as Record<string, unknown>).chainId;
  if (typeof chainId !== "number" || !Number.isInteger(chainId)) {
    throw new Error("Authorization Payment challenge request missing methodDetails.chainId");
  }

  return {
    amount: asNonEmptyString(request.amount, "request.amount"),
    chainId,
    assetAddress: asNonEmptyString(request.currency, "request.currency"),
    recipient: asNonEmptyString(request.recipient, "request.recipient")
  };
}
