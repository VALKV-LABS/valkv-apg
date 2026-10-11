# A small, disposable environment in the account's default VPC layout.
# Copy this directory for staging and production and change the variables.
#
#   terraform init
#   terraform apply -var vpc_id=vpc-... -var 'public_subnet_ids=[...]' -var 'private_subnet_ids=[...]'

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.40" }
  }
  # Keep state somewhere shared before more than one person applies this:
  # backend "s3" { bucket = "...", key = "valkv-apg/dev.tfstate", region = "...", dynamodb_table = "..." }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "version_tag" {
  description = "Release of valkv-apg to run."
  type        = string
  default     = "0.1.0"
}

module "gateway" {
  source = "../../modules/gateway"

  name               = "apg-dev"
  vpc_id             = var.vpc_id
  public_subnet_ids  = var.public_subnet_ids
  private_subnet_ids = var.private_subnet_ids
  node_image         = "valkv-labs/valkv-apg:${var.version_tag}"
  admin_image        = "valkv-labs/valkv-apg-admin:${var.version_tag}"

  # Small and cheap; none of this is for production.
  node_instance_type     = "t4g.small"
  node_count             = { min = 2, desired = 2, max = 3 }
  admin_count            = 1
  db_instance_class      = "db.t4g.micro"
  db_multi_az            = false
  db_deletion_protection = false

  tags = { environment = "dev" }
}

output "traffic_dns_name" {
  value = module.gateway.traffic_dns_name
}

output "admin_url" {
  value = module.gateway.admin_url
}

output "secret_arn" {
  value = module.gateway.secret_arn
}
