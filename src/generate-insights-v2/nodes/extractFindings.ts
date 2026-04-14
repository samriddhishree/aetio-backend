import { config } from "../../common/services/config";
import { openai, OPENAI_HELPER_MODEL } from "../../common/services/openai";
import { hashId, mapWithConcurrency } from "../../common/services/utils";
import type { PipelineError } from "../../types";
import {
  FINDING_EXTRACTION_PROMPT,
  FINDING_EXTRACTION_SCHEMA,
} from "../prompts";
import {
  filterDimensionsToValidMetadata,
  resolveValidMetadataFields,
} from "../services/metadataFieldPolicy";
import type {
  Finding,
  GenerateInsightsV2State,
  MetadataDimension,
  SupportingRef,
  V2Chunk,
  V2Table,
} from "../types";

type ExtractionTarget =
  | {
      target_id: string;
      source_modality: "text";
      document_id: string;
      chunk: V2Chunk;
    }
  | {
      target_id: string;
      source_modality: "table";
      document_id: string;
      table: V2Table;
    };

type FindingExtractionResponse = {
  findings: Array<{
    text: string;
    metric_value?: string | number | null;
    metric_unit?: string | null;
    dimensions?: Array<{ tag: string; value: string }>;
    confidence?: number | null;
    source_modality: "text" | "table";
    top_level_group_id?: string | null;
    supporting_unit_ids: string[];
  }>;
};

type TargetExtractionResult = {
  findings: Finding[];
  error?: PipelineError;
};

function toCompact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isNumericLike(value: string): boolean {
  return /^[-+]?\d{1,3}(,\d{3})*(\.\d+)?%?$/.test(value.trim());
}

function sanitizeDimensionTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\- ]+/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 48);
}

function isIdentifierLikeTag(value: string): boolean {
  const normalized = sanitizeDimensionTag(value);
  return /(^|_)(id|code|store|employee|account|member|sku|zip|postal|number|no)(_|$)/.test(
    normalized,
  );
}

function isPlaceholderDimensionTag(value: string): boolean {
  const normalized = sanitizeDimensionTag(value);
  if (!normalized) return true;
  if (/^unnamed_?\d*$/.test(normalized)) return true;
  if (/^(column|col)_\d+$/.test(normalized)) return true;
  return false;
}

function sanitizeDimensions(dimensions: Array<{ tag: string; value: string }>): MetadataDimension[] {
  const byTag = new Map<string, MetadataDimension>();
  for (const dimension of dimensions) {
    const normalizedTag = sanitizeDimensionTag(dimension.tag ?? "");
    const tag = toCompact(dimension.tag ?? "");
    const value = toCompact(dimension.value ?? "");
    if (!normalizedTag || !value) continue;
    if (!byTag.has(normalizedTag)) {
      byTag.set(normalizedTag, { tag: tag || normalizedTag, value });
    }
  }
  return Array.from(byTag.values());
}

function mergeDimensionsPrioritizingSource(input: {
  sourceDimensions: MetadataDimension[];
  modelDimensions: MetadataDimension[];
}): MetadataDimension[] {
  if (input.sourceDimensions.length > 0 && input.modelDimensions.length > 0) {
    return sanitizeDimensions([...input.sourceDimensions, ...input.modelDimensions]);
  }
  if (input.sourceDimensions.length > 0) return sanitizeDimensions(input.sourceDimensions);
  return sanitizeDimensions(input.modelDimensions);
}

function tableRowUnitId(tableId: string, rowIndex: number): string {
  return `table:${tableId}:row:${rowIndex}`;
}

function tableUnitId(tableId: string): string {
  return `table:${tableId}`;
}

function chunkUnitId(chunkId: string): string {
  return `chunk:${chunkId}`;
}

function parseTableRowIndexFromUnitId(unitId: string, tableId: string): number | undefined {
  const prefix = `table:${tableId}:row:`;
  if (!unitId.startsWith(prefix)) return undefined;
  const suffix = unitId.slice(prefix.length);
  const parsed = Number.parseInt(suffix, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function buildRowDimensions(table: V2Table, cells: string[]): MetadataDimension[] {
  if (table.headers.length === 0 || cells.length === 0) return [];

  const dimensions: MetadataDimension[] = [];
  const maxPairs = Math.min(table.headers.length, cells.length);
  for (let index = 0; index < maxPairs; index += 1) {
    const rawTag = table.headers[index] ?? `column_${index + 1}`;
    const rawValue = cells[index] ?? "";
    const tag = toCompact(rawTag);
    const value = toCompact(rawValue);
    if (!tag || !value) continue;
    if (isPlaceholderDimensionTag(tag)) continue;
    if (isNumericLike(value) && !isIdentifierLikeTag(tag)) continue;
    dimensions.push({ tag, value });
  }
  return dimensions;
}

function buildExtractionTargets(chunks: V2Chunk[], tables: V2Table[]): ExtractionTarget[] {
  const targets: ExtractionTarget[] = [];

  for (const chunk of chunks) {
    if (!toCompact(chunk.text)) continue;
    targets.push({
      target_id: chunkUnitId(chunk.chunk_id),
      source_modality: "text",
      document_id: chunk.document_id,
      chunk,
    });
  }

  for (const table of tables) {
    if (table.rows.length === 0 && !toCompact(table.raw_text)) continue;
    targets.push({
      target_id: tableUnitId(table.table_id),
      source_modality: "table",
      document_id: table.document_id,
      table,
    });
  }

  return targets;
}

function defaultSupportingUnitIds(target: ExtractionTarget): string[] {
  if (target.source_modality === "text") {
    return [chunkUnitId(target.chunk.chunk_id)];
  }

  if (target.table.rows.length > 0) {
    return [tableRowUnitId(target.table.table_id, target.table.rows[0]?.row_index ?? 0)];
  }
  return [tableUnitId(target.table.table_id)];
}

function allowedSupportingUnitIds(target: ExtractionTarget): string[] {
  if (target.source_modality === "text") {
    return [chunkUnitId(target.chunk.chunk_id)];
  }

  const rowIds = target.table.rows.map((row) => tableRowUnitId(target.table.table_id, row.row_index));
  return [tableUnitId(target.table.table_id), ...rowIds];
}

function buildTargetInput(
  target: ExtractionTarget,
  input?: { validMetadataFields?: string[] },
) {
  const allowedIds = allowedSupportingUnitIds(target);
  const validMetadataFields = (input?.validMetadataFields ?? [])
    .map((field) => toCompact(field))
    .filter((field) => field.length > 0);
  const validMetadataFieldSet = new Set(validMetadataFields);
  const metadataTagValueOptions = buildMetadataTagValueOptions(target, validMetadataFieldSet);

  if (target.source_modality === "text") {
    return {
      source_modality: "text",
      target_id: target.target_id,
      allowed_supporting_unit_ids: allowedIds,
      ...(validMetadataFields.length > 0
        ? { valid_metadata_fields: validMetadataFields }
        : {}),
      ...(metadataTagValueOptions.length > 0
        ? { metadata_tag_value_options: metadataTagValueOptions }
        : {}),
      chunk: {
        chunk_id: target.chunk.chunk_id,
        document_id: target.chunk.document_id,
        source_uri: target.chunk.source_uri,
        page: target.chunk.page,
        section_title: target.chunk.section_title,
        element_type: target.chunk.element_type,
        text: target.chunk.text,
      },
    };
  }

  return {
    source_modality: "table",
    target_id: target.target_id,
    allowed_supporting_unit_ids: allowedIds,
    ...(validMetadataFields.length > 0
      ? { valid_metadata_fields: validMetadataFields }
      : {}),
    ...(metadataTagValueOptions.length > 0
      ? { metadata_tag_value_options: metadataTagValueOptions }
      : {}),
    table: {
      table_id: target.table.table_id,
      document_id: target.table.document_id,
      source_uri: target.table.source_uri,
      page: target.table.page,
      section_title: target.table.section_title,
      element_type: target.table.element_type,
      sheet_name: target.table.sheet_name,
      table_region: target.table.table_region,
      headers: target.table.headers,
      rows: target.table.rows.map((row) => ({
        row_index: row.row_index,
        cells: row.cells,
        row_dimensions: buildRowDimensions(target.table, row.cells),
      })),
      raw_text: target.table.raw_text,
    },
  };
}

function buildMetadataTagValueOptions(
  target: ExtractionTarget,
  validMetadataFields: Set<string>,
): Array<{ tag: string; values: string[] }> {
  if (validMetadataFields.size === 0) return [];

  const valuesByTag = new Map<string, { tag: string; values: Set<string> }>();
  const addDimension = (dimension: MetadataDimension) => {
    const [cleaned] = filterDimensionsToValidMetadata([dimension], validMetadataFields);
    if (!cleaned) return;
    const key = sanitizeDimensionTag(cleaned.tag);
    if (!key) return;
    const existing = valuesByTag.get(key) ?? { tag: cleaned.tag, values: new Set<string>() };
    existing.values.add(cleaned.value);
    valuesByTag.set(key, existing);
  };

  if (target.source_modality === "text") {
    for (const dimension of buildChunkMetadataDimensions(target.chunk)) {
      addDimension(dimension);
    }
  } else {
    for (const row of target.table.rows) {
      for (const dimension of buildRowDimensions(target.table, row.cells)) {
        addDimension(dimension);
      }
    }
  }

  return Array.from(valuesByTag.values())
    .map((entry) => ({
      tag: entry.tag,
      values: Array.from(entry.values).sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.tag.localeCompare(right.tag));
}

function buildChunkSupportingRef(chunk: V2Chunk): SupportingRef {
  return {
    chunk_id: chunk.chunk_id,
    page: chunk.page,
    section_title: chunk.section_title,
    source_excerpt: toCompact(chunk.text).slice(0, 260),
    source_file: chunk.source_uri,
    element_type: chunk.element_type,
  };
}

function buildTableSupportingRef(table: V2Table, rowIndex?: number): SupportingRef {
  const row = typeof rowIndex === "number"
    ? table.rows.find((candidate) => candidate.row_index === rowIndex)
    : undefined;
  const rowText = row
    ? table.headers.map((header, index) => `${header}: ${row.cells[index] ?? ""}`).join(" | ")
    : table.raw_text;

  return {
    table_id: table.table_id,
    row_index: rowIndex,
    page: table.page,
    section_title: table.section_title,
    source_excerpt: toCompact(rowText).slice(0, 260),
    source_file: table.source_uri,
    element_type: table.element_type,
    sheet_name: table.sheet_name,
    table_region: table.table_region,
  };
}

function buildChunkMetadataDimensions(chunk: V2Chunk): MetadataDimension[] {
  const dimensions: MetadataDimension[] = [];
  if (typeof chunk.page === "number" && Number.isFinite(chunk.page)) {
    dimensions.push({ tag: "Page", value: String(chunk.page) });
  }
  if (chunk.section_title && toCompact(chunk.section_title)) {
    dimensions.push({ tag: "Section", value: toCompact(chunk.section_title) });
  }
  if (chunk.element_type && toCompact(chunk.element_type)) {
    dimensions.push({ tag: "Element Type", value: toCompact(chunk.element_type) });
  }
  return sanitizeDimensions(dimensions);
}

function sourceDimensionsFromSupport(target: ExtractionTarget, supportingUnitIds: string[]): MetadataDimension[] {
  if (target.source_modality === "text") return buildChunkMetadataDimensions(target.chunk);

  const dimensions: MetadataDimension[] = [];
  const seen = new Set<number>();
  for (const unitId of supportingUnitIds) {
    const rowIndex = parseTableRowIndexFromUnitId(unitId, target.table.table_id);
    if (typeof rowIndex !== "number" || seen.has(rowIndex)) continue;
    seen.add(rowIndex);
    const row = target.table.rows.find((candidate) => candidate.row_index === rowIndex);
    if (!row) continue;
    dimensions.push(...buildRowDimensions(target.table, row.cells));
  }

  return sanitizeDimensions(dimensions);
}

function supportingRefsFromIds(target: ExtractionTarget, supportingUnitIds: string[]): SupportingRef[] {
  if (target.source_modality === "text") {
    return [buildChunkSupportingRef(target.chunk)];
  }

  const refs: SupportingRef[] = [];
  const seen = new Set<string>();
  for (const unitId of supportingUnitIds) {
    if (unitId === tableUnitId(target.table.table_id)) {
      const ref = buildTableSupportingRef(target.table);
      const key = `${ref.table_id}|${ref.row_index ?? "table"}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push(ref);
      }
      continue;
    }

    const rowIndex = parseTableRowIndexFromUnitId(unitId, target.table.table_id);
    if (typeof rowIndex !== "number") continue;
    const rowExists = target.table.rows.some((row) => row.row_index === rowIndex);
    if (!rowExists) continue;
    const ref = buildTableSupportingRef(target.table, rowIndex);
    const key = `${ref.table_id}|${ref.row_index ?? "table"}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(ref);
    }
  }

  return refs.length > 0 ? refs : [buildTableSupportingRef(target.table)];
}

function normalizeModelFindingsForTarget(
  response: FindingExtractionResponse,
  target: ExtractionTarget,
  input: {
    validMetadataFields: Set<string>;
  },
): { findings: Finding[] } {
  const findings: Finding[] = [];
  const allowedIds = new Set(allowedSupportingUnitIds(target));
  const fallbackIds = defaultSupportingUnitIds(target);

  for (const [index, item] of (response.findings ?? []).entries()) {
    const findingText = toCompact(item.text ?? "");
    if (!findingText) continue;

    const modelDimensions = filterDimensionsToValidMetadata(
      sanitizeDimensions(item.dimensions ?? []),
      input.validMetadataFields,
    );
    const rawSupportingIds = Array.isArray(item.supporting_unit_ids)
      ? item.supporting_unit_ids.map((value) => toCompact(String(value)))
      : [];
    const matchedSupportingIds = rawSupportingIds.filter((unitId) => allowedIds.has(unitId));
    const resolvedSupportingIds = matchedSupportingIds.length > 0 ? matchedSupportingIds : fallbackIds;

    const sourceDimensions = sourceDimensionsFromSupport(target, resolvedSupportingIds);
    const finalDimensions = mergeDimensionsPrioritizingSource({
      sourceDimensions,
      modelDimensions,
    });
    const supportingRefs = supportingRefsFromIds(target, resolvedSupportingIds);

    findings.push({
      finding_id: hashId(`${target.document_id}:${target.target_id}:${findingText}:${index}`),
      top_level_group_id:
        typeof item.top_level_group_id === "string" && item.top_level_group_id.trim().length > 0
          ? toCompact(item.top_level_group_id)
          : target.target_id,
      text: findingText,
      metric_value:
        typeof item.metric_value === "string" || typeof item.metric_value === "number"
          ? item.metric_value
          : undefined,
      metric_unit: typeof item.metric_unit === "string" ? toCompact(item.metric_unit) : undefined,
      dimensions: finalDimensions,
      confidence:
        typeof item.confidence === "number" && Number.isFinite(item.confidence)
          ? Math.max(0, Math.min(1, item.confidence))
          : undefined,
      supporting_refs: supportingRefs,
      source_modality: target.source_modality,
    });
  }

  return { findings };
}

export async function extractFindingsNode(
  state: GenerateInsightsV2State,
): Promise<Partial<GenerateInsightsV2State>> {
  console.info("[finding-extraction] starting", {
    chunks: state.chunks.length,
    tables: state.tables.length,
  });

  const targets = buildExtractionTargets(state.chunks, state.tables);
  const validMetadataFields = resolveValidMetadataFields({
    metadataFilters: state.metadataFilters,
    dimensionMetadata: state.dimensionMetadata,
  });
  const validMetadataFieldList = Array.from(validMetadataFields).sort((left, right) =>
    left.localeCompare(right),
  );

  if (targets.length === 0) {
    console.warn("[finding-extraction] no extraction targets available");
    return {
      findings: [],
    };
  }

  const extractionResults = await mapWithConcurrency<ExtractionTarget, TargetExtractionResult>(
    targets,
    Math.max(1, config.maxConcurrency),
    async (target, targetIndex) => {
      try {
        const requestPayload = {
          model: OPENAI_HELPER_MODEL,
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content: FINDING_EXTRACTION_PROMPT,
            },
            {
              role: "user",
              content: [
                "Extract atomic findings from this single source target.",
                "Use only the provided data, and use supporting_unit_ids from allowed_supporting_unit_ids.",
                "Always include exactly one holistic/top-level finding with dimensions: [].",
                "When metadata_tag_value_options is provided, ensure each listed tag/value option appears in at least one finding dimension.",
                "When valid_metadata_fields is provided, treat it as the reusable metadata dimension allow-list.",
                "Do not drop findings solely because a dimension is outside valid_metadata_fields.",
                JSON.stringify(
                  buildTargetInput(target, {
                    validMetadataFields: validMetadataFieldList,
                  }),
                  null,
                  2,
                ),
              ].join("\n\n"),
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "finding_extraction_v2",
              schema: FINDING_EXTRACTION_SCHEMA,
              strict: true,
            },
          },
        } satisfies Parameters<typeof openai.chat.completions.create>[0];

        const response = await openai.chat.completions.create(requestPayload);
        const content = response.choices[0]?.message?.content;
        if (!content) throw new Error("Empty OpenAI response.");

        const parsed = JSON.parse(content) as FindingExtractionResponse;
        const normalized = normalizeModelFindingsForTarget(
          parsed,
          target,
          {
            validMetadataFields,
          },
        );

        return { findings: normalized.findings };
      } catch (error) {
        const extractionError: PipelineError = {
          stage: "finding-extraction",
          message: error instanceof Error ? error.message : "Unknown error",
          document_id: target.document_id,
          cause: error,
        };
        console.warn("[finding-extraction] target failed", {
          targetIndex,
          target_id: target.target_id,
          source_modality: target.source_modality,
          document_id: target.document_id,
          message: extractionError.message,
        });
        return { findings: [], error: extractionError };
      }
    },
  );

  const extractionErrors: PipelineError[] = extractionResults
    .map((result) => result.error)
    .filter((error): error is PipelineError => Boolean(error));
  const collectedFindings: Finding[] = extractionResults.flatMap((result) => result.findings);

  const findingsById = new Map<string, Finding>();
  for (const finding of collectedFindings) {
    const existing = findingsById.get(finding.finding_id);
    if (!existing) {
      findingsById.set(finding.finding_id, finding);
      continue;
    }
    findingsById.set(finding.finding_id, {
      ...existing,
      supporting_refs: [...existing.supporting_refs, ...finding.supporting_refs],
    });
  }

  const findings = Array.from(findingsById.values()).map((finding) => ({
    ...finding,
    supporting_refs: finding.supporting_refs.filter(
      (ref, index, refs) =>
        refs.findIndex(
          (candidate) =>
            candidate.chunk_id === ref.chunk_id &&
            candidate.table_id === ref.table_id &&
            candidate.row_index === ref.row_index,
        ) === index,
    ),
  }));

  console.info("[finding-extraction] completed", {
    targets: targets.length,
    findings: findings.length,
    tableFindings: findings.filter((finding) => finding.source_modality === "table").length,
    textFindings: findings.filter((finding) => finding.source_modality === "text").length,
    errors: extractionErrors.length,
  });

  return {
    findings,
    errors: state.errors.concat(extractionErrors),
  };
}
