# Preparation only: no resources exist unless explicitly enabled at client onboarding.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}
variable "enabled" { type = bool
  default = false
}
variable "cluster_name" { type = string
  default = "tttps-replay"
}
variable "acl_name" { type = string
  default = ""
}
variable "subnet_group_name" { type = string
  default = ""
}
variable "security_group_ids" { type = list(string)
  default = []
}
variable "parameter_group_name" { type = string
  default = ""
  description = "Reviewed MemoryDB parameter group using maxmemory-policy=noeviction."
}
variable "node_type" { type = string
  default = "db.t4g.small"
}
variable "kms_key_arn" { type = string
  default = null
}
resource "aws_memorydb_cluster" "replay" {
  count = var.enabled ? 1 : 0
  name = var.cluster_name
  acl_name = var.acl_name
  subnet_group_name = var.subnet_group_name
  security_group_ids = var.security_group_ids
  parameter_group_name = var.parameter_group_name
  node_type = var.node_type
  num_shards = 1
  num_replicas_per_shard = 1
  tls_enabled = true
  kms_key_arn = var.kms_key_arn
  snapshot_retention_limit = 0
  tags = { Purpose = "TTTPS replay claims" }
  lifecycle {
    precondition {
      condition = var.acl_name != "" && var.acl_name != "open-access" && var.subnet_group_name != "" && length(var.security_group_ids) > 0 && var.parameter_group_name != ""
      error_message = "Client onboarding requires private networking, reviewed ACL and noeviction parameter group."
    }
  }
}
output "endpoint" {
  value = var.enabled ? aws_memorydb_cluster.replay[0].cluster_endpoint : null
}
