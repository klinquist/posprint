const { randomUUID } = require("crypto");
const {
  DynamoDBClient,
} = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  IoTDataPlaneClient,
  PublishCommand,
} = require("@aws-sdk/client-iot-data-plane");

const REGION =
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  }
);

let cachedIotClient;
const getIotClient = () => {
  if (!cachedIotClient) {
    const endpoint = process.env.IOT_ENDPOINT;
    if (!endpoint) {
      throw new Error("IOT_ENDPOINT environment variable is not configured.");
    }

    cachedIotClient = new IoTDataPlaneClient({
      region: REGION,
      endpoint: `https://${endpoint}`,
    });
  }

  return cachedIotClient;
};

const buildResponse = (statusCode, body = {}) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
  },
  body: JSON.stringify(body),
});

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const resolveSourceIp = (event) => {
  const forwarded =
    event?.headers?.["x-forwarded-for"] ||
    event?.headers?.["X-Forwarded-For"] ||
    event?.headers?.["X-FORWARDED-FOR"];

  if (typeof forwarded === "string" && forwarded.trim().length > 0) {
    const [first] = forwarded.split(",");
    if (first && first.trim().length > 0) {
      return first.trim();
    }
  }

  return (
    event?.requestContext?.http?.sourceIp ||
    event?.requestContext?.identity?.sourceIp ||
    null
  );
};

exports.handler = async (event) => {
  if (event?.requestContext?.http?.method === "OPTIONS") {
    return buildResponse(204);
  }

  let payload;

  try {
    payload = JSON.parse(event.body || "{}");
  } catch (err) {
    console.error("Invalid JSON payload", { error: err });
    return buildResponse(400, { message: "Invalid JSON body." });
  }

  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  const message =
    typeof payload.message === "string" ? payload.message.trim() : "";

  if (!email || !message) {
    return buildResponse(400, {
      message: "Both email and message are required.",
    });
  }

  if (message.length > 1024) {
    return buildResponse(400, {
      message: "Message is too long. Maximum length is 1024 characters.",
    });
  }

  const receivedAt = new Date().toISOString();
  const sourceIp = resolveSourceIp(event);

  if (!sourceIp) {
    console.warn("Unable to determine source IP for request.");
    return buildResponse(400, { message: "Unable to determine source IP." });
  }

  const rateLimitMax = parsePositiveInt(
    process.env.RATE_LIMIT_MAX_MESSAGES,
    10
  );
  const rateLimitWindowHours = parsePositiveInt(
    process.env.RATE_LIMIT_WINDOW_HOURS,
    24
  );
  const rateLimitIndex = process.env.DYNAMO_RATE_INDEX;

  if (!rateLimitIndex) {
    console.error("Rate limit index name missing from environment.");
    return buildResponse(500, { message: "Configuration error." });
  }

  const windowStart = new Date(
    Date.now() - rateLimitWindowHours * 60 * 60 * 1000
  ).toISOString();

  try {
    const queryResult = await dynamo.send(
      new QueryCommand({
        TableName: process.env.DYNAMO_TABLE_NAME,
        IndexName: rateLimitIndex,
        KeyConditionExpression:
          "#sourceIp = :sourceIp AND #receivedAt >= :windowStart",
        ExpressionAttributeNames: {
          "#sourceIp": "sourceIp",
          "#receivedAt": "receivedAt",
        },
        ExpressionAttributeValues: {
          ":sourceIp": sourceIp,
          ":windowStart": windowStart,
        },
        Select: "COUNT",
      })
    );

    if ((queryResult.Count || 0) >= rateLimitMax) {
      return buildResponse(429, {
        message: "Rate limit exceeded. Please try again later.",
      });
    }
  } catch (err) {
    console.error("Failed to enforce rate limit", { error: err });
    return buildResponse(500, { message: "Failed to check rate limit." });
  }

  const item = {
    messageId: randomUUID(),
    receivedAt,
    email,
    sourceIp,
    message,
  };

  try {
    await dynamo.send(
      new PutCommand({
        TableName: process.env.DYNAMO_TABLE_NAME,
        Item: item,
      })
    );
  } catch (err) {
    console.error("Failed to store message", { error: err });
    return buildResponse(500, { message: "Failed to store message." });
  }

  try {
    const topic = process.env.IOT_TOPIC;
    if (!topic) {
      console.error("IOT_TOPIC environment variable is not configured.");
      return buildResponse(500, { message: "Configuration error." });
    }

    await getIotClient().send(
      new PublishCommand({
        topic,
        qos: 0,
        payload: Buffer.from(
          JSON.stringify({
            email,
            message,
            receivedAt,
          })
        ),
      })
    );
  } catch (err) {
    console.error("Failed to publish to IoT Core", { error: err });
    return buildResponse(500, { message: "Failed to publish notification." });
  }

  return buildResponse(201, { message: "Message received." });
};
