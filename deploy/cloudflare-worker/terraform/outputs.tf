output "worker_name" {
  description = "Cloudflare Worker service name."
  value       = cloudflare_worker.pay_api_proxy.name
}

output "worker_version_id" {
  description = "Published Worker version ID."
  value       = cloudflare_worker_version.pay_api_proxy.id
}

output "deployment_id" {
  description = "Active Worker deployment ID."
  value       = cloudflare_workers_deployment.pay_api_proxy.id
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
