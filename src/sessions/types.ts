import type { FastifyReply, FastifyRequest } from "fastify";
import type { ActualUsageAmount, PriceQuote } from "../charging/index.js";
import type { SessionReservationQuote, SessionSettlementAmount } from "../charging/session-meter.js";
import type { AppConfig } from "../core/config.js";
import type { ModelConfig } from "../core/models.js";
import type { TokenUsage } from "../core/tokenizer.js";

/**
 * SessionBackend is the abstraction over different funding/settlement systems.
 * Today there are two implementations:
 *   - InternalSessionBackend: customer pre-funds a session via POST /v1/payment-sessions
 *     and bills against it with x-mpp-session-id headers.
 *   - MppxSessionBackend: customer attaches an mppx Authorization Payment credential
 *     directly to the billed endpoint; mppx handles the channel/voucher lifecycle.
 *
 * The generic endpoint handler delegates reservation, settlement, release, and
 * receipt/header production to the selected backend. The backend owns the
 * idempotency contract around request_id (because mppx authorizes before request
 * record creation, whereas internal sessions reserve and create in one transaction).
 */
export interface SessionBackend {
  readonly name: SessionBackendName;

  /**
   * Reserve session funds for this request. Returns one of:
   * - `raw_response`: backend produced its own HTTP response (mppx 402 / management);
   *   the handler should forward it verbatim and stop.
   * - `error`: caller error in OpenAI style (the handler will translate to JSON).
   * - `reserved`: success — handler should proceed to call the upstream.
   *
   * The backend is responsible for creating the request DB record atomically with
   * (or immediately after) the reservation, releasing the reservation on conflict.
   */
  reserve(input: ReserveInput): Promise<ReserveOutcome>;

  /**
   * Settle the reservation to actual usage and mark the request completed.
   * Returns an opaque settle result that buildReceiptAndHeaders consumes.
   */
  settle(input: SettleInput): Promise<SettleOutcome>;

  /**
   * Roll back the reservation (best effort) and mark the request failed.
   * Called on upstream errors.
   */
  release(authorization: SessionAuthorization, requestId: string): Promise<void>;

  /**
   * Produce a signed receipt and apply backend-specific response headers.
   * The receipt is persisted by the handler before the body is sent.
   */
  buildReceiptAndHeaders(input: ReceiptInput): ReceiptOutput;
}

export type SessionBackendName = "internal" | "mppx";

export interface ReserveInput {
  request: FastifyRequest;
  body: Record<string, unknown>;
  model: ModelConfig;
  requestId: string;
  quote: PriceQuote;
  sessionQuote: SessionReservationQuote;
  endpoint: string;
}

export type ReserveOutcome =
  | { kind: "reserved"; authorization: SessionAuthorization }
  | { kind: "raw_response"; response: Response }
  | { kind: "error"; status: number; code: string; message: string };

export interface SettleInput {
  authorization: SessionAuthorization;
  settlement: SessionSettlementAmount;
  usage: TokenUsage;
  requestId: string;
}

export interface SettleOutcome {
  /** Backend-specific opaque settle context, passed back into buildReceiptAndHeaders. */
  context: unknown;
}

export interface ReceiptInput {
  authorization: SessionAuthorization;
  settle: SettleOutcome;
  settlement: SessionSettlementAmount;
  actual: ActualUsageAmount;
  usage: TokenUsage;
  requestId: string;
  model: ModelConfig;
  config: AppConfig;
}

export interface ReceiptOutput {
  receiptId: string;
  receiptHash: string;
  signature: string;
  payloadJson: string;
  paymentId?: string;
  status: "pending" | "final";
  applyHeaders(reply: FastifyReply): void;
}

/**
 * Opaque per-backend reservation handle. Backends discriminate on `kind` internally.
 * Stored only in the request's local scope between reserve and settle/release.
 */
export type SessionAuthorization = { kind: SessionBackendName } & Record<string, unknown>;
