import { hashId } from "../common/services/utils";
import { openai, OPENAI_HELPER_MODEL } from "../common/services/openai";

export type RawTableExtractionSource =
  | "explicit_table"
  | "implied_grid"
  | "csv"
  | "excel"
  | "pdf_table"
  | "llm_text_grid";

export type TableUnderstandingProvider = "auto" | "heuristic" | "llm";
export type SemanticProvider = "heuristic" | "llm";
export type ColumnRoleName = "entity" | "dimension" | "metric" | "time" | "measure" | "unknown";

export type RawTable = {
  table_id: string;
  document_id: string;
  source_chunk_id: string;
  page?: number;
  caption?: string;
  headers: string[];
  rows: string[][];
  extraction_source: RawTableExtractionSource;
};

export type TableColumnRole = {
  column_name: string;
  role: ColumnRoleName;
  semantic_type?: string;
  unit?: string;
  confidence: number;
  rationale?: string;
};

export type EvidenceCell = { row: number; col: number };

export type CandidateFact = {
  fact_id: string;
  row_index: number;
  metric: string;
  value: string | number;
  unit?: string;
  dimensions: Record<string, string>;
  evidence_cells: EvidenceCell[];
  confidence: number;
};

export type TableSemanticObject = {
  table_id: string;
  document_id: string;
  source_chunk_id: string;
  caption?: string;
  headers: string[];
  rows: string[][];
  subject_column?: string;
  column_roles: TableColumnRole[];
  candidate_facts: CandidateFact[];
  table_summary?: string;
  provider: SemanticProvider;
  confidence: number;
};

export type ImpliedGridResult = {
  source_chunk_id: string;
  grids: RawTable[];
  confidence: number;
};

export type ImpliedGridInput = {
  document_id: string;
  chunk_id: string;
  text: string;
  page?: number;
  context?: string;
};

const warned = new Set<string>();

function warnOnce(key: string, message: string, payload?: Record<string, unknown>): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message, payload ?? {});
}

function compact(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clamp(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(3));
}

function isNumericLike(value: string): boolean {
  return /^[+-]?\$?\d[\d,]*(?:\.\d+)?%?$/.test(compact(value).replace(/\s+/g, ""));
}

function metricUnit(header: string, value: string): string | undefined {
  const lower = `${header} ${value}`.toLowerCase();
  if (lower.includes("%") || lower.includes("percent") || lower.includes("rate")) return "%";
  if (lower.includes("$") || lower.includes("usd") || lower.includes("dollar") || lower.includes("revenue")) return "usd";
  if (lower.includes("count") || lower.includes("users") || lower.includes("orders")) return "count";
  return undefined;
}

function parseMetricValue(value: string): string | number {
  const raw = compact(value);
  if (raw.includes("%") || raw.startsWith("+")) return raw;
  const cleaned = raw.replace(/[$,]/g, "").replace(/%$/, "");
  if (/^[+-]?\d+(?:\.\d+)?$/.test(cleaned)) {
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) return parsed;
  }
  return raw;
}

function semanticType(header: string, role: ColumnRoleName): string | undefined {
  const lower = header.toLowerCase();
  if (role === "time") return "temporal";
  if (lower.includes("age")) return "demographic";
  if (lower.includes("channel")) return "marketing_channel";
  if (/region|country|city|market/.test(lower)) return "geography";
  if (role === "metric" || role === "measure") return "numeric_measure";
  return "categorical";
}

function isIdentifierHeader(header: string): boolean {
  return /\b(id|identifier|code|sku|store|account|member|zip|postal|number|no)\b/i.test(
    compact(header).replace(/[_-]+/g, " "),
  );
}

export function localUnderstandTable(table: RawTable): TableSemanticObject {
  const maxColumns = Math.max(table.headers.length, ...table.rows.map((row) => row.length), 0);
  const headers = Array.from({ length: maxColumns }, (_value, index) => compact(table.headers[index] ?? "") || `column_${index + 1}`);
  const rows = table.rows.map((row) => Array.from({ length: maxColumns }, (_value, index) => compact(row[index] ?? "")));
  const metricHeader = /(rate|conversion|delta|change|growth|revenue|sales|cost|price|count|volume|total|avg|average|mean|median|score|percent|%|amount|measure|metric)/i;
  const timeHeader = /(date|day|week|month|quarter|year|period|time)/i;
  const dateValue = /(^\d{4}[-/]\d{1,2}[-/]\d{1,2}$)|(^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$)|\b(q[1-4]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|20\d{2})\b/i;

  const metricCols: number[] = [];
  const contextCols: number[] = [];
  const column_roles = headers.map((header, col): TableColumnRole => {
    const values = rows.map((row) => row[col]).filter(Boolean);
    const numericDensity = values.filter(isNumericLike).length / Math.max(1, values.length);
    const dateDensity = values.filter((value) => dateValue.test(value)).length / Math.max(1, values.length);
    const uniqueRatio = new Set(values.map((value) => value.toLowerCase())).size / Math.max(1, values.length);
    const metricSignal = numericDensity + (metricHeader.test(header) ? 0.35 : 0);
    let role: ColumnRoleName = "unknown";
    if (isIdentifierHeader(header)) role = "entity";
    else if (timeHeader.test(header) || dateDensity >= 0.5) role = "time";
    else if (metricSignal >= 0.7 && !isIdentifierHeader(header)) role = "metric";
    else if (numericDensity < 0.45) role = uniqueRatio >= 0.75 ? "entity" : "dimension";
    else role = "measure";
    if (role === "metric" || role === "measure") metricCols.push(col);
    if (role === "entity" || role === "dimension" || role === "time") contextCols.push(col);
    return {
      column_name: header,
      role,
      semantic_type: semanticType(header, role),
      unit: role === "metric" || role === "measure" ? metricUnit(header, values.join(" ")) : undefined,
      confidence: clamp(0.58 + Math.max(numericDensity, dateDensity) * 0.24),
      rationale: `numeric_density=${numericDensity.toFixed(2)}; unique_ratio=${uniqueRatio.toFixed(2)}`,
    };
  });

  const subject = contextCols.find((col) => {
    const values = rows.map((row) => row[col]).filter(Boolean);
    return new Set(values.map((value) => value.toLowerCase())).size / Math.max(1, values.length) >= 0.7;
  }) ?? contextCols[0];

  const candidate_facts: CandidateFact[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    const dimensions = Object.fromEntries(contextCols.filter((col) => row[col]).map((col) => [headers[col], row[col]]));
    for (const col of metricCols) {
      if (!row[col]) continue;
      candidate_facts.push({
        fact_id: hashId(`${table.table_id}:${rowIndex}:${headers[col]}:${row[col]}`),
        row_index: rowIndex,
        metric: headers[col],
        value: parseMetricValue(row[col]),
        unit: metricUnit(headers[col], row[col]),
        dimensions,
        evidence_cells: [{ row: rowIndex, col }, ...contextCols.filter((contextCol) => row[contextCol]).map((contextCol) => ({ row: rowIndex, col: contextCol }))],
        confidence: 0.78,
      });
    }
  }

  return {
    table_id: table.table_id,
    document_id: table.document_id,
    source_chunk_id: table.source_chunk_id,
    caption: table.caption,
    headers,
    rows,
    subject_column: subject === undefined ? undefined : headers[subject],
    column_roles,
    candidate_facts,
    table_summary: `Local heuristic table understanding produced ${candidate_facts.length} candidate facts.`,
    provider: "heuristic",
    confidence: clamp(0.45 + Math.min(candidate_facts.length, 12) * 0.025),
  };
}

export function localExtractImpliedGrids(input: ImpliedGridInput): ImpliedGridResult {
  const text = compact(input.text);
  const channelRe = /\b(Instagram|TikTok|Email|Facebook|YouTube|LinkedIn|Search|Paid Search|Organic|Display|SMS|Web|App|Retail|Amazon)\b/gi;
  const valueRe = /(?:(rose|increased|grew|declined|decreased|fell|dropped|up|down)\s*)?([+-]?\$?\d[\d,]*(?:\.\d+)?\s*(?:%|percent|k|m|b)?)/gi;
  const ageRe = /(?:among|for)?\s*(?:users|adults|people)?\s*(\d{1,2}\s*[\-–]\s*\d{1,2}|\d{1,2}\+|over\s+\d{1,2}|under\s+\d{1,2})/i;
  const metricRe = /\b(conversions?|conversion rate|revenue|sales|orders|users|sessions|clicks?|spend|cost|margin)\b/i;
  const rows: string[][] = [];
  let match = valueRe.exec(text);
  while (match) {
    const value = compact(match[2] ?? "");
    const verb = compact(match[1] ?? "").toLowerCase();
    if (!verb && !/[%$kmb]$/i.test(value)) {
      match = valueRe.exec(text);
      continue;
    }
    const start = Math.max(0, match.index - 90);
    const end = Math.min(text.length, match.index + 120);
    const nearby = text.slice(start, end);
    const before = text.slice(start, match.index);
    const beforeChannels = Array.from(before.matchAll(channelRe));
    const channels = beforeChannels.length > 0 ? beforeChannels : Array.from(nearby.matchAll(channelRe));
    if (channels.length > 0) {
      const dir = /^-/.test(value) || /declined|decreased|fell|dropped|down/.test(verb) ? "down" : /rose|increased|grew|up|^\+/.test(`${verb} ${value}`) ? "up" : "reported";
      const signed = value.startsWith("+") || value.startsWith("-") ? value : dir === "up" ? `+${value}` : dir === "down" ? `-${value}` : value;
      rows.push([
        compact(channels[channels.length - 1][0]),
        compact(ageRe.exec(nearby)?.[1] ?? "").replace(/over\s+/i, ">").replace(/\s+/g, ""),
        compact(metricRe.exec(nearby)?.[1] ?? metricRe.exec(text)?.[1] ?? "Metric"),
        signed.replace(/ percent$/i, "%"),
        dir,
      ]);
    }
    match = valueRe.exec(text);
  }
  const deduped = rows.filter((row, index) => rows.findIndex((candidate) => candidate.join("|").toLowerCase() === row.join("|").toLowerCase()) === index);
  const grids = deduped.length > 0 ? [{
    table_id: hashId(`${input.document_id}:${input.chunk_id}:${deduped[0].join("|")}`),
    document_id: input.document_id,
    source_chunk_id: input.chunk_id,
    page: input.page,
    caption: "Implied grid extracted from prose.",
    headers: ["Channel", "Age Group", "Metric", "Value", "Direction"],
    rows: deduped,
    extraction_source: "implied_grid" as const,
  }] : [];
  return { source_chunk_id: input.chunk_id, grids, confidence: grids.length ? clamp(0.45 + deduped.length * 0.12) : 0 };
}

async function tryLlmUnderstandTable(table: RawTable): Promise<TableSemanticObject | undefined> {
  if (!process.env.OPENAI_API_KEY?.trim()) return undefined;

  const response = await openai.chat.completions.create({
    model: OPENAI_HELPER_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Infer table semantics. Return only JSON matching the schema. Keep rows and headers unchanged. Candidate facts must cite evidence cells.",
      },
      { role: "user", content: JSON.stringify(table) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "table_semantic_object",
        strict: false,
        schema: {
          type: "object",
          properties: {
            table_id: { type: "string" },
            document_id: { type: "string" },
            source_chunk_id: { type: "string" },
            caption: { type: ["string", "null"] },
            headers: { type: "array", items: { type: "string" } },
            rows: { type: "array", items: { type: "array", items: { type: "string" } } },
            subject_column: { type: ["string", "null"] },
            column_roles: { type: "array", items: { type: "object", additionalProperties: true } },
            candidate_facts: { type: "array", items: { type: "object", additionalProperties: true } },
            table_summary: { type: ["string", "null"] },
            confidence: { type: "number" },
          },
          required: ["table_id", "document_id", "source_chunk_id", "headers", "rows", "column_roles", "candidate_facts", "confidence"],
          additionalProperties: true,
        },
      },
    },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return undefined;
  const parsed = JSON.parse(content) as TableSemanticObject;
  return {
    ...parsed,
    table_id: table.table_id,
    document_id: table.document_id,
    source_chunk_id: table.source_chunk_id,
    headers: table.headers,
    rows: table.rows,
    provider: "llm",
  };
}

async function tryLlmExtractImpliedGrids(input: ImpliedGridInput): Promise<ImpliedGridResult | undefined> {
  if (!process.env.OPENAI_API_KEY?.trim()) return undefined;

  const response = await openai.chat.completions.create({
    model: OPENAI_HELPER_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Extract implied comparison grids from prose. Return JSON with source_chunk_id, grids, and confidence. Use concise headers and rows.",
      },
      { role: "user", content: JSON.stringify(input) },
    ],
    response_format: {
      type: "json_object",
    },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return undefined;
  const parsed = JSON.parse(content) as ImpliedGridResult;
  return {
    source_chunk_id: input.chunk_id,
    grids: (parsed.grids ?? []).map((grid) => ({
      ...grid,
      document_id: input.document_id,
      source_chunk_id: input.chunk_id,
      extraction_source: "llm_text_grid",
    })),
    confidence: clamp(parsed.confidence ?? 0.6),
  };
}

export async function understandTable(table: RawTable, provider: TableUnderstandingProvider = "auto"): Promise<TableSemanticObject> {
  if (provider === "heuristic") return localUnderstandTable(table);
  try {
    const llm = await tryLlmUnderstandTable(table);
    if (llm) return llm;
  } catch (error) {
    console.warn("[table-understanding] LLM call failed; using local fallback", { table_id: table.table_id, message: error instanceof Error ? error.message : "Unknown error" });
  }
  warnOnce("missing-openai-key-table-understanding", "[table-understanding] OPENAI_API_KEY missing; using local heuristic fallback.");
  return localUnderstandTable(table);
}

export async function batchUnderstandTables(tables: RawTable[], provider: TableUnderstandingProvider = "auto"): Promise<TableSemanticObject[]> {
  if (tables.length === 0) return [];
  return Promise.all(tables.map((table) => understandTable(table, provider)));
}

export async function extractImpliedGrids(input: ImpliedGridInput): Promise<ImpliedGridResult> {
  try {
    const llm = await tryLlmExtractImpliedGrids(input);
    if (llm) return llm;
  } catch (error) {
    console.warn("[table-understanding] implied-grid LLM call failed; using local fallback", { chunk_id: input.chunk_id, message: error instanceof Error ? error.message : "Unknown error" });
  }
  warnOnce("missing-openai-key-implied-grid", "[table-understanding] OPENAI_API_KEY missing; using local implied-grid fallback.");
  return localExtractImpliedGrids(input);
}
