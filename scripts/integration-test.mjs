import assert from "assert";

const baseUrl = process.env.AETIO_BACKEND_URL ?? "http://localhost:8000";
const endpoint = new URL("/generateInsights", baseUrl).toString();

const payload = {
  userId: process.env.AETIO_TEST_USER_ID ?? "f12b4500-1041-7018-dc1d-7bf79ae667c9",
  outputUrls: [
    process.env.AETIO_TEST_OUTPUT_URL ?? "s3://amplify-amplifyvitereactt-aetioinsightstoragebucke-jzbc7y9yml35/uploads/extraction/f12b4500-1041-7018-dc1d-7bf79ae667c9/0a3fd4f9-d780-4f79-80de-c8c847e9326c-233-597-1-PB.pdf",
  ],
  contextUrls: [
    process.env.AETIO_TEST_CONTEXT_URL ?? "s3://amplify-amplifyvitereactt-aetioinsightstoragebucke-jzbc7y9yml35/uploads/extraction/f12b4500-1041-7018-dc1d-7bf79ae667c9/8bf86a7c-4899-4d3b-85cb-bed041a815f9-5-6-2024_TKH_Hackathon_Demos_Outline___Agenda.pdf",
  ],
  researchContext: "Integration test run",
};

const response = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

const text = await response.text();
let data;
try {
  data = JSON.parse(text);
} catch {
  data = null;
}

assert.ok(response.ok, `Expected 2xx response, got ${response.status}: ${text}`);
assert.ok(data && typeof data === "object", "Expected JSON response body");
assert.equal(data.status, "accepted", "Expected status=accepted");
assert.ok(typeof data.requestId === "string" && data.requestId.length > 0, "Expected requestId");
assert.ok("insights" in data, "Expected insights field");
assert.ok("errors" in data, "Expected errors field");
console.log(response);
//assert.ok (response?.insights > 0, "Expected non-zero insights");

console.log("Integration test passed", {
  status: data.status,
  requestId: data.requestId
});
