const https = require("https");
const { URL } = require("url");

const functionUrl = process.env.FUNCTION_URL;

if (!functionUrl) {
  console.error("Set FUNCTION_URL to your Lambda function URL and retry.");
  process.exit(1);
}

const email = process.env.TEST_EMAIL || "test@example.com";
const message =
  process.env.TEST_MESSAGE ||
  "Hello from the POS print test!\nThis is a multi-line message.\nEnjoy!";

const payload = JSON.stringify({ email, message });

const url = new URL(functionUrl);

const requestOptions = {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  },
};

const request = https.request(url, requestOptions, (response) => {
  const chunks = [];

  response.on("data", (chunk) => {
    chunks.push(chunk);
  });

  response.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    const status = response.statusCode;

    console.log(`Response status: ${status}`);
    if (body) {
      console.log("Response body:", body);
    }

    if (status >= 400) {
      process.exitCode = 1;
    }
  });
});

request.on("error", (error) => {
  console.error("Request failed:", error);
  process.exit(1);
});

request.write(payload);
request.end();
