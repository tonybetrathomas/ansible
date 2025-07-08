resource "aws_s3_bucket" "main" {
  bucket = var.aws_s3_bucket_main_name
  object_lock_enabled = true
}