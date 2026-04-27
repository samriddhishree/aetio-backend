import { describe, expect, it, vi } from "vitest";
import { generateInsightsV3DefaultToolset } from "../tools";
import {
  extractImpliedGrids,
  understandTable,
  type RawTable,
} from "../../services/tableUnderstandingClient";
import type { V2Chunk, V2Table } from "../../generate-insights-v2/types";

const explicitTable: RawTable = {
  table_id: "tbl-1",
  document_id: "doc-1",
  source_chunk_id: "chunk-table-1",
  headers: ["Channel", "Age Group", "Conversion Rate", "Delta"],
  rows: [
    ["Instagram", "18-30", "12.4%", "+15%"],
    ["TikTok", "18-30", "10.1%", "+9%"],
    ["Email", "45+", "4.2%", "-2%"],
  ],
  extraction_source: "explicit_table",
};

function withoutServiceUrl<T>(fn: () => Promise<T>): Promise<T> {
  vi.stubEnv("OPENAI_API_KEY", "");
  return fn();
}

describe("table understanding", () => {
  it("understands explicit table metrics, dimensions, and facts", async () => withoutServiceUrl(async () => {
    const result = await understandTable(explicitTable, "auto");
    const roles = new Map(result.column_roles.map((role) => [role.column_name, role.role]));
    expect(["entity", "dimension"]).toContain(roles.get("Channel"));
    expect(["entity", "dimension"]).toContain(roles.get("Age Group"));
    expect(roles.get("Conversion Rate")).toBe("metric");
    expect(roles.get("Delta")).toBe("metric");
    expect(result.candidate_facts).toContainEqual(expect.objectContaining({
      metric: "Delta",
      value: "+15%",
      dimensions: expect.objectContaining({ Channel: "Instagram", "Age Group": "18-30" }),
    }));
  }));

  it("extracts implied grids from prose", async () => withoutServiceUrl(async () => {
    const result = await extractImpliedGrids({
      document_id: "doc-1",
      chunk_id: "chunk-1",
      text: "Instagram conversions rose 15% among 18–30 users, TikTok rose 9% among 18–30 users, while email declined 2% among users over 45.",
    });
    expect(result.grids.length).toBeGreaterThan(0);
    const grid = result.grids[0];
    expect(grid.headers.map((header) => header.toLowerCase()).join("|")).toMatch(/channel|metric|value/);
    const rows = grid.rows.map((row) => row.join("|").toLowerCase());
    expect(rows.some((row) => row.includes("instagram") && row.includes("+15%"))).toBe(true);
    expect(rows.some((row) => row.includes("tiktok") && row.includes("+9%"))).toBe(true);
    expect(rows.some((row) => row.includes("email") && row.includes("-2%"))).toBe(true);
  }));

  it("falls back locally when LLM credentials are unavailable", async () => withoutServiceUrl(async () => {
    const result = await understandTable(explicitTable, "auto");
    expect(result.provider).toBe("heuristic");
    expect(result.candidate_facts.length).toBeGreaterThan(0);
  }));

  it("adds table semantic objects before candidate grid extraction", async () => withoutServiceUrl(async () => {
    const chunk: V2Chunk = {
      chunk_id: "chunk-1",
      document_id: "doc-1",
      source_uri: "s3://bucket/doc.pdf",
      text: "Instagram conversions rose 15% among 18–30 users, TikTok rose 9% among 18–30 users, while email declined 2% among users over 45.",
      page: 1,
      element_type: "NarrativeText",
      source_modality: "text",
    };
    const table: V2Table = {
      table_id: "tbl-1",
      document_id: "doc-1",
      source_uri: "s3://bucket/doc.pdf",
      page: 1,
      element_type: "Table",
      table_region: "chunk-table-1",
      raw_text: "Channel | Age Group | Conversion Rate | Delta",
      headers: explicitTable.headers,
      rows: explicitTable.rows.map((cells, row_index) => ({ row_index, cells })),
    };
    const parsed = await generateInsightsV3DefaultToolset.parseFile({
      descriptor: {
        document_id: "doc-1",
        source_uri: "s3://bucket/doc.pdf",
        file_type: "pdf",
        file_name: "doc.pdf",
      },
      chunks: [chunk],
      tables: [table],
    });
    expect(parsed.raw_tables.length).toBeGreaterThanOrEqual(2);
    expect(parsed.table_semantic_objects.length).toBe(parsed.raw_tables.length);
    const candidates = await generateInsightsV3DefaultToolset.findCandidateGrids(parsed);
    expect(candidates.some((candidate) => candidate.table_semantic_object?.table_id === "tbl-1")).toBe(true);
  }));
});
