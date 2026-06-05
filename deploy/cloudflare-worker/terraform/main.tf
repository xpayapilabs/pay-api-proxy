locals {
  durable_object_class_name = "MppxStoreDurableObject"
  worker_bundle_path        = var.worker_bundle_path != null ? var.worker_bundle_path : abspath("${path.module}/../../../dist/cloudflare-worker/worker.js")

  plain_text_bindings = [
    {
      name        = "PUBLIC_BASE_URL"
      type        = "plain_text"
      text        = var.public_base_url
      class_name  = null
      script_name = null
    },
    {
      name        = "TEMPO_RPC_URL"
      type        = "plain_text"
      text        = var.tempo_rpc_url
      class_name  = null
      script_name = null
    },
    {
      name        = "TEMPO_CHAIN_ID"
      type        = "plain_text"
      text        = var.tempo_chain_id
      class_name  = null
      script_name = null
    },
    {
      name        = "TEMPO_SETTLEMENT_ADDRESS"
      type        = "plain_text"
      text        = var.tempo_settlement_address
      class_name  = null
      script_name = null
    },
    {
      name        = "TEMPO_ACCEPTED_ASSET"
      type        = "plain_text"
      text        = var.tempo_accepted_asset
      class_name  = null
      script_name = null
    },
    {
      name        = "TEMPO_ASSET_DECIMALS"
      type        = "plain_text"
      text        = var.tempo_asset_decimals
      class_name  = null
      script_name = null
    }
  ]

  secret_text_bindings = [
    {
      name        = "MPP_SECRET_KEY"
      type        = "secret_text"
      text        = var.mpp_secret_key
      class_name  = null
      script_name = null
    },
    {
      name        = "PAY_API_PROXY_CONFIG"
      type        = "secret_text"
      text        = var.pay_api_proxy_config
      class_name  = null
      script_name = null
    }
  ]

  durable_object_bindings = var.deployment_phase == "normal" ? [
    {
      name        = "MPPX_STORE"
      type        = "durable_object_namespace"
      text        = null
      class_name  = local.durable_object_class_name
      script_name = null
    }
  ] : []

  worker_bindings = concat(
    local.plain_text_bindings,
    local.secret_text_bindings,
    local.durable_object_bindings
  )

  initial_durable_object_migration = var.deployment_phase == "bootstrap" ? {
    new_tag            = var.durable_object_migration_tag
    new_sqlite_classes = [local.durable_object_class_name]
  } : null
}

resource "cloudflare_worker" "pay_api_proxy" {
  account_id = var.cloudflare_account_id
  name       = var.worker_name
  tags       = var.worker_tags

  subdomain = {
    enabled          = var.enable_workers_dev
    previews_enabled = var.workers_dev_previews_enabled
  }
}

resource "cloudflare_worker_version" "pay_api_proxy" {
  account_id          = var.cloudflare_account_id
  worker_id           = cloudflare_worker.pay_api_proxy.id
  main_module         = "worker.js"
  compatibility_date  = var.compatibility_date
  compatibility_flags = var.compatibility_flags
  bindings            = local.worker_bindings
  migrations          = local.initial_durable_object_migration

  annotations = {
    workers_message = var.deployment_message
  }

  modules = [{
    name         = "worker.js"
    content_type = "application/javascript+module"
    content_file = local.worker_bundle_path
  }]
}

resource "cloudflare_workers_deployment" "pay_api_proxy" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.pay_api_proxy.name
  strategy    = "percentage"

  versions = [{
    version_id = cloudflare_worker_version.pay_api_proxy.id
    percentage = 100
  }]

  annotations = {
    workers_message = var.deployment_message
  }
}

resource "cloudflare_workers_custom_domain" "pay_api_proxy" {
  count = var.custom_domain_hostname == null ? 0 : 1

  account_id = var.cloudflare_account_id
  hostname   = var.custom_domain_hostname
  service    = cloudflare_worker.pay_api_proxy.name
  zone_id    = var.cloudflare_zone_id
  zone_name  = var.cloudflare_zone_name

  depends_on = [cloudflare_workers_deployment.pay_api_proxy]

  lifecycle {
    precondition {
      condition     = var.custom_domain_hostname == null || var.cloudflare_zone_id != null || var.cloudflare_zone_name != null
      error_message = "Set cloudflare_zone_id or cloudflare_zone_name when custom_domain_hostname is set."
    }
  }
}
