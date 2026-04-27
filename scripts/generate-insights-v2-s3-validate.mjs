import assert from "assert";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { getCognitoJwtToken } from "../test/cognito-test-auth.mjs";

/**
 * Integration validator for /generate-insights-v2 (default) and /generate-insights-v3 (--v3).
 *
 * What it does:
 * 1) Accepts a required S3 input URL.
 * 2) Calls /generate-insights-v2 with Cognito auth (or /generate-insights-v3 with --v3),
 *    using endpoint-compatible payload fields.
 * 3) Waits at least 2 minutes before continuing (even if response returns earlier).
 * 4) Auto-generates expectation profile from a local CSV sample (if available).
 * 5) Validates family/data/row/metadata shape + minimum quality thresholds.
 *
 * Usage:
 *   node scripts/generate-insights-v2-s3-validate.mjs \
 *     --s3-url "s3://.../analysiswithcontext.xlsx - Sheet1.csv"
 *
 *   node scripts/generate-insights-v2-s3-validate.mjs \
 *     --v3 \
 *     --s3-url "s3://.../analysiswithcontext.xlsx - Sheet1.csv"
 *
 * Optional CLI flags:
 * - --context-urls "s3://.../context-a.pdf,s3://.../context-b.pdf"
 * - --raw-data-urls "s3://.../raw-a.csv,s3://.../raw-b.csv"
 * - --upload-mode "document|manual"
 * - --project-id "..."
 * - --organization-id "..."
 * - --status "Pending|Accepted|Declined|..."
 * - --research-context "..."
 * - --research-objective "..."
 * - --methodology "..."
 * - --additional-context "..."
 * - --analysis-start-date "YYYY-MM-DD"
 * - --analysis-end-date "YYYY-MM-DD"
 * - --owner "..."
 * - --related-projects "..."
 * - --approval-status "pending|approved_pr|approved_legal|approved_both|not_required"
 * - --sharing-scope "internal_restricted|internal_all|external_restricted|public"
 * - --user-info-json '{"full_name":"...","email_address":"..."}'
 *
 * Optional env:
 * - AETIO_BACKEND_URL (default: http://localhost:8000)
 * - GENERATE_INSIGHTS_V2_MIN_WAIT_MS (default: 120000)
 * - GENERATE_INSIGHTS_V2_VALIDATE_PROFILE_CSV
 *   (default: /Users/samriddhis/Downloads/analysiswithcontext.xlsx - Sheet1.csv)
 * - GENERATE_INSIGHTS_V2_RESEARCH_CONTEXT
 * - GENERATE_INSIGHTS_V2_TEST_CONTEXT_URIS / GENERATE_INSIGHTS_V3_TEST_CONTEXT_URIS (comma-separated)
 * - GENERATE_INSIGHTS_V2_TEST_RAW_DATA_URIS / GENERATE_INSIGHTS_V3_TEST_RAW_DATA_URIS (comma-separated)
 * - GENERATE_INSIGHTS_V2_UPLOAD_MODE / GENERATE_INSIGHTS_V3_UPLOAD_MODE ("document" | "manual")
 * - GENERATE_INSIGHTS_V2_STATUS / GENERATE_INSIGHTS_V3_STATUS
 * - GENERATE_INSIGHTS_V2_PROJECT_ID / GENERATE_INSIGHTS_V3_PROJECT_ID
 * - GENERATE_INSIGHTS_V2_ORGANIZATION_ID / GENERATE_INSIGHTS_V3_ORGANIZATION_ID
 * - GENERATE_INSIGHTS_V2_USER_INFO_JSON / GENERATE_INSIGHTS_V3_USER_INFO_JSON (JSON object)
 * - Structured research fields:
 *   GENERATE_INSIGHTS_V2_RESEARCH_OBJECTIVE / _METHODOLOGY / _ADDITIONAL_CONTEXT
 *   / _ANALYSIS_START_DATE / _ANALYSIS_END_DATE / _OWNER / _RELATED_PROJECTS
 *   / _APPROVAL_STATUS / _SHARING_SCOPE
 */

const DEFAULT_PROFILE_CSV =
  "/Users/samriddhis/Downloads/analysiswithcontext.xlsx - Sheet1.csv";
const DEFAULT_S3_URL = "s3://amplify-amplifyvitereactt-aetioinsightstoragebucke-jzbc7y9yml35/uploads/extraction/f12b4500-1041-7018-dc1d-7bf79ae667c9/analysiswithcontext.xlsx - Sheet1.csv";
// nutrients:   url: 'https://amplify-amplifyvitereactt-aetioinsightstoragebucke-jzbc7y9yml35.s3.us-east-2.amazonaws.com/uploads/extraction/f12b4500-1041-7018-dc1d-7bf79ae667c9/4fd87a3c-4a98-43e2-9545-4d0af28396a1-nutrients-13-03305.pdf?x-id=GetObject&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAVCLQ3AD2DATF56I6%2F20260423%2Fus-east-2%2Fs3%2Faws4_request&X-Amz-Date=20260423T122845Z&X-Amz-SignedHeaders=host&X-Amz-Expires=900&X-Amz-Security-Token=IQoJb3JpZ2luX2VjEJz%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMiJHMEUCICG0Kh%2F1YpLacqqMNjm1jD92oRHaDNQ744f2ZA3Vh2DhAiEAyfRFA5ZiNZMyn%2BhvgvpLF9mAyKvtGe5vSIyCGa5JOFYqxgQIZhAAGgwzNDg2NjU4NzI2MjgiDJFI5FfJl7rAIyAvFCqjBH0LQ%2BdJohV36sBNXRng%2FnWhHkKRjqWg%2BXPKGYWv4ciBVz9Ugj89YuIVDO%2FCOCDrcXdTKPMrWyCEDUpmXMosJnmRWN5o6oqzh7qQcCGmaiEe1Hq5OCohkQB%2BVV0hekMZ2ndL5IFjGG85HMRsQKAQNHkprTK4mKZ91WrICJC7cYp0rpE%2FO042VFDrX8U5otAU5fv3w6%2BCsodfZ39Jksbv8sqPiuXimZBw%2BEuydIRMbLVz%2FMVorwrDhwRO0OlugpKH0h1U%2B4UobH6N28hTJtsZOwwahR3n3YN1bxk86vP9LIso5pEZSO5dTZGE59YgrI6SZklTv%2F63un%2FUUHRl5uRuR6K0kXSnh%2BeqcbZxhssYO9Km0u81Ub850XbNHI190jO1WHJZkq1oHn7q4oEKN8g47YxrHQ7EWvTQDowvrXA5Dz7rAfALMaH2hGbARbqarJFiFDdfivlcQn7SDSzw%2FHhZ2NJ3n6BBNlamWG0nEas%2FmTu49LnXlq28v372K8CtF0PYWYE5d6vOWAm7vQxm8KguEnJdWL4Q%2B7fVUsqiwX2msXp3GZSWc1PJng9ji4ilOYyTHMTjJDJCR5L%2FU0Ug79DWmWZuAUK3d3%2BTP7Gc3AQvT9vmbJqYMfJwAGrmR%2Fy5RvGDpYqsvjvfx0cEA1tYIIoHMaX8mfLF90fspn3OLqcYfnt9aYe3qEU%2FOrIlX8FCzN22kfBq%2B1rdqUoYIj0PlBeHgVajV2cwtqCozwY6gwJ6DdOysgfh%2Bz%2BCws44Swe041xAmE%2BgrfVSCJQf8i1Hj%2Fa1hXjnxKbuD8n1aKH5A1bImFlHpV9IHFOB%2FMqeyWZvf75kLIpQZTr4bhKDkvUQoeHjjFGeRjUYRkTvU7q92WKSuMfMkjb5kXOii8yi4k2X43QZ0TgB%2FwytaHjBDrYbTzpcx82xHOSOfM3KhvJlkxQ9N%2FaCN2xCiEMHZdPADbWc6PiVKokDxqta%2FIwuem5JogXePbcklTZrCw7aIb86NzA1gpm7%2F76bYy0ZrKnfhb6Imd1mfu%2FnnohEQ4aIcELBtQo4YOqgWaXcxRNH%2FyCJ7PAtZOlzouPYSXyhX%2FCaDTx6Vkfb&X-Amz-Signature=f831466ecf1e2721642e6cd75785f23ca2d797d62d1b1d1085ffe39d0f59a534'
//"s3://amplify-amplifyvitereactt-aetioinsightstoragebucke-jzbc7y9yml35/uploads/extraction/f12b4500-1041-7018-dc1d-7bf79ae667c9/Mass Incarceration.pdf"
 // crop yield "s3://amplify-amplifyvitereactt-aetioinsightstoragebucke-jzbc7y9yml35/uploads/extraction/f12b4500-1041-7018-dc1d-7bf79ae667c9/analysiswithcontext.xlsx - Sheet1.csv";

const args = parseArgs(process.argv.slice(2));
const useV3 = args.v3 === "true";
const versionLabel = useV3 ? "v3" : "v2";
const baseUrl = process.env.AETIO_BACKEND_URL ?? "http://localhost:8000";
const endpointPath = useV3 ? "/generate-insights-v3" : "/generate-insights-v2";
const endpoint = new URL(endpointPath, baseUrl).toString();
const minWaitFromEnv = useV3
  ? process.env.GENERATE_INSIGHTS_V3_MIN_WAIT_MS ?? process.env.GENERATE_INSIGHTS_V2_MIN_WAIT_MS
  : process.env.GENERATE_INSIGHTS_V2_MIN_WAIT_MS;
const minWaitMs = Math.max(
  120000,
  Number.parseInt(minWaitFromEnv ?? "120000", 10) || 120000,
);
const profileCsvPath =
  process.env.GENERATE_INSIGHTS_V2_VALIDATE_PROFILE_CSV?.trim() || DEFAULT_PROFILE_CSV;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const tmpDir = path.join(projectRoot, "tmp");

const s3Url =
  args["s3-url"]?.trim()
  || process.env.GENERATE_INSIGHTS_V2_TEST_S3_URL?.trim()
  || process.env.GENERATE_INSIGHTS_V3_TEST_S3_URL?.trim()
  || DEFAULT_S3_URL;
assert.ok(
  s3Url && typeof s3Url === "string" && s3Url.startsWith("s3://"),
  "Missing required --s3-url s3://... argument (or GENERATE_INSIGHTS_V2_TEST_S3_URL env).",
);

const expectationProfile = await buildExpectationProfile(profileCsvPath);
const jwtToken = await getCognitoJwtToken();
const startedAt = Date.now();

const payload = buildRequestPayload({ useV3, s3Url, args });

console.log(`generate-insights-${versionLabel} validation starting`, {
  version: versionLabel,
  endpoint,
  s3Url,
  minWaitMs,
  profileCsvPath: expectationProfile.profileSource,
  expected: expectationProfile.expected,
  requestPayloadShape: {
    outputUrls: payload.outputUrls.length,
    contextUrls: payload.contextUrls.length,
    rawDataUrls: payload.rawDataUrls.length,
    hasResearchContext: Boolean(payload.researchContext),
    hasStructuredResearchFields: hasStructuredResearchFields(payload),
    uploadMode: payload.uploadMode ?? null,
    status: payload.status ?? null,
    hasProjectId: Boolean(payload.projectId),
    hasOrganizationId: Boolean(payload.organizationId),
    hasUserInfo: Boolean(payload.userInfo),
  },
});

const responsePromise = fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    Authorization: `Bearer ${jwtToken}`,
  },
  body: JSON.stringify(payload),
});

const [response] = await Promise.all([responsePromise, delay(minWaitMs)]);
const elapsedMs = Date.now() - startedAt;
const text = await response.text();
let data;
try {
  data = JSON.parse(text);
} catch {
  data = null;
}

assert.ok(
  response.ok,
  `Expected 2xx response from ${endpointPath}, got ${response.status}: ${text}`,
);
assert.ok(data && typeof data === "object", "Expected JSON response body.");

await fs.mkdir(tmpDir, { recursive: true });
const responseOutputPath = path.join(
  tmpDir,
  `generate-insights-${versionLabel}-response-${Date.now()}.json`,
);
await fs.writeFile(responseOutputPath, JSON.stringify(data, null, 2), "utf8");

const validation = useV3
  ? validateGenerateInsightsV3Response(data, expectationProfile.expected)
  : validateGenerateInsightsV2Response(data, expectationProfile.expected);
const summary = {
  version: versionLabel,
  endpointPath,
  elapsedMs,
  waitedAtLeastTwoMinutes: elapsedMs >= 120000,
  status: response.status,
  responseOutputPath,
  observed: validation.observed,
  expected: expectationProfile.expected,
  warnings: validation.warnings,
};

console.log(`generate-insights-${versionLabel} validation summary:`);
console.log(JSON.stringify(summary, null, 2));
assert.equal(validation.errors.length, 0, `Validation failed:\n- ${validation.errors.join("\n- ")}`);

console.log(`generate-insights-${versionLabel} validation passed`);

function parseArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      output[key] = "true";
      continue;
    }
    output[key] = next;
    index += 1;
  }
  return output;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRequestPayload(input) {
  const envPrefix = input.useV3 ? "GENERATE_INSIGHTS_V3" : "GENERATE_INSIGHTS_V2";
  const fallbackPrefix = "GENERATE_INSIGHTS_V2";
  const contextUrls = parseCsvList(
    input.args["context-urls"] ??
      envValue(`${envPrefix}_TEST_CONTEXT_URIS`) ??
      envValue(`${fallbackPrefix}_TEST_CONTEXT_URIS`),
  );
  const rawDataUrls = parseCsvList(
    input.args["raw-data-urls"] ??
      envValue(`${envPrefix}_TEST_RAW_DATA_URIS`) ??
      envValue(`${fallbackPrefix}_TEST_RAW_DATA_URIS`),
  );

  const researchContext =
    input.args["research-context"]?.trim() ||
    envValue(`${envPrefix}_RESEARCH_CONTEXT`) ||
    envValue(`${fallbackPrefix}_RESEARCH_CONTEXT`) ||
    "";

  const userInfo =
    parseJsonObject(input.args["user-info-json"]) ||
    parseJsonObject(envValue(`${envPrefix}_USER_INFO_JSON`)) ||
    parseJsonObject(envValue(`${fallbackPrefix}_USER_INFO_JSON`));

  const uploadModeCandidate =
    input.args["upload-mode"]?.trim() ||
    envValue(`${envPrefix}_UPLOAD_MODE`) ||
    envValue(`${fallbackPrefix}_UPLOAD_MODE`);
  const uploadMode =
    uploadModeCandidate === "document" || uploadModeCandidate === "manual"
      ? uploadModeCandidate
      : undefined;

  const payload = {
    outputUrls: [input.s3Url],
    contextUrls,
    rawDataUrls,
    researchContext,
    ...(uploadMode ? { uploadMode } : {}),
    ...(input.args["project-id"]?.trim() ||
    envValue(`${envPrefix}_PROJECT_ID`) ||
    envValue(`${fallbackPrefix}_PROJECT_ID`)
      ? {
          projectId:
            input.args["project-id"]?.trim() ||
            envValue(`${envPrefix}_PROJECT_ID`) ||
            envValue(`${fallbackPrefix}_PROJECT_ID`),
        }
      : {}),
    ...(input.args["organization-id"]?.trim() ||
    envValue(`${envPrefix}_ORGANIZATION_ID`) ||
    envValue(`${fallbackPrefix}_ORGANIZATION_ID`)
      ? {
          organizationId:
            input.args["organization-id"]?.trim() ||
            envValue(`${envPrefix}_ORGANIZATION_ID`) ||
            envValue(`${fallbackPrefix}_ORGANIZATION_ID`),
        }
      : {}),
    ...(input.args.status?.trim() || envValue(`${envPrefix}_STATUS`) || envValue(`${fallbackPrefix}_STATUS`)
      ? {
          status:
            input.args.status?.trim() ||
            envValue(`${envPrefix}_STATUS`) ||
            envValue(`${fallbackPrefix}_STATUS`),
        }
      : {}),
    ...(userInfo ? { userInfo } : {}),
    ...buildStructuredResearchFields({ envPrefix, fallbackPrefix, args: input.args }),
  };

  return payload;
}

function buildStructuredResearchFields(input) {
  const out = {};
  const fields = [
    ["researchObjective", "RESEARCH_OBJECTIVE", "research-objective"],
    ["methodology", "METHODOLOGY", "methodology"],
    ["additionalContext", "ADDITIONAL_CONTEXT", "additional-context"],
    ["analysisStartDate", "ANALYSIS_START_DATE", "analysis-start-date"],
    ["analysisEndDate", "ANALYSIS_END_DATE", "analysis-end-date"],
    ["owner", "OWNER", "owner"],
    ["relatedProjects", "RELATED_PROJECTS", "related-projects"],
    ["approvalStatus", "APPROVAL_STATUS", "approval-status"],
    ["sharingScope", "SHARING_SCOPE", "sharing-scope"],
  ];

  for (const [payloadField, envSuffix, argName] of fields) {
    const value =
      input.args[argName]?.trim() ||
      envValue(`${input.envPrefix}_${envSuffix}`) ||
      envValue(`${input.fallbackPrefix}_${envSuffix}`);
    if (value) {
      out[payloadField] = value;
    }
  }

  return out;
}

function hasStructuredResearchFields(payload) {
  return Boolean(
    payload.researchObjective ||
      payload.methodology ||
      payload.additionalContext ||
      payload.analysisStartDate ||
      payload.analysisEndDate ||
      payload.owner ||
      payload.relatedProjects ||
      payload.approvalStatus ||
      payload.sharingScope,
  );
}

function envValue(name) {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseCsvList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseJsonObject(raw) {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function buildExpectationProfile(csvPath) {
  try {
    const raw = await fs.readFile(csvPath, "utf8");
    const parsed = parseCsv(raw);
    const tableSections = inferTableSections(parsed.rows);
    const uniqueColumns = new Set(
      tableSections.flatMap((section) =>
        section.headers
          .map((header) => normalizeToken(header))
          .filter(Boolean),
      ),
    );

    const expected = {
      minFamilies: Math.max(2, Math.min(5, Math.ceil(tableSections.length * 0.6))),
      minGridFamilies: Math.max(1, Math.floor(tableSections.length / 2)),
      minFindings: Math.max(6, tableSections.length + 2),
      minDimensionMetadata: Math.max(
        4,
        Math.min(12, Math.ceil(uniqueColumns.size * 0.3)),
      ),
      minTotalRowsAcrossFamilyData: Math.max(6, tableSections.length + 2),
      maxDimensionMetadata: 80,
      expectedSections: tableSections.length,
    };

    return {
      profileSource: csvPath,
      expected,
      tableSections,
    };
  } catch (error) {
    return {
      profileSource: `${csvPath} (unavailable: ${error instanceof Error ? error.message : "unknown"})`,
      expected: {
        minFamilies: 2,
        minGridFamilies: 1,
        minFindings: 4,
        minDimensionMetadata: 3,
        minTotalRowsAcrossFamilyData: 4,
        maxDimensionMetadata: 80,
        expectedSections: undefined,
      },
      tableSections: [],
    };
  }
}

function parseCsv(csvText) {
  const lines = csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const rows = lines.map((line) => parseCsvLine(line));
  return { rows };
}

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current.trim());
  return result;
}

function inferTableSections(rows) {
  const sections = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const nonEmpty = row.filter(Boolean);
    if (nonEmpty.length < 2) continue;

    const nextIndex = findNextNonEmptyRow(rows, index + 1);
    if (nextIndex === -1) continue;
    const nextRow = rows[nextIndex];
    const nextNonEmpty = nextRow.filter(Boolean);
    if (nextNonEmpty.length < 2) continue;

    if (!isProbablyHeaderRow(row)) continue;

    const dataRows = [];
    let cursor = nextIndex;
    while (cursor < rows.length) {
      const current = rows[cursor];
      if (current.filter(Boolean).length === 0) break;
      if (
        cursor !== nextIndex &&
        current.filter(Boolean).length >= 2 &&
        isProbablyHeaderRow(current)
      ) {
        break;
      }
      dataRows.push(current);
      cursor += 1;
    }

    if (dataRows.length === 0) continue;

    const headerKey = row.join("|").toLowerCase();
    if (sections.some((section) => section.headerKey === headerKey)) continue;

    sections.push({
      headerKey,
      headers: row,
      dataRows,
      startIndex: index,
      endIndex: cursor - 1,
    });
  }

  return sections;
}

function findNextNonEmptyRow(rows, start) {
  for (let index = start; index < rows.length; index += 1) {
    if (rows[index].filter(Boolean).length > 0) return index;
  }
  return -1;
}

function isProbablyHeaderRow(row) {
  const values = row.filter(Boolean);
  if (values.length < 2) return false;

  let textualCount = 0;
  let numericLikeCount = 0;

  for (const value of values) {
    if (/[a-zA-Z]/.test(value)) textualCount += 1;
    if (/^[-+$()0-9.,%#/ ]+$/.test(value)) numericLikeCount += 1;
  }

  if (textualCount < 2) return false;
  return numericLikeCount <= Math.floor(values.length / 2);
}

function normalizeToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_ ]+/g, "")
    .replace(/\s+/g, "_");
}

function validateGenerateInsightsV2Response(data, expected) {
  const errors = [];
  const warnings = [];

  const documents = ensureArray(data.documents);
  const findings = ensureArray(data.findings);
  const families = ensureArray(data.insight_families);
  const rows = ensureArray(data.insight_rows);
  const familyData = ensureArray(data.insight_family_data);
  const dimensionMetadata = ensureArray(data.dimension_metadata);

  const tableById = new Map(familyData.map((table) => [table.table_id, table]));
  const metadataByDimensionId = new Map(
    dimensionMetadata.map((entry) => [entry.dimension_id, entry]),
  );
  const metadataByCanonicalName = new Map(
    dimensionMetadata.map((entry) => [entry.canonical_name, entry]),
  );

  if (documents.length === 0) errors.push("documents must be non-empty.");
  if (findings.length < expected.minFindings) {
    errors.push(`findings too low: expected >= ${expected.minFindings}, got ${findings.length}.`);
  }
  if (families.length < expected.minFamilies) {
    errors.push(`insight_families too low: expected >= ${expected.minFamilies}, got ${families.length}.`);
  }
  if (dimensionMetadata.length < expected.minDimensionMetadata) {
    errors.push(
      `dimension_metadata too low: expected >= ${expected.minDimensionMetadata}, got ${dimensionMetadata.length}.`,
    );
  }
  if (dimensionMetadata.length > expected.maxDimensionMetadata) {
    warnings.push(
      `dimension_metadata is unusually high (${dimensionMetadata.length}); expected <= ${expected.maxDimensionMetadata}.`,
    );
  }

  let gridFamilies = 0;
  for (const family of families) {
    if (!family || typeof family !== "object") {
      errors.push("family entry must be an object.");
      continue;
    }
    if (!family.family_id) errors.push("family missing family_id.");
    if (!family.family_text || String(family.family_text).trim().length < 12) {
      errors.push(`family ${family.family_id ?? "(unknown)"} has weak family_text.`);
    }
    if (!family.question_answered || String(family.question_answered).trim().length < 12) {
      errors.push(`family ${family.family_id ?? "(unknown)"} has weak question_answered.`);
    }
    if (!Array.isArray(family.filters)) {
      errors.push(`family ${family.family_id ?? "(unknown)"} filters must be array.`);
    }

    if (family.has_grid === true) {
      gridFamilies += 1;
      if (!family.insight_family_data_id) {
        errors.push(`family ${family.family_id} has_grid=true but missing insight_family_data_id.`);
      }
      const table = family.insight_family_data_id
        ? tableById.get(family.insight_family_data_id)
        : undefined;
      if (!table) {
        errors.push(`family ${family.family_id} linked table not found.`);
      } else {
        if (table.family_id !== family.family_id) {
          errors.push(
            `family ${family.family_id} linked to table ${table.table_id} with mismatched family_id.`,
          );
        }
        if (table.row_count !== ensureArray(table.rows).length) {
          errors.push(`table ${table.table_id} row_count mismatch with rows.length.`);
        }
      }
    }
  }

  if (gridFamilies < expected.minGridFamilies) {
    errors.push(
      `tabular families too low: expected >= ${expected.minGridFamilies}, got ${gridFamilies}.`,
    );
  }

  let totalPersistedRows = 0;
  for (const table of familyData) {
    const tableRows = ensureArray(table.rows);
    totalPersistedRows += tableRows.length;
    if (!Array.isArray(table.dimensions) || table.dimensions.length === 0) {
      errors.push(`table ${table.table_id ?? "(unknown)"} missing dimensions.`);
      continue;
    }
    if (!Array.isArray(table.metric_columns) || table.metric_columns.length === 0) {
      errors.push(`table ${table.table_id ?? "(unknown)"} missing metric_columns.`);
    }
    const normalizedDimensions = new Set(table.dimensions.map((name) => normalizeToken(name)));

    for (const row of tableRows) {
      if (row.family_id !== table.family_id) {
        errors.push(`table ${table.table_id} row ${row.row_id} has mismatched family_id.`);
      }
      if (!Array.isArray(row.supporting_refs) || row.supporting_refs.length === 0) {
        errors.push(`table ${table.table_id} row ${row.row_id} missing supporting_refs.`);
      }
      if (!Array.isArray(row.filter_values) || row.filter_values.length === 0) {
        errors.push(`table ${table.table_id} row ${row.row_id} missing filter_values.`);
        continue;
      }
      const rowDimensions = new Set();
      for (const filterValue of row.filter_values) {
        if (!filterValue.dimension_id) {
          errors.push(`table ${table.table_id} row ${row.row_id} missing filter dimension_id.`);
        }
        if (!filterValue.dimension_name) {
          errors.push(`table ${table.table_id} row ${row.row_id} missing filter dimension_name.`);
        }
        if (!filterValue.value || String(filterValue.value).trim().length === 0) {
          errors.push(`table ${table.table_id} row ${row.row_id} missing filter value.`);
        }
        const dimensionName = normalizeToken(filterValue.dimension_name);
        rowDimensions.add(dimensionName);
        if (!normalizedDimensions.has(dimensionName)) {
          errors.push(
            `table ${table.table_id} row ${row.row_id} has filter dimension not in table.dimensions (${filterValue.dimension_name}).`,
          );
        }

        const metadataById = filterValue.dimension_id
          ? metadataByDimensionId.get(filterValue.dimension_id)
          : undefined;
        const metadataByName = metadataByCanonicalName.get(dimensionName);
        if (!metadataById && !metadataByName) {
          errors.push(
            `row ${row.row_id} references unknown dimension metadata (${filterValue.dimension_name}).`,
          );
        }
      }

      for (const requiredDimension of normalizedDimensions) {
        if (!rowDimensions.has(requiredDimension)) {
          errors.push(
            `table ${table.table_id} row ${row.row_id} missing required dimension ${requiredDimension}.`,
          );
        }
      }
    }
  }

  if (totalPersistedRows < expected.minTotalRowsAcrossFamilyData) {
    errors.push(
      `insight_family_data rows too low: expected >= ${expected.minTotalRowsAcrossFamilyData}, got ${totalPersistedRows}.`,
    );
  }

  if (rows.length < totalPersistedRows) {
    warnings.push(
      `insight_rows (${rows.length}) is lower than sum(table.rows) (${totalPersistedRows}).`,
    );
  }

  return {
    errors,
    warnings,
    observed: {
      documents: documents.length,
      findings: findings.length,
      families: families.length,
      gridFamilies,
      insightFamilyDataTables: familyData.length,
      totalPersistedRows,
      insightRows: rows.length,
      dimensionMetadata: dimensionMetadata.length,
    },
  };
}

function validateGenerateInsightsV3Response(data, expected) {
  const errors = [];
  const warnings = [];

  const documents = ensureArray(data.documents);
  const insights = ensureArray(data.insights);
  const familyData = ensureArray(data.insight_family_data);
  const dimensionMetadata = ensureArray(data.dimension_metadata);
  const pipelineErrors = ensureArray(data.errors);

  const tableById = new Map(
    familyData
      .filter((table) => table && typeof table === "object" && table.table_id)
      .map((table) => [table.table_id, table]),
  );
  const metadataByDimensionId = new Map(
    dimensionMetadata
      .filter((entry) => entry && typeof entry === "object" && entry.dimension_id)
      .map((entry) => [entry.dimension_id, entry]),
  );
  const metadataByCanonicalName = new Map(
    dimensionMetadata
      .filter((entry) => entry && typeof entry === "object" && entry.canonical_name)
      .map((entry) => [entry.canonical_name, entry]),
  );

  if (documents.length === 0) errors.push("documents must be non-empty.");

  const minInsights = Math.max(1, expected.minGridFamilies ?? 1);
  if (insights.length < minInsights) {
    errors.push(`insights too low: expected >= ${minInsights}, got ${insights.length}.`);
  }

  if (familyData.length < expected.minGridFamilies) {
    errors.push(
      `insight_family_data tables too low: expected >= ${expected.minGridFamilies}, got ${familyData.length}.`,
    );
  }

  if (dimensionMetadata.length < expected.minDimensionMetadata) {
    errors.push(
      `dimension_metadata too low: expected >= ${expected.minDimensionMetadata}, got ${dimensionMetadata.length}.`,
    );
  }
  if (dimensionMetadata.length > expected.maxDimensionMetadata) {
    warnings.push(
      `dimension_metadata is unusually high (${dimensionMetadata.length}); expected <= ${expected.maxDimensionMetadata}.`,
    );
  }

  if (pipelineErrors.length > 0) {
    warnings.push(`response included ${pipelineErrors.length} pipeline error(s).`);
  }

  let insightsWithEmbeddedGrid = 0;
  for (const insight of insights) {
    if (!insight || typeof insight !== "object") {
      errors.push("insight entry must be an object.");
      continue;
    }

    if (!insight.insight_id || String(insight.insight_id).trim().length === 0) {
      errors.push("insight missing insight_id.");
    }
    if (!insight.text || String(insight.text).trim().length < 12) {
      errors.push(`insight ${insight.insight_id ?? "(unknown)"} has weak text.`);
    }
    if (!Array.isArray(insight.metadata)) {
      errors.push(`insight ${insight.insight_id ?? "(unknown)"} metadata must be array.`);
    }
    if (!Array.isArray(insight.dimension_metadata) || insight.dimension_metadata.length === 0) {
      errors.push(`insight ${insight.insight_id ?? "(unknown)"} missing dimension_metadata.`);
    }

    if (
      insight.insight_source_mode
      && insight.insight_source_mode !== "explicit_nearby_text"
      && insight.insight_source_mode !== "synthesized_from_grid"
    ) {
      warnings.push(
        `insight ${insight.insight_id ?? "(unknown)"} has unexpected insight_source_mode (${insight.insight_source_mode}).`,
      );
    }

    if (!insight.insightfamilydata || typeof insight.insightfamilydata !== "object") {
      errors.push(`insight ${insight.insight_id ?? "(unknown)"} missing insightfamilydata.`);
      continue;
    }

    insightsWithEmbeddedGrid += 1;
    const embeddedTableId = insight.insightfamilydata.table_id;
    if (!embeddedTableId) {
      errors.push(`insight ${insight.insight_id ?? "(unknown)"} missing insightfamilydata.table_id.`);
      continue;
    }

    const topLevelTable = tableById.get(embeddedTableId);
    if (!topLevelTable) {
      errors.push(
        `insight ${insight.insight_id ?? "(unknown)"} table ${embeddedTableId} is missing from top-level insight_family_data.`,
      );
    }

    if (insight.insight_family_data_id && insight.insight_family_data_id !== embeddedTableId) {
      errors.push(
        `insight ${insight.insight_id ?? "(unknown)"} insight_family_data_id does not match embedded table_id.`,
      );
    }

    const tableDimensions = new Set(
      ensureArray(insight.insightfamilydata.dimensions).map((name) => normalizeToken(name)).filter(Boolean),
    );
    const insightDimensionNames = new Set(
      ensureArray(insight.dimension_metadata)
        .map((entry) => normalizeToken(entry?.canonical_name))
        .filter(Boolean),
    );
    for (const tableDimension of tableDimensions) {
      if (!insightDimensionNames.has(tableDimension)) {
        errors.push(
          `insight ${insight.insight_id ?? "(unknown)"} missing dimension_metadata definition for ${tableDimension}.`,
        );
      }
    }
  }

  if (insightsWithEmbeddedGrid < insights.length) {
    errors.push(
      `only ${insightsWithEmbeddedGrid} of ${insights.length} insight(s) included embedded insightfamilydata.`,
    );
  }

  let totalPersistedRows = 0;
  for (const table of familyData) {
    const tableRows = ensureArray(table.rows);
    totalPersistedRows += tableRows.length;

    if (!table.table_id) {
      errors.push("insight_family_data table missing table_id.");
      continue;
    }
    if (!Array.isArray(table.dimensions) || table.dimensions.length === 0) {
      errors.push(`table ${table.table_id} missing dimensions.`);
      continue;
    }
    if (!Array.isArray(table.metric_columns) || table.metric_columns.length === 0) {
      errors.push(`table ${table.table_id} missing metric_columns.`);
    }
    if (table.row_count !== tableRows.length) {
      errors.push(`table ${table.table_id} row_count mismatch with rows.length.`);
    }

    const normalizedDimensions = new Set(table.dimensions.map((name) => normalizeToken(name)));

    for (const row of tableRows) {
      if (row.family_id !== table.family_id) {
        errors.push(`table ${table.table_id} row ${row.row_id} has mismatched family_id.`);
      }
      if (!Array.isArray(row.supporting_refs) || row.supporting_refs.length === 0) {
        errors.push(`table ${table.table_id} row ${row.row_id} missing supporting_refs.`);
      }
      if (!Array.isArray(row.filter_values) || row.filter_values.length === 0) {
        errors.push(`table ${table.table_id} row ${row.row_id} missing filter_values.`);
        continue;
      }

      const rowDimensions = new Set();
      for (const filterValue of row.filter_values) {
        if (!filterValue.dimension_id) {
          errors.push(`table ${table.table_id} row ${row.row_id} missing filter dimension_id.`);
        }
        if (!filterValue.dimension_name) {
          errors.push(`table ${table.table_id} row ${row.row_id} missing filter dimension_name.`);
        }
        if (!filterValue.value || String(filterValue.value).trim().length === 0) {
          errors.push(`table ${table.table_id} row ${row.row_id} missing filter value.`);
        }

        const dimensionName = normalizeToken(filterValue.dimension_name);
        rowDimensions.add(dimensionName);
        if (!normalizedDimensions.has(dimensionName)) {
          errors.push(
            `table ${table.table_id} row ${row.row_id} has filter dimension not in table.dimensions (${filterValue.dimension_name}).`,
          );
        }

        const metadataById = filterValue.dimension_id
          ? metadataByDimensionId.get(filterValue.dimension_id)
          : undefined;
        const metadataByName = metadataByCanonicalName.get(dimensionName);
        if (!metadataById && !metadataByName) {
          errors.push(
            `row ${row.row_id} references unknown dimension metadata (${filterValue.dimension_name}).`,
          );
        }
      }

      const hasDimensionContext = Array.from(rowDimensions).some((name) => normalizedDimensions.has(name));
      if (normalizedDimensions.size > 0 && !hasDimensionContext) {
        errors.push(
          `table ${table.table_id} row ${row.row_id} appears metric-only while dimensions exist.`,
        );
      }

      for (const requiredDimension of normalizedDimensions) {
        if (!rowDimensions.has(requiredDimension)) {
          errors.push(
            `table ${table.table_id} row ${row.row_id} missing required dimension ${requiredDimension}.`,
          );
        }
      }
    }
  }

  if (totalPersistedRows < expected.minTotalRowsAcrossFamilyData) {
    errors.push(
      `insight_family_data rows too low: expected >= ${expected.minTotalRowsAcrossFamilyData}, got ${totalPersistedRows}.`,
    );
  }

  return {
    errors,
    warnings,
    observed: {
      documents: documents.length,
      insights: insights.length,
      insightsWithEmbeddedGrid,
      insightFamilyDataTables: familyData.length,
      totalPersistedRows,
      dimensionMetadata: dimensionMetadata.length,
      pipelineErrors: pipelineErrors.length,
    },
  };
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}
