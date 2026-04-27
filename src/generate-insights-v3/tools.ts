import { hashId } from "../common/services/utils";
import { openai, OPENAI_HELPER_MODEL } from "../common/services/openai";
import {
  createDimensionMetadataRegistry,
  getOrCreateDimensionMetadata,
  getOrCreateDimensionValueMetadata,
  listDimensionMetadata,
  normalizeDimensionName,
} from "../generate-insights-v2/services/metadataService";
import { isResultantMetadataField } from "../generate-insights-v2/services/metadataFieldPolicy";
import type { InsightMetadataEntry, InsightTagEntry } from "../types";
import {
  V3_AGENT_PLANNER_PROMPT,
  V3_AGENT_PLANNER_SCHEMA,
  V3_EXPLICIT_INSIGHT_PROMPT,
  V3_EXPLICIT_INSIGHT_SCHEMA,
  V3_NARRATIVE_GRID_PROMPT,
  V3_NARRATIVE_GRID_SCHEMA,
  V3_SYNTHESIZE_INSIGHT_PROMPT,
  V3_SYNTHESIZE_INSIGHT_SCHEMA,
  V3_TAGS_PROMPT,
  V3_TAGS_SCHEMA,
} from "./prompts";
import { validateInsightObject } from "./validators";
import {
  batchUnderstandTables,
  extractImpliedGrids,
  understandTable,
  type RawTable,
  type TableSemanticObject,
} from "../services/tableUnderstandingClient";
import type {
  AgentAction,
  CandidateGrid,
  ExplicitInsightResult,
  GenerateInsightsV3AgentState,
  GenerateInsightsV3Insight,
  GenerateInsightsV3Toolset,
  GridContext,
  GridRowDraft,
  NormalizedGridDraft,
  NormalizedGridResult,
  ParsedFileContent,
  SynthesizedInsightResult,
  V3DocumentBundle,
  V3OpenAiChatResponseFormat,
} from "./types";
import type { SupportingRef, V2Chunk, V2Table } from "../generate-insights-v2/types";

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const MAX_METADATA_ENTRIES = 24;
const MAX_VALUES_PER_DIMENSION_TAG = 6;
const MAX_INSIGHT_TAGS = 10;

function clampConfidence(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(3));
}

function truncate(value: string, max = 1200): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => compact(value)).filter(Boolean)));
}

function isCaptionLike(text: string): boolean {
  const normalized = compact(text).toLowerCase();
  return /^(table|figure|chart)\s+\d+/i.test(normalized)
    || normalized.includes("table ")
    || normalized.includes("figure ")
    || normalized.includes("chart ");
}

function isHeadingLike(chunk: V2Chunk): boolean {
  const type = chunk.element_type.toLowerCase();
  return type.includes("title") || type.includes("header") || type.includes("heading");
}

function detectDelimiter(lines: string[]): string | null {
  const candidates = ["\t", "|", ",", ";"];
  let best: string | null = null;
  let bestScore = 0;

  for (const delimiter of candidates) {
    const score = lines.reduce((sum, line) => {
      const count = Math.max(0, line.split(delimiter).length - 1);
      return sum + count;
    }, 0);
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }

  return bestScore > 0 ? best : null;
}

function buildTextDerivedTable(chunk: V2Chunk): V2Table | null {
  const lines = chunk.text
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 3) return null;

  const delimiter = detectDelimiter(lines);
  if (!delimiter) return null;

  const rowCells = lines
    .map((line) => line.split(delimiter).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 2);

  if (rowCells.length < 3) return null;

  const header = rowCells[0] ?? [];
  const dataRows = rowCells.slice(1);
  if (header.length < 2 || dataRows.length < 2) return null;

  const maxColumns = Math.max(header.length, ...dataRows.map((row) => row.length));
  const headers = Array.from({ length: maxColumns }, (_value, index) => {
    const cell = compact(header[index] ?? "");
    return cell || `column_${index + 1}`;
  });

  const rows = dataRows.map((cells, rowIndex) => ({
    row_index: rowIndex,
    cells: Array.from({ length: maxColumns }, (_value, index) => compact(cells[index] ?? "")),
  }));

  return {
    table_id: hashId(`${chunk.document_id}:text-grid:${chunk.chunk_id}`),
    document_id: chunk.document_id,
    source_uri: chunk.source_uri,
    page: chunk.page,
    section_title: chunk.section_title,
    element_type: `text:${chunk.element_type}`,
    raw_text: lines.join("\n"),
    headers,
    rows,
    table_region: chunk.chunk_id,
  };
}

function extractionSourceForTable(table: V2Table): RawTable["extraction_source"] {
  const type = table.element_type.toLowerCase();
  const source = table.source_uri.toLowerCase();
  if (source.endsWith(".csv") || source.endsWith(".tsv")) return "csv";
  if (source.endsWith(".xls") || source.endsWith(".xlsx")) return "excel";
  if (source.endsWith(".pdf") || type.includes("pdf")) return "pdf_table";
  return "explicit_table";
}

function rawTableFromV2Table(table: V2Table): RawTable {
  return {
    table_id: table.table_id,
    document_id: table.document_id,
    source_chunk_id: table.table_region ?? table.table_id,
    page: table.page,
    caption: table.section_title,
    headers: table.headers,
    rows: table.rows.map((row) => row.cells),
    extraction_source: extractionSourceForTable(table),
  };
}

function v2TableFromRawTable(table: RawTable, sourceUri: string): V2Table {
  return {
    table_id: table.table_id,
    document_id: table.document_id,
    source_uri: sourceUri,
    page: table.page,
    section_title: table.caption,
    element_type: table.extraction_source === "implied_grid" ? "NarrativeImpliedGrid" : "Table",
    table_region: table.source_chunk_id,
    raw_text: [table.headers.join(" | "), ...table.rows.map((row) => row.join(" | "))].join("\n"),
    headers: table.headers,
    rows: table.rows.map((cells, rowIndex) => ({ row_index: rowIndex, cells })),
  };
}

function semanticByTableId(objects: TableSemanticObject[]): Map<string, TableSemanticObject> {
  return new Map(objects.map((object) => [object.table_id, object]));
}

function hasUsableOpenAiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function narrativeCandidateChunks(parsed: ParsedFileContent): V2Chunk[] {
  return parsed.text_blocks.filter((chunk) => {
    const text = compact(chunk.text);
    if (text.length < 32) return false;
    if (isCaptionLike(text)) return false;
    if (isHeadingLike(chunk)) return false;
    return true;
  });
}

function splitNarrativeSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => compact(sentence))
    .filter((sentence) => sentence.length >= 20);
}

function sanitizeNarrativeLabel(raw: string): string {
  return compact(raw)
    .replace(/^(the|a|an|in|for|among|across|and|while)\s+/i, "")
    .replace(/\s+(is|are|was|were|at|to|reached|hit|rose|fell)$/i, "")
    .slice(0, 72);
}

function extractNarrativeLabelValuePairs(sentence: string): Array<{ label: string; value: string }> {
  const pairs: Array<{ label: string; value: string }> = [];
  const pattern = /([A-Za-z][A-Za-z0-9/&\- ]{1,48}?)\s*(?::|=|\b(?:was|were|is|are|at|to|reached|hit)\b)?\s*(\$?-?\d[\d,]*(?:\.\d+)?%?)/g;

  let match = pattern.exec(sentence);
  while (match) {
    const label = sanitizeNarrativeLabel(match[1] ?? "");
    const value = compact(match[2] ?? "");
    if (label && value) {
      pairs.push({ label, value });
    }
    match = pattern.exec(sentence);
  }

  return pairs;
}

function buildHeuristicNarrativeTable(parsed: ParsedFileContent): V2Table | null {
  const chunks = narrativeCandidateChunks(parsed).slice(0, 12);
  if (chunks.length === 0) return null;

  const rows: string[][] = [];

  for (const chunk of chunks) {
    const sentences = splitNarrativeSentences(chunk.text);
    for (const sentence of sentences) {
      const pairs = extractNarrativeLabelValuePairs(sentence);
      if (pairs.length > 0) {
        for (const pair of pairs) {
          rows.push([pair.label, pair.value, truncate(sentence, 180)]);
        }
        continue;
      }

      rows.push([
        compact(chunk.section_title ?? "narrative_segment"),
        truncate(sentence, 72),
        truncate(sentence, 180),
      ]);
    }
  }

  const compactRows = rows
    .map((row) => row.map((cell) => compact(cell)))
    .filter((row) => row.some((cell) => cell.length > 0))
    .slice(0, 28);

  if (compactRows.length === 0) return null;

  const maxColumns = Math.max(3, ...compactRows.map((row) => row.length));
  const paddedRows = compactRows.map((row, rowIndex) => ({
    row_index: rowIndex,
    cells: Array.from(
      { length: maxColumns },
      (_value, columnIndex) => compact(row[columnIndex] ?? ""),
    ),
  }));

  const headers = ["Segment", "Reported value", "Narrative evidence"];
  while (headers.length < maxColumns) {
    headers.push(`column_${headers.length + 1}`);
  }

  const tableRegion = chunks.slice(0, 6).map((chunk) => chunk.chunk_id).join("|");
  const rawText = paddedRows.map((row) => row.cells.join(" | ")).join("\n");

  return {
    table_id: hashId(`${parsed.document.document_id}:narrative-heuristic:${tableRegion || "none"}`),
    document_id: parsed.document.document_id,
    source_uri: parsed.document.source_uri,
    page: chunks.find((chunk) => typeof chunk.page === "number")?.page,
    section_title: chunks.find((chunk) => chunk.section_title)?.section_title,
    element_type: "NarrativeImpliedGrid",
    table_region: tableRegion || undefined,
    raw_text: rawText,
    headers,
    rows: paddedRows,
  };
}

function normalizeComparisonToken(value: string): string {
  return compact(value)
    .toLowerCase()
    .replace(/[$,%]/g, "")
    .replace(/[^a-z0-9.\- ]+/g, " ")
    .replace(/\s+/g, " ");
}

function overlapRatio(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / left.size;
}

function tableComparisonFootprint(table: V2Table): {
  headerTokens: Set<string>;
  rowTokens: Set<string>;
  cellTokens: Set<string>;
  pairTokens: Set<string>;
} {
  const headerTokens = new Set<string>();
  const rowTokens = new Set<string>();
  const cellTokens = new Set<string>();
  const pairTokens = new Set<string>();

  for (const header of table.headers) {
    const normalized = normalizeComparisonToken(header);
    if (!normalized) continue;
    headerTokens.add(normalized);
    cellTokens.add(normalized);
  }

  for (const row of table.rows) {
    const normalizedCells = row.cells
      .map((cell) => normalizeComparisonToken(cell))
      .filter((cell) => cell.length > 0);

    for (const token of normalizedCells) {
      cellTokens.add(token);
      for (const word of token.split(" ")) {
        if (word.length >= 2) cellTokens.add(word);
      }
    }

    if (normalizedCells.length > 0) {
      rowTokens.add(normalizedCells.join("|"));
    }

    const first = normalizedCells[0];
    const second = normalizedCells[1];
    if (first && second) {
      pairTokens.add(`${first}|${second}`);
    }
  }

  return {
    headerTokens,
    rowTokens,
    cellTokens,
    pairTokens,
  };
}

function isNarrativeGridDuplicateOfActual(narrativeTable: V2Table, actualTable: V2Table): boolean {
  if (tableSignature(narrativeTable) === tableSignature(actualTable)) return true;

  const narrative = tableComparisonFootprint(narrativeTable);
  const actual = tableComparisonFootprint(actualTable);

  const headerOverlap = overlapRatio(narrative.headerTokens, actual.headerTokens);
  const rowOverlap = overlapRatio(narrative.rowTokens, actual.rowTokens);
  const cellOverlap = overlapRatio(narrative.cellTokens, actual.cellTokens);
  const pairOverlap = overlapRatio(narrative.pairTokens, actual.pairTokens);

  return rowOverlap >= 0.7
    || pairOverlap >= 0.5
    || (headerOverlap >= 0.65 && cellOverlap >= 0.72)
    || cellOverlap >= 0.85;
}

function toNarrativeCandidateGrid(input: {
  table: V2Table;
  confidence?: number;
  rationale: string;
}): CandidateGrid {
  const structuralConfidence = scoreCandidateGrid(input.table, "narrative_implied");
  const modelConfidence = clampConfidence(input.confidence ?? structuralConfidence);
  return {
    grid_id: hashId(`${input.table.table_id}:grid`),
    document_id: input.table.document_id,
    source_uri: input.table.source_uri,
    table: input.table,
    source_mode: "narrative_implied",
    confidence: clampConfidence((structuralConfidence * 0.55) + (modelConfidence * 0.45)),
    rationale: input.rationale,
  };
}

function toNarrativeTableFromLlmGrid(input: {
  parsed: ParsedFileContent;
  index: number;
  title: string | null;
  rationale: string;
  confidence: number;
  headers: string[];
  rows: string[][];
  supportingChunkIds: string[];
}): { table: V2Table; confidence: number; rationale: string } | null {
  const cleanHeaders = uniqueStrings((input.headers ?? []).map((header) => compact(header))).slice(0, 8);
  if (cleanHeaders.length < 2) return null;

  const maxColumns = Math.max(
    cleanHeaders.length,
    ...(input.rows ?? []).map((row) => row.length),
    2,
  );

  const headers = Array.from({ length: maxColumns }, (_value, columnIndex) => {
    const header = compact(cleanHeaders[columnIndex] ?? "");
    return header || `column_${columnIndex + 1}`;
  });

  const cleanRows = (input.rows ?? [])
    .map((row) => row.map((cell) => compact(cell)))
    .filter((row) => row.some((cell) => cell.length > 0))
    .slice(0, 40);

  if (cleanRows.length === 0) return null;

  const rows = cleanRows.map((cells, rowIndex) => ({
    row_index: rowIndex,
    cells: Array.from({ length: maxColumns }, (_value, columnIndex) => compact(cells[columnIndex] ?? "")),
  }));

  const supportById = new Map(
    input.parsed.text_blocks.map((chunk) => [chunk.chunk_id, chunk]),
  );
  const supportChunks = uniqueStrings(input.supportingChunkIds ?? [])
    .map((chunkId) => supportById.get(chunkId))
    .filter((chunk): chunk is V2Chunk => Boolean(chunk))
    .slice(0, 8);

  const fallbackChunks = narrativeCandidateChunks(input.parsed).slice(0, 8);
  const chunks = supportChunks.length > 0 ? supportChunks : fallbackChunks;

  const sectionTitle = chunks.find((chunk) => chunk.section_title)?.section_title;
  const page = chunks.find((chunk) => typeof chunk.page === "number")?.page;
  const tableRegion = chunks.map((chunk) => chunk.chunk_id).join("|");

  const rawText = [
    compact(input.title ?? "Narrative implied grid"),
    `Rationale: ${compact(input.rationale)}`,
    ...rows.map((row) => row.cells.join(" | ")),
  ].join("\n");

  const seed = [
    input.parsed.document.document_id,
    input.index,
    headers.join("|"),
    rows[0]?.cells.join("|") ?? "",
  ].join("::");

  return {
    table: {
      table_id: hashId(`${input.parsed.document.document_id}:narrative-llm:${seed}`),
      document_id: input.parsed.document.document_id,
      source_uri: input.parsed.document.source_uri,
      page,
      section_title: sectionTitle,
      element_type: "NarrativeImpliedGrid",
      table_region: tableRegion || undefined,
      raw_text: rawText,
      headers,
      rows,
    },
    confidence: clampConfidence(input.confidence),
    rationale: compact(input.rationale) || "Implied grid inferred from narrative statements.",
  };
}

async function extractNarrativeImpliedGrids(parsed: ParsedFileContent): Promise<CandidateGrid[]> {
  const narrativeChunks = narrativeCandidateChunks(parsed);
  if (narrativeChunks.length === 0) return [];

  const inferred: CandidateGrid[] = [];
  const seenNarrativeSignatures = new Set<string>();

  if (hasUsableOpenAiKey()) {
    try {
      const payload = JSON.stringify(
        {
          document_id: parsed.document.document_id,
          source_uri: parsed.document.source_uri,
          narrative_chunks: narrativeChunks.slice(0, 18).map((chunk) => ({
            chunk_id: chunk.chunk_id,
            page: chunk.page,
            section_title: chunk.section_title,
            element_type: chunk.element_type,
            text: truncate(compact(chunk.text), 700),
          })),
        },
        null,
        2,
      );

      const response = await runJsonCompletion<{
        implied_grids: Array<{
          title: string | null;
          rationale: string;
          confidence: number;
          headers: string[];
          rows: string[][];
          supporting_chunk_ids: string[];
        }>;
      }>({
        systemPrompt: V3_NARRATIVE_GRID_PROMPT,
        userPayload: payload,
        schemaName: "v3_narrative_implied_grids",
        schema: V3_NARRATIVE_GRID_SCHEMA,
        temperature: 0.1,
      });

      for (const [index, candidate] of (response.implied_grids ?? []).entries()) {
        const inferredTable = toNarrativeTableFromLlmGrid({
          parsed,
          index,
          title: candidate.title,
          rationale: candidate.rationale,
          confidence: candidate.confidence,
          headers: candidate.headers,
          rows: candidate.rows,
          supportingChunkIds: candidate.supporting_chunk_ids,
        });
        if (!inferredTable) continue;

        const signature = tableSignature(inferredTable.table);
        if (seenNarrativeSignatures.has(signature)) continue;
        seenNarrativeSignatures.add(signature);

        inferred.push(
          toNarrativeCandidateGrid({
            table: inferredTable.table,
            confidence: inferredTable.confidence,
            rationale: inferredTable.rationale,
          }),
        );
      }
    } catch (error) {
      console.warn("[agent] narrative implied grid extraction fallback", {
        document_id: parsed.document.document_id,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  const heuristic = buildHeuristicNarrativeTable(parsed);
  if (heuristic) {
    const signature = tableSignature(heuristic);
    if (!seenNarrativeSignatures.has(signature)) {
      inferred.push(
        toNarrativeCandidateGrid({
          table: heuristic,
          confidence: 0.42,
          rationale: "Heuristic narrative-to-grid conversion from non-tabular text blocks.",
        }),
      );
    }
  }

  return inferred.sort((left, right) => right.confidence - left.confidence);
}

function tableSignature(table: V2Table): string {
  const firstRow = table.rows[0]?.cells.join("|") ?? "";
  return [
    table.document_id,
    table.page ?? "",
    table.headers.join("|"),
    firstRow,
  ].join("::");
}

function scoreCandidateGrid(table: V2Table, sourceMode: CandidateGrid["source_mode"]): number {
  const rowCount = table.rows.length;
  const columnCount = Math.max(
    table.headers.length,
    ...table.rows.map((row) => row.cells.length),
    0,
  );

  let score = 0.34;
  if (sourceMode === "table_element") score = 0.5;
  if (sourceMode === "text_block") score = 0.38;
  score += Math.min(rowCount, 20) * 0.02;
  score += Math.min(columnCount, 12) * 0.015;
  if (table.headers.length > 0) score += 0.08;
  if (table.page !== undefined) score += 0.04;

  return clampConfidence(score);
}

function summarizeTableForPrompt(table: V2Table, maxRows = 15): string {
  const headers = table.headers.length > 0
    ? table.headers
    : Array.from({ length: Math.max(...table.rows.map((row) => row.cells.length), 1) }, (_v, i) => `column_${i + 1}`);

  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = table.rows
    .slice(0, maxRows)
    .map((row) => {
      const cells = Array.from({ length: headers.length }, (_value, index) => row.cells[index] ?? "");
      return `| ${cells.join(" | ")} |`;
    });

  return [head, sep, ...body].join("\n");
}

function buildChunkSupportingRef(chunk: V2Chunk): SupportingRef {
  return {
    chunk_id: chunk.chunk_id,
    page: chunk.page,
    section_title: chunk.section_title,
    source_excerpt: truncate(compact(chunk.text), 260),
    source_file: chunk.source_uri,
    element_type: chunk.element_type,
  };
}

function buildTableSupportingRef(table: V2Table, rowIndex?: number): SupportingRef {
  return {
    table_id: table.table_id,
    row_index: rowIndex,
    page: table.page,
    section_title: table.section_title,
    source_excerpt: truncate(compact(table.raw_text), 260),
    source_file: table.source_uri,
    element_type: table.element_type,
    sheet_name: table.sheet_name,
    table_region: table.table_region,
  };
}

function inferMetricUnit(input: { header: string; value: string }): string | undefined {
  const header = input.header.toLowerCase();
  const value = input.value.toLowerCase();
  if (header.includes("bps") || value.includes("bps") || header.includes("basis point")) {
    return "bps";
  }
  if (header.includes("percent") || header.includes("rate") || header.includes("%") || input.value.includes("%")) {
    return "%";
  }
  if (
    header.includes("usd")
    || header.includes("dollar")
    || header.includes("revenue")
    || header.includes("cash")
    || header.includes("$")
    || input.value.includes("$")
  ) {
    return "usd";
  }
  if (header.includes("count") || header.includes("volume")) {
    return "count";
  }
  return undefined;
}

function toMetricValue(value: string): string | number | undefined {
  const normalized = compact(value);
  if (!normalized) return undefined;

  const negativeParens = /^\(.+\)$/.test(normalized);
  let withoutCommas = normalized
    .replace(/[,$]/g, "")
    .replace(/\s*bps$/i, "")
    .replace(/\s*percent$/i, "%")
    .trim();
  if (negativeParens) withoutCommas = withoutCommas.replace(/[()]/g, "");
  const percent = withoutCommas.endsWith("%");
  const numeric = percent ? withoutCommas.slice(0, -1) : withoutCommas;

  if (/^[-+]?\d+(?:\.\d+)?$/.test(numeric)) {
    const parsed = Number(numeric);
    if (Number.isFinite(parsed)) return negativeParens ? -parsed : parsed;
  }

  const leadingNumeric = numeric.match(/^([-+]?\d+(?:\.\d+)?)\b/);
  if (leadingNumeric?.[1]) {
    const parsed = Number(leadingNumeric[1]);
    if (Number.isFinite(parsed)) return negativeParens ? -parsed : parsed;
  }

  return normalized;
}

function isAggregateDimensionValue(value: string): boolean {
  return /^(total|grand total|overall|all|subtotal|all others|others)$/i.test(compact(value));
}

function isLikelyMetricHeader(header: string): boolean {
  const normalized = compact(header).toLowerCase();
  return /(rate|conversion|delta|change|growth|revenue|sales|cost|price|count|volume|total|avg|average|mean|median|score|percent|%|amount|measure|metric|cash|equivalent|value|\$|bps|points|yield|bushel|acre|fertiliz|precipitation)/.test(normalized);
}

function buildTableUnderstandingSummary(object: CandidateGrid["table_semantic_object"]) {
  if (!object) return undefined;
  return {
    provider: object.provider,
    subject_column: object.subject_column,
    confidence: object.confidence,
    candidate_facts_count: object.candidate_facts.length,
    column_roles: object.column_roles.map((role) => ({
      column_name: role.column_name,
      role: role.role,
      semantic_type: role.semantic_type,
      unit: role.unit,
      confidence: role.confidence,
    })),
  };
}

function isNumericLike(value: string): boolean {
  return typeof toMetricValue(value) === "number";
}

function isLikelyIdentifierHeader(header: string): boolean {
  const normalized = compact(header).toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
  if (!normalized) return false;
  return /(^| )(id|identifier|code|sku|store|account|member|zip|postal|no|number)( |$)/.test(
    normalized,
  );
}

function isLikelyTemporalHeader(header: string): boolean {
  const normalized = compact(header).toLowerCase();
  return /(date|day|week|month|quarter|year|period|time)/.test(normalized);
}

function isLikelyDimensionHeader(header: string): boolean {
  return isLikelyIdentifierHeader(header) || isLikelyTemporalHeader(header);
}

function markdownForTable(table: V2Table): string {
  const headers = table.headers.length > 0
    ? table.headers
    : Array.from({ length: Math.max(...table.rows.map((row) => row.cells.length), 1) }, (_v, i) => `column_${i + 1}`);
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const rows = table.rows.map((row) => {
    const cells = Array.from({ length: headers.length }, (_value, index) => row.cells[index] ?? "");
    return `| ${cells.join(" | ")} |`;
  });
  return [head, sep, ...rows].join("\n");
}

function textChunkForTable(table: V2Table): string {
  const headers = table.headers.length > 0 ? table.headers.join(" | ") : "No headers";
  const rows = table.rows
    .slice(0, 40)
    .map((row) => `Row ${row.row_index}: ${row.cells.join(" | ")}`)
    .join("\n");
  return [`Table ${table.table_id}`, `Headers: ${headers}`, rows].filter(Boolean).join("\n");
}

function buildRunScopedInsightFamilyDataTableId(input: {
  familyId: string;
  sourceTableId: string;
  sourceMode: CandidateGrid["source_mode"];
}): string {
  return hashId(
    `insightfamilydata-v3:${input.familyId}:${input.sourceTableId}:${input.sourceMode}`,
  );
}

async function runJsonCompletion<T>(input: {
  systemPrompt: string;
  userPayload: string;
  schemaName: string;
  schema: Record<string, unknown>;
  temperature?: number;
}): Promise<T> {
  const responseFormat: V3OpenAiChatResponseFormat = {
    type: "json_schema",
    json_schema: {
      name: input.schemaName,
      schema: input.schema,
      strict: true,
    },
  };

  const response = await openai.chat.completions.create({
    model: OPENAI_HELPER_MODEL,
    temperature: input.temperature ?? 0,
    messages: [
      {
        role: "system",
        content: input.systemPrompt,
      },
      {
        role: "user",
        content: input.userPayload,
      },
    ],
    response_format: responseFormat,
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("Empty OpenAI response.");
  return JSON.parse(raw) as T;
}

function deterministicPlanner(state: GenerateInsightsV3AgentState): AgentAction {
  if (!state.parsedContent) {
    return { action: "parse_file", reason: "Need parsed content before any analysis." };
  }

  if (!state.candidateGridDiscoveryDone) {
    return { action: "find_candidate_grids", reason: "Need to discover candidate grids in parsed content." };
  }

  if (state.candidateGrids.length === 0 && state.pendingGridIds.length === 0) {
    return { action: "finish_document", reason: "No candidate grids were detected in this document." };
  }

  if (!state.activeGridId) {
    if (state.pendingGridIds.length > 0) {
      return { action: "select_next_grid", reason: "Pick the next unprocessed grid." };
    }
    return { action: "finish_document", reason: "No pending grids remain." };
  }

  const work = state.gridWorkById.get(state.activeGridId);
  if (!work) {
    return { action: "select_next_grid", reason: "Initialize work state for a pending grid." };
  }

  if (!work.context) {
    return { action: "inspect_grid_context", reason: "Need nearby context before insight selection." };
  }

  if (!work.explicitInsight) {
    return { action: "extract_explicit_insight", reason: "Check whether nearby text already states the insight." };
  }

  if (!work.explicitInsight.found_explicit_insight && !work.synthesizedInsight) {
    return { action: "synthesize_insight", reason: "No explicit nearby insight found; synthesize grounded statement." };
  }

  if (!work.normalizedGridDraft) {
    return { action: "normalize_grid", reason: "Need normalized grid rows for persistence." };
  }

  if (work.normalizedGridDraft.row_count <= 0) {
    return {
      action: "complete_grid",
      reason: "Grid produced zero normalized rows and will be dropped with surfaced errors.",
    };
  }

  if (work.validationErrors && work.validationErrors.length > 0) {
    return {
      action: "complete_grid",
      reason: "Grid failed validation and will be completed with surfaced errors.",
    };
  }

  if (!work.normalizedGrid) {
    return {
      action: "normalize_dimension_metadata",
      reason: "Need canonical dimension metadata and IDs for normalized rows.",
    };
  }

  if (!work.metadata) {
    return { action: "build_insight_metadata", reason: "Need grid-derived metadata values." };
  }

  if (!work.tags) {
    return { action: "build_insight_tags", reason: "Need synthesized semantic insight tags." };
  }

  if (!work.validationErrors && !work.validationWarnings) {
    return { action: "validate_insight", reason: "Validate final insight coherence before completion." };
  }

  if (work.validatedInsight) {
    return {
      action: "complete_grid",
      reason: "Grid produced a validated insight and is ready to finalize.",
    };
  }

  return { action: "complete_grid", reason: "Grid pipeline complete for this grid." };
}

function isActionAllowed(state: GenerateInsightsV3AgentState, action: AgentAction["action"]): boolean {
  const work = state.activeGridId ? state.gridWorkById.get(state.activeGridId) : undefined;

  switch (action) {
    case "parse_file":
      return !state.parsedContent;
    case "find_candidate_grids":
      return Boolean(state.parsedContent) && !state.candidateGridDiscoveryDone;
    case "select_next_grid":
      return !state.activeGridId && state.pendingGridIds.length > 0;
    case "inspect_grid_context":
      return Boolean(state.activeGridId) && work !== undefined && !work.context;
    case "extract_explicit_insight":
      return Boolean(state.activeGridId) && Boolean(work?.context) && !work?.explicitInsight;
    case "synthesize_insight":
      return Boolean(state.activeGridId)
        && Boolean(work?.context)
        && Boolean(work?.explicitInsight)
        && !work?.explicitInsight?.found_explicit_insight
        && !work?.synthesizedInsight;
    case "normalize_grid":
      return Boolean(state.activeGridId) && Boolean(work?.insightId) && !work?.normalizedGridDraft;
    case "normalize_dimension_metadata":
      return Boolean(state.activeGridId)
        && Boolean(work?.normalizedGridDraft)
        && !work?.validationErrors
        && !work?.normalizedGrid;
    case "build_insight_metadata":
      return Boolean(state.activeGridId)
        && Boolean(work?.normalizedGrid)
        && Boolean(work?.context)
        && !work?.validationErrors
        && !work?.metadata;
    case "build_insight_tags":
      return Boolean(state.activeGridId)
        && Boolean(work?.normalizedGrid)
        && Boolean(work?.context)
        && Boolean(work?.metadata)
        && !work?.validationErrors
        && !work?.tags;
    case "validate_insight":
      return Boolean(state.activeGridId)
        && Boolean(work?.normalizedGrid)
        && Boolean(work?.context)
        && Boolean(work?.metadata)
        && Boolean(work?.tags)
        && !work?.validatedInsight
        && !work?.validationErrors;
    case "complete_grid":
      return Boolean(state.activeGridId)
        && Boolean(work)
        && (Boolean(work?.validatedInsight) || Boolean(work?.validationErrors));
    case "finish_document":
      return !state.activeGridId && state.pendingGridIds.length === 0;
    default:
      return false;
  }
}

function tableFirstDimensionLabel(table: V2Table): string {
  if (table.headers.length > 0) return compact(table.headers[0]);
  return "segment";
}

function fallbackSynthesizedInsight(table: V2Table): SynthesizedInsightResult {
  const dimensionLabel = tableFirstDimensionLabel(table);
  const numericByColumn = new Map<number, number[]>();

  for (const row of table.rows) {
    for (const [index, rawCell] of row.cells.entries()) {
      const metric = toMetricValue(rawCell);
      if (typeof metric !== "number") continue;
      const list = numericByColumn.get(index) ?? [];
      list.push(metric);
      numericByColumn.set(index, list);
    }
  }

  const bestMetricColumn = Array.from(numericByColumn.entries())
    .sort((left, right) => right[1].length - left[1].length)[0];

  if (!bestMetricColumn) {
    return {
      insight_text: `The grid provides segmented values across ${dimensionLabel.toLowerCase()} categories.`,
      question_answered: `How do reported values vary across ${dimensionLabel.toLowerCase()} categories?`,
      confidence: 0.45,
      reasoning: "Fallback synthesis without reliable numeric signal.",
    };
  }

  const [metricColumnIndex, values] = bestMetricColumn;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const metricLabel = compact(table.headers[metricColumnIndex] ?? `metric_${metricColumnIndex + 1}`);

  return {
    insight_text: `The grid shows meaningful variation in ${metricLabel.toLowerCase()} across ${dimensionLabel.toLowerCase()} segments, spanning roughly ${min} to ${max}.`,
    question_answered: `How does ${metricLabel.toLowerCase()} vary across ${dimensionLabel.toLowerCase()} segments?`,
    confidence: 0.52,
    reasoning: "Fallback synthesis from numeric range in the largest metric column.",
  };
}

function fallbackExplicitInsight(context: GridContext): ExplicitInsightResult {
  const candidate = context.captions[0] ?? context.nearby_paragraphs[0] ?? "";
  const cleaned = compact(candidate);

  if (cleaned.length >= 24) {
    return {
      found_explicit_insight: true,
      insight_text: cleaned,
      supporting_snippets: [truncate(cleaned, 240)],
      confidence: 0.5,
      reasoning: "Fallback selected the nearest caption/paragraph as explicit insight text.",
    };
  }

  return {
    found_explicit_insight: false,
    supporting_snippets: [],
    confidence: 0.4,
    reasoning: "Fallback could not find strong nearby explicit insight text.",
  };
}

function dedupeMetadata(entries: InsightMetadataEntry[]): InsightMetadataEntry[] {
  const byKey = new Map<string, InsightMetadataEntry>();
  for (const entry of entries) {
    const rawTag = compact(entry.tag ?? "");
    const normalizedTag = normalizeDimensionName(rawTag);
    const tag = normalizedTag || rawTag.toLowerCase().replace(/\s+/g, "_");
    const value = compact(entry.value);
    if (!tag || !value) continue;
    if (isResultantMetadataField(tag)) continue;

    const key = `${tag}::${value.toLowerCase()}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      tag,
      value,
      ...(typeof entry.confidence === "number" ? { confidence: clampConfidence(entry.confidence) } : {}),
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

function toInsightTagEntry(tag: string, value: string): InsightTagEntry | null {
  const normalizedTag = normalizeTagKey(tag);
  const normalizedValue = compact(value);
  if (!normalizedTag || !normalizedValue) return null;
  return { [normalizedTag]: normalizedValue };
}

function dedupeInsightTags(entries: InsightTagEntry[]): InsightTagEntry[] {
  const byTag = new Map<string, InsightTagEntry>();

  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    for (const [rawTag, rawValue] of Object.entries(entry)) {
      const normalized = toInsightTagEntry(rawTag, String(rawValue ?? ""));
      if (!normalized) continue;
      const tag = Object.keys(normalized)[0];
      byTag.set(tag, normalized);
    }
  }

  return Array.from(byTag.values());
}

function isNonInformativeMetadataValue(value: string): boolean {
  const normalized = compact(value).toLowerCase();
  if (!normalized) return true;
  return normalized === "n/a"
    || normalized === "na"
    || normalized === "none"
    || normalized === "null"
    || normalized === "unknown"
    || normalized === "-"
    || normalized === "--";
}

function isDimensionEchoValue(input: {
  value: string;
  dimensionCanonicalName: string;
  dimensionDisplayName?: string;
}): boolean {
  const normalizedValue = normalizeDimensionName(input.value);
  if (!normalizedValue) return false;
  if (normalizedValue === normalizeDimensionName(input.dimensionCanonicalName)) return true;
  if (
    input.dimensionDisplayName
    && normalizedValue === normalizeDimensionName(input.dimensionDisplayName)
  ) {
    return true;
  }
  return false;
}

function shouldEmitDimensionValuesAsMetadata(input: {
  dimensionName: string;
  uniqueValueCount: number;
  rowCount: number;
}): boolean {
  const canonical = normalizeDimensionName(input.dimensionName);
  if (!canonical) return false;
  if (isResultantMetadataField(canonical)) return false;
  if (/(employee_id|store_id|account|sku|identifier|code|id)$/.test(canonical)) return false;
  if (input.uniqueValueCount === 0) return false;
  if (input.uniqueValueCount === 1) return true;
  if (input.uniqueValueCount <= MAX_VALUES_PER_DIMENSION_TAG) return true;

  const cardinalityRatio = input.rowCount > 0
    ? input.uniqueValueCount / input.rowCount
    : 1;
  return input.uniqueValueCount <= 12 && cardinalityRatio <= 0.5;
}

function dimensionValueMetadataEntries(grid: NormalizedGridResult): InsightMetadataEntry[] {
  const entries: InsightMetadataEntry[] = [];
  const rows = grid.insightFamilyData.rows;

  for (const dimension of grid.dimensionMetadata) {
    const values = rows
      .flatMap((row) => row.filter_values)
      .filter((value) => value.dimension_id === dimension.dimension_id)
      .map((value) => value.display_value ?? value.value)
      .map((value) => compact(value));

    const filteredValues = values.filter((value) =>
      !isNonInformativeMetadataValue(value)
      && !isAggregateDimensionValue(value)
      && !isDimensionEchoValue({
        value,
        dimensionCanonicalName: dimension.canonical_name,
        dimensionDisplayName: dimension.display_name,
      })
    );
    const uniqueValues = uniqueStrings(filteredValues);
    if (
      !shouldEmitDimensionValuesAsMetadata({
        dimensionName: dimension.canonical_name,
        uniqueValueCount: uniqueValues.length,
        rowCount: rows.length,
      })
    ) {
      continue;
    }

    const valueCounts = new Map<string, number>();
    for (const value of filteredValues) {
      valueCounts.set(value, (valueCounts.get(value) ?? 0) + 1);
    }
    const rankedValues = Array.from(valueCounts.entries())
      .sort((left, right) => {
        if (right[1] !== left[1]) return right[1] - left[1];
        return left[0].localeCompare(right[0]);
      })
      .map(([value]) => value);

    const maxValues = uniqueValues.length === 1
      ? 1
      : Math.min(MAX_VALUES_PER_DIMENSION_TAG, rankedValues.length);

    for (const [index, value] of rankedValues.slice(0, maxValues).entries()) {
      entries.push({
        tag: dimension.canonical_name,
        value,
        confidence: clampConfidence(uniqueValues.length === 1 ? 0.9 : (0.82 - (index * 0.02))),
      });
    }
  }

  return entries;
}

function gridExtractedMetadata(grid: NormalizedGridResult): InsightMetadataEntry[] {
  return dedupeMetadata(dimensionValueMetadataEntries(grid)).slice(0, MAX_METADATA_ENTRIES);
}

function metadataValuesForTags(
  metadata: InsightMetadataEntry[],
  acceptedTags: Set<string>,
): string[] {
  return metadata
    .filter((entry) => acceptedTags.has(normalizeDimensionName(entry.tag)))
    .map((entry) => compact(entry.value))
    .filter((value) => value.length > 0);
}

function inferDistributionShapeTag(grid: NormalizedGridResult): string | undefined {
  const rows = grid.insightFamilyData.rows ?? [];
  if (rows.length < 3) return undefined;

  const primaryDimension = grid.insightFamilyData.dimensions[0];
  if (!primaryDimension) return undefined;

  const totalsByEntity = new Map<string, number>();
  for (const row of rows) {
    const entity = row.filter_values.find((filter) =>
      normalizeDimensionName(filter.dimension_name) === normalizeDimensionName(primaryDimension)
    );
    if (!entity) continue;

    const metricRaw = row.metric_value;
    const metric = typeof metricRaw === "number"
      ? metricRaw
      : (typeof metricRaw === "string" ? Number(String(toMetricValue(metricRaw)).replace(/,/g, "")) : NaN);
    if (!Number.isFinite(metric)) continue;
    const key = compact(entity.display_value ?? entity.value);
    totalsByEntity.set(key, (totalsByEntity.get(key) ?? 0) + metric);
  }

  const totals = Array.from(totalsByEntity.values()).filter((value) => Number.isFinite(value) && value > 0);
  if (totals.length < 3) return undefined;

  const sorted = totals.slice().sort((left, right) => right - left);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return undefined;

  const topShare = sorted[0] / total;
  const topTwoShare = (sorted[0] + sorted[1]) / total;
  if (topShare >= 0.55) return "dominated by a single entity";
  if (topTwoShare >= 0.7) return "highly concentrated in top 2 entities";
  if (topTwoShare <= 0.45) return "broadly distributed across entities";
  return "moderately concentrated across leading entities";
}

function inferComparisonBasis(grid: NormalizedGridResult): string {
  const metricColumns = uniqueStrings((grid.insightFamilyData.metric_columns ?? []).map((value) => compact(value)));
  if (metricColumns.length === 0) return "comparison of metric values across table dimensions";

  const joined = metricColumns.slice(0, 2).join(", ");
  const lower = joined.toLowerCase();
  if (/%|percent|rate|ratio|share/.test(lower)) {
    return `${joined} as share/rate comparison across dimensions`;
  }
  return `${joined} comparison across dimensions`;
}

function fallbackInsightTags(input: {
  insightText: string;
  grid: NormalizedGridResult;
  sourceMode: "explicit_nearby_text" | "synthesized_from_grid";
  metadata: InsightMetadataEntry[];
}): InsightTagEntry[] {
  const tags: InsightTagEntry[] = [];
  const dimensions = uniqueStrings(
    (input.grid.insightFamilyData.dimensions ?? []).map((value) => normalizeDimensionName(value)),
  );

  const primaryDimension = dimensions[0];
  const secondaryDimension = dimensions[1];
  if (primaryDimension) {
    const entry = toInsightTagEntry("dimension_primary", primaryDimension);
    if (entry) tags.push(entry);
  }
  if (secondaryDimension) {
    const entry = toInsightTagEntry("dimension_secondary", secondaryDimension);
    if (entry) tags.push(entry);
  }

  const comparisonBasis = toInsightTagEntry("comparison_basis", inferComparisonBasis(input.grid));
  if (comparisonBasis) tags.push(comparisonBasis);

  const distributionShape = inferDistributionShapeTag(input.grid);
  if (distributionShape) {
    const entry = toInsightTagEntry("distribution_shape", distributionShape);
    if (entry) tags.push(entry);
  }

  const geographyValues = uniqueStrings(
    metadataValuesForTags(input.metadata, new Set(["region", "location", "geography"])),
  );
  if (geographyValues.length >= 2) {
    const scoped = geographyValues.slice(0, 4).join(", ");
    const entry = toInsightTagEntry("geography_scope", `includes ${scoped}`);
    if (entry) tags.push(entry);
  }

  if (/manual adjust|anomal|control issue|outlier/i.test(input.insightText)) {
    const entry = toInsightTagEntry(
      "risk_signal",
      "potential process anomaly or control issue in specific locations",
    );
    if (entry) tags.push(entry);
  }

  const source = toInsightTagEntry("insight_source_mode", input.sourceMode);
  if (source) tags.push(source);

  return dedupeInsightTags(tags).slice(0, MAX_INSIGHT_TAGS);
}

export const generateInsightsV3DefaultToolset: GenerateInsightsV3Toolset = {
  async understandTable(table: RawTable): Promise<TableSemanticObject> {
    return understandTable(table, "auto");
  },

  async extractImpliedGrid(input): Promise<Awaited<ReturnType<typeof extractImpliedGrids>>> {
    return extractImpliedGrids(input);
  },

  async parseFile(bundle: V3DocumentBundle): Promise<ParsedFileContent> {
    const headings = uniqueStrings(
      bundle.chunks
        .filter((chunk) => isHeadingLike(chunk) || Boolean(chunk.section_title))
        .flatMap((chunk) => [chunk.section_title ?? "", chunk.text])
        .map((value) => compact(value))
        .filter((value) => value.length > 0),
    ).slice(0, 24);

    const figureCaptions = uniqueStrings(
      bundle.chunks
        .map((chunk) => compact(chunk.text))
        .filter((text) => text.length > 0 && isCaptionLike(text)),
    ).slice(0, 48);

    const explicitRawTables = bundle.tables.map(rawTableFromV2Table);
    const impliedGridResults = await Promise.all(
      bundle.chunks.map((chunk) =>
        extractImpliedGrids({
          document_id: chunk.document_id,
          chunk_id: chunk.chunk_id,
          text: chunk.text,
          page: chunk.page,
          context: chunk.section_title,
        })
      ),
    );
    const rawTables = [
      ...explicitRawTables,
      ...impliedGridResults.flatMap((result) => result.grids),
    ];
    const tableSemanticObjects = await batchUnderstandTables(rawTables, "auto");

    return {
      document: bundle.descriptor,
      extracted: bundle.extracted,
      text_blocks: bundle.chunks,
      tables: bundle.tables,
      raw_tables: rawTables,
      implied_grid_results: impliedGridResults,
      table_semantic_objects: tableSemanticObjects,
      figure_captions: figureCaptions,
      headings,
    };
  },

  async findCandidateGrids(parsed: ParsedFileContent): Promise<CandidateGrid[]> {
    const actualDiscovered: CandidateGrid[] = [];
    const seenSignatures = new Set<string>();
    const semantics = semanticByTableId(parsed.table_semantic_objects);
    const rawTables = new Map(parsed.raw_tables.map((table) => [table.table_id, table]));

    for (const table of parsed.tables) {
      if ((table.rows?.length ?? 0) === 0) continue;
      const signature = tableSignature(table);
      if (seenSignatures.has(signature)) continue;
      seenSignatures.add(signature);

      actualDiscovered.push({
        grid_id: hashId(`${table.table_id}:grid`),
        document_id: table.document_id,
        source_uri: table.source_uri,
        table,
        raw_table: rawTables.get(table.table_id),
        table_semantic_object: semantics.get(table.table_id),
        source_mode: "table_element",
        confidence: scoreCandidateGrid(table, "table_element"),
        rationale: "Structured table element from normalized extraction.",
      });
    }

    for (const rawTable of parsed.raw_tables.filter((table) => table.extraction_source === "implied_grid")) {
      const table = v2TableFromRawTable(rawTable, parsed.document.source_uri);
      if ((table.rows?.length ?? 0) === 0) continue;
      const signature = tableSignature(table);
      if (seenSignatures.has(signature)) continue;
      seenSignatures.add(signature);

      actualDiscovered.push({
        grid_id: hashId(`${table.table_id}:grid`),
        document_id: table.document_id,
        source_uri: table.source_uri,
        table,
        raw_table: rawTable,
        table_semantic_object: semantics.get(table.table_id),
        source_mode: "narrative_implied",
        confidence: scoreCandidateGrid(table, "narrative_implied"),
        rationale: "Implied grid extracted from narrative text by table-understanding tool.",
      });
    }

    for (const chunk of parsed.text_blocks) {
      const table = buildTextDerivedTable(chunk);
      if (!table) continue;
      const signature = tableSignature(table);
      if (seenSignatures.has(signature)) continue;
      seenSignatures.add(signature);

      actualDiscovered.push({
        grid_id: hashId(`${table.table_id}:grid`),
        document_id: table.document_id,
        source_uri: table.source_uri,
        table,
        source_mode: "text_block",
        confidence: scoreCandidateGrid(table, "text_block"),
        rationale: "Detected repeated delimited row/column structure in text block.",
      });
    }

    const actual = actualDiscovered
      .filter((grid) => grid.table.rows.length > 0)
      .sort((left, right) => right.confidence - left.confidence);

    const narrative = await extractNarrativeImpliedGrids(parsed);
    const acceptedNarrative: CandidateGrid[] = [];

    for (const candidate of narrative) {
      if (candidate.table.rows.length === 0) continue;

      const signature = tableSignature(candidate.table);
      if (seenSignatures.has(signature)) continue;

      const duplicatesActual = actual.some((grid) =>
        isNarrativeGridDuplicateOfActual(candidate.table, grid.table),
      );
      if (duplicatesActual) continue;

      const duplicatesNarrative = acceptedNarrative.some((grid) =>
        isNarrativeGridDuplicateOfActual(candidate.table, grid.table),
      );
      if (duplicatesNarrative) continue;

      seenSignatures.add(signature);
      acceptedNarrative.push(candidate);
    }

    return [...actual, ...acceptedNarrative]
      .filter((grid) => grid.table.rows.length > 0)
      .sort((left, right) => right.confidence - left.confidence);
  },

  async inspectGridContext(grid: CandidateGrid, parsed: ParsedFileContent): Promise<GridContext> {
    const sourceTable = grid.table;
    const chunks = parsed.text_blocks;

    const nearby = chunks
      .filter((chunk) => {
        if (chunk.document_id !== sourceTable.document_id) return false;
        if (typeof sourceTable.page === "number" && typeof chunk.page === "number") {
          return Math.abs(chunk.page - sourceTable.page) <= 1;
        }
        if (sourceTable.section_title && chunk.section_title) {
          return compact(sourceTable.section_title).toLowerCase() === compact(chunk.section_title).toLowerCase();
        }
        return false;
      })
      .slice(0, 12);

    const fallbackNearby = nearby.length > 0 ? nearby : chunks.slice(0, 8);

    const headings = uniqueStrings([
      sourceTable.section_title ?? "",
      ...fallbackNearby
        .filter((chunk) => isHeadingLike(chunk) || Boolean(chunk.section_title))
        .flatMap((chunk) => [chunk.section_title ?? "", chunk.text])
        .map((value) => compact(value)),
      ...parsed.headings,
    ]).slice(0, 8);

    const captions = uniqueStrings([
      ...parsed.figure_captions,
      ...fallbackNearby
        .map((chunk) => compact(chunk.text))
        .filter((text) => isCaptionLike(text)),
    ]).slice(0, 8);

    const nearbyParagraphs = uniqueStrings(
      fallbackNearby
        .map((chunk) => compact(chunk.text))
        .filter((text) => text.length > 0),
    ).slice(0, 10);

    const supportingRefs: SupportingRef[] = [
      buildTableSupportingRef(sourceTable),
      ...fallbackNearby.map((chunk) => buildChunkSupportingRef(chunk)),
    ];

    const combined = [
      ...headings.map((heading) => `Heading: ${heading}`),
      ...captions.map((caption) => `Caption: ${caption}`),
      ...nearbyParagraphs.map((paragraph) => `Paragraph: ${truncate(paragraph, 420)}`),
    ].join("\n");

    return {
      grid_id: grid.grid_id,
      page: sourceTable.page,
      section_title: sourceTable.section_title,
      headings,
      captions,
      nearby_paragraphs: nearbyParagraphs,
      supporting_refs: supportingRefs,
      combined_context_text: combined,
    };
  },

  async extractExplicitInsight(
    grid: CandidateGrid,
    context: GridContext,
  ): Promise<ExplicitInsightResult> {
    try {
      const payload = [
        "Determine whether nearby text explicitly states the insight represented by this grid.",
        "Prefer concise adaptation of nearby language.",
        JSON.stringify(
          {
            grid: {
              grid_id: grid.grid_id,
              table_id: grid.table.table_id,
              headers: grid.table.headers,
              table_preview_markdown: summarizeTableForPrompt(grid.table),
              table_semantic_object: grid.table_semantic_object,
            },
            context: {
              headings: context.headings,
              captions: context.captions,
              nearby_paragraphs: context.nearby_paragraphs,
              section_title: context.section_title,
            },
          },
          null,
          2,
        ),
      ].join("\n\n");

      const response = await runJsonCompletion<{
        found_explicit_insight: boolean;
        insight_text: string | null;
        supporting_snippets: string[];
        confidence: number;
        reasoning: string;
      }>({
        systemPrompt: V3_EXPLICIT_INSIGHT_PROMPT,
        userPayload: payload,
        schemaName: "v3_explicit_insight",
        schema: V3_EXPLICIT_INSIGHT_SCHEMA,
        temperature: 0,
      });

      const insightText = compact(response.insight_text ?? "");
      const found = response.found_explicit_insight && insightText.length > 0;

      return {
        found_explicit_insight: found,
        ...(found ? { insight_text: insightText } : {}),
        supporting_snippets: uniqueStrings((response.supporting_snippets ?? []).map((value) => truncate(compact(value), 260))).slice(0, 5),
        confidence: clampConfidence(response.confidence ?? (found ? 0.8 : 0.35)),
        reasoning: compact(response.reasoning ?? ""),
      };
    } catch (error) {
      console.warn("[agent] explicit insight extraction fallback", {
        grid_id: grid.grid_id,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      return fallbackExplicitInsight(context);
    }
  },

  async synthesizeInsightFromGrid(
    grid: CandidateGrid,
    context: GridContext,
  ): Promise<SynthesizedInsightResult> {
    try {
      const payload = [
        "Synthesize one grounded generalized insight for this grid.",
        JSON.stringify(
          {
            grid: {
              grid_id: grid.grid_id,
              table_id: grid.table.table_id,
              headers: grid.table.headers,
              table_preview_markdown: summarizeTableForPrompt(grid.table),
              row_count: grid.table.rows.length,
              table_semantic_object: grid.table_semantic_object,
            },
            context: {
              headings: context.headings,
              captions: context.captions,
              nearby_paragraphs: context.nearby_paragraphs,
              section_title: context.section_title,
            },
          },
          null,
          2,
        ),
      ].join("\n\n");

      const response = await runJsonCompletion<{
        insight_text: string;
        question_answered: string | null;
        confidence: number;
        reasoning: string;
      }>({
        systemPrompt: V3_SYNTHESIZE_INSIGHT_PROMPT,
        userPayload: payload,
        schemaName: "v3_synthesized_insight",
        schema: V3_SYNTHESIZE_INSIGHT_SCHEMA,
        temperature: 0.1,
      });

      return {
        insight_text: compact(response.insight_text),
        ...(response.question_answered ? { question_answered: compact(response.question_answered) } : {}),
        confidence: clampConfidence(response.confidence ?? 0.65),
        reasoning: compact(response.reasoning ?? ""),
      };
    } catch (error) {
      console.warn("[agent] synthesized insight fallback", {
        grid_id: grid.grid_id,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      return fallbackSynthesizedInsight(grid.table);
    }
  },

  async normalizeGrid(grid: CandidateGrid, familyId: string): Promise<NormalizedGridDraft> {
    const table = grid.table;
    const insightFamilyDataTableId = buildRunScopedInsightFamilyDataTableId({
      familyId,
      sourceTableId: table.table_id,
      sourceMode: grid.source_mode,
    });

    const maxColumns = Math.max(
      table.headers.length,
      ...table.rows.map((row) => row.cells.length),
      1,
    );

    const headers = Array.from({ length: maxColumns }, (_value, index) => {
      const raw = compact(table.headers[index] ?? "");
      return raw || `column_${index + 1}`;
    });

    const columnStats = headers.map((_header, columnIndex) => {
      const values = table.rows
        .map((row) => compact(row.cells[columnIndex] ?? ""))
        .filter((value) => value.length > 0);
      const numericCount = values.filter((value) => isNumericLike(value)).length;
      return {
        index: columnIndex,
        values,
        numericCount,
        numericRatio: values.length > 0 ? numericCount / values.length : 0,
      };
    });

    const semanticRoles = grid.table_semantic_object?.column_roles ?? [];
    const semanticMetricNames = new Set(
      semanticRoles
        .filter((role) => role.role === "metric")
        .map((role) => compact(role.column_name).toLowerCase()),
    );
    const semanticDimensionNames = new Set(
      semanticRoles
        .filter((role) => role.role === "entity" || role.role === "dimension" || role.role === "time")
        .map((role) => compact(role.column_name).toLowerCase()),
    );

    let metricColumnIndexes = semanticMetricNames.size > 0
      ? headers
          .map((header, index) => ({ header, index }))
          .filter(({ header }) => semanticMetricNames.has(compact(header).toLowerCase()))
          .map(({ index }) => index)
      : [];

    const metricLikeHeaderIndexes = columnStats
      .filter((stats) => {
        const header = headers[stats.index] ?? "";
        if (isLikelyIdentifierHeader(header)) return false;
        if (!isLikelyMetricHeader(header)) return false;
        return stats.numericRatio >= 0.4
          || stats.values.some((value) => /\d/.test(value) || Boolean(inferMetricUnit({ header, value })));
      })
      .map((stats) => stats.index);
    metricColumnIndexes = [...metricColumnIndexes, ...metricLikeHeaderIndexes];

    if (metricColumnIndexes.length === 0) {
      metricColumnIndexes = columnStats
      .filter((stats) => stats.values.length > 0 && stats.numericRatio >= 0.6)
      .filter((stats) => !isLikelyDimensionHeader(headers[stats.index] ?? ""))
      .map((stats) => stats.index);
    }

    if (metricColumnIndexes.length === 0) {
      const fallback = columnStats
        .slice()
        .sort((left, right) => right.numericCount - left.numericCount)
        .find((stats) => !isLikelyDimensionHeader(headers[stats.index] ?? ""));
      metricColumnIndexes = [fallback?.index ?? maxColumns - 1];
    }

    metricColumnIndexes = uniqueStrings(metricColumnIndexes.map((index) => String(index))).map((value) => Number(value));

    const metricColumnSet = new Set(metricColumnIndexes);
    let dimensionColumnIndexes = semanticDimensionNames.size > 0
      ? headers
          .map((header, index) => ({ header, index }))
          .filter(({ header, index }) =>
            semanticDimensionNames.has(compact(header).toLowerCase()) && !metricColumnSet.has(index)
          )
          .map(({ index }) => index)
      : columnStats
          .map((stats) => stats.index)
          .filter((index) => !metricColumnSet.has(index));

    if (dimensionColumnIndexes.length === 0) {
      dimensionColumnIndexes = [];
    }

    const dimensions = dimensionColumnIndexes.length > 0
      ? dimensionColumnIndexes.map((index) => headers[index])
      : ["measure"];

    const metricColumns = metricColumnIndexes.map((index) => headers[index]);
    const rows: GridRowDraft[] = [];

    for (const row of table.rows) {
      for (const metricColumnIndex of metricColumnIndexes) {
        const metricName = headers[metricColumnIndex];
        const metricRaw = compact(row.cells[metricColumnIndex] ?? "");
        if (!metricRaw) continue;

        const aggregateContext = dimensionColumnIndexes
          .map((dimensionIndex) => compact(row.cells[dimensionIndex] ?? ""))
          .some(isAggregateDimensionValue);
        if (aggregateContext) continue;

        const filterValues = dimensionColumnIndexes.length > 0
          ? dimensionColumnIndexes.map((dimensionIndex) => {
              const value = compact(row.cells[dimensionIndex] ?? "");
              return {
                dimension_name: headers[dimensionIndex],
                value,
                display_value: value,
              };
            })
          : [
              {
                dimension_name: "measure",
                value: metricName,
                display_value: metricName,
              },
            ];

        if (dimensionColumnIndexes.length > 0 && filterValues.some((value) => !value.value)) {
          continue;
        }

        const metricValue = toMetricValue(metricRaw);
        const semanticFact = grid.table_semantic_object?.candidate_facts.find((fact) =>
          fact.row_index === row.row_index && compact(fact.metric).toLowerCase() === compact(metricName).toLowerCase()
        );

        rows.push({
          row_id: hashId(`${familyId}:${table.table_id}:${row.row_index}:${metricName}`),
          filter_values: filterValues,
          metric_name: metricName,
          metric_value: metricValue,
          metric_unit: inferMetricUnit({ header: metricName, value: metricRaw }),
          value_text: headers
            .map((header, index) => `${header}: ${compact(row.cells[index] ?? "")}`)
            .join(" | "),
          supporting_refs: [
            {
              ...buildTableSupportingRef(table, row.row_index),
              chunk_id: grid.raw_table?.source_chunk_id ?? grid.table_semantic_object?.source_chunk_id,
              evidence_cells: semanticFact?.evidence_cells,
              row_indices: [row.row_index],
              cell_refs: semanticFact?.evidence_cells.map((cell) => `R${cell.row + 1}C${cell.col + 1}`),
            },
          ],
        });
      }
    }

    return {
      table_id: insightFamilyDataTableId,
      family_id: familyId,
      dimensions,
      metric_columns: metricColumns,
      row_count: rows.length,
      rows,
      raw_table: grid.raw_table,
      table_semantic_object: grid.table_semantic_object,
      table_understanding_summary: buildTableUnderstandingSummary(grid.table_semantic_object),
      source_modalities:
        grid.source_mode === "table_element"
          ? ["table"]
          : grid.source_mode === "text_block"
            ? ["text", "table"]
            : ["text"],
      table_markdown: markdownForTable(table),
      table_text_chunk: textChunkForTable(table),
    };
  },

  async normalizeDimensionMetadata(draft: NormalizedGridDraft): Promise<NormalizedGridResult> {
    const registry = createDimensionMetadataRegistry();

    for (const dimensionName of draft.dimensions) {
      getOrCreateDimensionMetadata(registry, { dimensionName });
    }

    const rows = draft.rows.map((row) => ({
      ...row,
      family_id: draft.family_id,
      filter_values: row.filter_values.map((filterValue) => {
        const dimensionMetadata = getOrCreateDimensionMetadata(registry, {
          dimensionName: filterValue.dimension_name,
        });
        const valueMetadata = getOrCreateDimensionValueMetadata(registry, {
          dimensionName: dimensionMetadata.canonical_name,
          dimensionId: dimensionMetadata.dimension_id,
          rawValue: filterValue.value,
        });

        return {
          dimension_id: dimensionMetadata.dimension_id,
          dimension_name: filterValue.dimension_name,
          value_id: valueMetadata.value.value_id,
          value: valueMetadata.value.canonical_value,
          ...(filterValue.display_value || valueMetadata.value.display_value
            ? { display_value: filterValue.display_value ?? valueMetadata.value.display_value }
            : {}),
        };
      }),
    }));

    const metadata = listDimensionMetadata(registry);
    const now = new Date().toISOString();

    const insightFamilyData = {
      table_id: draft.table_id,
      family_id: draft.family_id,
      question_answered: draft.question_answered,
      dimensions: draft.dimensions,
      metric_columns: draft.metric_columns,
      row_count: rows.length,
      rows,
      table_markdown: draft.table_markdown,
      table_text_chunk: draft.table_text_chunk,
      raw_table: draft.raw_table,
      table_semantic_object: draft.table_semantic_object,
      table_understanding_summary: draft.table_understanding_summary,
      source_modalities: draft.source_modalities ?? ["table"],
      created_at: now,
      updated_at: now,
    };

    return {
      insightFamilyData,
      dimensionMetadata: metadata,
    };
  },

  async buildInsightMetadata(input): Promise<InsightMetadataEntry[]> {
    return gridExtractedMetadata(input.grid);
  },

  async buildInsightTags(input): Promise<InsightTagEntry[]> {
    const base = fallbackInsightTags({
      insightText: input.insightText,
      grid: input.grid,
      sourceMode: input.sourceMode,
      metadata: input.metadata,
    });

    if (!hasUsableOpenAiKey()) return base;

    try {
      const metadataByTag = Array.from(
        (input.metadata ?? []).reduce((accumulator, entry) => {
          const tag = normalizeDimensionName(entry.tag);
          const value = compact(entry.value);
          if (!tag || !value) return accumulator;

          const current = accumulator.get(tag) ?? [];
          current.push(value);
          accumulator.set(tag, uniqueStrings(current));
          return accumulator;
        }, new Map<string, string[]>()),
      ).map(([tag, values]) => ({ tag, values }));

      const payload = [
        "Generate synthesized insight tags that are distinct from raw grid metadata.",
        JSON.stringify(
          {
            insight_text: input.insightText,
            source_mode: input.sourceMode,
            section_title: input.context.section_title,
            headings: input.context.headings,
            dimensions: input.grid.insightFamilyData.dimensions,
            metric_columns: input.grid.insightFamilyData.metric_columns,
            row_count: input.grid.insightFamilyData.row_count,
            metadata_by_tag: metadataByTag,
            seeded_tags: base,
          },
          null,
          2,
        ),
      ].join("\n\n");

      const response = await runJsonCompletion<{
        tags: Array<{ tag: string; value: string; confidence: number | null }>;
      }>({
        systemPrompt: V3_TAGS_PROMPT,
        userPayload: payload,
        schemaName: "v3_insight_tags",
        schema: V3_TAGS_SCHEMA,
        temperature: 0,
      });

      const merged = dedupeInsightTags([
        ...base,
        ...(response.tags ?? [])
          .map((entry) => toInsightTagEntry(entry.tag, entry.value))
          .filter((entry): entry is InsightTagEntry => Boolean(entry)),
      ]);

      return merged.slice(0, MAX_INSIGHT_TAGS);
    } catch (error) {
      console.warn("[agent] tags fallback", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
      return base;
    }
  },

  async validateInsight(insight: GenerateInsightsV3Insight) {
    return validateInsightObject(insight);
  },

  async decideNextAction(state: GenerateInsightsV3AgentState): Promise<AgentAction> {
    const fallback = deterministicPlanner(state);

    try {
      const activeGrid = state.activeGridId
        ? state.gridWorkById.get(state.activeGridId)
        : undefined;

      const summary = {
        document_id: state.document.document_id,
        parsed: Boolean(state.parsedContent),
        candidate_grid_discovery_done: state.candidateGridDiscoveryDone,
        candidate_grid_count: state.candidateGrids.length,
        pending_grid_ids: state.pendingGridIds,
        processed_grid_ids: state.processedGridIds,
        active_grid_id: state.activeGridId,
        active_grid_progress: activeGrid
          ? {
              has_context: Boolean(activeGrid.context),
              has_explicit_insight_check: Boolean(activeGrid.explicitInsight),
              explicit_insight_found: activeGrid.explicitInsight?.found_explicit_insight ?? false,
              has_synthesized_insight: Boolean(activeGrid.synthesizedInsight),
              has_normalized_grid_draft: Boolean(activeGrid.normalizedGridDraft),
              has_normalized_grid: Boolean(activeGrid.normalizedGrid),
              has_metadata: Boolean(activeGrid.metadata),
              has_tags: Boolean(activeGrid.tags),
              has_validation: Boolean(activeGrid.validationErrors || activeGrid.validationWarnings),
            }
          : null,
      };

      const response = await runJsonCompletion<{ action: AgentAction["action"]; reason: string }>({
        systemPrompt: V3_AGENT_PLANNER_PROMPT,
        userPayload: JSON.stringify(summary, null, 2),
        schemaName: "v3_agent_action",
        schema: V3_AGENT_PLANNER_SCHEMA,
        temperature: 0,
      });

      const candidate: AgentAction = {
        action: response.action,
        reason: compact(response.reason ?? ""),
      };

      if (!isActionAllowed(state, candidate.action)) {
        return fallback;
      }

      if (candidate.action === "complete_grid") {
        return {
          action: candidate.action,
          reason: fallback.reason,
        };
      }

      return candidate;
    } catch (error) {
      console.warn("[agent] planner fallback", {
        document_id: state.document.document_id,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      return fallback;
    }
  },
};

export function mergeToolsetOverrides(
  overrides?: Partial<GenerateInsightsV3Toolset>,
): GenerateInsightsV3Toolset {
  if (!overrides) return generateInsightsV3DefaultToolset;
  return {
    ...generateInsightsV3DefaultToolset,
    ...overrides,
  };
}
