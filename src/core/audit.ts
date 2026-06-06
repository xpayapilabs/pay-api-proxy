export type RefundStatus = "not_applicable" | "pending" | "refunded" | "rejected";

export interface PaidCallAudit {
  id: string;
  createdAt: string;
  completedAt?: string;
  apiId?: string;
  routeId?: string;
  method: string;
  path: string;
  upstreamPath?: string;
  status: number;
  paid: boolean;
  paymentVerified: boolean;
  receiptAttached: boolean;
  paymentMethod?: string;
  paymentReference?: string;
  externalId?: string;
  receiptTimestamp?: string;
  paymentVerifiedAt?: string;
  requestPrice?: string;
  assetSymbol?: string;
  assetAddress?: string;
  assetDecimals?: number;
  chainId?: number;
  refundStatus: RefundStatus;
  refundReason?: string;
  durationMs?: number;
}

export interface PaidCallQuery {
  /** ISO timestamp lower bound (inclusive), e.g. yesterday. */
  since?: string;
  /** Restrict to a single configured API id. */
  apiId?: string;
  /** Look up by settlement transaction reference. */
  reference?: string;
  /** Filter pending refund work. */
  refundStatus?: RefundStatus;
  /** Max rows (clamped server-side). */
  limit?: number;
}

export interface PaidCallAuditSink {
  record(audit: PaidCallAudit): Promise<void> | void;
}

export function refundStatusForPaidCall(params: { paid: boolean; status: number }): {
  refundStatus: RefundStatus;
  refundReason?: string;
} {
  if (!params.paid || params.status < 500) {
    return { refundStatus: "not_applicable" };
  }
  return {
    refundStatus: "pending",
    refundReason: `paid_response_${params.status}`
  };
}

export function parseRefundStatus(value: unknown): RefundStatus | undefined {
  if (
    value === "not_applicable" ||
    value === "pending" ||
    value === "refunded" ||
    value === "rejected"
  ) {
    return value;
  }
  return undefined;
}
