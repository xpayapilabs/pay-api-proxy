# Feature Design

## Product Goal

Help a non-technical operator launch a public, paid AI/API proxy from a Linux VPS. The operator should be able to connect upstream AI providers, publish OpenAI-compatible endpoints, charge stablecoin payments through x402/MPP-style flows on supported settlement chains, and prove usage with receipts.

## Target Users

- Operator: rents a VPS, owns provider API keys, sets prices, receives payments.
- API customer: uses OpenAI-compatible SDKs or HTTP clients, pays per usage.
- Integrator: embeds the paid endpoint into an app, agent, workflow, or marketplace.

## MVP User Journey

1. Operator rents a Linux VPS with a public IP or domain.
2. Operator runs a single install command.
3. Browser setup wizard opens at the VPS address.
4. Operator adds upstream provider API keys.
5. Operator selects supported models and sets token prices.
6. Operator adds a settlement wallet and supported chain.
7. Node publishes OpenAI-compatible endpoints.
8. Customer sends a request, receives an MPP/x402-style `402 Payment Required` challenge, signs a payment credential offchain, then retries with the payment header.
9. Node verifies or broadcasts the payment credential, forwards request upstream, meters token usage, and returns a signed usage receipt.
10. Operator views revenue, request history, usage, errors, and withdrawal/settlement status.

## Core MVP Features

### 1. One-Command Docker Install

- Shell installer for Ubuntu/Debian VPS.
- Installs Docker and Docker Compose plugin if missing.
- Downloads the Docker Compose bundle.
- Starts app, worker, reverse proxy, and database volume.
- Prints the admin setup URL and default local credentials.
- Includes health check command: `pay-api-proxy doctor`.

### 2. Browser Setup Wizard

- First-run web UI protected by a temporary setup token.
- Steps:
  - Admin account creation.
  - Public domain or IP confirmation.
  - TLS setup.
  - Upstream provider API key entry.
  - Settlement wallet setup.
  - Chain selection, starting with supported Base/Tempo-compatible configuration once verified.
  - Default model and pricing selection.
  - Test request and test payment.

### 3. OpenAI-Compatible API Proxy

MVP endpoints:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses` if supported by configured upstreams
- `POST /v1/embeddings`

Behavior:

- Accept standard OpenAI-compatible request bodies.
- Forward requests to configured upstream providers.
- Normalize model names through local aliases.
- Preserve streaming support for chat/responses.
- Return OpenAI-compatible errors where practical.

### 4. Payment Gate

- Each paid endpoint requires a valid x402/MPP payment credential.
- First Tempo testnet MVP supports offchain-signed Tempo MPP credentials.
- Supports `type="transaction"` where the client sends a signed Tempo transaction and the node broadcasts/verifies it.
- Supports `type="hash"` where the client broadcasts first and the node verifies the transaction receipt.
- Calculates a maximum charge from input tokens plus the request `max_tokens` value before returning the payment challenge.
- For non-token media endpoints, calculates a deterministic maximum charge from request dimensions such as endpoint, model, size, quality, requested count, video duration, and resolution.
- Runs the upstream AI request only after payment for the maximum charge is verified.
- Rejects requests with clear machine-readable payment errors.
- Exposes a payment discovery endpoint:
  - `GET /.well-known/x402`
  - `GET /.well-known/mpp`
  - `GET /pricing`

For MVP, avoid an onchain refund flow. Charge the pre-estimated maximum amount and show actual usage in the receipt.

### 5. MPP Sessions

After the basic Tempo MPP path is stable, add MPP Sessions for actual-usage charging. Sessions let a customer authorize a bounded spending envelope once, then use that authorization across multiple paid calls. This is especially important for images, video, streamed responses, and async jobs where the final bill may be known only after generation completes.

An MPP Session must be bound to:

- Authenticated customer or customer API key.
- Accepted asset and settlement chain.
- Node settlement address.
- Expiry time.
- Allowed endpoint and model scope.
- Maximum authorized spend.
- Remaining authorized balance.
- Optional per-request maximum.
- Session nonce or sequence number to prevent replay.

Session lifecycle:

- Customer creates or presents an MPP Session authorization.
- Node verifies the session authorization, chain, asset, settlement recipient, expiry, allowed scope, and remaining balance.
- Node persists the session before accepting session-backed requests.
- Customer sends API requests with the customer credential and `x-mpp-session-id`.
- Node computes the maximum expected charge for the request.
- Node creates a reservation against the session for that maximum amount before calling the upstream provider.
- Node records a canonical request hash so paid retries cannot mutate the request body, endpoint, model, customer, or session.
- Node rejects the request if the session cannot reserve the maximum expected charge.
- Node calls the upstream provider only after the reservation succeeds.
- Node records upstream usage, upstream request ID, job ID, or stream completion metadata.
- Node calculates the actual usage amount from the final metered usage.
- Node settles or debits only the actual usage amount from the session.
- Node releases the unused reservation amount back to the session balance.
- Node writes a signed receipt with the reserved amount, actual charged amount, released amount, and settlement reference.

Session-backed requests should follow this policy:

- API request includes the customer credential and `x-mpp-session-id`.
- Node verifies the session belongs to the authenticated customer and is allowed for the requested endpoint and model.
- Node stores a canonical request hash and reserves the maximum expected charge before calling the upstream provider.
- Node records the upstream request or job ID against the paid request.
- Node settles or debits the final actual usage amount from the session after completion.
- Node releases unused reservation amount, preserves the receipt trail, and rejects replayed or mutated paid retries.

Failed request policy:

- If the request fails before the upstream provider is called, release the full reservation and do not charge usage.
- If the upstream provider returns a billable partial result, settle the configured partial actual usage amount and release the remainder.
- If a streamed response disconnects before completion, settle according to metered delivered or upstream-reported usage, using the operator's configured policy.
- If settlement finalization is interrupted, keep the reservation pending and let the worker reconcile it before releasing funds.

MPP Session endpoints:

- `POST /v1/payment-sessions`
- `GET /v1/payment-sessions/{session_id}`
- `POST /v1/payment-sessions/{session_id}/revoke`
- `GET /v1/payment-sessions/{session_id}/reservations`

### 6. Usage Metering

- Meter prompt tokens, completion tokens, total tokens, model, latency, request ID, and upstream cost estimate.
- Prefer upstream-reported usage.
- Fall back to local token estimation only when upstream usage is unavailable.
- Track streamed responses until completion before final usage receipt.
- Meter image requests by the configured media pricing unit, including endpoint, model, size, quality, requested count, and generated count.
- Meter video requests by the configured media pricing unit, including model, requested duration, actual generated duration when available, resolution, job status, and upstream job ID.
- Record failed, cancelled, and partially streamed requests separately.

### 7. Pricing Rules

Operator can configure:

- Price per 1M input tokens.
- Price per 1M output tokens.
- Price per image or image token unit by model, size, quality, and endpoint.
- Price per video second by model and resolution.
- Optional request minimum.
- Server default `max_tokens` when the client omits it.
- Server maximum `max_tokens` per model.
- Server maximum image count, video duration, and video resolution per model.
- Optional free test quota.
- Optional model-specific markup over upstream cost.
- Accepted stablecoin asset and settlement chain.

The customer-facing API should expose enough pricing metadata for clients to estimate payment before sending a request.

### 8. Verified Usage Receipts

Every successful paid request returns or exposes a receipt containing:

- Receipt ID.
- Request ID.
- Session ID, when paid from an MPP Session.
- Timestamp.
- Model.
- Token usage.
- Media usage fields for image/video requests, when applicable.
- Price calculation.
- Charged amount.
- Maximum authorized or prepaid amount.
- Actual usage amount.
- Reserved amount, when paid from an MPP Session.
- Released amount, when a session reservation exceeds actual usage.
- Difference between prepaid maximum and actual usage, if applicable.
- Settlement asset and chain.
- Payment transaction or authorization reference.
- Hash of request metadata.
- Node signature.

Endpoints:

- `GET /receipts/{receipt_id}`
- `GET /v1/usage/{request_id}`

### 9. Operator Dashboard

Minimum views:

- Overview: revenue, requests, tokens, errors, uptime.
- Models: enabled models, aliases, upstream provider status.
- Pricing: per-model rates and payment settings.
- Requests: logs, usage, payment status, receipt links.
- Payment sessions: authorized balance, reserved balance, settled usage, expiry, and revocation status.
- Customers/API keys: customer labels, limits, recent activity.
- System: domain, TLS, service status, version, update button.

### 10. Customer Access

- Public docs page generated from local configuration.
- Shows base URL, models, pricing, payment requirements, and examples.
- Provides copy-paste examples for:
  - curl
  - JavaScript OpenAI SDK
  - Python OpenAI SDK
- Optional customer API keys for rate limiting and analytics, separate from payment credentials.

### 11. Safety and Abuse Controls

- Rate limits per IP, customer key, and payment account.
- Max request body size.
- Max tokens per request.
- Model allowlist.
- Spend cap per customer key.
- Upstream timeout and retry policy.
- Admin login protection.
- Audit log for configuration changes.

## Important Non-MVP Features

These are valuable, but should wait until the MVP proves the paid proxy loop:

- Multi-operator marketplace.
- Hosted control plane.
- Automatic provider key marketplace.
- Advanced customer billing portal.
- Team accounts.
- Fine-grained RBAC.
- Dynamic auction pricing.
- Cross-node federation.
- Custom model hosting.

## Suggested MVP Architecture

### Runtime Services

- API server: handles OpenAI-compatible endpoints, payment checks, and proxying.
- Admin server: setup wizard and operator dashboard.
- Worker: settlement polling, receipt finalization, usage reconciliation.
- Database: local SQLite for MVP.
- Reverse proxy: Caddy for TLS and public routing.

### Data Model

- `operators`: admin user and node ownership.
- `providers`: upstream API provider credentials.
- `models`: local model aliases, upstream mapping, enabled status.
- `pricing_rules`: token rates, media rates, minimums, accepted assets.
- `customers`: optional customer API keys and limits.
- `requests`: request metadata, status, latency, model.
- `usage_records`: token counts and cost calculations.
- `payments`: MPP/x402 credential, transaction hash, settlement, chain refs.
- `payment_sessions`: MPP Session authorization, customer binding, maximum authorized spend, remaining balance, reserved balance, expiry, allowed scope, nonce or sequence state, and revocation status.
- `payment_reservations`: per-request reserved amount, actual settled amount, released amount, reservation status, canonical request hash, upstream request/job reference, and session reference.
- `receipts`: signed usage proof and retrieval metadata.
- `audit_logs`: admin changes and system events.

## MVP Success Criteria

- A user can install the node on a clean VPS in under 15 minutes.
- A customer can call the node with a standard OpenAI-compatible SDK.
- The node blocks unpaid requests.
- The node blocks unpaid requests and records actual token usage.
- For the first Tempo testnet MVP, the node can charge the pre-estimated maximum and disclose actual usage in the receipt.
- With MPP Sessions, the node can reserve maximum expected spend, charge actual usage after completion, release unused reservation amount, and expose the final accounting in the receipt.
- For image/video milestones, the node can charge from an MPP Session, bind the charge to the correct customer and upstream job, and settle the actual media usage amount in the receipt.
- The customer receives a verifiable usage receipt.
- The operator can see request history, revenue, and payment status.
- The service survives process restart without losing payment or receipt records.

## First Implementation Milestones

1. Scaffold API server, SQLite schema, and health checks.
2. Implement OpenAI-compatible proxy for `chat/completions`.
3. Add static pricing and usage recording.
4. Add payment middleware with deterministic test payment fixtures.
5. Add receipt generation and signature verification.
6. Build setup wizard and admin dashboard.
7. Add Tempo testnet MPP signed transaction/hash verification.
8. Add MPP Session schema, reservation accounting, and actual-usage settlement.
9. Add installer, Docker Compose bundle, TLS, and upgrade path.
