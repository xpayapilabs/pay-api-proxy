# Refund Auditing

Traditional paid APIs charge before the upstream request is forwarded. When a
paid request finishes with a `5xx` response, the proxy records the call with
`refundStatus: "pending"` so an operator can review and manually refund it.

The proxy does not send refund transactions automatically.

## Find Refund Candidates

Use the admin endpoint on either Node/Fargate or Cloudflare Workers:

```bash
curl -H "Authorization: Bearer $MPP_SECRET_KEY" \
  "https://example.com/admin/calls?refundStatus=pending"
```

Important fields:

- `id`: audit row id used by the update endpoint.
- `paymentReference`: payment transaction/reference to verify on-chain.
- `requestPrice`, `assetAddress`, `assetDecimals`, `chainId`: configured charge details.
- `apiId`, `routeId`, `path`, `status`, `refundReason`: why the row needs review.

## Mark A Manual Refund

After sending the refund from the operator wallet, record the refund transaction
or reference:

```bash
curl -X PATCH "https://example.com/admin/calls/audit_row_id/refund" \
  -H "Authorization: Bearer $MPP_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "refundStatus": "refunded",
    "refundReference": "0xrefundtxhash",
    "refundReason": "manual_refund_sent",
    "refundNote": "Refunded after upstream 500."
  }'
```

Use `"refundStatus": "rejected"` when review decides no refund is owed. Use
`"pending"` to correct metadata without closing the review.

For `refunded`, `refundedAt` defaults to the current server time. You may provide
it explicitly:

```json
{
  "refundStatus": "refunded",
  "refundReference": "0xrefundtxhash",
  "refundedAt": "2026-06-06T12:00:00.000Z"
}
```

## Node/Fargate Direct SQLite Update

The admin endpoint is preferred, but for Node/Fargate you can also update the
SQLite database directly if you have shell access to the mounted database file:

```sql
UPDATE audit_calls
SET refund_status = 'refunded',
    refund_reference = '0xrefundtxhash',
    refund_reason = 'manual_refund_sent',
    refunded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    refund_note = 'Refunded after upstream 500.'
WHERE id = 'audit_row_id';
```

Reject a candidate:

```sql
UPDATE audit_calls
SET refund_status = 'rejected',
    refund_reason = 'not_operator_error',
    refund_note = 'Reviewed; no refund owed.'
WHERE id = 'audit_row_id';
```

## Cloudflare Durable Object Storage

Do not try to manually edit Durable Object SQLite storage. Use the admin endpoint:

```bash
curl -X PATCH "https://example.com/admin/calls/audit_row_id/refund" \
  -H "Authorization: Bearer $MPP_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"refundStatus":"refunded","refundReference":"0xrefundtxhash"}'
```

The Worker forwards the update to the `MppxStoreDurableObject`, which persists
`refund_status`, `refund_reference`, `refunded_at`, `refund_reason`, and
`refund_note` with the original audit row.
