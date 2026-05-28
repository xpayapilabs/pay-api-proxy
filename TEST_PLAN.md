# Test Plan

## Test Strategy

Test in layers:

1. Local unit tests with deterministic test payment fixtures.
2. Local integration tests with Docker Compose.
3. Tempo testnet end-to-end tests with faucet stablecoins.
4. VPS install tests on a clean Ubuntu server.
5. Abuse, failure, and recovery tests.

The first real payment environment is Tempo Testnet.

## Test Environments

### Local Development

Purpose:

- Fast feedback.
- No chain dependency.
- No real upstream AI cost when using deterministic provider responses.

Components:

- App container.
- Worker container.
- SQLite volume.
- Test AI provider.
- Test payment provider.

### Local Tempo Testnet

Purpose:

- Verify real wallet, asset, payment, settlement, and receipt behavior against Tempo Testnet.

Components:

- App container.
- Worker container.
- SQLite volume.
- Real Tempo RPC.
- Tempo testnet wallet.
- Tempo faucet assets.
- Optional real upstream AI provider with low request limits.

### Clean VPS

Purpose:

- Verify non-technical install path.

Components:

- Fresh Ubuntu 22.04 or 24.04 VPS.
- Public IP.
- Domain pointed to VPS when testing HTTPS.
- One-command installer.

## Tempo Testnet Configuration

Use current Tempo Testnet details:

- Network name: Tempo Testnet / Moderato.
- Chain ID: `42431`.
- HTTP RPC: `https://rpc.moderato.tempo.xyz`.
- WebSocket RPC: `wss://rpc.moderato.tempo.xyz`.
- Explorer: `https://explore.tempo.xyz`.

Faucet test assets:

- `pathUSD`: `0x20c0000000000000000000000000000000000000`
- `AlphaUSD`: `0x20c0000000000000000000000000000000000001`
- `BetaUSD`: `0x20c0000000000000000000000000000000000002`
- `ThetaUSD`: `0x20c0000000000000000000000000000000000003`

Before test execution, verify these values against the official Tempo docs because testnet details may change.

## Unit Tests

### Pricing

- Calculates input-token charge correctly.
- Calculates output-token charge correctly.
- Calculates image charge from endpoint, model, size, quality, and requested count.
- Calculates video maximum charge from model, resolution, requested duration, and requested count.
- Applies minimum charge.
- Handles zero completion tokens.
- Handles model-specific pricing.
- Handles media-specific pricing.
- Rejects disabled models.
- Rejects unsupported assets.

### Usage Metering

- Uses upstream-reported token usage when present.
- Falls back to local token estimate when upstream usage is missing.
- Marks interrupted streams as partial.
- Records generated image count, size, quality, model, and calculated amount.
- Records video duration, resolution, model, upstream job ID, job status, and calculated amount.
- Does not overcharge failed upstream requests.
- Records timeout and cancellation status.

### Tempo Sessions

- Creates a session bound to one customer, asset, chain, settlement address, expiry, and allowed endpoint/model scope.
- Rejects a session used by a different authenticated customer.
- Rejects expired, disabled, or out-of-scope sessions.
- Reserves maximum charge before upstream execution.
- Rejects reservation when remaining authorized amount is insufficient.
- Releases unused reservation amount after final usage amount is known.
- Deduplicates repeated reservation attempts for the same `request_id`.
- Rejects a paid retry whose canonical request hash differs from the original reservation.
- Records session ID and reservation ID on usage receipts.

### Payment Provider Interface

- Creates payment challenge.
- Parses `type="transaction"` credential.
- Parses `type="hash"` credential.
- Rejects missing credential.
- Rejects malformed signed transaction.
- Rejects expired or out-of-window transaction.
- Rejects insufficient payment amount.
- Rejects wrong memo or request ID.
- Accepts valid signed Tempo transaction.
- Accepts valid transaction hash after onchain verification.
- Deduplicates already-used transaction credentials.
- Retries settlement-status polling.

### Receipt Signing

- Generates stable receipt JSON.
- Hashes receipt payload.
- Signs with node private key.
- Verifies with node public key.
- Fails verification after receipt tampering.

## API Integration Tests

### OpenAI Compatibility

- `GET /v1/models` returns enabled public model names.
- `POST /v1/chat/completions` accepts OpenAI-compatible body.
- Streaming response works when `stream: true`.
- Non-streaming response includes usage when upstream returns usage.
- Errors use OpenAI-compatible error shape where practical.

### Payment Required Flow

- Unpaid request returns HTTP `402`.
- `402` response includes accepted asset, chain ID, max charge, memo/request ID, and payment endpoint metadata.
- `402` response advertises supported Tempo MPP credential types: `transaction` and `hash`.
- Paid request proceeds to upstream.
- Session-backed paid request proceeds to upstream after reservation succeeds.
- Underpaid request returns HTTP `402`.
- Unsupported chain returns HTTP `402` or clear payment error.

### Media Payment Flow

- `POST /v1/images/generations` quotes from model, size, quality, and requested count.
- `POST /v1/images/edits` quotes from model, size, quality, requested count, and edit endpoint pricing.
- Image request with valid session creates a reservation before upstream execution.
- Image receipt includes session ID, reservation ID, request hash, generated count, and actual usage amount.
- `POST /v1/videos` quotes from model, resolution, and requested duration.
- Video request stores upstream job ID after upstream accepts the job.
- Video polling/finalization requires the same authenticated customer that created the job.
- Completed video job settles actual amount, releases unused reservation, and creates receipt.
- Failed video job releases reservation and records failure without usage settlement unless partial upstream cost is configured.

### Receipts

- Successful paid request returns receipt ID in response header.
- `GET /receipts/{receipt_id}` returns receipt.
- `GET /v1/usage/{request_id}` returns usage record.
- Receipt amount matches pricing rule and usage.
- Receipt payment reference matches payment record.
- Receipt includes prepaid maximum amount and actual usage amount.

## Tempo Testnet End-to-End Tests

### Setup

1. Create test operator wallet.
2. Create test customer wallet.
3. Add Tempo Testnet to wallet using chain ID `42431`.
4. Fund customer wallet with faucet asset.
5. Configure node to accept one faucet asset, starting with `pathUSD`.
6. Configure low test pricing, for example tiny fractions of test stablecoin per request.
7. Configure one upstream AI model or deterministic test provider.

### Cases

- Customer receives `402` challenge for unpaid request.
- Customer signs a Tempo MPP `type="transaction"` credential offchain for the requested max charge.
- Customer retries with the signed transaction in the payment header.
- Node decodes, broadcasts, and verifies the signed transaction.
- Node proxies AI request.
- Node calculates final token usage.
- Worker observes final settlement.
- Receipt includes chain ID `42431`, asset address, request ID, max charge, actual usage, actual usage amount, and settlement reference.
- Explorer shows settlement transaction.

### Transaction Hash Credential Case

- Customer receives `402` challenge.
- Customer broadcasts Tempo payment transaction independently.
- Customer retries with MPP `type="hash"` credential.
- Node verifies transaction receipt through Tempo RPC.
- Node confirms transaction amount, recipient, asset, chain ID, and memo match the challenge.
- Node proxies AI request only after verification succeeds.

### Failure Cases

- Customer has no faucet balance.
- Customer uses wrong asset.
- Customer uses wrong chain.
- Customer submits malformed signed transaction.
- Customer submits expired or not-yet-valid transaction.
- Customer pays less than the requested max charge.
- Customer reuses a transaction credential for another request.
- Customer changes request body after receiving the payment challenge.
- Customer uses another customer's Tempo session.
- Customer mutates image size, quality, count, video duration, or resolution after reservation.
- Customer attempts to poll or finalize another customer's video job.
- Tempo RPC is unavailable.
- Settlement transaction is pending longer than expected.
- Settlement fails before upstream request starts.
- Stream is interrupted before completion.

Expected behavior:

- No upstream request should run before the Tempo payment credential is verified.
- For session-backed media, no upstream request should run before the reservation succeeds.
- If transaction verification is pending, request state must remain recoverable by the worker.
- Receipt should remain pending until settlement is final.
- The first Tempo testnet MVP does not perform automatic refunds; it records max charge and actual usage amount.
- Tempo session milestones should settle actual usage from the session and release any unused reservation amount.

## VPS Install Tests

### Fresh Install

- Run installer on clean Ubuntu 22.04.
- Run installer on clean Ubuntu 24.04.
- Confirm Docker is installed automatically when missing.
- Confirm app starts with `docker compose ps`.
- Confirm setup URL is printed.
- Confirm setup token works once.
- Confirm TLS works when domain is configured.
- Confirm IP-only install works for non-production test mode.

### Upgrade

- Install version A.
- Complete setup.
- Process a paid test request.
- Upgrade to version B.
- Confirm database migrations run.
- Confirm previous receipts remain accessible.
- Confirm services recover after restart.

### Backup and Restore

- Stop services.
- Copy SQLite volume and key material.
- Restore on a new VPS.
- Confirm admin login, receipts, and payment history are available.
- Confirm node signing identity is preserved.

## Security Tests

- Admin setup token cannot be reused.
- Admin routes require login.
- Customer API key hashes are not reversible from database.
- Provider API keys are encrypted at rest.
- Logs do not include provider API keys.
- Logs do not include full payment credential headers.
- Request body logging is disabled by default.
- Rate limits apply by IP and customer key.
- Max request body size is enforced.
- Max token limit is enforced.

## Abuse and Load Tests

- Burst unpaid requests return cheap `402` responses without hitting upstream.
- Burst paid requests respect rate limits.
- Long streaming response does not block unrelated requests.
- Worker can process settlement backlog.
- Database remains consistent after process restart during:
  - upstream request,
  - streaming response,
  - payment credential verification,
  - receipt generation.

## Acceptance Criteria

The MVP is ready for private beta when:

- Clean VPS install succeeds from one command.
- User can configure Tempo testnet payment in browser setup.
- Unpaid API calls are blocked.
- Paid API calls work with OpenAI-compatible clients.
- Max charge is calculated before execution from input estimate plus `max_tokens`.
- Actual token usage is recorded after execution.
- Tempo testnet settlement is visible in explorer.
- Receipt is generated, signed, retrievable, and verifiable.
- Restarting the server does not lose request, payment, or receipt state.
- Operator dashboard shows revenue, requests, usage, payment status, and errors.

## Manual Test Script

1. Install on VPS.
2. Open setup URL.
3. Create admin account.
4. Add upstream provider key.
5. Add Tempo testnet settlement wallet.
6. Select `pathUSD` test asset.
7. Set one model price.
8. Open public docs page.
9. Send unpaid curl request and confirm HTTP `402`.
10. Fund customer wallet from faucet.
11. Sign a Tempo MPP transaction credential offchain for the challenged max charge.
12. Retry request with payment credential.
13. Confirm AI response.
14. Confirm receipt URL.
15. Confirm settlement transaction in explorer.
16. Confirm receipt shows max charge and actual usage amount.
17. Restart containers.
18. Confirm receipt and request history still load.
