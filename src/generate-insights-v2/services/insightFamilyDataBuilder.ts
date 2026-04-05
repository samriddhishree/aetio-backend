import { hashId } from "../../common/services/utils";
import { inferInsightFamilyDataSchema } from "../mappers/familyToInsightFamilyDataSchema";
import {
  buildRowIdentity,
  mapFindingToInsightFamilyDataRow,
} from "../mappers/findingToInsightFamilyDataRow";
import type {
  Finding,
  InsightFamily,
  InsightFamilyData,
  SupportingRef,
} from "../types";

export type BuildInsightFamilyDataResult = {
  family: InsightFamily;
  insightFamilyData?: InsightFamilyData;
  droppedDuplicateRows: number;
  tabularity_confidence: number;
  warnings: string[];
};

export type InsightFamilyDataValidationResult = {
  valid: boolean;
  table?: InsightFamilyData;
  errors: string[];
  warnings: string[];
  tabularity_confidence: number;
};

function normalizeTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\- ]+/g, "")
    .replace(/\s+/g, "_");
}

function dedupeRefs(refs: SupportingRef[]): SupportingRef[] {
  const seen = new Set<string>();
  const output: SupportingRef[] = [];
  for (const ref of refs) {
    const key = [
      ref.chunk_id ?? "",
      ref.table_id ?? "",
      ref.row_index ?? "",
      ref.page ?? "",
      ref.section_title ?? "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(ref);
  }
  return output;
}

export function validateInsightFamilyData(
  table: InsightFamilyData,
  tabularityConfidence = 0.5,
): InsightFamilyDataValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!table.table_id.trim()) errors.push("table_id is required.");
  if (!table.family_id.trim()) errors.push("family_id is required.");
  if (table.dimensions.length === 0) errors.push("dimensions must be non-empty for tabular families.");
  if (table.metric_columns.length === 0) errors.push("metric_columns must be non-empty.");

  const normalizedDimensions = table.dimensions.map((dimension) => normalizeTag(dimension));
  const repairedRows = table.rows
    .filter((row) => {
      if (row.family_id !== table.family_id) return false;
      if ((row.supporting_refs ?? []).length === 0) return false;

      const rowTagSet = new Set(row.filter_values.map((entry) => normalizeTag(entry.tag)));
      return normalizedDimensions.every((dimension) => rowTagSet.has(dimension));
    })
    .map((row) => ({
      ...row,
      supporting_refs: dedupeRefs(row.supporting_refs),
    }));

  if (repairedRows.length !== table.rows.length) {
    warnings.push(
      `Dropped ${table.rows.length - repairedRows.length} rows for missing evidence or mismatched dimensions.`,
    );
  }

  const dedupedRowsByKey = new Map<string, InsightFamilyData["rows"][number]>();
  let droppedDuplicateRows = 0;

  for (const row of repairedRows) {
    const key = buildRowIdentity(row);
    const existing = dedupedRowsByKey.get(key);
    if (!existing) {
      dedupedRowsByKey.set(key, row);
      continue;
    }

    droppedDuplicateRows += 1;
    dedupedRowsByKey.set(key, {
      ...existing,
      supporting_refs: dedupeRefs([...existing.supporting_refs, ...row.supporting_refs]),
      value_text: existing.value_text.length >= row.value_text.length ? existing.value_text : row.value_text,
    });
  }

  if (droppedDuplicateRows > 0) {
    warnings.push(`Dropped ${droppedDuplicateRows} duplicate rows with identical dimension keys.`);
  }

  const dedupedRows = Array.from(dedupedRowsByKey.values());
  const invalidMetricRows = dedupedRows.filter(
    (row) => !row.metric_name || !table.metric_columns.includes(row.metric_name),
  );
  if (invalidMetricRows.length > 0) {
    errors.push("Metric columns are inconsistent with row metric names.");
  }

  if (dedupedRows.length === 0) errors.push("row_count must be > 0 for persisted tables.");

  const repairedTable: InsightFamilyData = {
    ...table,
    rows: dedupedRows,
    row_count: dedupedRows.length,
    updated_at: new Date().toISOString(),
  };

  return {
    valid: errors.length === 0,
    table: errors.length === 0 ? repairedTable : undefined,
    errors,
    warnings,
    tabularity_confidence: Number(Math.max(0, Math.min(1, tabularityConfidence)).toFixed(3)),
  };
}

export function buildInsightFamilyDataFromFindings(input: {
  family: InsightFamily;
  findings: Finding[];
}): BuildInsightFamilyDataResult {
  const schema = inferInsightFamilyDataSchema({
    family: input.family,
    findings: input.findings,
  });

  console.info("[insightfamilydata] inferring table schema for family", {
    family_id: input.family.family_id,
    findings: input.findings.length,
    has_grid: schema.has_grid,
    dimensions: schema.dimensions,
    metric_columns: schema.metric_columns,
    tabularity_confidence: schema.tabularity_confidence,
    reasoning: schema.reasoning,
  });

  if (!schema.has_grid) {
    console.info("[insightfamilydata] family marked non-tabular", {
      family_id: input.family.family_id,
      tabularity_confidence: schema.tabularity_confidence,
    });
    return {
      family: {
        ...input.family,
        has_grid: false,
        insight_family_data_id: undefined,
        row_count: undefined,
        table_dimensions: undefined,
        metric_columns: undefined,
      },
      droppedDuplicateRows: 0,
      tabularity_confidence: schema.tabularity_confidence,
      warnings: [schema.reasoning],
    };
  }

  const metricName = schema.metric_columns[0] ?? "value";
  const rowCandidates = input.findings
    .map((finding) =>
      mapFindingToInsightFamilyDataRow({
        family: input.family,
        finding,
        dimensions: schema.dimensions,
        metricName,
      }),
    )
    .filter((row): row is NonNullable<typeof row> => Boolean(row));

  const byIdentity = new Map<string, typeof rowCandidates[number]>();
  let droppedDuplicateRows = 0;

  for (const row of rowCandidates) {
    const identity = buildRowIdentity(row);
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, row);
      continue;
    }

    droppedDuplicateRows += 1;
    byIdentity.set(identity, {
      ...existing,
      supporting_refs: dedupeRefs([...existing.supporting_refs, ...row.supporting_refs]),
      value_text: existing.value_text.length >= row.value_text.length ? existing.value_text : row.value_text,
    });
  }

  const rows = Array.from(byIdentity.values());
  console.info("[insightfamilydata] built rows", {
    family_id: input.family.family_id,
    rows: rows.length,
    droppedDuplicateRows,
  });

  if (rows.length === 0) {
    console.warn("[insightfamilydata] no supported rows; marking family non-tabular", {
      family_id: input.family.family_id,
    });
    return {
      family: {
        ...input.family,
        has_grid: false,
        insight_family_data_id: undefined,
        row_count: undefined,
        table_dimensions: undefined,
        metric_columns: undefined,
      },
      droppedDuplicateRows,
      tabularity_confidence: schema.tabularity_confidence,
      warnings: ["No evidence-grounded rows could be built."],
    };
  }

  const now = new Date().toISOString();
  const tableId = hashId(
    `insightfamilydata:${input.family.family_id}:${schema.dimensions.join("|")}:${schema.metric_columns.join("|")}`,
  );
  const table: InsightFamilyData = {
    table_id: tableId,
    family_id: input.family.family_id,
    dimensions: schema.dimensions,
    metric_columns: schema.metric_columns,
    row_count: rows.length,
    rows,
    source_modalities: Array.from(new Set(input.findings.map((finding) => finding.source_modality))),
    created_at: now,
    updated_at: now,
  };

  const validation = validateInsightFamilyData(table, schema.tabularity_confidence);
  console.info("[insightfamilydata] validation completed", {
    family_id: input.family.family_id,
    valid: validation.valid,
    errors: validation.errors.length,
    warnings: validation.warnings.length,
    tabularity_confidence: validation.tabularity_confidence,
  });

  if (!validation.valid || !validation.table) {
    return {
      family: {
        ...input.family,
        has_grid: false,
        insight_family_data_id: undefined,
        row_count: undefined,
        table_dimensions: undefined,
        metric_columns: undefined,
      },
      droppedDuplicateRows,
      tabularity_confidence: validation.tabularity_confidence,
      warnings: validation.errors.concat(validation.warnings),
    };
  }

  return {
    family: {
      ...input.family,
      has_grid: true,
      insight_family_data_id: validation.table.table_id,
      row_count: validation.table.row_count,
      table_dimensions: validation.table.dimensions,
      metric_columns: validation.table.metric_columns,
    },
    insightFamilyData: validation.table,
    droppedDuplicateRows,
    tabularity_confidence: validation.tabularity_confidence,
    warnings: validation.warnings,
  };
}
