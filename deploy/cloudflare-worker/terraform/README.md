# Cloudflare Worker Terraform Deploy

This folder deploys the Cloudflare Worker adapter for `pay-api-proxy`.

Terraform manages:

- the Worker service
- Workers Observability
- the Worker script from `dist/cloudflare-worker/worker.js`
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

Use `extra_secret_text_bindings` for vendor API keys referenced by `requestRewrite`, for example `{ "key": { "env": "VENDOR_FX_API_KEY" } }`.

Due to a Cloudflare Terraform provider Worker bindings sensitivity bug, this module deploys scalar Worker environment values as JSON string bindings instead of native `text` or `secret_text` bindings. The Worker still receives strings in `env.*`, but these values are not Cloudflare-native Worker secrets. Protect Terraform state and restrict Cloudflare account access.

Workers Observability is enabled by default. Tune sampling or persistence with the `worker_observability_*` variables.

`custom_domain_hostname` is hostname-only, for example `api.example.com`. Keep the scheme in `public_base_url`, for example `https://api.example.com`.

**Switching network is one knob — `network`:**

```hcl
network = "testnet"   # default: Tempo Moderato (pathUSD)
network = "mainnet"   # live: Tempo mainnet RPC + chain 4217 + USDC, all set for you
```

`network` selects the RPC URL, chain id, accepted asset, and decimals in one place; the Worker then derives `mppx.testnet=false` from chain id 4217 automatically. You can still override any single value with a `tempo_*` var. To flip an existing deploy to mainnet without editing files:

```bash
terraform apply -var='network=mainnet' -var='deployment_phase=normal'
```

`terraform output network` and `terraform output tempo_chain_id` confirm what you deployed.

## Local Private Files

Keep personal deploy values in ignored local files, not in files that are pushed:

- `terraform.tfvars`: Cloudflare account/zone IDs, Worker name, public domain, wallet address, mppx secret, vendor API keys, and private upstream configuration.
- `terraform.tfstate*`: Terraform state and backups. These can contain `mpp_secret_key`, `PAY_API_PROXY_CONFIG`, and vendor API key bindings.
- `.terraform/`: Terraform provider/plugin cache and local backend metadata.
- `*.auto.tfvars`: optional local override files for personal experiments.

This folder's `.gitignore` excludes those files. Commit only sanitized examples such as `terraform.tfvars.example` and `terraform.tfvars.mainnet.example`.

For a private deployment profile, keep a separate copy such as:

```text
~/pay-api-proxy-private/cloudflare-worker/terraform.tfvars
```

Then copy it into this folder before applying:

```bash
cp ~/pay-api-proxy-private/cloudflare-worker/terraform.tfvars deploy/cloudflare-worker/terraform/terraform.tfvars
```

Do not put real Cloudflare account IDs, zone IDs, domains, upstream URLs, API keys, or wallet private keys in this README or in `*.example` files.

## First Deploy

Cloudflare Durable Objects need an initial migration before the normal Worker can bind to the Durable Object namespace.

```bash
terraform init
terraform apply -var='deployment_phase=bootstrap'
terraform apply -var='deployment_phase=normal'
```

During `bootstrap`, Terraform uploads a Worker script that exports `MppxStoreDurableObject` and applies the `v1` SQLite Durable Object migration. During `normal`, Terraform deploys the real script with the `MPPX_STORE` binding.

## Migrating From Worker Version Resources

Older copies of this module used `cloudflare_worker_version` plus `cloudflare_workers_deployment`. If your state contains those resources, remove them from state before applying this module so Terraform does not delete the existing Worker:

```bash
terraform state rm cloudflare_worker.pay_api_proxy || true
terraform state rm cloudflare_worker_version.pay_api_proxy || true
terraform state rm cloudflare_workers_deployment.pay_api_proxy || true
terraform import cloudflare_workers_script.pay_api_proxy "$CLOUDFLARE_ACCOUNT_ID/$WORKER_NAME"
```

Example:

```bash
export CLOUDFLARE_ACCOUNT_ID="replace-with-cloudflare-account-id"
export WORKER_NAME="pay-api-proxy-worker"
terraform import cloudflare_workers_script.pay_api_proxy "$CLOUDFLARE_ACCOUNT_ID/$WORKER_NAME"
```

## Later Deploys

```bash
cd /path/to/pay-api-proxy
npm run build:worker:cloudflare
cd deploy/cloudflare-worker/terraform
terraform apply -var='deployment_phase=normal'
```

## Remote state (do this before production)

`MPP_SECRET_KEY` and `PAY_API_PROXY_CONFIG` are deployed through Terraform bindings, so Terraform state contains those sensitive values in cleartext. The default local `terraform.tfstate` is fine for testing only.

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
