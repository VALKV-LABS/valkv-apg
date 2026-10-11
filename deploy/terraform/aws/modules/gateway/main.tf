# A reference deployment of valkv-apg on AWS (spec §18.1):
#
#   internet -> network load balancer -> nodes (auto-scaling group)
#                                          |  poll
#                                          v
#               internal load balancer -> admin (auto-scaling group) -> Postgres (RDS)
#
# Secrets live in Secrets Manager and are read by the instances at boot.
# Nothing here is specific to one account; see ../../environments/dev.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = ">= 5.40" }
    random = { source = "hashicorp/random", version = ">= 3.6" }
  }
}

data "aws_vpc" "this" {
  id = var.vpc_id
}

# Amazon Linux 2023 for arm64; the default instance types are Graviton.
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

locals {
  # Read off an ARN, so the module needs no region argument of its own.
  region = split(":", aws_cloudwatch_log_group.this.arn)[3]
  tags   = merge(var.tags, { "valkv-apg" = var.name })
}

# ── Secrets ──────────────────────────────────────────────────────────────────

resource "random_bytes" "secret_key" {
  length = 32
}

resource "random_password" "admin_token" {
  length  = 43
  special = false
}

resource "random_password" "node_token" {
  length  = 43
  special = false
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "gateway" {
  name_prefix = "${var.name}-"
  description = "valkv-apg: encryption key, bootstrap tokens and database URL"
  tags        = local.tags
}

resource "aws_secretsmanager_secret_version" "gateway" {
  secret_id = aws_secretsmanager_secret.gateway.id
  secret_string = jsonencode({
    secret_key   = random_bytes.secret_key.base64
    admin_token  = "apg_at_${random_password.admin_token.result}"
    node_token   = "apg_at_${random_password.node_token.result}"
    database_url = "postgres://apg:${random_password.db.result}@${aws_db_instance.this.address}:5432/apg?sslmode=require"
  })
}

# ── Security groups (least privilege) ────────────────────────────────────────

resource "aws_security_group" "node" {
  name_prefix = "${var.name}-node-"
  description = "valkv-apg nodes"
  vpc_id      = var.vpc_id
  tags        = local.tags
}

# The network load balancer keeps the client's address, so traffic arrives from anywhere.
resource "aws_vpc_security_group_ingress_rule" "node_https" {
  security_group_id = aws_security_group.node.id
  description       = "client traffic, HTTPS"
  ip_protocol       = "tcp"
  from_port         = 8443
  to_port           = 8443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "node_http" {
  security_group_id = aws_security_group.node.id
  description       = "client traffic, HTTP (redirects and ACME challenges)"
  ip_protocol       = "tcp"
  from_port         = 8080
  to_port           = 8080
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "node_mgmt" {
  security_group_id = aws_security_group.node.id
  description       = "health checks and metrics, from inside the VPC only"
  ip_protocol       = "tcp"
  from_port         = 9100
  to_port           = 9100
  cidr_ipv4         = data.aws_vpc.this.cidr_block
}

resource "aws_vpc_security_group_egress_rule" "node_all" {
  security_group_id = aws_security_group.node.id
  description       = "upstreams, the admin, image registry, ACME authority"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "admin_lb" {
  name_prefix = "${var.name}-admin-lb-"
  description = "valkv-apg admin load balancer"
  vpc_id      = var.vpc_id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "admin_lb_from_nodes" {
  security_group_id            = aws_security_group.admin_lb.id
  description                  = "nodes polling for configuration"
  ip_protocol                  = "tcp"
  from_port                    = 9000
  to_port                      = 9000
  referenced_security_group_id = aws_security_group.node.id
}

resource "aws_vpc_security_group_ingress_rule" "admin_lb_from_operators" {
  for_each          = toset(var.admin_allowed_cidrs)
  security_group_id = aws_security_group.admin_lb.id
  description       = "operators"
  ip_protocol       = "tcp"
  from_port         = 9000
  to_port           = 9000
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_egress_rule" "admin_lb_to_admin" {
  security_group_id            = aws_security_group.admin_lb.id
  ip_protocol                  = "tcp"
  from_port                    = 9000
  to_port                      = 9000
  referenced_security_group_id = aws_security_group.admin.id
}

resource "aws_security_group" "admin" {
  name_prefix = "${var.name}-admin-"
  description = "valkv-apg admin"
  vpc_id      = var.vpc_id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "admin_from_lb" {
  security_group_id            = aws_security_group.admin.id
  ip_protocol                  = "tcp"
  from_port                    = 9000
  to_port                      = 9000
  referenced_security_group_id = aws_security_group.admin_lb.id
}

resource "aws_vpc_security_group_egress_rule" "admin_all" {
  security_group_id = aws_security_group.admin.id
  description       = "database, image registry"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "db" {
  name_prefix = "${var.name}-db-"
  description = "valkv-apg database"
  vpc_id      = var.vpc_id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "db_from_admin" {
  security_group_id            = aws_security_group.db.id
  description                  = "only the admin talks to the database; nodes never do"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.admin.id
}

# ── Database ─────────────────────────────────────────────────────────────────

resource "aws_db_subnet_group" "this" {
  name_prefix = "${var.name}-"
  subnet_ids  = var.private_subnet_ids
  tags        = local.tags
}

resource "aws_db_instance" "this" {
  identifier_prefix            = "${var.name}-"
  engine                       = "postgres"
  engine_version               = "16"
  instance_class               = var.db_instance_class
  allocated_storage            = 20
  max_allocated_storage        = 200
  storage_type                 = "gp3"
  storage_encrypted            = true
  db_name                      = "apg"
  username                     = "apg"
  password                     = random_password.db.result
  db_subnet_group_name         = aws_db_subnet_group.this.name
  vpc_security_group_ids       = [aws_security_group.db.id]
  multi_az                     = var.db_multi_az
  backup_retention_period      = 7
  deletion_protection          = var.db_deletion_protection
  skip_final_snapshot          = !var.db_deletion_protection
  final_snapshot_identifier    = var.db_deletion_protection ? "${var.name}-final" : null
  auto_minor_version_upgrade   = true
  performance_insights_enabled = true
  tags                         = local.tags
}

# ── Identity of the instances ────────────────────────────────────────────────

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "instance" {
  statement {
    sid       = "ReadTheGatewaySecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.gateway.arn]
  }
  statement {
    sid       = "WriteItsOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }
}

resource "aws_iam_role" "instance" {
  name_prefix        = "${var.name}-"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "instance" {
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.instance.json
}

# Shell access through Session Manager; no SSH port is opened anywhere.
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "this" {
  name_prefix = "${var.name}-"
  role        = aws_iam_role.instance.name
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/valkv-apg/${var.name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

# ── Admin ────────────────────────────────────────────────────────────────────

resource "aws_lb" "admin" {
  name_prefix        = "apgadm"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.admin_lb.id]
  subnets            = var.private_subnet_ids
  tags               = local.tags
}

resource "aws_lb_target_group" "admin" {
  name_prefix = "apgadm"
  port        = 9000
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  health_check {
    path                = "/readyz"
    interval            = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = local.tags
}

# Plain HTTP inside the VPC. To serve the Admin API over TLS, add a certificate
# and an HTTPS listener here, and change the nodes' APG_CONFIG_URL to match.
resource "aws_lb_listener" "admin" {
  load_balancer_arn = aws_lb.admin.arn
  port              = 9000
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.admin.arn
  }
}

resource "aws_launch_template" "admin" {
  name_prefix   = "${var.name}-admin-"
  image_id      = data.aws_ssm_parameter.al2023.value
  instance_type = var.admin_instance_type
  iam_instance_profile {
    arn = aws_iam_instance_profile.this.arn
  }
  vpc_security_group_ids = [aws_security_group.admin.id]
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  user_data = base64encode(templatefile("${path.module}/user_data.sh.tftpl", {
    role       = "admin"
    image      = var.admin_image
    secret_arn = aws_secretsmanager_secret.gateway.arn
    region     = local.region
    log_group  = aws_cloudwatch_log_group.this.name
    admin_url  = ""
    acme_email = ""
    extra_env  = {}
  }))
  tag_specifications {
    resource_type = "instance"
    tags          = merge(local.tags, { Name = "${var.name}-admin" })
  }
  depends_on = [aws_secretsmanager_secret_version.gateway]
}

resource "aws_autoscaling_group" "admin" {
  name_prefix         = "${var.name}-admin-"
  min_size            = var.admin_count
  max_size            = var.admin_count
  desired_capacity    = var.admin_count
  vpc_zone_identifier = var.private_subnet_ids
  target_group_arns   = [aws_lb_target_group.admin.arn]
  health_check_type   = "ELB"
  launch_template {
    id      = aws_launch_template.admin.id
    version = aws_launch_template.admin.latest_version
  }
  # The admin goes first in an upgrade (spec PKG-2): replace it before the nodes.
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
    }
  }
}

# ── Nodes ────────────────────────────────────────────────────────────────────

resource "aws_lb" "node" {
  name_prefix        = "apgnod"
  internal           = false
  load_balancer_type = "network"
  subnets            = var.public_subnet_ids
  tags               = local.tags
}

resource "aws_lb_target_group" "node" {
  for_each = { https = 8443, http = 8080 }

  name_prefix = "apg${substr(each.key, 0, 3)}"
  port        = each.value
  protocol    = "TCP"
  vpc_id      = var.vpc_id
  # The node drains for up to 30 seconds on SIGTERM; give connections that long.
  deregistration_delay = 30
  # Ready means "holds a complete configuration", not "the admin is reachable":
  # nodes stay in service through a control-plane outage.
  health_check {
    protocol            = "HTTP"
    port                = "9100"
    path                = "/readyz"
    interval            = 10
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
  tags = local.tags
}

resource "aws_lb_listener" "node" {
  for_each = { https = 443, http = 80 }

  load_balancer_arn = aws_lb.node.arn
  port              = each.value
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.node[each.key].arn
  }
}

resource "aws_launch_template" "node" {
  name_prefix   = "${var.name}-node-"
  image_id      = data.aws_ssm_parameter.al2023.value
  instance_type = var.node_instance_type
  iam_instance_profile {
    arn = aws_iam_instance_profile.this.arn
  }
  vpc_security_group_ids = [aws_security_group.node.id]
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  user_data = base64encode(templatefile("${path.module}/user_data.sh.tftpl", {
    role       = "node"
    image      = var.node_image
    secret_arn = aws_secretsmanager_secret.gateway.arn
    region     = local.region
    log_group  = aws_cloudwatch_log_group.this.name
    admin_url  = "http://${aws_lb.admin.dns_name}:9000"
    acme_email = var.acme_email
    extra_env  = var.node_env
  }))
  tag_specifications {
    resource_type = "instance"
    tags          = merge(local.tags, { Name = "${var.name}-node" })
  }
}

resource "aws_autoscaling_group" "node" {
  name_prefix         = "${var.name}-node-"
  min_size            = var.node_count.min
  max_size            = var.node_count.max
  desired_capacity    = var.node_count.desired
  vpc_zone_identifier = var.private_subnet_ids
  target_group_arns   = [for tg in aws_lb_target_group.node : tg.arn]
  health_check_type   = "ELB"
  launch_template {
    id      = aws_launch_template.node.id
    version = aws_launch_template.node.latest_version
  }
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 90
    }
  }
  depends_on = [aws_autoscaling_group.admin]

  lifecycle {
    ignore_changes = [desired_capacity]
  }
}

resource "aws_autoscaling_policy" "node_cpu" {
  name                   = "${var.name}-node-cpu"
  autoscaling_group_name = aws_autoscaling_group.node.name
  policy_type            = "TargetTrackingScaling"
  target_tracking_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
    target_value = 60
  }
}
