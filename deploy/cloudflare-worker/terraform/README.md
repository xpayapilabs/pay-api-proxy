# Cloudflare Worker Terraform Deploy

This folder deploys the Cloudflare Worker adapter for `pay-api-proxy`.

Terraform manages:

- the Worker service
- one Worker version from `dist/cloudflare-worker/worker.js`
- a 100% deployment to that version
- the `MPPX_STORE` Durable Object binding
- the initial SQLite-backed Durable Object migration
- an optional Worker custom domain

## Prerequisites

Use a Cloudflare API token with Workers Scripts read/write permissions and access to the target zone if you attach a custom domain.

```bash
export CLOUDFLARE_API_TOKEN=...
cd /path/to/pay-api-proxy
npm install
npm run build:worker:cloudflare
```

The build script writes:

```text
dist/cloudflare-worker/worker.js
```

## Configure

```bash
cd deploy/cloudflare-worker/terraform
# Testnet (Tempo Moderato) defaults:
cp terraform.tfvars.example terraform.tfvars
# Or start from the mainnet (real-money) example:
cp terraform.tfvars.mainnet.example terraform.tfvars
```

Edit `terraform.tfvars`.

Put paid API runtime configuration in `pay_api_proxy_config`. Use `apis[]` for multiple upstreams, with per-route prices and optional per-API rate limits.

`custom_domain_hostname` is hostname-only, for example `api.example.com`. Keep the scheme in `public_base_url`, for example `https://api.example.com`.

**Network:** the testnet example uses Tempo Moderato (`tempo_chain_id = "42431"`). The mainnet example uses `tempo_chain_id = "4217"` with the mainnet RPC and USDC asset — the Worker derives `mppx.testnet=false` from the mainnet chain id automatically, so you only set the chain in one place.

## First Deploy

Cloudflare Durable Objects need an initial migration before the normal Worker version can bind to the Durable Object namespace.

```bash
terraform init
terraform apply -var='deployment_phase=bootstrap'
terraform apply -var='deployment_phase=normal'
```

During `bootstrap`, Terraform uploads a Worker version that exports `MppxStoreDurableObject` and applies the `v1` SQLite Durable Object migration. During `normal`, Terraform deploys the real version with the `MPPX_STORE` binding.

## Later Deploys

```bash
cd /path/to/pay-api-proxy
npm run build:worker:cloudflare
cd deploy/cloudflare-worker/terraform
terraform apply -var='deployment_phase=normal'
```

## Remote state (do this before production)

`MPP_SECRET_KEY` and `PAY_API_PROXY_CONFIG` are deployed as `secret_text` bindings, but Terraform state still contains those sensitive values in cleartext. The default local `terraform.tfstate` is fine for testing only.

Before a real deploy, configure a private, encrypted, access-controlled backend. `versions.tf` contains a ready-to-uncomment Cloudflare R2 (S3-compatible) `backend "s3"` block. Fill it in, then:

```bash
terraform init -reconfigure
```

`.gitignore` already excludes `terraform.tfstate*` and `terraform.tfvars`, so local secrets are never committed — but a remote encrypted backend is still required for team use and durability.

## Notes

The Worker adapter currently supports the paid HTTP API path. The Node/container adapter remains the full-featured runtime for OpenAI-compatible/session workflows.

References:

- Cloudflare Workers IaC: https://developers.cloudflare.com/workers/platform/infrastructure-as-code/
- Durable Object migrations: https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/
