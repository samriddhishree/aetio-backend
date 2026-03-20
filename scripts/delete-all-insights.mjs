import assert from "assert";

const baseUrl = process.env.AETIO_BACKEND_URL ?? "http://localhost:8000";
const endpoint = new URL("/insights/deleteAll", baseUrl).toString();

const response = await fetch(endpoint, {
  method: "DELETE",
  headers: {
    "content-type": "application/json",
  },
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
assert.ok(typeof data.deleted === "number", "Expected numeric deleted count");

console.log("Delete-all insights completed", {
  deleted: data.deleted,
  endpoint,
});
