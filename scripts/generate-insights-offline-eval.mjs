import assert from "assert";
import fs from "fs/promises";
import path from "path";
import { getCognitoJwtToken } from "../test/cognito-test-auth.mjs";

const baseUrl = process.env.AETIO_BACKEND_URL ?? "http://localhost:8000";
const fixturesPath = process.env.GENERATE_INSIGHTS_OFFLINE_FIXTURES_PATH
  ?? path.resolve("test/fixtures/generate-insights-offline-eval.sample.json");

const jwtToken = await getCognitoJwtToken();
const raw = await fs.readFile(fixturesPath, "utf8");
const fixtures = JSON.parse(raw);

if (!Array.isArray(fixtures) || fixtures.length === 0) {
  throw new Error("Fixture file must be a non-empty array.");
}

const results = [];
for (const fixture of fixtures) {
  const mode = fixture.mode === "v3" ? "v3" : "v2";
  const endpoint = new URL(mode === "v3" ? "/generate-insights-v3" : "/generate-insights-v2", baseUrl).toString();

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${jwtToken}`,
    },
    body: JSON.stringify(fixture.payload ?? {}),
  });

  const text = await response.text();
  let output;
  try {
    output = JSON.parse(text);
  } catch {
    output = undefined;
  }

  assert.ok(response.ok, `Fixture ${fixture.fixture_id} failed with status ${response.status}: ${text}`);

  const checks = runChecks({ fixture, output });
  results.push({
    fixture_id: fixture.fixture_id,
    mode,
    passed: checks.every((check) => check.passed),
    checks,
  });
}

console.log(JSON.stringify({
  fixture_count: results.length,
  passed: results.filter((item) => item.passed).length,
  failed: results.filter((item) => !item.passed).length,
  results,
}, null, 2));

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function collectInsights(output) {
  if (Array.isArray(output?.insights)) return output.insights;
  if (Array.isArray(output?.insight_families)) {
    return output.insight_families.map((family) => ({
      text: family.family_text,
      family_text: family.family_text,
      question_answered: family.question_answered,
      table_dimensions: family.table_dimensions,
    }));
  }
  return [];
}

function collectDimensions(output) {
  if (Array.isArray(output?.insight_family_data)) {
    return Array.from(new Set(output.insight_family_data.flatMap((table) => table.dimensions ?? [])));
  }
  return [];
}

function collectMetadataTags(output) {
  if (Array.isArray(output?.insights)) {
    return Array.from(new Set(output.insights.flatMap((insight) => (insight.metadata ?? []).map((entry) => entry.tag))));
  }
  return [];
}

function collectRowCount(output) {
  if (!Array.isArray(output?.insight_family_data)) return 0;
  return output.insight_family_data.reduce((sum, table) => sum + Number(table.row_count ?? 0), 0);
}

function runChecks({ fixture, output }) {
  const expected = fixture.expected ?? {};
  const checks = [];
  const insights = collectInsights(output);
  const dimensions = collectDimensions(output).map(compact);
  const metadataTags = collectMetadataTags(output).map(compact);
  const rowCount = collectRowCount(output);

  if (typeof expected.expected_insight_count === "number") {
    checks.push({
      check: "expected_insight_count",
      passed: insights.length === expected.expected_insight_count,
      details: `expected=${expected.expected_insight_count}, actual=${insights.length}`,
    });
  }

  if (Array.isArray(expected.expected_family_text_contains)) {
    const corpus = insights.map((item) => compact(item.family_text ?? item.text)).join("\n");
    for (const expectedText of expected.expected_family_text_contains) {
      checks.push({
        check: `expected_family_text_contains:${expectedText}`,
        passed: corpus.includes(compact(expectedText)),
      });
    }
  }

  if (Array.isArray(expected.expected_semantic_labels)) {
    const corpus = insights.map((item) => compact(item.question_answered ?? "")).join("\n");
    for (const expectedLabel of expected.expected_semantic_labels) {
      checks.push({
        check: `expected_semantic_labels:${expectedLabel}`,
        passed: corpus.includes(compact(expectedLabel)),
      });
    }
  }

  if (Array.isArray(expected.expected_dimensions)) {
    for (const expectedDimension of expected.expected_dimensions) {
      checks.push({
        check: `expected_dimensions:${expectedDimension}`,
        passed: dimensions.includes(compact(expectedDimension)),
      });
    }
  }

  if (typeof expected.expected_row_count === "number") {
    checks.push({
      check: "expected_row_count",
      passed: rowCount === expected.expected_row_count,
      details: `expected=${expected.expected_row_count}, actual=${rowCount}`,
    });
  }

  if (Array.isArray(expected.expected_metadata_tags)) {
    for (const tag of expected.expected_metadata_tags) {
      checks.push({
        check: `expected_metadata_tags:${tag}`,
        passed: metadataTags.includes(compact(tag)),
      });
    }
  }

  return checks;
}
