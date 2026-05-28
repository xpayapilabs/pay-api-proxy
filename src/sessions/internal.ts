import { createHash } from "node:crypto";
import type { FastifyReply } from "fastify";
import { nanoid } from "nanoid";
import { bigintToString } from "../core/money.js";
import type { PaymentReservationRecord, Repository } from "../db/repository.js";
import { buildSignedReceipt, stableJson } from "../receipts/receipt.js";
import type {
  ReceiptInput,
  ReceiptOutput,
  ReserveInput,
  ReserveOutcome,
  SessionAuthorization,
  SessionBackend,
  SettleInput,
  SettleOutcome
} from "./types.js";

const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9_-]{1,64}$/;
const CUSTOMER_ID_PATTERN = /^cust_[A-Za-z0-9_-]{1,64}$/;

interface InternalAuthorization extends SessionAuthorization {
  kind: "internal";
  sessionId: string;
  customerId: string;
  reservation: PaymentReservationRecord;
}

interface InternalSettleContext {
  settledReservation: PaymentReservationRecord;
}

export class InternalSessionBackend implements SessionBackend {
  readonly name = "internal" as const;

  constructor(private readonly repository: Repository, private readonly signingSecret: string) {}

  async reserve(input: ReserveInput): Promise<ReserveOutcome> {
    const sessionId = firstHeaderValue(input.request.headers["x-mpp-session-id"]);
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
      return { kind: "error", status: 400, code: "invalid_session_id", message: "x-mpp-session-id must match sess_[A-Za-z0-9_-]{1,64}" };
    }
    const customerId = firstHeaderValue(input.request.headers["x-customer-id"]);
    if (!customerId) {
      return { kind: "error", status: 400, code: "missing_customer_id", message: "x-customer-id is required for session-backed requests" };
    }
    if (!CUSTOMER_ID_PATTERN.test(customerId)) {
      return { kind: "error", status: 400, code: "invalid_customer_id", message: "x-customer-id must match cust_[A-Za-z0-9_-]{1,64}" };
    }

    const requestHash = canonicalRequestHash({
      endpoint: input.endpoint,
      body: input.body,
      model: input.model.modelName,
      customer_id: customerId,
      session_id: sessionId,
      request_id: input.requestId
    });
    const reservationId = `rsv_${nanoid(16)}`;

    try {
      const reservation = this.repository.transaction(() => {
        const existingRequest = this.repository.getRequest(input.requestId);
        if (!existingRequest) {
          this.repository.createRequest({
            id: input.requestId,
            model: input.model.modelName,
            status: "running",
            inputTokensEstimate: input.quote.inputTokensEstimate,
            maxOutputTokens: input.quote.maxOutputTokens,
            maxCharge: bigintToString(input.sessionQuote.reservedAmount)
          });
        }
        const outcome = this.repository.reservePaymentSession({
          sessionId,
          reservationId,
          requestId: input.requestId,
          customerId,
          requestHash,
          model: input.model.modelName,
          amount: bigintToString(input.sessionQuote.reservedAmount)
        });
        if (outcome.kind === "reserved") return outcome.reservation;
        if (outcome.kind === "existing" && existingRequest?.status === "running") return outcome.reservation;
        if (outcome.kind === "existing" && existingRequest?.status === "failed") {
          throw new SessionReservationError("request_previously_failed");
        }
        throw new SessionReservationError(outcome.kind);
      });

      const authorization: InternalAuthorization = {
        kind: "internal",
        sessionId,
        customerId,
        reservation
      };
      return { kind: "reserved", authorization };
    } catch (error) {
      if (error instanceof SessionReservationError) {
        return {
          kind: "error",
          status: sessionReservationStatus(error.kind),
          code: error.kind,
          message: sessionReservationMessage(error.kind)
        };
      }
      throw error;
    }
  }

  async settle(input: SettleInput): Promise<SettleOutcome> {
    const auth = input.authorization as InternalAuthorization;
    const settledReservation = this.repository.transaction(() => {
      const settled = this.repository.settlePaymentReservation(auth.reservation.id, input.settlement.totalAmount.toString());
      this.repository.completeRequest(input.requestId, input.usage.inputTokens, input.usage.outputTokens, settled.actualAmount ?? "0");
      return settled;
    });
    return { context: { settledReservation } satisfies InternalSettleContext };
  }

  async release(authorization: SessionAuthorization, requestId: string): Promise<void> {
    const auth = authorization as InternalAuthorization;
    this.repository.transaction(() => {
      this.repository.releasePaymentReservation(auth.reservation.id);
      this.repository.failRequest(requestId, "upstream_error");
    });
  }

  buildReceiptAndHeaders(input: ReceiptInput): ReceiptOutput {
    const auth = input.authorization as InternalAuthorization;
    const { settledReservation } = input.settle.context as InternalSettleContext;

    const completedRequest = this.repository.getRequest(input.requestId);
    const session = this.repository.getPaymentSession(auth.sessionId);
    const payment = session ? this.repository.getPayment(session.paymentId) : undefined;
    if (!completedRequest || !session || !payment) {
      throw new Error("Completed session records could not be loaded");
    }

    const signedReceipt = buildSignedReceipt(
      completedRequest,
      payment,
      this.signingSecret,
      `rcpt_${nanoid(16)}`,
      session,
      settledReservation
    );

    const status: "pending" | "final" =
      payment.status === "settled" && payment.settlementVerification === "onchain" ? "final" : "pending";

    return {
      receiptId: signedReceipt.payload.receipt_id,
      receiptHash: signedReceipt.receiptHash,
      signature: signedReceipt.signature,
      payloadJson: stableJson(signedReceipt.payload),
      paymentId: payment.id,
      status,
      applyHeaders: (reply: FastifyReply) => {
        reply
          .header("x-paid-receipt-id", signedReceipt.payload.receipt_id)
          .header("x-mpp-session-id", auth.sessionId)
          .header("x-mpp-reservation-id", settledReservation.id)
          .header("x-session-billing-unit-type", input.settlement.unitType)
          .header("x-session-billing-units", input.settlement.totalUnits.toString());
      }
    };
  }
}

class SessionReservationError extends Error {
  constructor(readonly kind: string) {
    super(kind);
  }
}

function sessionReservationStatus(kind: string): number {
  if (kind === "not_found" || kind === "wrong_customer") return 404;
  if (kind === "insufficient_funds") return 402;
  if (kind === "mutated_request" || kind === "request_previously_failed") return 409;
  return 400;
}

function sessionReservationMessage(kind: string): string {
  const messages: Record<string, string> = {
    not_found: "Payment session not found",
    wrong_customer: "Payment session does not belong to this customer",
    inactive: "Payment session is not active",
    expired: "Payment session is expired",
    model_not_allowed: "Payment session does not allow this model",
    insufficient_funds: "Payment session has insufficient available balance",
    mutated_request: "Request id was already reserved for different session request details",
    request_previously_failed: "Request id belongs to a failed upstream attempt; retry with a new x-paid-request-id"
  };
  return messages[kind] ?? "Payment session reservation failed";
}

function canonicalRequestHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function firstHeaderValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}
