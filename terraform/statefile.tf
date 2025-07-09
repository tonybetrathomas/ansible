/*create s3 bucket and dynamoDb table for statefile lock. Initally we create these 2 resources with local as backend and after creating
these resources, we will change the backend terraform.tfstate file location to S3, with state-lock enabled. */
module "statefile_S3" {
  source = "./modules/s3"
  aws_s3_bucket_main_name = var.aws_s3_bucket_main_name
}