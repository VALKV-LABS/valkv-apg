variable "name" {
  description = "Prefix for every resource this module creates."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  description = "Subnets of the public load balancer, one per availability zone."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Subnets of the nodes, the admin and the database. They need a route to the internet (NAT) to pull images and reach an ACME authority."
  type        = list(string)
}

variable "node_image" {
  description = "Node image with its tag, for example valkv-labs/valkv-apg:0.1.0."
  type        = string
}

variable "admin_image" {
  description = "Admin image with its tag, for example valkv-labs/valkv-apg-admin:0.1.0."
  type        = string
}

variable "node_instance_type" {
  type    = string
  default = "c7g.large"
}

variable "admin_instance_type" {
  type    = string
  default = "t4g.small"
}

variable "node_count" {
  description = "Smallest, wanted and largest number of nodes."
  type        = object({ min = number, desired = number, max = number })
  default     = { min = 2, desired = 2, max = 6 }
}

variable "admin_count" {
  type    = number
  default = 2
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "db_multi_az" {
  type    = bool
  default = true
}

variable "db_deletion_protection" {
  description = "Set to false only for an environment you mean to destroy."
  type        = bool
  default     = true
}

variable "admin_allowed_cidrs" {
  description = "Networks that may call the Admin API through the internal load balancer, besides the nodes."
  type        = list(string)
  default     = []
}

variable "acme_email" {
  description = "Contact for certificates from an ACME authority. Leave empty to use only uploaded certificates."
  type        = string
  default     = ""
}

variable "node_env" {
  description = "Extra environment variables for the nodes."
  type        = map(string)
  default     = {}
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
