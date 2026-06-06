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

variable "worker_observability_enabled" {
  description = "Whether Workers Observability is enabled."
  type        = bool
  default     = true
}

variable "worker_observability_head_sampling_rate" {
  description = "Workers Observability sampling rate. 1 means 100%, 0.1 means 10%."
  type        = number
  default     = 1

  validation {
    condition     = var.worker_observability_head_sampling_rate >= 0 && var.worker_observability_head_sampling_rate <= 1
    error_message = "worker_observability_head_sampling_rate must be between 0 and 1."
  }
}

variable "worker_observability_logs_enabled" {
  description = "Whether Workers Observability logs are enabled."
  type        = bool
  default     = true
}

variable "worker_observability_logs_head_sampling_rate" {
  description = "Workers Observability log sampling rate. 1 means 100%, 0.1 means 10%."
  type        = number
  default     = 1

  validation {
    condition     = var.worker_observability_logs_head_sampling_rate >= 0 && var.worker_observability_logs_head_sampling_rate <= 1
    error_message = "worker_observability_logs_head_sampling_rate must be between 0 and 1."
  }
}

variable "worker_observability_logs_invocation_logs" {
  description = "Whether Workers invocation logs are enabled."
  type        = bool
  default     = true
}

variable "worker_observability_logs_persist" {
  description = "Whether Workers Observability logs are persisted."
  type        = bool
  default     = true
}

variable "worker_observability_traces_enabled" {
  description = "Whether Workers Observability traces are enabled."
  type        = bool
  default     = true
}

variable "worker_observability_traces_head_sampling_rate" {
  description = "Workers Observability trace sampling rate. 1 means 100%, 0.1 means 10%."
  type        = number
  default     = 1

  validation {
    condition     = var.worker_observability_traces_head_sampling_rate >= 0 && var.worker_observability_traces_head_sampling_rate <= 1
    error_message = "worker_observability_traces_head_sampling_rate must be between 0 and 1."
  }
}

variable "worker_observability_traces_persist" {
  description = "Whether Workers Observability traces are persisted."
  type        = bool
  default     = true
}

variable "pay_api_proxy_config" {
  description = "PAY_API_PROXY_CONFIG JSON/JSONC string. Put apis[], route prices, upstream auth, and per-API rate limits here."
  type        = string
  sensitive   = true
}

variable "extra_plain_text_bindings" {
  description = "Additional non-secret Worker JSON string bindings, for example feature flags used by PAY_API_PROXY_CONFIG."
  type        = map(string)
  default     = {}
}

variable "extra_secret_text_bindings" {
  description = "Additional sensitive Worker JSON string bindings, for example vendor API keys referenced from requestRewrite env values. These avoid a Cloudflare provider secret_text sensitivity bug; protect Terraform state."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "mpp_secret_key" {
  description = "Secret key used by mppx to sign/verify challenges."
  type        = string
  sensitive   = true
}

variable "network" {
  description = "Tempo network preset. Sets RPC URL, chain id, accepted asset, and decimals in one place. Use \"mainnet\" to deploy for real money. Override any individual tempo_* var below to customize."
  type        = string
  default     = "testnet"

  validation {
    condition     = contains(["testnet", "mainnet"], var.network)
    error_message = "network must be either testnet or mainnet."
  }
}

variable "tempo_rpc_url" {
  description = "Override the network preset's Tempo RPC URL. Leave null to use the preset for var.network."
  type        = string
  default     = null
}

variable "tempo_chain_id" {
  description = "Override the network preset's Tempo chain ID. Leave null to use the preset for var.network."
  type        = string
  default     = null
}

variable "tempo_settlement_address" {
  description = "Wallet address that receives settled payments."
  type        = string
}

variable "tempo_accepted_asset" {
  description = "Override the network preset's accepted Tempo asset address. Leave null to use the preset for var.network."
  type        = string
  default     = null
}

variable "tempo_asset_decimals" {
  description = "Override the network preset's accepted asset decimals. Leave null to use the preset for var.network."
  type        = string
  default     = null
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
