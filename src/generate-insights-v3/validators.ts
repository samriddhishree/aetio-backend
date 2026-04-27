import type {
  DimensionMetadata,
  InsightFamilyData,
} from "../generate-insights-v2/types";
import type { InsightMetadataEntry, InsightTagEntry } from "../types";
import { normalizeDimensionName } from "../generate-insights-v2/services/metadataService";
import type {
  GenerateInsightsV3Insight,
  GridRowCompletenessStats,
  MinimalInsightValidationInput,
} from "./types";

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const RAW_EVIDENCE_PATTERN =
  /\b(table_id|source_chunk_id|evidence_cells|row_index|row_indices)\b|R\d+C\d+/i;

function stripRawEvidenceFromText(value: string): string {
  let text = compact(value);
  text = text.replace(/\s*Evidence:\s*.*$/is, "");
  text = text.replace(/\s*\(?\btable(?:_id)?\s*=?\s*[a-f0-9]{12,}\)?/gi, "");
  text = text.replace(/\s*\(?\bsource_chunk_id\s*=?\s*[a-f0-9]{12,}\)?/gi, "");
  text = text.replace(/\s*\(?\brow_index\s*=?\s*\d+\)?/gi, "");
  return compact(text);
}

function fallbackQuestionAnswered(table: InsightFamilyData): string {
  const metric = table.metric_columns?.[0] ?? "reported values";
  const dimension = table.dimensions?.[0] ?? "segments";
  return `How does ${metric} vary by ${dimension}?`;
}

function textDomain(value: string): "crop_yield" | "loyalty_fraud" | undefined {
  const normalized = value.toLowerCase();
  const cropHits = [
    "crop",
    "yield",
    "bushel",
    "farm",
    "soil",
    "irrigation",
    "fertilizer",
    "harvest",
    "acre",
  ].filter((token) => normalized.includes(token)).length;
  const fraudHits = [
    "loyalty",
    "redemption",
    "fraud",
    "points",
    "manual adjustment",
    "store",
    "employee",
    "cashier",
  ].filter((token) => normalized.includes(token)).length;
  if (cropHits >= 2 && cropHits > fraudHits) return "crop_yield";
  if (fraudHits >= 2 && fraudHits > cropHits) return "loyalty_fraud";
  return undefined;
}

function evidenceMetricWarnings(table: InsightFamilyData, text: string): string[] {
  const warnings: string[] = [];
  const lowerText = text.toLowerCase();
  const namedMetrics = (table.metric_columns ?? []).filter((metric) =>
    lowerText.includes(metric.toLowerCase()),
  );
  if (namedMetrics.length === 0) return warnings;

  const supportedMetrics = new Set(
    (table.rows ?? [])
      .filter((row) => row.supporting_refs?.some((ref) => (ref.evidence_cells?.length ?? 0) > 0))
      .map((row) => compact(row.metric_name ?? "").toLowerCase())
      .filter(Boolean),
  );
  const unsupported = namedMetrics.filter((metric) => !supportedMetrics.has(metric.toLowerCase()));
  if (unsupported.length > 0) {
    warnings.push(`Named metric(s) lack direct evidence refs: ${unsupported.join(", ")}.`);
  }
  return warnings;
}

function normalizeMetadata(
  metadata: InsightMetadataEntry[] | undefined,
): InsightMetadataEntry[] {
  const byKey = new Map<string, InsightMetadataEntry>();

  for (const entry of metadata ?? []) {
    const tag = compact(entry.tag ?? "");
    const value = compact(entry.value ?? "");
    if (!tag || !value) continue;

    const key = `${tag.toLowerCase()}::${value.toLowerCase()}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      tag,
      value,
      ...(typeof entry.confidence === "number" ? { confidence: entry.confidence } : {}),
    });
  }

  return Array.from(byKey.values());
}

function normalizeTagKey(value: string): string {
  return compact(value)
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeTags(tags: InsightTagEntry[] | undefined): InsightTagEntry[] {
  const byTag = new Map<string, InsightTagEntry>();

  for (const entry of tags ?? []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    for (const [rawTag, rawValue] of Object.entries(entry)) {
      const tag = normalizeTagKey(rawTag);
      const value = compact(String(rawValue ?? ""));
      if (!tag || !value) continue;

      byTag.set(tag, { [tag]: value });
    }
  }

  return Array.from(byTag.values());
}

function normalizedTableDimensions(table: InsightFamilyData): string[] {
  return (table.dimensions ?? [])
    .map((dimension) => normalizeDimensionName(dimension))
    .filter((dimension) => dimension.length > 0);
}

function normalizedDimensionMetadataNames(metadata: DimensionMetadata[]): Set<string> {
  const names = new Set<string>();
  for (const dimension of metadata) {
    const canonical = normalizeDimensionName(dimension.canonical_name);
    if (!canonical) continue;
    names.add(canonical);
  }
  return names;
}

export function computeGridRowCompletenessStats(table: InsightFamilyData): GridRowCompletenessStats {
  const normalizedDims = new Set(normalizedTableDimensions(table));
  let rowsWithDimensions = 0;
  let metricOnlyRows = 0;
  let missingDimensionRows = 0;

  for (const row of table.rows ?? []) {
    const rowDims = new Set(
      (row.filter_values ?? [])
        .map((entry) => normalizeDimensionName(entry.dimension_name))
        .filter((value) => value.length > 0),
    );

    if (rowDims.size > 0) rowsWithDimensions += 1;

    const hasAnyTableDimension = normalizedDims.size > 0;
    const hasTableDimensionInRow = Array.from(normalizedDims).some((dimension) => rowDims.has(dimension));

    if (hasAnyTableDimension && !hasTableDimensionInRow) {
      metricOnlyRows += 1;
      continue;
    }

    if (hasAnyTableDimension) {
      const isMissingDimension = Array.from(normalizedDims).some((dimension) => !rowDims.has(dimension));
      if (isMissingDimension) missingDimensionRows += 1;
    }
  }

  return {
    row_count: table.rows.length,
    rows_with_dimensions: rowsWithDimensions,
    metric_only_rows: metricOnlyRows,
    missing_dimension_rows: missingDimensionRows,
  };
}

export function validateMinimalInsightPayload(
  input: MinimalInsightValidationInput,
): {
  valid: boolean;
  errors: string[];
  warnings: string[];
  metadata: InsightMetadataEntry[];
  tags: InsightTagEntry[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  const text = compact(input.text ?? "");
  if (!text) errors.push("Insight text is required.");

  const table = input.insightfamilydata;
  if (!table || !table.table_id?.trim()) {
    errors.push("insightfamilydata with table_id is required.");
  }

  if (!table || !Array.isArray(table.rows) || table.rows.length === 0) {
    errors.push("insightfamilydata.rows must be non-empty.");
  }

  const stats = table ? computeGridRowCompletenessStats(table) : undefined;
  if (stats && stats.metric_only_rows > 0) {
    errors.push(
      `Detected ${stats.metric_only_rows} metric-only row(s) while dimension columns exist; row context must be preserved.`,
    );
  }

  if (stats && stats.missing_dimension_rows > 0) {
    warnings.push(
      `Detected ${stats.missing_dimension_rows} row(s) missing one or more dimensions from the table schema.`,
    );
  }

  const dimensionMetadata = input.dimension_metadata ?? [];
  if (!Array.isArray(dimensionMetadata) || dimensionMetadata.length === 0) {
    errors.push("dimension_metadata must be non-empty.");
  }

  if (table && Array.isArray(dimensionMetadata) && dimensionMetadata.length > 0) {
    const tableDimensionNames = normalizedTableDimensions(table);
    const dimensionMetadataNames = normalizedDimensionMetadataNames(dimensionMetadata);

    const missingDimensionDefinitions = tableDimensionNames.filter(
      (name) => !dimensionMetadataNames.has(name),
    );
    if (missingDimensionDefinitions.length > 0) {
      errors.push(
        `dimension_metadata is missing definitions for: ${missingDimensionDefinitions.join(", ")}.`,
      );
    }
  }

  const cleanedText = stripRawEvidenceFromText(text);
  if (RAW_EVIDENCE_PATTERN.test(text) && cleanedText.length === 0) {
    errors.push("Insight text contains only raw evidence identifiers after cleanup.");
  }

  if (table?.table_text_chunk) {
    const sourceDomain = textDomain(table.table_text_chunk);
    const insightDomain = textDomain(text);
    if (sourceDomain && insightDomain && sourceDomain !== insightDomain) {
      errors.push(`Insight domain mismatch: source=${sourceDomain}, insight=${insightDomain}.`);
    }
  }

  if (table) {
    warnings.push(...evidenceMetricWarnings(table, text));
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    metadata: normalizeMetadata(input.metadata),
    tags: normalizeTags(input.tags),
  };
}

export function validateInsightObject(insight: GenerateInsightsV3Insight): {
  valid: boolean;
  errors: string[];
  warnings: string[];
  insight?: GenerateInsightsV3Insight;
} {
  const validation = validateMinimalInsightPayload({
    text: insight.text,
    insightfamilydata: insight.insightfamilydata,
    dimension_metadata: insight.dimension_metadata,
    metadata: insight.metadata,
    tags: insight.tags,
  });

  if (!validation.valid) {
    return {
      valid: false,
      errors: validation.errors,
      warnings: validation.warnings,
    };
  }

  const now = new Date().toISOString();
  const repaired: GenerateInsightsV3Insight = {
    ...insight,
    text: stripRawEvidenceFromText(insight.text),
    family_text: insight.family_text
      ? stripRawEvidenceFromText(insight.family_text)
      : stripRawEvidenceFromText(insight.text),
    question_answered: insight.question_answered
      ? compact(insight.question_answered)
      : fallbackQuestionAnswered(insight.insightfamilydata),
    metadata: validation.metadata,
    tags: validation.tags,
    created_at: insight.created_at ?? now,
    updated_at: now,
    createdAt: insight.createdAt ?? insight.created_at ?? now,
    updatedAt: now,
  };

  return {
    valid: true,
    errors: [],
    warnings: validation.warnings,
    insight: repaired,
  };
}
