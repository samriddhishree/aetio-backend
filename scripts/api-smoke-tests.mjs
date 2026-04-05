import assert from "assert";
import { getCognitoJwtToken } from "../test/cognito-test-auth.mjs";

const BASE_URL =  "http://localhost:8000";
const MIN_INSIGHTS = 2;

const jwtToken = await getCognitoJwtToken();
console.log("Successfully obtained Cognito JWT token for smoke tests.", jwtToken);
const headers = {
  Authorization: `Bearer ${jwtToken}`,
};

const cache = {
  insightIds: [],
  projectIds: [],
};

await testFetchAllInsights();

console.log(
  JSON.stringify(
    {
      status: "ok",
      baseUrl: BASE_URL,
      cachedInsightIds: cache.insightIds.length,
      cachedProjectIds: cache.projectIds.length,
    },
    null,
    2,
  ),
);

async function testFetchAllInsights() {
  const url = new URL("/insights", BASE_URL).toString();
  const response = await fetch(url, { method: "GET", headers });
  console.log(`GET /insights response status: ${JSON.stringify(response)}`);
  const body = await parseJsonResponse(response, "GET /insights");

  assert.ok(
    Array.isArray(body.items),
    "GET /insights expected response with an items array",
  );
  assert.ok(
    body.items.length >= MIN_INSIGHTS,
    `GET /insights expected at least ${MIN_INSIGHTS} insights, got ${body.items.length}`,
  );

  const insightIds = body.items
    .map((item) => (typeof item?.insight_id === "string" ? item.insight_id.trim() : ""))
    .filter(Boolean);
  const projectIds = body.items
    .map((item) => (typeof item?.project_id === "string" ? item.project_id.trim() : ""))
    .filter(Boolean);

  assert.ok(insightIds.length > 0, "GET /insights returned no valid insight_id values");
  assert.ok(projectIds.length > 0, "GET /insights returned no valid project_id values");

  cache.insightIds = unique(insightIds);
  cache.projectIds = unique(projectIds);
}

async function parseJsonResponse(response, label) {
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON response (${response.status}): ${text}`);
  }

  if (!response.ok) {
    throw new Error(`${label} failed (${response.status}): ${JSON.stringify(parsed)}`);
  }

  return parsed;
}

function unique(values) {
  return [...new Set(values)];
}
