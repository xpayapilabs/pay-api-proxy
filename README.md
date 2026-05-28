Self-hosted node for launching paid AI/API services with x402 payments, OpenAI-compatible endpoints, and verified usage receipts.

MVP Objective:
a non technical user can easily provide paid AI api proxy service to public, charging MPP/x402 stable coin payment settled on Tempo/base chain, based on token usage.

Providers can run it as a local service behind an existing reverse proxy, as a
public service on a VPS with Caddy, or through Cloudflare Tunnel when inbound
ports or a public IP are not available.

Project docs:

- [Feature design](FEATURE_DESIGN.md)
- [Architecture plan](ARCHITECTURE_PLAN.md)
- [Test plan](TEST_PLAN.md)
- [Configuration reference (mandatory vs optional fields)](docs/configuration-reference.md)
- [OpenAI-compatible endpoints](docs/openai-compatible-endpoints.md)
- [Image proxy billing](docs/image-proxy-billing.md)
- [Agent and client compatibility](docs/agent-client-compatibility.md)
- [Production readiness tracker](docs/production-readiness.md)

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

## Configuration

Keep `pay-api-proxy.config.jsonc` small: it should contain operator choices like provider and charging method. Defaults such as ports, body limits, OpenAI base URL, and Tempo testnet constants live in code defaults unless the operator truly needs to override them.

Supported `chargingMethod` values:

- `ai-token`: quote from estimated input tokens plus requested max output tokens, then record actual token usage.
- `per-request`: quote and charge one fixed amount for a configured traditional HTTP API mounted at its normal root paths.

Session-backed AI token charging uses the same `ai-token` prices, but reserves the quoted maximum from the user's authorized session and settles the actual input/output token usage afterwards. The session unit policy is configurable so an `mppx`/Tempo adapter can charge one fixed unit repeatedly while the provider still configures natural token prices:

```jsonc
{
  "chargingMethod": "ai-token",
  "sessionBilling": {
    "reserveMode": "max-quote",
    "settlementMode": "actual-usage",
    "unitAmount": "1",
    "unitType": "asset-smallest-unit"
  }
}
```

For native `mppx.session({ amount, unitType })` support, keep `unitAmount` small enough for rounding tolerance. Input and output token prices can differ because the meter converts each component into a different number of fixed-price session units.

Native `mppx.session()` support can be enabled for clients that send `Authorization: Payment` session credentials directly to `/v1/chat/completions`:

```jsonc
{
  "mppxSession": {
    "enabled": true,
    "decimals": 6,
    "waitForConfirmation": true
  }
}
```

Set `MPPX_SESSION_PRIVATE_KEY` in `.env` to a Tempo wallet private key the server can use to settle or close channels, and set `mppxSession.secretKey` only if AI sessions should use a challenge secret separate from fixed-charge mppx. When native mppx sessions are enabled, requests without `x-mpp-session-id` receive an mppx session `402` challenge. The node validates the mppx session credential, calls OpenAI, then settles the native channel spend to actual metered token usage. Native mppx channel state is persisted in the node SQLite database.

Traditional APIs are configured with `traditionalApis`:

```jsonc
{
  "chargingMethod": "per-request",
  "traditionalApis": [
    {
      "id": "fx",
      "upstreamBaseUrl": "https://demo-fx.example",
      "bearer": "upstream-service-token",
      "headers": {
        "x-api-key": "upstream-service-key"
      },
      "methods": ["GET", "POST"],
      "pricing": { "request": "0.0005" },
      "routes": [
        {
          "id": "live",
          "path": "/v1/live/*",
          "methods": ["GET"],
          "pricing": { "request": "0.0025" },
          "headers": { "x-api-key": "route-specific-key" }
        },
        { "id": "status", "path": "/v1/status", "methods": ["GET"], "pricing": { "request": "0.0001" } }
      ],
      "assetSymbol": "pathUSD",
      "assetAddress": "0x20c0000000000000000000000000000000000000",
      "chainId": 42431
    }
  ]
}
```

That publishes the API at the root mount, so `/v1/quote` forwards to the matching upstream path without an `/api/{id}` prefix.
Traditional HTTP APIs use fixed per-request `tempo.charge` billing. They do not use native mppx session channels.
`bearer` injects `Authorization: Bearer ...` upstream and `headers` injects arbitrary upstream headers, matching the common `mppx/proxy` `Service.custom` options. Route `pricing.request`, `bearer`, and `headers` values override the API default. Route paths support exact matches, OpenAPI templates such as `/v1/users/{id}`, prefix wildcards such as `/v1/live/*`, and `*` as a catch-all; the most specific matching route wins. Set `allowUnmatchedRoutes: false` or `TRADITIONAL_API_ROUTES_ONLY=true` when you want an imported OpenAPI route list to act as the public allowlist.

If the upstream API runs directly on the same VPS host while this node runs in Docker, you can set `UPSTREAM_BASE_URL=http://localhost:8000`. At runtime the Docker app maps localhost-style upstream URLs to `host.docker.internal` so the container reaches the host service.

To preserve an existing OpenAPI document during installer-based setup, set `TRADITIONAL_OPENAPI_DOCUMENT_URL` to a public or server-reachable JSON URL, or set `TRADITIONAL_OPENAPI_SOURCE_PATH` to a local file path on the server / a folder containing `openapi.json` or `swagger.json`. The installer copies local files into the Docker data volume and configures `/openapi.json` to inject payment metadata into that document.

OpenAI-compatible model defaults live in [src/core/models.ts](src/core/models.ts) and are applied when `MODELS`, inline `models`, and [openai-models.config.jsonc](openai-models.config.jsonc) are omitted. This keeps [pay-api-proxy.config.jsonc](pay-api-proxy.config.jsonc) usable for normal HTTP API providers that do not serve OpenAI models.

When `upstreamProvider` is `openai` and no `MODELS` env var or inline `models` array is configured, the app automatically loads [openai-models.config.jsonc](openai-models.config.jsonc) if it exists. To override OpenAI pricing/model metadata, edit that file, set `MODELS`, or add a `models` array to `pay-api-proxy.config.jsonc`:

```jsonc
{
  "models": [
    {
      "modelName": "gpt-5.4-mini",
      "pricing": {
        "inputPerMillion": "0.75",
        "cachedInputPerMillion": "0.075",
        "outputPerMillion": "4.50",
        "minimum": "0.001"
      },
      "defaultMaxTokens": 512,
      "maxTokensLimit": 128000,
      "contextWindow": 400000,
      "knowledgeCutoff": "2025-08-31"
    }
  ]
}
```

Pricing values are normal decimal asset amounts. With pathUSD's 6 decimals, `"0.001"` becomes `1000` smallest units. Advanced deployments can still use integer fields such as `inputPricePerMillion`, `cachedInputPricePerMillion`, `outputPricePerMillion`, and `minimumCharge`.

## Agent/client compatibility

pay-api-proxy targets AgentCash, `mppx/client`, and Tempo CLI / request tooling as paid API callers. One-time Tempo charge is the baseline compatibility target for all three; Tempo session support must be verified per client before it is publicly claimed. See [Agent and client compatibility](docs/agent-client-compatibility.md) for the compatibility matrix and expected discovery/payment flow.

To see which upstream OpenAI models your API key can access:

```bash
npm run openai:models
```

To test which common upstream OpenAI endpoints your key can call:

```bash
npm run openai:endpoints
```

By default this runs only safe `GET` probes. To send tiny live requests to generation and embedding endpoints:

```bash
npm run openai:endpoints -- --live --model gpt-4.1-mini
```

Docker Compose runs the production shape:

```bash
cp .env.example .env
# Set OPENAI_API_KEY in .env for production/OpenAI mode.
docker compose --profile vps up -d --build
```

Compose starts:

- `app`: API server
- `worker`: background settlement/recovery worker
- `caddy`: public reverse proxy and HTTPS edge
- `pay-api-proxy-data`: SQLite database volume

### One-command install script

`scripts/install.sh` clones the repo, writes `.env`, and runs Docker Compose.
On fresh hosts it installs Docker when missing.

**Oracle Linux** (and other RHEL-family distros such as RHEL, Rocky, AlmaLinux)
use Docker's CentOS-compatible `dnf`/`yum` packages: `docker-ce`,
`docker-compose-plugin`, and related plugins. The script also removes the
`podman-docker` shim when present, starts the `docker` service, and installs
`curl`/`git` if they are missing.


### Graceful restart and shutdown

The app drains paid requests on `SIGTERM`/`SIGINT`. During a Docker stop or
recreate it stops accepting new non-health requests, reports `/health` as
unhealthy, waits for active MPP/payment requests to finish, then closes the
database and exits. In-flight requests are tracked by phase, such as payment
verification, upstream forwarding, settlement, receipt creation, and response
send.

Docker Compose gives the app a grace period long enough for the default drain:

```bash
docker compose up -d --force-recreate app worker
```

You can tune the timeout in `.env`:

```ini
GRACEFUL_SHUTDOWN_TIMEOUT_MS=60000
APP_STOP_GRACE_PERIOD=75s
WORKER_STOP_GRACE_PERIOD=30s
```

Keep `APP_STOP_GRACE_PERIOD` slightly longer than
`GRACEFUL_SHUTDOWN_TIMEOUT_MS`; otherwise Docker may send `SIGKILL` before the
app has finished draining.

For providers who already have their own reverse proxy, run the default local-service shape and point the existing proxy at `APP_BIND`:

```bash
docker compose up -d --build
```

For providers who do not have a VPS or public inbound ports, run through Cloudflare Tunnel instead of Caddy. For a temporary test URL:

```bash
docker compose --profile quick-tunnel up -d --build
docker compose logs cloudflared-quick
```

For a stable production hostname:

1. Add the provider's domain to Cloudflare.
2. In Cloudflare Zero Trust, create a remotely-managed Tunnel.
3. Add a Public Hostname, for example `api.example.com`, with service URL `http://app:8080`.
4. Set `CLOUDFLARE_TUNNEL_MODE=named` and copy the tunnel token into `.env` as `CLOUDFLARE_TUNNEL_TOKEN`.
5. Set `DOMAIN_NAME=api.example.com` and `PUBLIC_BASE_URL=https://api.example.com`.
6. Start only the tunnel profile:

```bash
docker compose --profile tunnel up -d --build
```

Cloudflare Tunnel uses outbound connections from the `cloudflared` container, so the provider does not need to open ports 80/443 or own a VPS with a public IP.

## Directory auto-publish

The worker can publish the node to the xpayapi directory without provider
credentials. Put the node's stable public base URL in `.env`:

```ini
XPAYAPI_PUBLISH_ENABLED=true
XPAYAPI_DIRECTORY_URL=https://api.xpayapi.com
PUBLIC_BASE_URL=https://api.example.com
```

On startup, the worker calls the public registration endpoint with only
`PUBLIC_BASE_URL`. The URL must be a real domain-name base URL, not localhost,
an IP address, or a URL with a path. The directory fetches this node's
`/health` and `/openapi.json`, then imports configured `traditionalApis` and
OpenAI-compatible model endpoints only when `upstreamProvider` is `openai`.

Quick Cloudflare tunnels print a temporary URL in `docker compose logs
cloudflared-quick`; set `PUBLIC_BASE_URL` to that URL before enabling
auto-publish. For production, use a named tunnel or your own domain so the URL
does not change.

Compose environment values:

- `NODE_SIGNING_SECRET`: optional override for the internal receipt-signing secret; generated in `data/node-signing-secret` when omitted
- `OPENAI_API_KEY`: optional upstream OpenAI API key
- `PAYMENT_RECIPIENT_ADDRESS`: wallet address that receives customer payments
- `CLOUDFLARE_TUNNEL_TOKEN`: optional token for Cloudflare Tunnel mode
- `XPAYAPI_PUBLISH_ENABLED`: optional directory auto-publish toggle; defaults to true
- `XPAYAPI_DIRECTORY_URL`: optional directory API URL; defaults to `https://api.xpayapi.com`

Compose environment files contain deployment-specific settings and secrets. Optional app settings live in [pay-api-proxy.config.jsonc](pay-api-proxy.config.jsonc), while Compose-only defaults live in [docker-compose.yml](docker-compose.yml).

Set `DOMAIN_NAME` to your public domain, for example `api.example.com`. The app derives `PUBLIC_BASE_URL` from it, usually as `https://api.example.com`; that domain is the node's public identity in discovery and mppx realms. Set `PUBLIC_BASE_URL` only when you need an explicit override. Environment variables still override `pay-api-proxy.config.jsonc` for automation and one-off deployments.

The MVP server exposes:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/images/generations`
- `GET /.well-known/mpp`
- `GET /.well-known/x402`
- `GET /pricing`
- `GET /receipts/:receiptId`
