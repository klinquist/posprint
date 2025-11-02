terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0.0"
    }

    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4.0"
    }
  }
}

variable "aws_region" {
  description = "AWS region to deploy resources into."
  type        = string
  default     = "us-east-1"
}

locals {
  lambda_name = "posprint-message-receiver"
  table_name  = "posprint_messages"
  iot_topic   = "linquist/posprint"
}

provider "aws" {
  region = var.aws_region
}

data "aws_iot_endpoint" "this" {
  endpoint_type = "iot:Data-ATS"
}

resource "aws_dynamodb_table" "messages" {
  name         = local.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "messageId"

  attribute {
    name = "messageId"
    type = "S"
  }

  attribute {
    name = "sourceIp"
    type = "S"
  }

  attribute {
    name = "receivedAt"
    type = "S"
  }

  global_secondary_index {
    name            = "sourceIp-receivedAt-index"
    hash_key        = "sourceIp"
    range_key       = "receivedAt"
    projection_type = "ALL"
  }

  tags = {
    Project = "posprint"
  }
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name_prefix        = "${local.lambda_name}-role-"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "lambda_permissions" {
  statement {
    sid    = "AllowDynamoPut"
    effect = "Allow"

    actions = [
      "dynamodb:PutItem"
    ]

    resources = [
      aws_dynamodb_table.messages.arn
    ]
  }

  statement {
    sid    = "AllowIotPublish"
    effect = "Allow"

    actions = [
      "iot:Publish"
    ]

    resources = [
      "arn:aws:iot:${var.aws_region}:${data.aws_caller_identity.current.account_id}:topic/${local.iot_topic}"
    ]
  }

  statement {
    sid    = "AllowDynamoQueryIndex"
    effect = "Allow"

    actions = [
      "dynamodb:Query"
    ]

    resources = [
      "${aws_dynamodb_table.messages.arn}/index/sourceIp-receivedAt-index"
    ]
  }
}

data "aws_caller_identity" "current" {}

resource "aws_iam_policy" "lambda_permissions" {
  name_prefix = "${local.lambda_name}-policy-"
  policy      = data.aws_iam_policy_document.lambda_permissions.json
}

resource "aws_iam_role_policy_attachment" "lambda_permissions" {
  role       = aws_iam_role.lambda.name
  policy_arn = aws_iam_policy.lambda_permissions.arn
}

data "archive_file" "lambda_package" {
  type        = "zip"
  source_dir  = "${path.module}/lambda"
  output_path = "${path.module}/lambda.zip"
  depends_on  = [null_resource.lambda_npm_install]
}

resource "aws_lambda_function" "message_receiver" {
  function_name = local.lambda_name
  role          = aws_iam_role.lambda.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"

  filename         = data.archive_file.lambda_package.output_path
  source_code_hash = data.archive_file.lambda_package.output_base64sha256

  environment {
    variables = {
      DYNAMO_TABLE_NAME       = aws_dynamodb_table.messages.name
      DYNAMO_RATE_INDEX       = "sourceIp-receivedAt-index"
      RATE_LIMIT_MAX_MESSAGES = "10"
      RATE_LIMIT_WINDOW_HOURS = "24"
      IOT_ENDPOINT            = data.aws_iot_endpoint.this.endpoint_address
      IOT_TOPIC               = local.iot_topic
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.lambda_basic_execution,
    aws_iam_role_policy_attachment.lambda_permissions
  ]
}

resource "null_resource" "lambda_npm_install" {
  triggers = {
    package_json = filesha256("${path.module}/lambda/package.json")
    package_lock = try(filesha256("${path.module}/lambda/package-lock.json"), "")
  }

  provisioner "local-exec" {
    command     = "npm install"
    working_dir = "${path.module}/lambda"
  }
}

resource "aws_lambda_function_url" "this" {
  function_name      = aws_lambda_function.message_receiver.function_name
  authorization_type = "NONE"

  cors {
    allow_origins = ["*"]
    allow_methods = ["POST"]
    allow_headers = ["content-type"]
  }
}

output "lambda_function_url" {
  description = "Public function URL for submitting messages."
  value       = aws_lambda_function_url.this.function_url
}

output "dynamodb_table_name" {
  description = "DynamoDB table storing received messages."
  value       = aws_dynamodb_table.messages.name
}
