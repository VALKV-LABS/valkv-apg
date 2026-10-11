output "traffic_dns_name" {
  description = "Point your domains at this name (CNAME, or an alias record)."
  value       = aws_lb.node.dns_name
}

output "traffic_zone_id" {
  description = "For Route 53 alias records."
  value       = aws_lb.node.zone_id
}

output "admin_url" {
  description = "The Admin API, reachable from inside the VPC and from admin_allowed_cidrs."
  value       = "http://${aws_lb.admin.dns_name}:9000"
}

output "secret_arn" {
  description = "Holds the encryption key, the bootstrap tokens and the database URL."
  value       = aws_secretsmanager_secret.gateway.arn
}

output "log_group" {
  value = aws_cloudwatch_log_group.this.name
}

output "node_security_group_id" {
  description = "Allow this group on your upstreams' security groups."
  value       = aws_security_group.node.id
}
