import { config } from "../../common/services/config";
import { openai, OPENAI_HELPER_MODEL } from "../../common/services/openai";
import { chunkArray, hashId, mapWithConcurrency } from "../../common/services/utils";
import type { PipelineError } from "../../types";
import {
  FINDING_EXTRACTION_PROMPT,
  FINDING_EXTRACTION_SCHEMA,
} from "../prompts";
import type {
  Finding,
  GenerateInsightsV2State,
  MetadataDimension,
  SupportingRef,
  V2Chunk,
  V2Table,
} from "../types";

type EvidenceUnit = {
  unit_id: string;
  document_id: string;
  source_modality: "text" | "table";
  chunk_id?: string;
  table_id?: string;
  row_index?: number;
  page?: number;
  section_title?: string;
  source_file: string;
  element_type: string;
  sheet_name?: string;
  table_region?: string;
  text: string;
  dimensions: MetadataDimension[];
};

type FindingExtractionResponse = {
  findings: Array<{
    text: string;
    metric_value?: string | number | null;
    metric_unit?: string | null;
    dimensions?: Array<{ tag: string; value: string }>;
    confidence?: number | null;
    source_modality: "text" | "table";
    supporting_unit_ids: string[];
  }>;
};

const MAX_UNIT_TEXT_CHARS = 900;
const FINDING_BATCH_SIZE = 18;

function toCompact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 3)}...`;
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

function sanitizeDimensions(dimensions: Array<{ tag: string; value: string }>): MetadataDimension[] {
  const byTag = new Map<string, string>();
  for (const dimension of dimensions) {
    const tag = sanitizeDimensionTag(dimension.tag ?? "");
    const value = toCompact(dimension.value ?? "");
    if (!tag || !value) continue;
    if (!byTag.has(tag)) byTag.set(tag, value);
  }
  return Array.from(byTag.entries()).map(([tag, value]) => ({ tag, value }));
}

function buildRowDimensions(table: V2Table, cells: string[]): MetadataDimension[] {
  if (table.headers.length === 0 || cells.length === 0) return [];

  const dimensions: MetadataDimension[] = [];
  const maxPairs = Math.min(table.headers.length, cells.length);
  for (let index = 0; index < maxPairs; index += 1) {
    const rawTag = table.headers[index] ?? `column_${index + 1}`;
    const rawValue = cells[index] ?? "";
    const tag = sanitizeDimensionTag(rawTag);
    const value = toCompact(rawValue);
    if (!tag || !value || isNumericLike(value)) continue;
    dimensions.push({ tag, value });
  }
  return dimensions;
}

function buildTextEvidenceUnits(chunks: V2Chunk[]): EvidenceUnit[] {
  const units: EvidenceUnit[] = [];
  for (const chunk of chunks) {
    const text = truncate(toCompact(chunk.text), MAX_UNIT_TEXT_CHARS);
    if (!text) continue;
    units.push({
      unit_id: `chunk:${chunk.chunk_id}`,
      document_id: chunk.document_id,
      source_modality: "text",
      chunk_id: chunk.chunk_id,
      page: chunk.page,
      section_title: chunk.section_title,
      source_file: chunk.source_uri,
      element_type: chunk.element_type,
      text,
      dimensions: [],
    });
  }
  return units;
}

function buildTableEvidenceUnits(tables: V2Table[]): EvidenceUnit[] {
  const units: EvidenceUnit[] = [];

  for (const table of tables) {
    if (table.rows.length > 0) {
      for (const row of table.rows) {
        const rowText = table.headers.length > 0
          ? table.headers
              .map((header, index) => `${header}: ${row.cells[index] ?? ""}`)
              .join(" | ")
          : row.cells.join(" | ");
        const normalizedRowText = truncate(toCompact(rowText), MAX_UNIT_TEXT_CHARS);
        if (!normalizedRowText) continue;
        units.push({
          unit_id: `table:${table.table_id}:row:${row.row_index}`,
          document_id: table.document_id,
          source_modality: "table",
          table_id: table.table_id,
          row_index: row.row_index,
          page: table.page,
          section_title: table.section_title,
          source_file: table.source_uri,
          element_type: table.element_type,
          sheet_name: table.sheet_name,
          table_region: table.table_region,
          text: normalizedRowText,
          dimensions: buildRowDimensions(table, row.cells),
        });
      }
    }

    if (table.rows.length === 0 && table.raw_text.trim().length > 0) {
      units.push({
        unit_id: `table:${table.table_id}`,
        document_id: table.document_id,
        source_modality: "table",
        table_id: table.table_id,
        page: table.page,
        section_title: table.section_title,
        source_file: table.source_uri,
        element_type: table.element_type,
        sheet_name: table.sheet_name,
        table_region: table.table_region,
        text: truncate(toCompact(table.raw_text), MAX_UNIT_TEXT_CHARS),
        dimensions: [],
      });
    }
  }

  return units;
}

function buildSupportingRef(unit: EvidenceUnit): SupportingRef {
  return {
    chunk_id: unit.chunk_id,
    table_id: unit.table_id,
    row_index: unit.row_index,
    page: unit.page,
    section_title: unit.section_title,
    source_excerpt: truncate(unit.text, 260),
    source_file: unit.source_file,
    element_type: unit.element_type,
    sheet_name: unit.sheet_name,
    table_region: unit.table_region,
  };
}

function toBatchInput(units: EvidenceUnit[]) {
  return {
    units: units.map((unit) => ({
      unit_id: unit.unit_id,
      source_modality: unit.source_modality,
      page: unit.page,
      section_title: unit.section_title,
      dimensions: unit.dimensions,
      text: unit.text,
    })),
  };
}

function normalizeModelFindings(
  response: FindingExtractionResponse,
  unitById: Map<string, EvidenceUnit>,
  fallbackUnit: EvidenceUnit,
): Finding[] {
  const findings: Finding[] = [];

  for (const [index, item] of (response.findings ?? []).entries()) {
    const findingText = toCompact(item.text ?? "");
    if (!findingText) continue;

    const matchedUnits = item.supporting_unit_ids
      .map((unitId) => unitById.get(unitId))
      .filter((unit): unit is EvidenceUnit => Boolean(unit));

    const supportingUnits = matchedUnits.length > 0 ? matchedUnits : [fallbackUnit];
    const dimensions = sanitizeDimensions(item.dimensions ?? []);
    const fallbackDimensions = supportingUnits.flatMap((unit) => unit.dimensions);

    const finalDimensions = dimensions.length > 0
      ? dimensions
      : sanitizeDimensions(fallbackDimensions);

    const supportingRefs = supportingUnits.map((unit) => buildSupportingRef(unit));

    const primaryUnit = supportingUnits[0] ?? fallbackUnit;
    findings.push({
      finding_id: hashId(`${primaryUnit.document_id}:${findingText}:${index}`),
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
      source_modality: item.source_modality ?? primaryUnit.source_modality,
    });
  }

  return findings;
}

export async function extractFindingsNode(
  state: GenerateInsightsV2State,
): Promise<Partial<GenerateInsightsV2State>> {
  console.info("[finding-extraction] starting", {
    chunks: state.chunks.length,
    tables: state.tables.length,
  });

  const textUnits = buildTextEvidenceUnits(state.chunks);
  const tableUnits = buildTableEvidenceUnits(state.tables);
  const evidenceUnits = [...textUnits, ...tableUnits];

  if (evidenceUnits.length === 0) {
    console.warn("[finding-extraction] no evidence units available");
    return {
      findings: [],
    };
  }

  const unitsByDocument = new Map<string, EvidenceUnit[]>();
  for (const unit of evidenceUnits) {
    const list = unitsByDocument.get(unit.document_id) ?? [];
    list.push(unit);
    unitsByDocument.set(unit.document_id, list);
  }

  const batches = Array.from(unitsByDocument.values()).flatMap((documentUnits) =>
    chunkArray(documentUnits, FINDING_BATCH_SIZE),
  );

  const extractionErrors: PipelineError[] = [];
  const batchedFindings = await mapWithConcurrency(
    batches,
    Math.max(1, config.maxConcurrency),
    async (batch, batchIndex): Promise<Finding[]> => {
      const unitById = new Map(batch.map((unit) => [unit.unit_id, unit]));
      const fallbackUnit = batch[0];

      if (!fallbackUnit) return [];

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
                "Extract atomic findings from these evidence units.",
                "Never include unsupported claims.",
                JSON.stringify(toBatchInput(batch), null, 2),
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
        return normalizeModelFindings(parsed, unitById, fallbackUnit);
      } catch (error) {
        extractionErrors.push({
          stage: "finding-extraction",
          message: error instanceof Error ? error.message : "Unknown error",
          document_id: fallbackUnit.document_id,
          cause: error,
        });
        console.warn("[finding-extraction] batch failed", {
          batchIndex,
          document_id: fallbackUnit.document_id,
          units: batch.length,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        return [];
      }
    },
  );

  const findingsById = new Map<string, Finding>();
  for (const finding of batchedFindings.flat()) {
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
    evidenceUnits: evidenceUnits.length,
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
