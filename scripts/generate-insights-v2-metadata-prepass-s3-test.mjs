import assert from "assert";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { getCognitoJwtToken } from "../test/cognito-test-auth.mjs";

/**
 * Integration validator for metadata-prepass flow:
 * DocumentIntake -> ContentExtraction -> Normalization -> MetadataDimensionExtraction
 *
 * Usage:
 *   node scripts/generate-insights-v2-metadata-prepass-s3-test.mjs --s3-url "s3://.../file.csv"
 */

const s3Url = "s3://amplify-amplifyvitereactt-aetioinsightstoragebucke-jzbc7y9yml35/uploads/extraction/f12b4500-1041-7018-dc1d-7bf79ae667c9/analysiswithcontext.xlsx - Sheet1.csv";
assert.ok(
  s3Url && typeof s3Url === "string" && s3Url.startsWith("s3://"),
  "Missing required --s3-url s3://... (or GENERATE_INSIGHTS_V2_PREPASS_S3_URL env).",
);

const baseUrl = process.env.AETIO_BACKEND_URL ?? "http://localhost:8000";
const endpoint = new URL("/generate-insights-v2-metadata-prepass", baseUrl).toString();
const jwtToken = await getCognitoJwtToken();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const tmpDir = path.join(projectRoot, "tmp");

const payload = {
  outputUrls: [s3Url],
  contextUrls: [],
  researchContext:
    process.env.GENERATE_INSIGHTS_V2_PREPASS_RESEARCH_CONTEXT ??
    "Metadata prepass validation for table dimensions and column tags.",
};

console.log("metadata prepass validation starting", { endpoint, s3Url });

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

assert.ok(
  response.ok,
  `Expected 2xx response from /generate-insights-v2-metadata-prepass, got ${response.status}: ${text}`,
);
assert.ok(data && typeof data === "object", "Expected JSON response body.");

await fs.mkdir(tmpDir, { recursive: true });
const responseOutputPath = path.join(
  tmpDir,
  `generate-insights-v2-metadata-prepass-response-${Date.now()}.json`,
);
await fs.writeFile(responseOutputPath, JSON.stringify(data, null, 2), "utf8");

const validation = validatePrepassResponse(data);
const dimensionMetadata = ensureArray(data.dimension_metadata);
const dimensionNames = dimensionMetadata
  .map((entry) => String(entry?.canonical_name ?? "").trim())
  .filter(Boolean);

console.log("metadata prepass validation summary:");
console.log(
  JSON.stringify(
    {
      ...validation.summary,
      responseOutputPath,
      dimensionNames,
    },
    null,
    2,
  ),
);
console.log("metadata prepass metadata_filters (full):");
console.log(JSON.stringify(ensureArray(data.metadata_filters), null, 2));
console.log("metadata prepass dimension_metadata (full):");
console.log(JSON.stringify(dimensionMetadata, null, 2));
assert.equal(validation.errors.length, 0, `Validation failed:\n- ${validation.errors.join("\n- ")}`);

console.log("metadata prepass validation passed");

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

function validatePrepassResponse(data) {
  const errors = [];
  const warnings = [];

  const documents = ensureArray(data.documents);
  const tables = ensureArray(data.tables);
  const metadataFilters = ensureArray(data.metadata_filters).map((value) => String(value ?? ""));
  const dimensionMetadata = ensureArray(data.dimension_metadata);

  if (documents.length === 0) errors.push("documents must be non-empty.");
  if (tables.length === 0) errors.push("tables must be non-empty.");
  if (metadataFilters.length === 0) errors.push("metadata_filters must be non-empty.");
  if (dimensionMetadata.length === 0) errors.push("dimension_metadata must be non-empty.");

  const metadataByCanonicalName = new Map(
    dimensionMetadata.map((entry) => [String(entry.canonical_name ?? ""), entry]),
  );

  for (const filter of metadataFilters) {
    const normalized = normalizeToken(filter);
    if (/^unnamed_?\d*$/.test(normalized) || /^column_\d+$/.test(normalized)) {
      errors.push(`metadata filter should not include placeholder dimension: ${filter}`);
    }
    if (!metadataByCanonicalName.has(filter)) {
      warnings.push(`metadata filter ${filter} has no direct canonical metadata match.`);
    }
  }

  let totalRows = 0;
  for (const table of tables) {
    const headers = ensureArray(table.headers).map((header) => String(header ?? "").trim());
    const rows = ensureArray(table.rows);
    totalRows += rows.length;

    if (headers.length === 0) {
      warnings.push(`table ${table.table_id ?? "(unknown)"} has no headers.`);
    }
    if (rows.length === 0) {
      warnings.push(`table ${table.table_id ?? "(unknown)"} has no rows.`);
    }
  }

  return {
    errors,
    summary: {
      documents: documents.length,
      tables: tables.length,
      totalRows,
      metadataFilters: metadataFilters.length,
      dimensionMetadata: dimensionMetadata.length,
      warnings,
    },
  };
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_ ]+/g, "")
    .replace(/\s+/g, "_");
}
