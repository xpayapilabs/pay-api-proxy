# Architecture Plan

## MVP Architecture Choice

Use a one-command installer that runs Docker Compose under the hood.

The operator experience should be:

```bash
curl -fsSL https://install.pay-api-proxy.example/install.sh | bash
```

The installer handles Docker installation, app configuration, service startup, TLS, and upgrade hooks. The user should not need to know Docker.

## Deployment Topology

```text
Internet
  |
  v
Caddy reverse proxy
  |
  +--> Public API server
  |      - OpenAI-compatible API
  |      - Payment challenge and verification
  |      - Usage metering
  |
  +--> Admin web server
         - Setup wizard
         - Dashboard

Background worker
  - Payment settlement polling
  - Receipt finalization
  - Usage reconciliation

SQLite database volume
  - Config
  - Requests
  - Usage
  - Payments
  - Receipts
```

## Docker Compose Services

### `app`

Main Node.js service.

Responsibilities:

- Serve `/v1/*` OpenAI-compatible endpoints.
- Serve admin UI and setup wizard.
- Validate customer API keys when enabled.
- Enforce payment requirements.
- Forward requests to upstream AI providers.
- Store request, payment, usage, and receipt records.
- Expose health checks.

### `worker`

Background processing service using the same application image.

Responsibilities:

- Poll payment settlement status.
- Retry interrupted broadcasts/finalizations.
- Reconcile usage records with payment records.
- Mark receipts final after payment confirmation.
- Emit audit/system events.

### `caddy`

Public reverse proxy.

Responsibilities:

- Automatic HTTPS when a domain is configured.
- Route public API traffic.
- Route admin traffic.
- Apply basic request size and timeout limits.

### `db`

For MVP, prefer SQLite in a mounted Docker volume.

Reason:

- Fewer moving parts for non-technical users.
- Easy backup as a single file.
- Good enough for one self-hosted node.

Move to Postgres later when supporting high volume, multi-node clustering, hosted control planes, or richer analytics.

## Core Request Flow

### Paid API Call

1. Customer calls `POST /v1/chat/completions`.
2. API server loads model and pricing rule.
3. API server validates request limits and resolves `max_tokens`.
4. API server estimates maximum charge from estimated input tokens plus `max_tokens`.
5. API server checks the MPP/x402 payment credential.
6. If payment is missing or insufficient, return HTTP `402 Payment Required` with amount, asset, chain, memo, and supported credential types.
7. Customer signs a Tempo MPP payment transaction offchain or broadcasts the transaction directly.
8. Customer retries with a payment credential header.
9. API server verifies the payment credential and records the settlement reference.
10. If payment is valid, create a request record.
11. Proxy request to upstream AI provider.
12. Stream response to customer if requested.
13. Capture final token usage.
14. Calculate actual usage amount for the receipt.
15. Generate signed usage receipt.
16. Return receipt reference in response headers and make the full receipt retrievable.

For the first Tempo testnet MVP, the paid amount is the pre-estimated maximum. The receipt must show both the prepaid maximum and actual usage amount. A later Tempo session milestone should reduce overpayment by authorizing a bounded spend envelope, reserving per request, and settling the final usage amount when the request completes.

### Paid Media Call With Tempo Session

Image and video endpoints should use Tempo sessions once sessions are available. Media requests do not fit the current token-only `max_tokens` quote model, and video jobs may complete asynchronously after the initial HTTP request returns.

1. Customer authenticates with an API key or other customer credential.
2. Customer creates or presents a Tempo session that authorizes a maximum spend, accepted asset, settlement address, expiry, and allowed endpoint/model scope.
3. Customer calls a paid media endpoint, for example `POST /v1/images/generations`, `POST /v1/images/edits`, or `POST /v1/videos`, with `x-tempo-session-id`.
4. API server verifies the session belongs to the authenticated customer, is unexpired, has enough remaining authorization, and allows the endpoint/model.
5. API server canonicalizes the request body and stores a request hash before upstream execution.
6. API server calculates a deterministic maximum charge:
   - Images: endpoint, model, size, quality, requested count, and configured image pricing unit.
   - Video: model, requested duration, resolution, requested count, and configured per-second pricing unit.
7. API server creates a reservation against the session for the maximum charge.
8. API server proxies the request to OpenAI only after the reservation succeeds.
9. API server stores the upstream request ID or video job ID on the request record.
10. On completion, API server or worker calculates the actual media usage amount from generated count, actual duration when available, resolution, and configured pricing.
11. API server or worker settles/debits the actual amount from the session, releases unused reservation amount, and records usage.
12. API server or worker generates a signed receipt containing `customer_id`, `session_id`, `request_id`, upstream job ID, request hash, reserved amount, actual usage amount, and settlement reference.

Session-backed media requests must be idempotent by `request_id`. A paid retry with the same `request_id` must have the same canonical request hash, customer, session, endpoint, and model. Async video polling or finalization must require the same customer identity that created the upstream job.

### Payment Discovery

Endpoints:

- `GET /.well-known/x402`
- `GET /.well-known/mpp`
- `GET /pricing`

These should expose:

- Supported payment protocols.
- Supported network IDs.
- Accepted stablecoin assets.
- Price units.
- API endpoint base URL.
- Required headers.
- Example payment challenge.

## Payment Architecture

Use a provider interface so the product can start with Tempo testnet and later support Base or other x402/MPP facilitators without rewriting the API server.

```text
PaymentProvider
  - createChallenge(requestContext)
  - parseCredential(headers)
  - verifyCredential(credential, charge)
  - broadcastCredential(credential, charge)
  - getSettlementStatus(paymentId)
```

Initial implementations:

- `TempoPaymentProvider`: Tempo testnet/mainnet integration.
- Deterministic test payment fixtures for unit tests.
- `BaseX402PaymentProvider`: later milestone.

### Tempo MPP Credential Flow

Tempo MPP supports two credential modes for MVP:

- `type="transaction"`: the customer sends a signed Tempo transaction to the node. The node decodes it, optionally adds a fee-payer signature, broadcasts it, and verifies settlement.
- `type="hash"`: the customer broadcasts the payment transaction independently and sends the transaction hash. The node verifies the receipt through Tempo RPC.

The first implementation should prefer `type="transaction"` because it gives the API node a single place to verify, broadcast, deduplicate, and attach the request memo. Support `type="hash"` as a compatibility path.

Do not require a separate ERC-20 `approve()` flow for the Tempo MPP MVP. The signed Tempo transaction is the payment credential.

### Tempo Session Flow

Tempo sessions are the preferred post-MVP payment path for media, streaming, and multi-call workflows. A session represents spend authority owned by one customer, not a generic bearer token that any caller can spend.

Session state:

- `session_id`
- `customer_id`
- `credential_hash` or session authorization reference
- `chain_id`
- `asset_address`
- `settlement_address`
- `authorized_max_amount`
- `remaining_authorized_amount`
- `expires_at`
- `allowed_endpoints`
- `allowed_models`
- `status`

Reservation state:

- `reservation_id`
- `session_id`
- `request_id`
- `customer_id`
- `reserved_amount`
- `actual_amount`
- `released_amount`
- `status`
- `created_at`
- `settled_at`

Session validation rules:

- The authenticated customer must match the session owner.
- The endpoint and model must be within the session scope.
- The session must be active and unexpired.
- The reservation must fit inside the remaining authorized amount.
- The request hash must be stable across unpaid challenge, paid retry, and async completion.
- Reused reservations or mutated retries must be rejected before any upstream cost is created.

### Maximum Charge Policy

Usage-based AI requests have unknown output length before execution. MVP policy:

1. Estimate input tokens before payment challenge.
2. Require client `max_tokens`, or apply a server default.
3. Enforce a server maximum `max_tokens` per model.
4. Calculate maximum charge:

```text
max_charge =
  estimated_input_tokens * input_token_price
  + max_tokens * output_token_price
  + minimum_charge_if_needed
```

5. Require payment for `max_charge`.
6. After upstream completion, record actual usage and actual usage amount in the receipt.

This avoids refund complexity for the first testnet implementation. Future MPP sessions or streaming payments should replace this with closer-to-actual incremental settlement.

### Media Charge Policy

Media endpoints should not reuse token-only pricing fields as if they were chat completions. They need explicit media pricing dimensions so the quoted maximum and actual receipt are understandable and auditable.

Image quote inputs:

- Endpoint: generation, edit, variation, or Responses image tool.
- Model.
- Size.
- Quality.
- Requested image count.
- Optional operator markup or minimum charge.

Video quote inputs:

- Model.
- Resolution.
- Requested duration in seconds.
- Requested video count.
- Optional operator markup or minimum charge.

For async video jobs, create the reservation before job creation, attach the upstream job ID immediately after OpenAI accepts the job, and finalize the actual usage amount when the job reaches a terminal state. Failed upstream jobs should release the reservation and record the failure without settling a usage charge unless the upstream provider charged the operator for partial work.

## Tempo Testnet First

Use Tempo Testnet for the first real payment tests.

Current known testnet details:

- Network name: Tempo Testnet / Moderato.
- Chain ID: `42431`.
- HTTP RPC: `https://rpc.moderato.tempo.xyz`.
- WebSocket RPC: `wss://rpc.moderato.tempo.xyz`.
- Explorer: `https://explore.tempo.xyz`.
- Test assets from faucet:
  - `pathUSD`: `0x20c0000000000000000000000000000000000000`
  - `AlphaUSD`: `0x20c0000000000000000000000000000000000001`
  - `BetaUSD`: `0x20c0000000000000000000000000000000000002`
  - `ThetaUSD`: `0x20c0000000000000000000000000000000000003`

Treat these as configurable values, not hard-coded constants. The setup wizard should fetch or display the active testnet configuration and allow an update without rebuilding the app.

## Data Model

### `settings`

- `key`
- `value`
- `updated_at`

Stores installation and node configuration.

### `providers`

- `id`
- `type`
- `name`
- `encrypted_api_key`
- `base_url`
- `enabled`
- `created_at`
- `updated_at`

### `models`

- `id`
- `public_name`
- `provider_id`
- `upstream_name`
- `supports_streaming`
- `supports_embeddings`
- `enabled`

### `pricing_rules`

- `id`
- `model_id`
- `endpoint_type`
- `input_price_per_million`
- `output_price_per_million`
- `image_price`
- `image_token_price_per_million`
- `video_price_per_second`
- `size`
- `quality`
- `resolution`
- `minimum_charge`
- `asset_symbol`
- `asset_address`
- `chain_id`
- `enabled`

### `customers`

- `id`
- `label`
- `api_key_hash`
- `spend_limit`
- `rate_limit`
- `enabled`

### `requests`

- `id`
- `customer_id`
- `model_id`
- `endpoint_type`
- `status`
- `started_at`
- `completed_at`
- `upstream_request_id`
- `upstream_job_id`
- `request_hash`
- `error_code`
- `is_streaming`

### `usage_records`

- `id`
- `request_id`
- `prompt_tokens`
- `completion_tokens`
- `total_tokens`
- `media_unit`
- `media_count`
- `duration_seconds`
- `resolution`
- `metering_source`
- `calculated_amount`

### `payments`

- `id`
- `request_id`
- `customer_id`
- `protocol`
- `chain_id`
- `asset_address`
- `credential_type`
- `credential_hash`
- `settlement_tx`
- `status`
- `prepaid_max_amount`
- `settled_amount`
- `actual_usage_amount`

### `payment_sessions`

- `id`
- `customer_id`
- `protocol`
- `chain_id`
- `asset_address`
- `settlement_address`
- `credential_hash`
- `authorized_max_amount`
- `remaining_authorized_amount`
- `allowed_endpoints`
- `allowed_models`
- `expires_at`
- `status`
- `created_at`
- `updated_at`

### `payment_reservations`

- `id`
- `session_id`
- `request_id`
- `customer_id`
- `reserved_amount`
- `actual_amount`
- `released_amount`
- `status`
- `created_at`
- `settled_at`

### `receipts`

- `id`
- `request_id`
- `payment_id`
- `session_id`
- `reservation_id`
- `receipt_json`
- `receipt_hash`
- `signature`
- `status`
- `created_at`

### `audit_logs`

- `id`
- `actor`
- `action`
- `metadata_json`
- `created_at`

## Security Architecture

- Encrypt upstream provider API keys at rest.
- Store admin password with Argon2id or bcrypt.
- Store customer API keys as hashes only.
- Generate a local node signing key on first setup.
- Keep private keys in a Docker volume with restrictive file permissions.
- Never log full payment headers, provider API keys, or customer request bodies by default.
- Separate admin routes from public API routes.
- Require setup token before first admin account exists.

## Install and Upgrade Architecture

Installer responsibilities:

1. Check OS support.
2. Install Docker and Docker Compose plugin if missing.
3. Create `/opt/pay-api-proxy`.
4. Write `.env`.
5. Download `docker-compose.yml`.
6. Start containers.
7. Print setup URL and temporary token.

Upgrade responsibilities:

1. Pull new images.
2. Run database migrations.
3. Restart services.
4. Verify health checks.
5. Roll back to previous image tag if health checks fail.

## Build Milestones

1. Docker Compose skeleton with app, worker, Caddy, and SQLite volume.
2. API server health checks and setup-token flow.
3. OpenAI-compatible proxy for `chat/completions`.
4. Usage metering and request ledger.
5. Test payment fixture and HTTP `402` flow.
6. Receipt signing and verification endpoint.
7. Tempo testnet MPP payment provider with signed transaction and transaction-hash credential support.
8. Admin setup wizard and dashboard.
9. Installer and upgrade command.
10. Base/x402 provider after Tempo testnet flow is stable.
