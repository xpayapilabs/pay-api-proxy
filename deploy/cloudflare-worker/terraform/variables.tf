variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the Worker."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for the custom domain. Leave null when not attaching a custom domain."
  type        = string
  default     = null
}

variable "cloudflare_zone_name" {
  description = "Cloudflare zone name for the custom domain. Optional when cloudflare_zone_id is set."
  type        = string
  default     = null
}

variable "worker_name" {
  description = "Cloudflare Worker service name."
  type        = string
  default     = "pay-api-proxy-worker"
}

variable "worker_bundle_path" {
  description = "Path to the bundled Worker JavaScript file produced by npm run build:worker:cloudflare."
  type        = string
  default     = null
}

variable "deployment_phase" {
  description = "Use bootstrap only for the first Durable Object migration apply; use normal for the real running Worker and all later deploys."
  type        = string
  default     = "normal"

  validation {
    condition     = contains(["bootstrap", "normal"], var.deployment_phase)
    error_message = "deployment_phase must be either bootstrap or normal."
  }
}

variable "durable_object_migration_tag" {
  description = "Initial Durable Object migration tag. Change only when intentionally adding a new Durable Object migration."
  type        = string
  default     = "v1"
}

variable "compatibility_date" {
  description = "Cloudflare Workers compatibility date."
  type        = string
  default     = "2026-06-03"
}

variable "compatibility_flags" {
  description = "Cloudflare Workers compatibility flags."
  type        = list(string)
  default     = ["nodejs_compat"]
}

variable "public_base_url" {
  description = "Public HTTPS base URL clients use for this paid API proxy."
  type        = string

  validation {
    condition     = can(regex("^https://[^/]+", var.public_base_url))
    error_message = "public_base_url must be an HTTPS base URL, for example https://api.example.com."
  }
}

variable "custom_domain_hostname" {
  description = "Optional custom domain hostname to attach to the Worker, without scheme."
  type        = string
  default     = null

  validation {
    condition = var.custom_domain_hostname == null || (
      can(regex("^[A-Za-z0-9.-]+$", var.custom_domain_hostname)) &&
      !can(regex("^https?://", var.custom_domain_hostname))
    )
    error_message = "custom_domain_hostname must be a hostname only, for example api.example.com."
  }
}

variable "enable_workers_dev" {
  description = "Whether to expose the Worker on workers.dev in addition to any custom domain."
  type        = bool
  default     = false
}

variable "workers_dev_previews_enabled" {
  description = "Whether preview URLs are enabled on workers.dev."
  type        = bool
  default     = false
}

variable "pay_api_proxy_config" {
  description = "PAY_API_PROXY_CONFIG JSON/JSONC string. Put apis[], route prices, upstream auth, and per-API rate limits here."
  type        = string
  sensitive   = true
}

variable "mpp_secret_key" {
  description = "Secret key used by mppx to sign/verify challenges."
  type        = string
  sensitive   = true
}

variable "tempo_rpc_url" {
  description = "Tempo RPC URL."
  type        = string
  default     = "https://rpc.moderato.tempo.xyz"
}

variable "tempo_chain_id" {
  description = "Tempo chain ID."
  type        = string
  default     = "42431"
}

variable "tempo_settlement_address" {
  description = "Wallet address that receives settled payments."
  type        = string
}

variable "tempo_accepted_asset" {
  description = "Accepted Tempo asset address."
  type        = string
  default     = "0x20c0000000000000000000000000000000000000"
}

variable "tempo_asset_decimals" {
  description = "Accepted asset decimals."
  type        = string
  default     = "6"
}

variable "worker_tags" {
  description = "Tags applied to the Cloudflare Worker."
  type        = set(string)
  default     = ["pay-api-proxy", "paid-api"]
}

variable "deployment_message" {
  description = "Annotation message for the Worker version/deployment."
  type        = string
  default     = "Deploy pay-api-proxy Cloudflare Worker"
}
