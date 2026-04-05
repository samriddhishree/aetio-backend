import assert from "assert";
import { getCognitoJwtToken } from "../test/cognito-test-auth.mjs";

/**
 * Real endpoint integration script for:
 * POST /insights/:insightId/opensearch
 *
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
 * - FAMILY_PERSISTENCE_TEST_INSIGHT_ID
 * - AETIO_BACKEND_JWT (if set, skips Cognito login)
 */

const baseUrl = process.env.AETIO_BACKEND_URL ?? "http://localhost:8000";
const insightId =
  process.env.FAMILY_PERSISTENCE_TEST_INSIGHT_ID ?? "c1639542cfea36c9887b70115f393770";

const endpoint = new URL(
  `/insights/${encodeURIComponent(insightId)}/opensearch`,
  baseUrl,
).toString();

const jwtToken = process.env.AETIO_BACKEND_JWT ?? (await getCognitoJwtToken());

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${jwtToken}`,
  },
});

const text = await response.text();
let data;
try {
  data = JSON.parse(text);
} catch {
  data = null;
}

console.log("/insights/:insightId/opensearch status:", response.status);
if (data) {
  console.log("/insights/:insightId/opensearch response JSON:");
  console.log(JSON.stringify(data, null, 2));
} else {
  console.log("/insights/:insightId/opensearch response text:");
  console.log(text);
}

assert.ok(
  response.ok,
  `Expected 2xx response from /insights/:insightId/opensearch, got ${response.status}: ${text}`,
);
assert.ok(data && typeof data === "object", "Expected JSON response body");
assert.equal(
  data.insight_id,
  insightId,
  `Expected insight_id to equal ${insightId}, got ${data.insight_id}`,
);
assert.equal(data.indexed, true, "Expected indexed=true in response");

