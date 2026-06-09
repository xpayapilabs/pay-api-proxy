locals {
  durable_object_class_name = "MppxStoreDurableObject"
  worker_bundle_path        = var.worker_bundle_path != null ? var.worker_bundle_path : abspath("${path.module}/../../../dist/cloudflare-worker/worker.js")

  pay_api_proxy_config_inline_set   = var.pay_api_proxy_config == null ? false : trimspace(nonsensitive(var.pay_api_proxy_config)) != ""
  pay_api_proxy_config_path         = var.pay_api_proxy_config_path == null ? null : trimspace(var.pay_api_proxy_config_path)
  pay_api_proxy_config_path_set     = local.pay_api_proxy_config_path == null ? false : local.pay_api_proxy_config_path != ""
  pay_api_proxy_config_path_abs     = local.pay_api_proxy_config_path_set ? (startswith(local.pay_api_proxy_config_path, "/") ? local.pay_api_proxy_config_path : abspath("${path.module}/${local.pay_api_proxy_config_path}")) : null
  pay_api_proxy_config_path_exists  = local.pay_api_proxy_config_path_set ? fileexists(local.pay_api_proxy_config_path_abs) : true
  pay_api_proxy_config_source_count = (local.pay_api_proxy_config_inline_set ? 1 : 0) + (local.pay_api_proxy_config_path_set ? 1 : 0)
  pay_api_proxy_config_from_path    = local.pay_api_proxy_config_path_set && local.pay_api_proxy_config_path_exists ? file(local.pay_api_proxy_config_path_abs) : null
  pay_api_proxy_config              = local.pay_api_proxy_config_source_count == 1 && local.pay_api_proxy_config_from_path != null ? local.pay_api_proxy_config_from_path : coalesce(var.pay_api_proxy_config, "")
  openapi_document_paths            = { for api_id, document_path in var.openapi_document_paths : api_id => trimspace(document_path) }
  openapi_document_path_abs         = { for api_id, document_path in local.openapi_document_paths : api_id => startswith(document_path, "/") ? document_path : abspath("${path.module}/${document_path}") }
  openapi_document_path_exists      = { for api_id, document_path in local.openapi_document_path_abs : api_id => fileexists(document_path) }
  openapi_document_hashes           = { for api_id, document_path in local.openapi_document_path_abs : api_id => filesha256(document_path) if local.openapi_document_path_exists[api_id] }
  openapi_documents_configured      = length(var.openapi_document_paths) > 0
  favicon_path                      = var.favicon_path == null ? null : trimspace(var.favicon_path)
  favicon_path_set                  = local.favicon_path == null ? false : local.favicon_path != ""
  favicon_path_abs                  = local.favicon_path_set ? (startswith(local.favicon_path, "/") ? local.favicon_path : abspath("${path.module}/${local.favicon_path}")) : null
  favicon_path_exists               = local.favicon_path_set ? fileexists(local.favicon_path_abs) : true
  favicon_hash                      = local.favicon_path_set ? (local.favicon_path_exists ? filesha256(local.favicon_path_abs) : "") : ""
  worker_bundle_content             = local.openapi_documents_configured || local.favicon_path_set ? file(local.worker_bundle_path) : ""
  worker_bundle_has_openapi_documents = local.openapi_documents_configured ? alltrue([
    for api_id, document_hash in local.openapi_document_hashes :
    strcontains(local.worker_bundle_content, document_hash)
  ]) : true
  worker_bundle_has_favicon = local.favicon_path_set ? strcontains(local.worker_bundle_content, local.favicon_hash) : true

  # One knob: var.network picks the whole Tempo chain preset. Individual tempo_* vars
  # still override when set. The Worker derives mppx.testnet from the chain id (4217 = live).
  network_presets = {
    testnet = {
      rpc_url        = "https://rpc.moderato.tempo.xyz"
      chain_id       = "42431"
      accepted_asset = "0x20c0000000000000000000000000000000000000"
      asset_decimals = "6"
    }
    mainnet = {
      rpc_url        = "https://rpc.tempo.xyz"
      chain_id       = "4217"
      accepted_asset = "0x20C000000000000000000000b9537d11c60E8b50" # USDC on Tempo mainnet
      asset_decimals = "6"
    }
  }
  network_preset = local.network_presets[var.network]

  tempo_rpc_url        = coalesce(var.tempo_rpc_url, local.network_preset.rpc_url)
  tempo_chain_id       = coalesce(var.tempo_chain_id, local.network_preset.chain_id)
  tempo_accepted_asset = coalesce(var.tempo_accepted_asset, local.network_preset.accepted_asset)
  tempo_asset_decimals = coalesce(var.tempo_asset_decimals, local.network_preset.asset_decimals)

  json_bindings = [
    {
      name        = "PUBLIC_BASE_URL"
      type        = "json"
      json        = jsonencode(var.public_base_url)
      class_name  = null
      script_name = null
    },
    {
      name        = "TEMPO_RPC_URL"
      type        = "json"
      json        = jsonencode(local.tempo_rpc_url)
      class_name  = null
      script_name = null
    },
    {
      name        = "TEMPO_CHAIN_ID"
      type        = "json"
      json        = jsonencode(local.tempo_chain_id)
      class_name  = null
      script_name = null
    },
    {
      name        = "TEMPO_SETTLEMENT_ADDRESS"
      type        = "json"
      json        = jsonencode(var.tempo_settlement_address)
      class_name  = null
      script_name = null
    },
    {
      name        = "TEMPO_ACCEPTED_ASSET"
      type        = "json"
      json        = jsonencode(local.tempo_accepted_asset)
      class_name  = null
      script_name = null
    },
    {
      name        = "TEMPO_ASSET_DECIMALS"
      type        = "json"
      json        = jsonencode(local.tempo_asset_decimals)
      class_name  = null
      script_name = null
    }
  ]

  secret_json_bindings = [
    {
      name        = "MPP_SECRET_KEY"
      type        = "json"
      json        = nonsensitive(jsonencode(var.mpp_secret_key))
      class_name  = null
      script_name = null
    },
    {
      name        = "PAY_API_PROXY_CONFIG"
      type        = "json"
      json        = nonsensitive(jsonencode(sensitive(local.pay_api_proxy_config)))
      class_name  = null
      script_name = null
    }
  ]

  extra_json_bindings = [
    for name, value in var.extra_plain_text_bindings : {
      name        = name
      type        = "json"
      json        = jsonencode(value)
      class_name  = null
      script_name = null
    }
  ]

  extra_secret_json_bindings = [
    for name, value in nonsensitive(var.extra_secret_text_bindings) : {
      name        = name
      type        = "json"
      json        = jsonencode(value)
      class_name  = null
      script_name = null
    }
  ]

  durable_object_bindings = var.deployment_phase == "normal" ? [
    {
      name        = "MPPX_STORE"
      type        = "durable_object_namespace"
      json        = null
      class_name  = local.durable_object_class_name
      script_name = null
    }
  ] : []

  worker_bindings = concat(
    local.json_bindings,
    local.secret_json_bindings,
    local.extra_json_bindings,
    local.extra_secret_json_bindings,
    local.durable_object_bindings
  )

  initial_durable_object_migration = var.deployment_phase == "bootstrap" ? {
    new_tag            = var.durable_object_migration_tag
    new_sqlite_classes = [local.durable_object_class_name]
  } : null
}

resource "cloudflare_workers_script" "pay_api_proxy" {
  account_id          = var.cloudflare_account_id
  script_name         = var.worker_name
  main_module         = "worker.js"
  content_file        = local.worker_bundle_path
  content_sha256      = filesha256(local.worker_bundle_path)
  content_type        = "application/javascript+module"
  compatibility_date  = var.compatibility_date
  compatibility_flags = var.compatibility_flags
  bindings            = local.worker_bindings
  migrations          = local.initial_durable_object_migration

  annotations = {
    workers_message = var.deployment_message
  }

  observability = {
    enabled            = var.worker_observability_enabled
    head_sampling_rate = var.worker_observability_head_sampling_rate

    logs = {
      enabled            = var.worker_observability_logs_enabled
      head_sampling_rate = var.worker_observability_logs_head_sampling_rate
      invocation_logs    = var.worker_observability_logs_invocation_logs
      persist            = var.worker_observability_logs_persist
    }

    traces = {
      enabled            = var.worker_observability_traces_enabled
      head_sampling_rate = var.worker_observability_traces_head_sampling_rate
      persist            = var.worker_observability_traces_persist
    }
  }

  lifecycle {
    precondition {
      condition     = local.pay_api_proxy_config_source_count == 1
      error_message = "Set exactly one of pay_api_proxy_config or pay_api_proxy_config_path."
    }

    precondition {
      condition     = local.pay_api_proxy_config_path_exists
      error_message = "pay_api_proxy_config_path must point to an existing JSON/JSONC file. Relative paths are resolved from the Terraform folder."
    }

    precondition {
      condition     = alltrue(values(local.openapi_document_path_exists))
      error_message = "Every openapi_document_paths value must point to an existing JSON/JSONC file. Relative paths are resolved from the Terraform folder."
    }

    precondition {
      condition     = local.favicon_path_exists
      error_message = "favicon_path must point to an existing favicon file. Relative paths are resolved from the Terraform folder."
    }

    precondition {
      condition     = local.worker_bundle_has_openapi_documents
      error_message = "The Worker bundle does not contain the configured OpenAPI document hashes. Rebuild from the repo root with PAY_API_PROXY_OPENAPI_DOCUMENT_PATHS='{\"api_id\":\"deploy/cloudflare-worker/terraform/api.openapi.json\"}' npm run build:worker:cloudflare, then run terraform apply again."
    }

    precondition {
      condition     = local.worker_bundle_has_favicon
      error_message = "The Worker bundle does not contain the configured favicon hash. Rebuild from the repo root with PAY_API_PROXY_FAVICON_PATH='deploy/cloudflare-worker/terraform/favicon.svg' npm run build:worker:cloudflare, then run terraform apply again."
    }
  }
}

resource "cloudflare_workers_script_subdomain" "pay_api_proxy" {
  count = var.enable_workers_dev || var.workers_dev_previews_enabled ? 1 : 0

  account_id       = var.cloudflare_account_id
  script_name      = cloudflare_workers_script.pay_api_proxy.script_name
  enabled          = var.enable_workers_dev
  previews_enabled = var.workers_dev_previews_enabled
}

resource "cloudflare_workers_custom_domain" "pay_api_proxy" {
  count = var.custom_domain_hostname == null ? 0 : 1

  account_id = var.cloudflare_account_id
  hostname   = var.custom_domain_hostname
  service    = cloudflare_workers_script.pay_api_proxy.script_name
  zone_id    = var.cloudflare_zone_id
  zone_name  = var.cloudflare_zone_name

  depends_on = [cloudflare_workers_script.pay_api_proxy]

  lifecycle {
    precondition {
      condition     = var.custom_domain_hostname == null || var.cloudflare_zone_id != null || var.cloudflare_zone_name != null
      error_message = "Set cloudflare_zone_id or cloudflare_zone_name when custom_domain_hostname is set."
    }
  }
}
