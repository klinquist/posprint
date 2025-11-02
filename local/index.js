const { IoTClient, DescribeEndpointCommand } = require("@aws-sdk/client-iot");
const { mqtt, iot, auth, io } = require("aws-iot-device-sdk-v2");
const escpos = require("escpos");

escpos.Network = require("escpos-network");

const REGION =
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION ||
  "us-east-1";
const TOPIC = process.env.IOT_TOPIC || "linquist/posprint";
const PRINTER_HOST = process.env.PRINTER_HOST || "192.168.0.5";
const PRINTER_PORT = Number(process.env.PRINTER_PORT || 9100);
const PRINTER_WIDTH = Number(process.env.PRINTER_WIDTH || 42);

const iotClient = new IoTClient({ region: REGION });

const clientBootstrap = new io.ClientBootstrap();

const resolveEndpoint = async () => {
  const result = await iotClient.send(
    new DescribeEndpointCommand({
      endpointType: "iot:Data-ATS",
    })
  );

  if (!result.endpointAddress) {
    throw new Error("Failed to resolve AWS IoT Core endpoint.");
  }

  return result.endpointAddress;
};

const createConnection = async (endpoint) => {
  const credentialsProvider = auth.AwsCredentialsProvider.newDefault();

  const configBuilder =
    iot.AwsIotMqttConnectionConfigBuilder.new_with_websockets({
      credentials_provider: credentialsProvider,
      region: REGION,
    });

  const clientId = `posprint-listener-${Math.floor(
    Math.random() * 1_000_000
  )}`;

  configBuilder.with_endpoint(endpoint);
  configBuilder.with_client_id(clientId);
  configBuilder.with_clean_session(false);
  configBuilder.with_keep_alive_seconds(60);

  const config = configBuilder.build();
  const client = new mqtt.MqttClient(clientBootstrap);

  return client.new_connection(config);
};

const normalizeMessage = (input) => {
  if (typeof input !== "string") {
    return "";
  }

  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
};

const repeatChar = (char, length) => char.repeat(Math.max(length, 0));

const wrapLine = (line, width) => {
  if (!line) {
    return [""];
  }

  const segments = [];
  let remaining = line;

  while (remaining.length > width) {
    segments.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }

  segments.push(remaining);
  return segments;
};

const wrapMessage = (message, width) => {
  const normalized = normalizeMessage(message);

  if (!normalized) {
    return ["(no message provided)"];
  }

  return normalized
    .split("\n")
    .flatMap((line) => wrapLine(line, width));
};

const printJob = (email, message, receivedAt) =>
  new Promise((resolve, reject) => {
    const device = new escpos.Network(PRINTER_HOST, PRINTER_PORT);
    const separator = repeatChar("-", PRINTER_WIDTH);
    const messageLines = wrapMessage(message, PRINTER_WIDTH);

    device.open((error) => {
      if (error) {
        reject(error);
        return;
      }

      const printer = new escpos.Printer(device, {
        width: PRINTER_WIDTH,
      });

      try {
        const lines = [
          `From: ${email}`,
          `Received: ${receivedAt}`,
          "",
          ...messageLines,
          "",
          separator,
        ];

        printer.encode("UTF-8").align("LT");
        lines.forEach((line) => printer.text(line));
        printer.feed(3).close((closeErr) => {
          if (closeErr) {
            reject(closeErr);
            return;
          }
          resolve();
        });
      } catch (err) {
        try {
          device.close();
        } catch (closeErr) {
          console.error("Failed to close device after error:", closeErr);
        }
        reject(err);
      }
    });
  });

const handleMessage = async (topic, payload) => {
  try {
    const data = JSON.parse(
      Buffer.from(payload).toString("utf8")
    );

    if (!data || typeof data !== "object") {
      console.warn("Received empty payload.");
      return;
    }

    const { email, message, receivedAt } = data;

    if (!email || !message) {
      console.warn("Skipping payload with missing fields:", data);
      return;
    }

    await printJob(email, message, receivedAt || new Date().toISOString());
    console.log("Printed message from", email);
  } catch (error) {
    console.error("Failed to process message:", error);
  }
};

const main = async () => {
  try {
    const endpoint = await resolveEndpoint();
    console.log("Using IoT endpoint:", endpoint);

    const connection = await createConnection(endpoint);

    connection.on("error", (error) => {
      console.error("Connection error:", error);
    });

    connection.on("interrupt", () => {
      console.warn("Connection interrupted.");
    });

    connection.on("resume", (returnCode, sessionPresent) => {
      console.log(
        "Connection resumed:",
        returnCode,
        "sessionPresent:",
        sessionPresent
      );
    });

    connection.on("disconnect", () => {
      console.warn("Disconnected from IoT Core.");
    });

    await connection.connect();
    console.log("Connected to AWS IoT Core. Subscribing to topic:", TOPIC);

    await connection.subscribe(TOPIC, mqtt.QoS.AtLeastOnce, handleMessage);
    console.log("Subscription active. Waiting for messages...");

    const exitHandler = async () => {
      console.log("Shutting down...");
      try {
        await connection.disconnect();
      } catch (error) {
        console.error("Error during disconnect:", error);
      } finally {
        process.exit(0);
      }
    };

    process.on("SIGINT", exitHandler);
    process.on("SIGTERM", exitHandler);
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
};

main();
