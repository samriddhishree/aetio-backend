import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const argMap = parseArgs(process.argv.slice(2));

const baseUrl = argMap.baseUrl || process.env.BASE_URL || "http://localhost:8000";
const searchPath = argMap.path || process.env.SEARCH_PATH || "/search";
const payloadPath = argMap.input || process.env.SEARCH_INPUT || path.join(__dirname, "search-sample-input.json");

const payloadRaw = fs.readFileSync(payloadPath, "utf8");
const payload = JSON.parse(payloadRaw);

const url = new URL(searchPath, baseUrl);
const body = JSON.stringify(payload);

const isHttps = url.protocol === "https:";
const client = isHttps ? https : http;

const options = {
  method: "POST",
  hostname: url.hostname,
  port: url.port || (isHttps ? 443 : 80),
  path: `${url.pathname}${url.search}`,
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  },
};

const req = client.request(options, (res) => {
  let responseBody = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => {
    responseBody += chunk;
  });
  res.on("end", () => {
    const status = res.statusCode || 0;
    const ok = status >= 200 && status < 300;

    try {
      const parsed = JSON.parse(responseBody || "{}");
      console.log(JSON.stringify({ status, ok, url: url.toString(), response: parsed }, null, 2));
    } catch {
      console.log(JSON.stringify({ status, ok, url: url.toString(), response: responseBody }, null, 2));
    }

    if (!ok) {
      process.exitCode = 1;
    }
  });
});

req.on("error", (error) => {
  console.error(`Request failed: ${error.message}`);
  process.exit(1);
});

req.write(body);
req.end();

function parseArgs(argv) {
  const result = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--base-url" && argv[i + 1]) {
      result.baseUrl = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--path" && argv[i + 1]) {
      result.path = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--input" && argv[i + 1]) {
      result.input = argv[i + 1];
      i += 1;
      continue;
    }
  }

  return result;
}
