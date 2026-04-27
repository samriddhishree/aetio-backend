import {
  extractImpliedGrids,
  understandTable,
  type ImpliedGridInput,
  type ImpliedGridResult,
  type RawTable,
  type TableSemanticObject,
} from "../services/tableUnderstandingClient";

export const RAW_TABLE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    table_id: { type: "string" },
    document_id: { type: "string" },
    source_chunk_id: { type: "string" },
    page: { type: ["number", "null"] },
    caption: { type: ["string", "null"] },
    headers: { type: "array", items: { type: "string" } },
    rows: { type: "array", items: { type: "array", items: { type: "string" } } },
    extraction_source: {
      type: "string",
      enum: ["explicit_table", "implied_grid", "csv", "excel", "pdf_table", "llm_text_grid"],
    },
  },
  required: ["table_id", "document_id", "source_chunk_id", "headers", "rows", "extraction_source"],
} as const;

export const IMPLIED_GRID_INPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    document_id: { type: "string" },
    chunk_id: { type: "string" },
    text: { type: "string" },
    page: { type: ["number", "null"] },
    context: { type: ["string", "null"] },
  },
  required: ["document_id", "chunk_id", "text"],
} as const;

export const understand_table_tool = {
  name: "understand_table_tool",
  description: "Given a structured table with headers and rows, infer column roles, subject column, semantic types, candidate facts, dimensions, metrics, and evidence cells.",
  parameters: RAW_TABLE_JSON_SCHEMA,
  async invoke(input: RawTable): Promise<TableSemanticObject> {
    return understandTable(input, "auto");
  },
};

export const extract_implied_grid_tool = {
  name: "extract_implied_grid_tool",
  description: "Given a chunk of prose, extract any implied comparison grid/table with dimensions, metrics, values, and evidence.",
  parameters: IMPLIED_GRID_INPUT_JSON_SCHEMA,
  async invoke(input: ImpliedGridInput): Promise<ImpliedGridResult> {
    return extractImpliedGrids(input);
  },
};

export const openAiTableUnderstandingTools = [
  {
    type: "function" as const,
    function: {
      name: understand_table_tool.name,
      description: understand_table_tool.description,
      parameters: understand_table_tool.parameters,
    },
  },
  {
    type: "function" as const,
    function: {
      name: extract_implied_grid_tool.name,
      description: extract_implied_grid_tool.description,
      parameters: extract_implied_grid_tool.parameters,
    },
  },
];
