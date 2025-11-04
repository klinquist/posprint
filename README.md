PosPrint
========

This project wires a public message input to an Epson POS receipt printer at home. It comprises Terraform infrastructure, a serverless ingestion Lambda, and a local Node.js client that listens for new messages and prints them in real time.  Uses the AWS IoT Core MQTT broker for communication between the lambda and the virtual machine running the local script.

Repository Layout
-----------------

- `infra/` – Terraform configuration for the backend stack.
  - `main.tf` – DynamoDB table, IAM roles/policies, Lambda function + Function URL, IoT Core endpoint lookup, and packaging logic (including auto-running `npm install` for the Lambda bundle).
  - `lambda/` – Node.js 20 Lambda handler that validates submissions, enforces per-IP rate limits, stores messages, and publishes to AWS IoT Core.
- `local/` – Node.js utilities for running the home printer client and testing the Lambda URL.
  - `index.js` – Subscribes to the IoT topic using `aws-iot-device-sdk-v2` and prints messages to the networked Epson printer.
  - `test-message.js` – Sends sample requests to the Lambda Function URL for end-to-end testing.
- `stream.sh` - shell script to stream from RTSP to Youtube.



Infrastructure Overview
-----------------------

Terraform provisions the following:

1. DynamoDB table `posprint_messages`
   - Primary key: `messageId` (string, UUID).
   - Global Secondary Index: `sourceIp-receivedAt-index` for per-IP rate limiting.
2. AWS Lambda function `posprint-message-receiver`
   - Runtime: Node.js 20.
   - Exposed via a public Lambda Function URL (no auth; CORS enabled for POST).
   - Environment:
     - `DYNAMO_TABLE_NAME`, `DYNAMO_RATE_INDEX`
     - `RATE_LIMIT_MAX_MESSAGES` (default 10) and `RATE_LIMIT_WINDOW_HOURS` (default 24)
     - `IOT_ENDPOINT` (data endpoint) and `IOT_TOPIC` (`linquist/posprint`)
   - IAM permissions: DynamoDB Put/Query and IoT topic publish.
3. AWS IoT endpoint discovery (`aws_iot_endpoint` data source) to feed the Lambda.
4. Archive packaging that includes Lambda dependencies via `null_resource.lambda_npm_install`.

Local Printer Client
--------------------

`local/index.js` performs:

1. Fetch AWS IoT Core endpoint using IAM credentials (default region `us-east-1`).
2. Connect to the `linquist/posprint` topic over secure WebSockets.
3. Receive JSON messages containing `contact`, `message`, and `receivedAt`.
4. Wrap text to 42 columns, preserve multiline content, and print via ESC/POS (network printer at `192.168.0.5:9100` by default).
5. Append a separator line and feed three blank lines after each message.

Environment variables (optional overrides):

- `AWS_REGION` / `AWS_DEFAULT_REGION`
- `IOT_TOPIC`
- `PRINTER_HOST`, `PRINTER_PORT`, `PRINTER_WIDTH`

Start the client:

```
cd local
npm install
npm start
```

Ensure your AWS credentials (with IoT subscribe permissions) are available in the environment.

Test Script
-----------

`local/test-message.js` sends a POST request to the Lambda Function URL.

Usage:

```
cd local
npm run test:send
```

Environment variables:

- `FUNCTION_URL` *(required)* – the Lambda Function URL.
- `TEST_CONTACT` – override default `"Test User"`.
- `TEST_MESSAGE` – override default multiline content.

API Documentation
-----------------

Endpoint

- **URL**: `https://<function-id>.lambda-url.<region>.on.aws/`
- **Method**: `POST`
- **Headers**: `Content-Type: application/json`
- **CORS**: Enabled (`Access-Control-Allow-Origin: *`). Preflight handled by Lambda.

Request Body (JSON)

```
{
  "contact": "sender@example.com",
  "message": "Hello world\nThis is multiline."
}
```

- `contact` *(string, required)* – free-form contact info (name, email, link, etc.), trimmed, non-empty.
- `message` *(string, required)* – message content, trimmed, maximum 512 characters. Multiline supported via `\n`.

Rate Limiting

- Based on source IP derived from the Lambda request context.
- Defaults: 10 messages per 24 hours (configurable via environment variables).
- Exceeding the limit returns HTTP 429 with JSON body `{ "message": "Rate limit exceeded. Please try again later." }`.

Responses

- `201 Created` – message recorded and published.
  - Body: `{ "message": "Message received." }`
- `400 Bad Request`
  - Causes: missing/empty fields, JSON parse failure, IP resolution failure.
  - Body: `{ "message": "<error description>" }`
- `429 Too Many Requests`
  - Body: `{ "message": "Rate limit exceeded. Please try again later." }`
- `500 Internal Server Error`
  - Causes: DynamoDB error, IoT publish failure, configuration issues.
  - Body: `{ "message": "<error description>" }`

Logging

- Lambda logs to CloudWatch on validation errors, DynamoDB failures, and IoT publish issues.
- Local client logs connection lifecycle events, printer errors, and successful prints.

Deployment & Operation
----------------------

1. Initialize and deploy infrastructure:

   ```
   cd infra
   terraform init
   terraform apply
   ```

   Terraform automatically installs Lambda dependencies before zipping the function.

2. Record outputs:
   - `lambda_function_url` – public submission endpoint.
   - `dynamodb_table_name` – verify table creation.

3. Run local client (see previous section) to print incoming messages.

4. Optionally run `npm run test:send` in `local/` to validate end-to-end flowing from Lambda to printer.
