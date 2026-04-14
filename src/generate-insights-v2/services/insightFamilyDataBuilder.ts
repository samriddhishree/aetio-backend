import { hashId } from "../../common/services/utils";
import { inferInsightFamilyDataSchema } from "../mappers/familyToInsightFamilyDataSchema";
import {
  buildRowIdentity,
  mapFindingToInsightFamilyDataRow,
} from "../mappers/findingToInsightFamilyDataRow";
import type {
  DimensionMetadata,
  Finding,
  InsightFamily,
  InsightFamilyData,
  InsightFamilyDataRow,
  SupportingRef,
  V2Chunk,
  V2Table,
} from "../types";
import {
  createDimensionMetadataRegistry,
  getOrCreateDimensionMetadata,
  isMetadataEligibleDimensionName,
  listDimensionMetadata,
  normalizeDimensionName,
} from "./metadataService";

export type BuildInsightFamilyDataResult = {
  family: InsightFamily;
  insightFamilyData?: InsightFamilyData;
  droppedDuplicateRows: number;
  tabularity_confidence: number;
  warnings: string[];
  dimensionMetadata: DimensionMetadata[];
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

function normalizeRowFilterValues(
  filterValues: InsightFamilyData["rows"][number]["filter_values"],
): InsightFamilyData["rows"][number]["filter_values"] {
  const byDimension = new Map<string, InsightFamilyData["rows"][number]["filter_values"][number]>();
  for (const entry of filterValues) {
    const originalDimensionName = String(entry.dimension_name ?? "").trim();
    const normalizedDimensionName = normalizeDimensionName(originalDimensionName) || normalizeTag(originalDimensionName);
    if (!entry.dimension_id || !normalizedDimensionName || !entry.value) continue;
    if (!byDimension.has(normalizedDimensionName)) {
      byDimension.set(normalizedDimensionName, {
        ...entry,
        dimension_name: originalDimensionName,
      });
    }
  }
  return Array.from(byDimension.values());
}

function isIncompleteFilterValue(
  value: InsightFamilyData["rows"][number]["filter_values"][number],
): boolean {
  const normalized = String(value.value ?? "").trim().toLowerCase();
  if (!value.dimension_id || !value.dimension_name) return true;
  if (!normalized) return true;
  return (
    normalized === "unknown" ||
    normalized === "n/a" ||
    normalized === "na" ||
    normalized === "not_available" ||
    normalized === "not available"
  );
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

  const normalizedDimensions = table.dimensions
    .map((dimension) => normalizeDimensionName(dimension))
    .filter(Boolean);
  const repairedRows = table.rows
    .filter((row) => {
      if (row.family_id !== table.family_id) return false;
      if ((row.supporting_refs ?? []).length === 0) return false;

      const normalizedFilterValues = normalizeRowFilterValues(row.filter_values);
      if (normalizedFilterValues.some((entry) => isIncompleteFilterValue(entry))) return false;
      const rowDimensionSet = new Set(
        normalizedFilterValues.map((entry) => normalizeDimensionName(entry.dimension_name)),
      );
      return normalizedDimensions.every((dimension) => rowDimensionSet.has(dimension));
    })
    .map((row) => ({
      ...row,
      filter_values: normalizeRowFilterValues(row.filter_values),
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

function toNarrativeFamily(family: InsightFamily): InsightFamily {
  return {
    ...family,
    insight_id: family.insight_id ?? family.family_id,
    has_grid: false,
    insight_family_data_id: undefined,
    row_count: undefined,
    table_dimensions: undefined,
    metric_columns: undefined,
  };
}

function collectOriginalDimensionLabels(findings: Finding[]): Map<string, string> {
  const labelsByCanonical = new Map<string, string>();
  for (const finding of findings) {
    for (const dimension of finding.dimensions ?? []) {
      const canonical = normalizeDimensionName(dimension.tag);
      const original = String(dimension.tag ?? "").trim();
      if (!canonical || !original) continue;
      if (!isMetadataEligibleDimensionName(canonical)) continue;
      if (!labelsByCanonical.has(canonical)) {
        labelsByCanonical.set(canonical, original);
      }
    }
  }
  return labelsByCanonical;
}

function isNumericLike(value: string): boolean {
  return /^[-+]?\d{1,3}(,\d{3})*(\.\d+)?%?$/.test(value.trim());
}

function isIdentifierLikeTag(value: string): boolean {
  const normalized = normalizeTag(value);
  return /(^|_)(id|code|store|employee|account|member|sku|zip|postal|number|no)(_|$)/.test(
    normalized,
  );
}

function isPlaceholderDimensionTag(value: string): boolean {
  const normalized = normalizeTag(value);
  if (!normalized) return true;
  if (/^unnamed_?\d*$/.test(normalized)) return true;
  if (/^(column|col)_\d+$/.test(normalized)) return true;
  return false;
}

function normalizeSourceRef(ref: SupportingRef, sourceExcerpt: string): SupportingRef {
  return {
    ...ref,
    source_excerpt: ref.source_excerpt && ref.source_excerpt.trim().length > 0
      ? ref.source_excerpt
      : sourceExcerpt.slice(0, 260),
  };
}

function buildTableRowText(table: V2Table, row: V2Table["rows"][number]): string {
  if (table.headers.length > 0) {
    return table.headers.map((header, index) => `${header}: ${row.cells[index] ?? ""}`).join(" | ");
  }
  return row.cells.join(" | ");
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function buildTableMarkdown(table: V2Table): string {
  const maxColumns = Math.max(
    table.headers.length,
    ...table.rows.map((row) => row.cells.length),
    1,
  );
  const headers = Array.from({ length: maxColumns }, (_value, index) =>
    String(table.headers[index] ?? `column_${index + 1}`),
  );
  const headerRow = `| ${headers.map((cell) => escapeMarkdownCell(cell)).join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyRows = table.rows.map((row) => {
    const cells = Array.from({ length: maxColumns }, (_value, index) => String(row.cells[index] ?? ""));
    return `| ${cells.map((cell) => escapeMarkdownCell(cell)).join(" | ")} |`;
  });
  return [headerRow, separator, ...bodyRows].join("\n");
}

function buildTableTextChunk(table: V2Table): string {
  const headerText = table.headers.length > 0 ? table.headers.join(" | ") : "No headers";
  const rowText = table.rows.map((row) => `Row ${row.row_index}: ${row.cells.join(" | ")}`).join("\n");
  return [
    `Table ID: ${table.table_id}`,
    `Headers: ${headerText}`,
    rowText,
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

function buildFamilyGridArtifacts(input: {
  findings: Finding[];
  tableById: Map<string, V2Table>;
}): { table_markdown?: string; table_text_chunk?: string } {
  const tableIdsInOrder: string[] = [];
  const seen = new Set<string>();
  for (const finding of input.findings) {
    for (const ref of finding.supporting_refs ?? []) {
      if (!ref.table_id || seen.has(ref.table_id)) continue;
      if (!input.tableById.has(ref.table_id)) continue;
      seen.add(ref.table_id);
      tableIdsInOrder.push(ref.table_id);
    }
  }

  if (tableIdsInOrder.length === 0) return {};

  const markdownParts: string[] = [];
  const textChunkParts: string[] = [];
  for (const tableId of tableIdsInOrder) {
    const table = input.tableById.get(tableId);
    if (!table) continue;
    markdownParts.push(`### ${tableId}\n${buildTableMarkdown(table)}`);
    textChunkParts.push(buildTableTextChunk(table));
  }

  return {
    table_markdown: markdownParts.join("\n\n"),
    table_text_chunk: textChunkParts.join("\n\n"),
  };
}

function buildDimensionsFromTableRow(table: V2Table, cells: string[]): Array<{ tag: string; value: string }> {
  if (table.headers.length === 0 || cells.length === 0) return [];

  const dimensions: Array<{ tag: string; value: string }> = [];
  const maxPairs = Math.min(table.headers.length, cells.length);
  for (let index = 0; index < maxPairs; index += 1) {
    const rawTag = String(table.headers[index] ?? "").trim();
    const rawValue = String(cells[index] ?? "").trim();
    if (!rawTag || !rawValue) continue;
    if (isPlaceholderDimensionTag(rawTag)) continue;
    if (isNumericLike(rawValue) && !isIdentifierLikeTag(rawTag)) continue;
    dimensions.push({ tag: rawTag, value: rawValue });
  }

  return dimensions;
}

function mapSourceBackedFindingToRow(input: {
  family: InsightFamily;
  finding: Finding;
  dimensions: string[];
  metricName: string;
  metadataRegistry: ReturnType<typeof createDimensionMetadataRegistry>;
  chunkById: Map<string, V2Chunk>;
  tableById: Map<string, V2Table>;
}): InsightFamilyDataRow | null {
  const refs = dedupeRefs(input.finding.supporting_refs ?? []);
  const rowRef = refs.find((ref) => ref.table_id && typeof ref.row_index === "number");
  if (rowRef?.table_id) {
    const table = input.tableById.get(rowRef.table_id);
    if (table) {
      const row = table.rows.find((candidate) => candidate.row_index === rowRef.row_index);
      if (row) {
        const sourceText = buildTableRowText(table, row);
        const sourceFinding: Finding = {
          ...input.finding,
          text: sourceText,
          dimensions: buildDimensionsFromTableRow(table, row.cells),
          supporting_refs: [normalizeSourceRef(rowRef, sourceText)],
          source_modality: "table",
        };

        const mapped = mapFindingToInsightFamilyDataRow({
          family: input.family,
          finding: sourceFinding,
          dimensions: input.dimensions,
          metricName: input.metricName,
          metadataRegistry: input.metadataRegistry,
        });
        if (mapped) return mapped;
      }
    }
  }

  const tableRef = refs.find((ref) => ref.table_id);
  if (tableRef?.table_id) {
    const table = input.tableById.get(tableRef.table_id);
    if (table) {
      const sourceText = table.rows.length > 0 ? buildTableTextChunk(table) : table.raw_text;
      const sourceFinding: Finding = {
        ...input.finding,
        text: sourceText,
        supporting_refs: [normalizeSourceRef(tableRef, sourceText)],
        source_modality: "table",
      };

      const mapped = mapFindingToInsightFamilyDataRow({
        family: input.family,
        finding: sourceFinding,
        dimensions: input.dimensions,
        metricName: input.metricName,
        metadataRegistry: input.metadataRegistry,
      });
      if (mapped) return mapped;
    }
  }

  const chunkRef = refs.find((ref) => ref.chunk_id);
  if (chunkRef?.chunk_id) {
    const chunk = input.chunkById.get(chunkRef.chunk_id);
    if (chunk) {
      const sourceText = chunk.text;
      const sourceFinding: Finding = {
        ...input.finding,
        text: sourceText,
        supporting_refs: [normalizeSourceRef(chunkRef, sourceText)],
        source_modality: "text",
      };

      const mapped = mapFindingToInsightFamilyDataRow({
        family: input.family,
        finding: sourceFinding,
        dimensions: input.dimensions,
        metricName: input.metricName,
        metadataRegistry: input.metadataRegistry,
      });
      if (mapped) return mapped;
    }
  }

  return null;
}

export function buildInsightFamilyDataFromFindings(input: {
  family: InsightFamily;
  findings: Finding[];
  existingDimensionMetadata?: DimensionMetadata[];
  normalizedChunks?: V2Chunk[];
  normalizedTables?: V2Table[];
}): BuildInsightFamilyDataResult {
  const metadataRegistry = createDimensionMetadataRegistry(input.existingDimensionMetadata ?? []);
  for (const filter of input.family.filters ?? []) {
    if (!isMetadataEligibleDimensionName(filter)) continue;
    getOrCreateDimensionMetadata(metadataRegistry, { dimensionName: filter });
  }

  const schema = inferInsightFamilyDataSchema({
    family: input.family,
    findings: input.findings,
  });

  console.info("[family-data] inferred schema for family", {
    family_id: input.family.family_id,
    findings: input.findings.length,
    has_grid: schema.has_grid,
    dimensions: schema.dimensions,
    metric_columns: schema.metric_columns,
    tabularity_confidence: schema.tabularity_confidence,
    reasoning: schema.reasoning,
  });

  if (!schema.has_grid) {
    return {
      family: toNarrativeFamily(input.family),
      droppedDuplicateRows: 0,
      tabularity_confidence: schema.tabularity_confidence,
      warnings: [schema.reasoning],
      dimensionMetadata: listDimensionMetadata(metadataRegistry),
    };
  }

  const metricName = schema.metric_columns[0] ?? "value";
  const originalDimensionLabels = collectOriginalDimensionLabels(input.findings);
  for (const dimension of schema.dimensions) {
    if (!isMetadataEligibleDimensionName(dimension)) continue;
    getOrCreateDimensionMetadata(metadataRegistry, { dimensionName: dimension });
  }

  const chunkById = new Map((input.normalizedChunks ?? []).map((chunk) => [chunk.chunk_id, chunk]));
  const tableById = new Map((input.normalizedTables ?? []).map((table) => [table.table_id, table]));
  const rowCandidates: InsightFamilyDataRow[] = [];

  for (const finding of input.findings) {
    const sourceBackedRow = mapSourceBackedFindingToRow({
      family: input.family,
      finding,
      dimensions: schema.dimensions,
      metricName,
      metadataRegistry,
      chunkById,
      tableById,
    });

    if (sourceBackedRow) {
      rowCandidates.push(sourceBackedRow);
      continue;
    }

    const fallbackRow = mapFindingToInsightFamilyDataRow({
      family: input.family,
      finding,
      dimensions: schema.dimensions,
      metricName,
      metadataRegistry,
    });
    if (fallbackRow) rowCandidates.push(fallbackRow);
  }

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
  console.info(`[family-data] built ${rows.length} rows for family ${input.family.family_id}`);

  if (droppedDuplicateRows > 0) {
    console.info(
      `[family-data] deduped ${droppedDuplicateRows} duplicate rows for family ${input.family.family_id}`,
    );
  }

  if (rows.length === 0) {
    return {
      family: toNarrativeFamily(input.family),
      droppedDuplicateRows,
      tabularity_confidence: schema.tabularity_confidence,
      warnings: ["No evidence-grounded rows could be built."],
      dimensionMetadata: listDimensionMetadata(metadataRegistry),
    };
  }

  const now = new Date().toISOString();
  const tableDimensions = schema.dimensions.map(
    (dimension) => originalDimensionLabels.get(dimension) ?? dimension,
  );
  const dimensionDisplayByCanonical = new Map<string, string>(
    schema.dimensions.map((canonical, index) => [canonical, tableDimensions[index] ?? canonical]),
  );
  const rowsWithDisplayDimensions = rows.map((row) => ({
    ...row,
    filter_values: row.filter_values.map((entry) => {
      const canonical = normalizeDimensionName(entry.dimension_name);
      const displayName = dimensionDisplayByCanonical.get(canonical);
      if (!displayName) return entry;
      return {
        ...entry,
        dimension_name: displayName,
      };
    }),
  }));
  const tableId = hashId(
    `insightfamilydata:${input.family.family_id}:${schema.dimensions.join("|")}:${schema.metric_columns.join("|")}`,
  );
  const familyGridArtifacts = buildFamilyGridArtifacts({
    findings: input.findings,
    tableById,
  });
  const table: InsightFamilyData = {
    table_id: tableId,
    family_id: input.family.family_id,
    dimensions: tableDimensions,
    metric_columns: schema.metric_columns,
    row_count: rowsWithDisplayDimensions.length,
    rows: rowsWithDisplayDimensions,
    table_markdown: familyGridArtifacts.table_markdown,
    table_text_chunk: familyGridArtifacts.table_text_chunk,
    source_modalities: Array.from(new Set(input.findings.map((finding) => finding.source_modality))),
    created_at: now,
    updated_at: now,
  };

  const validation = validateInsightFamilyData(table, schema.tabularity_confidence);
  if (!validation.valid || !validation.table) {
    return {
      family: toNarrativeFamily(input.family),
      droppedDuplicateRows,
      tabularity_confidence: validation.tabularity_confidence,
      warnings: validation.errors.concat(validation.warnings),
      dimensionMetadata: listDimensionMetadata(metadataRegistry),
    };
  }

  return {
    family: {
      ...input.family,
      insight_id: input.family.insight_id ?? input.family.family_id,
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
    dimensionMetadata: listDimensionMetadata(metadataRegistry),
  };
}
