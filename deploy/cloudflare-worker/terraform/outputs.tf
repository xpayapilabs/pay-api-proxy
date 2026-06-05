output "worker_name" {
  description = "Cloudflare Worker service name."
  value       = cloudflare_workers_script.pay_api_proxy.script_name
}

output "worker_script_id" {
  description = "Cloudflare Worker script resource ID."
  value       = cloudflare_workers_script.pay_api_proxy.id
}

output "worker_script_etag" {
  description = "Cloudflare Worker script ETag after upload."
  value       = cloudflare_workers_script.pay_api_proxy.etag
}

output "custom_domain_hostname" {
  description = "Attached custom domain hostname, if configured."
  value       = var.custom_domain_hostname
}

output "public_base_url" {
  description = "Public base URL configured for the Worker."
  value       = var.public_base_url
}

output "deployment_phase" {
  description = "Current deployment phase."
  value       = var.deployment_phase
}
