import assert from "assert";
import { getCognitoJwtToken } from "../test/cognito-test-auth.mjs";

/**
 * Real endpoint integration script for /generate-insights-v2.
 * Assumes backend service is already running.
 *
 * Required env (via .env or shell):
 * - COGNITO_TEST_REGION
 * - COGNITO_TEST_CLIENT_ID
 * - COGNITO_TEST_USERNAME
 * - COGNITO_TEST_PASSWORD
 *
 * Optional env:
 * - AETIO_BACKEND_URL (default: http://localhost:8000)
 * - GENERATE_INSIGHTS_V2_TEST_OUTPUT_URIS (comma-separated S3 URIs)
 * - GENERATE_INSIGHTS_V2_TEST_CONTEXT_URIS (comma-separated S3 URIs, or "null")
 * - GENERATE_INSIGHTS_V2_TEST_RESEARCH_CONTEXT
 */

const baseUrl = process.env.AETIO_BACKEND_URL ?? "http://localhost:8000";
const endpoint = new URL("/generate-insights-v2", baseUrl).toString();
const jwtToken = await getCognitoJwtToken();



// mass incarceration report
//"s3://amplify-amplifyvitereactt-aetioinsightstoragebucke-jzbc7y9yml35/uploads/extraction/f12b4500-1041-7018-dc1d-7bf79ae667c9/Mass Incarceration.pdf"
const payload = {
  outputUrls: parseCsvOrFallback(
    process.env.GENERATE_INSIGHTS_V2_TEST_OUTPUT_URIS,
    [
     "s3://amplify-amplifyvitereactt-aetioinsightstoragebucke-jzbc7y9yml35/uploads/extraction/f12b4500-1041-7018-dc1d-7bf79ae667c9/analysiswithcontext.xlsx - Sheet1.csv"
    ],
  ),
  contextUrls: parseContextUris(process.env.GENERATE_INSIGHTS_V2_TEST_CONTEXT_URIS),
  researchContext:
    process.env.GENERATE_INSIGHTS_V2_TEST_RESEARCH_CONTEXT ??
          "Omnimart loyalty program customer behavior analysis for Q2 2024, focusing on fraud",
};

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    Authorization: `Bearer ${jwtToken}`,
  },
  body: JSON.stringify(payload),
});

const text = await response.text();
let data;
try {
  data = JSON.parse(text);
} catch {
  data = null;
}

console.log("/generate-insights-v2 status:", response.status);
if (data) {
  console.log("/generate-insights-v2 response JSON:");
  console.log(JSON.stringify(data, null, 2));
} else {
  console.log("/generate-insights-v2 response text:");
  console.log(text);
}

assert.ok(
  response.ok,
  `Expected 2xx response from /generate-insights-v2, got ${response.status}: ${text}`,
);
assert.ok(data && typeof data === "object", "Expected JSON response body");

function parseCsvOrFallback(raw, fallback) {
  const parsed = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function parseContextUris(raw) {
  if ((raw ?? "").trim().toLowerCase() === "null") return [];
  return parseCsvOrFallback(raw, []);
}
