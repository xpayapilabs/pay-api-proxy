import type { DatabaseSync } from "node:sqlite";
import type { PaidCallAudit, PaidCallQuery } from "../core/audit.js";

export interface RequestRecord {
  id: string;
  model: string;
  status: string;
  inputTokensEstimate: number;
  maxOutputTokens: number;
  maxCharge: string;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  actualUsageAmount?: string;
  errorCode?: string;
  createdAt: string;
  completedAt?: string;
}

export interface PaymentRecord {
  id: string;
  requestId?: string;
  protocol: string;
  chainId: number;
  assetAddress: string;
  credentialType: string;
  credentialHash: string;
  settlementTx?: string;
  status: string;
  settlementVerification: string;
  prepaidMaxAmount: string;
  settledAmount?: string;
  actualUsageAmount?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentSessionRecord {
  id: string;
  customerId: string;
  paymentId: string;
  protocol: string;
  chainId: number;
  assetAddress: string;
  settlementAddress: string;
  credentialHash: string;
  authorizedMaxAmount: string;
  remainingAuthorizedAmount: string;
  reservedAmount: string;
  settledAmount: string;
  expiresAt: string;
  allowedModels: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentReservationRecord {
  id: string;
  sessionId: string;
  requestId: string;
  customerId: string;
  requestHash: string;
  reservedAmount: string;
  actualAmount?: string;
  releasedAmount?: string;
  status: string;
  createdAt: string;
  settledAt?: string;
}

export interface ReceiptRecord {
  id: string;
  requestId: string;
  paymentId?: string;
  receiptJson: string;
  receiptHash: string;
  signature: string;
  status: string;
  createdAt: string;
}

export type ReserveSessionResult =
  | { kind: "reserved"; reservation: PaymentReservationRecord }
  | { kind: "existing"; reservation: PaymentReservationRecord }
  | { kind: "not_found" }
  | { kind: "wrong_customer" }
  | { kind: "inactive" }
  | { kind: "expired" }
  | { kind: "model_not_allowed" }
  | { kind: "insufficient_funds" }
  | { kind: "mutated_request" };

function now(): string {
  return new Date().toISOString();
}

export class Repository {
  constructor(private readonly db: DatabaseSync) {}

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ROLLBACK after a failed statement may itself error; safe to ignore.
      }
      throw error;
    }
  }

  createRequest(record: Omit<RequestRecord, "createdAt">): RequestRecord {
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO requests (
        id, model, status, input_tokens_estimate, max_output_tokens, max_charge,
        actual_input_tokens, actual_output_tokens, actual_usage_amount, error_code,
        created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.model,
      record.status,
      record.inputTokensEstimate,
      record.maxOutputTokens,
      record.maxCharge,
      record.actualInputTokens ?? null,
      record.actualOutputTokens ?? null,
      record.actualUsageAmount ?? null,
      record.errorCode ?? null,
      createdAt,
      record.completedAt ?? null
    );

    return { ...record, createdAt };
  }

  completeRequest(id: string, inputTokens: number, outputTokens: number, actualUsageAmount: string): void {
    this.db.prepare(`
      UPDATE requests
      SET status = 'completed',
          actual_input_tokens = ?,
          actual_output_tokens = ?,
          actual_usage_amount = ?,
          completed_at = ?
      WHERE id = ?
    `).run(inputTokens, outputTokens, actualUsageAmount, now(), id);
  }

  failRequest(id: string, errorCode: string): void {
    this.db.prepare(`
      UPDATE requests
      SET status = 'failed', error_code = ?, completed_at = ?
      WHERE id = ?
    `).run(errorCode, now(), id);
  }

  getRequest(id: string): RequestRecord | undefined {
    const row = this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapRequest(row) : undefined;
  }

  createPayment(record: Omit<PaymentRecord, "createdAt" | "updatedAt">): PaymentRecord {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO payments (
        id, request_id, protocol, chain_id, asset_address, credential_type, credential_hash,
        settlement_tx, status, settlement_verification, prepaid_max_amount, settled_amount, actual_usage_amount,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.requestId ?? null,
      record.protocol,
      record.chainId,
      record.assetAddress,
      record.credentialType,
      record.credentialHash,
      record.settlementTx ?? null,
      record.status,
      record.settlementVerification,
      record.prepaidMaxAmount,
      record.settledAmount ?? null,
      record.actualUsageAmount ?? null,
      timestamp,
      timestamp
    );

    return { ...record, createdAt: timestamp, updatedAt: timestamp };
  }

  updatePaymentUsage(id: string, actualUsageAmount: string): void {
    this.db.prepare(`
      UPDATE payments
      SET actual_usage_amount = ?, updated_at = ?
      WHERE id = ?
    `).run(actualUsageAmount, now(), id);
  }

  expirePendingPayments(createdAtCutoff: string): number {
    const result = this.db.prepare(`
      UPDATE payments
      SET status = 'expired', updated_at = ?
      WHERE status = 'pending' AND created_at < ?
    `).run(now(), createdAtCutoff);
    return Number(result.changes ?? 0);
  }

  countPaymentsByStatus(status: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM payments WHERE status = ?").get(status) as
      | { count: number | bigint }
      | undefined;
    return row ? Number(row.count) : 0;
  }

  findPaymentByCredentialHash(credentialHash: string): PaymentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM payments WHERE credential_hash = ?").get(credentialHash) as
      | Record<string, unknown>
      | undefined;
    return row ? mapPayment(row) : undefined;
  }

  getPayment(id: string): PaymentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM payments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapPayment(row) : undefined;
  }

  createPaymentSession(record: Omit<PaymentSessionRecord, "createdAt" | "updatedAt">): PaymentSessionRecord {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO payment_sessions (
        id, customer_id, payment_id, protocol, chain_id, asset_address, settlement_address,
        credential_hash, authorized_max_amount, remaining_authorized_amount, reserved_amount,
        settled_amount, expires_at, allowed_models, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.customerId,
      record.paymentId,
      record.protocol,
      record.chainId,
      record.assetAddress,
      record.settlementAddress,
      record.credentialHash,
      record.authorizedMaxAmount,
      record.remainingAuthorizedAmount,
      record.reservedAmount,
      record.settledAmount,
      record.expiresAt,
      JSON.stringify(record.allowedModels),
      record.status,
      timestamp,
      timestamp
    );

    return { ...record, createdAt: timestamp, updatedAt: timestamp };
  }

  getPaymentSession(id: string): PaymentSessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM payment_sessions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapPaymentSession(row) : undefined;
  }

  findPaymentSessionByCredentialHash(credentialHash: string): PaymentSessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM payment_sessions WHERE credential_hash = ?").get(credentialHash) as
      | Record<string, unknown>
      | undefined;
    return row ? mapPaymentSession(row) : undefined;
  }

  revokePaymentSession(id: string, customerId: string): boolean {
    const result = this.db.prepare(`
      UPDATE payment_sessions
      SET status = 'revoked', updated_at = ?
      WHERE id = ? AND customer_id = ? AND status = 'active'
    `).run(now(), id, customerId);
    return Number(result.changes ?? 0) > 0;
  }

  reservePaymentSession(params: {
    sessionId: string;
    reservationId: string;
    requestId: string;
    customerId: string;
    requestHash: string;
    model: string;
    amount: string;
  }): ReserveSessionResult {
    const existing = this.getPaymentReservationByRequestId(params.requestId);
    if (existing) {
      if (
        existing.sessionId !== params.sessionId ||
        existing.customerId !== params.customerId ||
        existing.requestHash !== params.requestHash
      ) {
        return { kind: "mutated_request" };
      }
      return { kind: "existing", reservation: existing };
    }

    const session = this.getPaymentSession(params.sessionId);
    if (!session) return { kind: "not_found" };
    if (session.customerId !== params.customerId) return { kind: "wrong_customer" };
    if (session.status !== "active") return { kind: "inactive" };
    const expiresAtMs = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return { kind: "expired" };
    if (session.allowedModels.length > 0 && !session.allowedModels.includes(params.model)) {
      return { kind: "model_not_allowed" };
    }

    const amount = BigInt(params.amount);
    const remaining = BigInt(session.remainingAuthorizedAmount);
    if (amount > remaining) return { kind: "insufficient_funds" };

    const reserved = BigInt(session.reservedAmount);
    const timestamp = now();
    this.db.prepare(`
      UPDATE payment_sessions
      SET remaining_authorized_amount = ?,
          reserved_amount = ?,
          updated_at = ?
      WHERE id = ?
    `).run((remaining - amount).toString(), (reserved + amount).toString(), timestamp, params.sessionId);

    this.db.prepare(`
      INSERT INTO payment_reservations (
        id, session_id, request_id, customer_id, request_hash, reserved_amount,
        actual_amount, released_amount, status, created_at, settled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.reservationId,
      params.sessionId,
      params.requestId,
      params.customerId,
      params.requestHash,
      params.amount,
      null,
      null,
      "reserved",
      timestamp,
      null
    );

    const reservation = this.getPaymentReservation(params.reservationId);
    if (!reservation) throw new Error("Created reservation could not be loaded");
    return { kind: "reserved", reservation };
  }

  settlePaymentReservation(id: string, actualAmount: string): PaymentReservationRecord {
    const reservation = this.getPaymentReservation(id);
    if (!reservation) throw new Error("Reservation not found");
    if (reservation.status !== "reserved") return reservation;

    const session = this.getPaymentSession(reservation.sessionId);
    if (!session) throw new Error("Reservation session not found");

    const reserved = BigInt(reservation.reservedAmount);
    const requestedActual = BigInt(actualAmount);
    const actual = requestedActual > reserved ? reserved : requestedActual;
    const released = reserved - actual;
    const timestamp = now();

    this.db.prepare(`
      UPDATE payment_reservations
      SET actual_amount = ?,
          released_amount = ?,
          status = 'settled',
          settled_at = ?
      WHERE id = ?
    `).run(actual.toString(), released.toString(), timestamp, id);

    this.db.prepare(`
      UPDATE payment_sessions
      SET remaining_authorized_amount = ?,
          reserved_amount = ?,
          settled_amount = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      (BigInt(session.remainingAuthorizedAmount) + released).toString(),
      (BigInt(session.reservedAmount) - reserved).toString(),
      (BigInt(session.settledAmount) + actual).toString(),
      timestamp,
      session.id
    );

    const updated = this.getPaymentReservation(id);
    if (!updated) throw new Error("Settled reservation could not be loaded");
    return updated;
  }

  releasePaymentReservation(id: string): PaymentReservationRecord | undefined {
    const reservation = this.getPaymentReservation(id);
    if (!reservation) return undefined;
    if (reservation.status !== "reserved") return reservation;

    const session = this.getPaymentSession(reservation.sessionId);
    if (!session) throw new Error("Reservation session not found");

    const reserved = BigInt(reservation.reservedAmount);
    const timestamp = now();
    this.db.prepare(`
      UPDATE payment_reservations
      SET actual_amount = '0',
          released_amount = ?,
          status = 'released',
          settled_at = ?
      WHERE id = ?
    `).run(reservation.reservedAmount, timestamp, id);

    this.db.prepare(`
      UPDATE payment_sessions
      SET remaining_authorized_amount = ?,
          reserved_amount = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      (BigInt(session.remainingAuthorizedAmount) + reserved).toString(),
      (BigInt(session.reservedAmount) - reserved).toString(),
      timestamp,
      session.id
    );

    return this.getPaymentReservation(id);
  }

  getPaymentReservation(id: string): PaymentReservationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM payment_reservations WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapPaymentReservation(row) : undefined;
  }

  getPaymentReservationByRequestId(requestId: string): PaymentReservationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM payment_reservations WHERE request_id = ?").get(requestId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapPaymentReservation(row) : undefined;
  }

  listPaymentReservations(sessionId: string, customerId: string): PaymentReservationRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM payment_reservations
      WHERE session_id = ? AND customer_id = ?
      ORDER BY created_at DESC
    `).all(sessionId, customerId) as Record<string, unknown>[];
    return rows.map(mapPaymentReservation);
  }

  createReceipt(record: Omit<ReceiptRecord, "createdAt">): ReceiptRecord {
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO receipts (
        id, request_id, payment_id, receipt_json, receipt_hash, signature, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.requestId,
      record.paymentId ?? null,
      record.receiptJson,
      record.receiptHash,
      record.signature,
      record.status,
      createdAt
    );

    return { ...record, createdAt };
  }

  getReceipt(id: string): ReceiptRecord | undefined {
    const row = this.db.prepare("SELECT * FROM receipts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapReceipt(row) : undefined;
  }

  recordPaidCallAudit(record: PaidCallAudit): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO audit_calls (
        id, created_at, completed_at, api_id, route_id, method, path, upstream_path,
        status, paid, payment_verified, receipt_attached,
        payment_method, payment_reference, external_id, receipt_timestamp, payment_verified_at,
        request_price, asset_symbol, asset_address, asset_decimals, chain_id,
        refund_status, refund_reason, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.createdAt,
      record.completedAt ?? null,
      record.apiId ?? null,
      record.routeId ?? null,
      record.method,
      record.path,
      record.upstreamPath ?? null,
      record.status,
      record.paid ? 1 : 0,
      record.paymentVerified ? 1 : 0,
      record.receiptAttached ? 1 : 0,
      record.paymentMethod ?? null,
      record.paymentReference ?? null,
      record.externalId ?? null,
      record.receiptTimestamp ?? null,
      record.paymentVerifiedAt ?? null,
      record.requestPrice ?? null,
      record.assetSymbol ?? null,
      record.assetAddress ?? null,
      record.assetDecimals ?? null,
      record.chainId ?? null,
      record.refundStatus,
      record.refundReason ?? null,
      record.durationMs ?? null
    );
  }

  listPaidCallAudits(query: PaidCallQuery = {}): PaidCallAudit[] {
    const clauses: string[] = [];
    const bindings: string[] = [];
    if (query.since) { clauses.push("created_at >= ?"); bindings.push(query.since); }
    if (query.apiId) { clauses.push("api_id = ?"); bindings.push(query.apiId); }
    if (query.reference) { clauses.push("payment_reference = ?"); bindings.push(query.reference); }
    if (query.refundStatus) { clauses.push("refund_status = ?"); bindings.push(query.refundStatus); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = clampAuditLimit(query.limit);
    const rows = this.db.prepare(`
      SELECT * FROM audit_calls ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...bindings, limit) as Record<string, unknown>[];
    return rows.map(mapPaidCallAudit);
  }
}

function asString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function mapRequest(row: Record<string, unknown>): RequestRecord {
  return {
    id: String(row.id),
    model: String(row.model),
    status: String(row.status),
    inputTokensEstimate: Number(row.input_tokens_estimate),
    maxOutputTokens: Number(row.max_output_tokens),
    maxCharge: String(row.max_charge),
    actualInputTokens: row.actual_input_tokens === null ? undefined : Number(row.actual_input_tokens),
    actualOutputTokens: row.actual_output_tokens === null ? undefined : Number(row.actual_output_tokens),
    actualUsageAmount: asString(row.actual_usage_amount),
    errorCode: asString(row.error_code),
    createdAt: String(row.created_at),
    completedAt: asString(row.completed_at)
  };
}

function mapPayment(row: Record<string, unknown>): PaymentRecord {
  return {
    id: String(row.id),
    requestId: asString(row.request_id),
    protocol: String(row.protocol),
    chainId: Number(row.chain_id),
    assetAddress: String(row.asset_address),
    credentialType: String(row.credential_type),
    credentialHash: String(row.credential_hash),
    settlementTx: asString(row.settlement_tx),
    status: String(row.status),
    settlementVerification: String(row.settlement_verification ?? "test"),
    prepaidMaxAmount: String(row.prepaid_max_amount),
    settledAmount: asString(row.settled_amount),
    actualUsageAmount: asString(row.actual_usage_amount),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapPaymentSession(row: Record<string, unknown>): PaymentSessionRecord {
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    paymentId: String(row.payment_id),
    protocol: String(row.protocol),
    chainId: Number(row.chain_id),
    assetAddress: String(row.asset_address),
    settlementAddress: String(row.settlement_address),
    credentialHash: String(row.credential_hash),
    authorizedMaxAmount: String(row.authorized_max_amount),
    remainingAuthorizedAmount: String(row.remaining_authorized_amount),
    reservedAmount: String(row.reserved_amount),
    settledAmount: String(row.settled_amount),
    expiresAt: String(row.expires_at),
    allowedModels: parseStringArray(row.allowed_models),
    status: String(row.status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapPaymentReservation(row: Record<string, unknown>): PaymentReservationRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    requestId: String(row.request_id),
    customerId: String(row.customer_id),
    requestHash: String(row.request_hash),
    reservedAmount: String(row.reserved_amount),
    actualAmount: asString(row.actual_amount),
    releasedAmount: asString(row.released_amount),
    status: String(row.status),
    createdAt: String(row.created_at),
    settledAt: asString(row.settled_at)
  };
}

function mapReceipt(row: Record<string, unknown>): ReceiptRecord {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    paymentId: asString(row.payment_id),
    receiptJson: String(row.receipt_json),
    receiptHash: String(row.receipt_hash),
    signature: String(row.signature),
    status: String(row.status),
    createdAt: String(row.created_at)
  };
}

function mapPaidCallAudit(row: Record<string, unknown>): PaidCallAudit {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    completedAt: asString(row.completed_at),
    apiId: asString(row.api_id),
    routeId: asString(row.route_id),
    method: String(row.method),
    path: String(row.path),
    upstreamPath: asString(row.upstream_path),
    status: Number(row.status),
    paid: Number(row.paid) === 1,
    paymentVerified: Number(row.payment_verified) === 1,
    receiptAttached: Number(row.receipt_attached) === 1,
    paymentMethod: asString(row.payment_method),
    paymentReference: asString(row.payment_reference),
    externalId: asString(row.external_id),
    receiptTimestamp: asString(row.receipt_timestamp),
    paymentVerifiedAt: asString(row.payment_verified_at),
    requestPrice: asString(row.request_price),
    assetSymbol: asString(row.asset_symbol),
    assetAddress: asString(row.asset_address),
    assetDecimals: row.asset_decimals === null || row.asset_decimals === undefined ? undefined : Number(row.asset_decimals),
    chainId: row.chain_id === null || row.chain_id === undefined ? undefined : Number(row.chain_id),
    refundStatus: String(row.refund_status) as PaidCallAudit["refundStatus"],
    refundReason: asString(row.refund_reason),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms)
  };
}

function clampAuditLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) return 100;
  return Math.min(Math.floor(value), 1000);
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
