terraform {
  required_providers {
    aws = {
        source = "hashicorp/aws"
        version = "6.0.0"
    }
  }
  required_version = "1.12.2"
}
provider "aws" {
  assume_role {
    role_arn = var.role_arn
  }
  region = var.aws_provider_region
}