terraform {
  required_version = ">= 1.6.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.19"
    }
  }

  # IMPORTANT: this stack writes secrets (mpp_secret_key, and pay_api_proxy_config which can
  # contain upstream API keys) into Terraform state. Do NOT ship to production on the default
  # local state file. Store state in a private, encrypted, access-controlled backend.
  #
  # Cloudflare R2 is S3-compatible and a natural fit. Uncomment, fill in, then run:
  #   terraform init -reconfigure
  #
  # backend "s3" {
  #   bucket    = "pay-api-proxy-tfstate"                  # R2 bucket name
  #   key       = "cloudflare-worker/terraform.tfstate"
  #   region    = "auto"
  #   endpoints = { s3 = "https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com" }
  #
  #   # Prefer env vars over inline keys: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
  #   # set to an R2 API token's access key id / secret.
  #   access_key = "<R2_ACCESS_KEY_ID>"
  #   secret_key = "<R2_SECRET_ACCESS_KEY>"
  #
  #   # R2 is not real S3 — disable the AWS-only behaviors the backend would otherwise attempt:
  #   skip_credentials_validation = true
  #   skip_region_validation      = true
  #   skip_requesting_account_id  = true
  #   skip_metadata_api_check     = true
  #   skip_s3_checksum            = true
  #   use_path_style              = true
  # }
}

# Reads CLOUDFLARE_API_TOKEN from the environment. The token needs Workers Scripts edit and,
# when attaching a custom domain, Zone / DNS edit on the target zone.
provider "cloudflare" {}
