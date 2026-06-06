import type { PaidCallAudit, PaidCallQuery, PaidCallRefundUpdate } from "../../core/audit.js";
import type { DurableObjectStubLike } from "./storage-durable-object.js";

/**
 * A single paid (or free) HTTP call recorded for the operator audit trail.
 *
 * The mppx `Payment-Receipt` header does not carry the payer address or amount
 * directly — those are resolvable on-chain via `paymentReference` (the settlement
 * transaction reference). `externalId` is the `api:<apiId>:<routeId>` tag the proxy
 * attaches when charging, so a row identifies which route was billed.
 */

const AUDIT_ORIGIN = "https://mppx-store.local";

export async function recordPaidCall(
  stub: DurableObjectStubLike,
  audit: PaidCallAudit
): Promise<void> {
  const response = await stub.fetch(`${AUDIT_ORIGIN}/audit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(audit)
  });
  if (!response.ok) throw new Error(`audit insert failed: ${response.status}`);
}

export async function queryPaidCalls(
  stub: DurableObjectStubLike,
  query: PaidCallQuery = {}
): Promise<PaidCallAudit[]> {
  const params = new URLSearchParams();
  if (query.since) params.set("since", query.since);
  if (query.apiId) params.set("apiId", query.apiId);
  if (query.reference) params.set("reference", query.reference);
  if (query.refundStatus) params.set("refundStatus", query.refundStatus);
  if (query.limit) params.set("limit", String(query.limit));
  const response = await stub.fetch(`${AUDIT_ORIGIN}/audit?${params.toString()}`);
  if (!response.ok) throw new Error(`audit query failed: ${response.status}`);
  return await response.json() as PaidCallAudit[];
}

export async function updatePaidCallRefund(
  stub: DurableObjectStubLike,
  id: string,
  update: PaidCallRefundUpdate
): Promise<PaidCallAudit | undefined> {
  const response = await stub.fetch(`${AUDIT_ORIGIN}/audit/${encodeURIComponent(id)}/refund`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update)
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`audit refund update failed: ${response.status}`);
  return await response.json() as PaidCallAudit;
}
