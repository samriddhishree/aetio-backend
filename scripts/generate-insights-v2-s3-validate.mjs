import assert from "assert";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { getCognitoJwtToken } from "../test/cognito-test-auth.mjs";

/**
 * Integration validator for /generate-insights-v2.
 *
 * What it does:
 * 1) Accepts a required S3 input URL.
 * 2) Calls /generate-insights-v2 with Cognito auth.
 * 3) Waits at least 2 minutes before continuing (even if response returns earlier).
 * 4) Auto-generates expectation profile from a local CSV sample (if available).
 * 5) Validates family/data/row/metadata shape + minimum quality thresholds.
 *
 * Usage:
 *   node scripts/generate-insights-v2-s3-validate.mjs \
 *     --s3-url "s3://.../analysiswithcontext.xlsx - Sheet1.csv"
 *
 * Optional env:
 * - AETIO_BACKEND_URL (default: http://localhost:8000)
 * - GENERATE_INSIGHTS_V2_MIN_WAIT_MS (default: 120000)
 * - GENERATE_INSIGHTS_V2_VALIDATE_PROFILE_CSV
 *   (default: /Users/samriddhis/Downloads/analysiswithcontext.xlsx - Sheet1.csv)
 * - GENERATE_INSIGHTS_V2_RESEARCH_CONTEXT
 */

const DEFAULT_PROFILE_CSV =
  "/Users/samriddhis/Downloads/analysiswithcontext.xlsx - Sheet1.csv";

const args = parseArgs(process.argv.slice(2));
const baseUrl = process.env.AETIO_BACKEND_URL ?? "http://localhost:8000";
const endpoint = new URL("/generate-insights-v2", baseUrl).toString();
const minWaitMs = Math.max(
  120000,
  Number.parseInt(process.env.GENERATE_INSIGHTS_V2_MIN_WAIT_MS ?? "120000", 10) || 120000,
);
const profileCsvPath =
  process.env.GENERATE_INSIGHTS_V2_VALIDATE_PROFILE_CSV?.trim() || DEFAULT_PROFILE_CSV;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const tmpDir = path.join(projectRoot, "tmp");

const s3Url = "s3://amplify-amplifyvitereactt-aetioinsightstoragebucke-jzbc7y9yml35/uploads/extraction/f12b4500-1041-7018-dc1d-7bf79ae667c9/analysiswithcontext.xlsx - Sheet1.csv";
assert.ok(
  s3Url && typeof s3Url === "string" && s3Url.startsWith("s3://"),
  "Missing required --s3-url s3://... argument (or GENERATE_INSIGHTS_V2_TEST_S3_URL env).",
);

const expectationProfile = await buildExpectationProfile(profileCsvPath);
const jwtToken = await getCognitoJwtToken();
const startedAt = Date.now();

const payload = {
  outputUrls: [s3Url],
  contextUrls: [],
  researchContext:
    process.env.GENERATE_INSIGHTS_V2_RESEARCH_CONTEXT ??
    "OmniMart loyalty program fraud analysis with focus on regional/store/employee/shift-level anomalies and financial impact.",
};

console.log("generate-insights-v2 validation starting", {
  endpoint,
  s3Url,
  minWaitMs,
  profileCsvPath: expectationProfile.profileSource,
  expected: expectationProfile.expected,
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
  `Expected 2xx response from /generate-insights-v2, got ${response.status}: ${text}`,
);
assert.ok(data && typeof data === "object", "Expected JSON response body.");

await fs.mkdir(tmpDir, { recursive: true });
const responseOutputPath = path.join(tmpDir, `generate-insights-v2-response-${Date.now()}.json`);
await fs.writeFile(responseOutputPath, JSON.stringify(data, null, 2), "utf8");

const validation = validateGenerateInsightsV2Response(data, expectationProfile.expected);
const summary = {
  elapsedMs,
  waitedAtLeastTwoMinutes: elapsedMs >= 120000,
  status: response.status,
  responseOutputPath,
  observed: validation.observed,
  expected: expectationProfile.expected,
  warnings: validation.warnings,
};

console.log("generate-insights-v2 validation summary:");
console.log(JSON.stringify(summary, null, 2));
assert.equal(validation.errors.length, 0, `Validation failed:\n- ${validation.errors.join("\n- ")}`);

console.log("generate-insights-v2 validation passed");

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

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}
