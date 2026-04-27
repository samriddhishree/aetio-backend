import { describe, expect, it, vi } from "vitest";
import { buildPersistedInsightFamilyDataRecord } from "../../generate-insights-v2/services/insightFamilyDataPersistence";
import { validateInsightObject } from "../validators";
import { generateInsightsV3DefaultToolset } from "../tools";
import type { GenerateInsightsV3Insight } from "../types";
import type { CandidateGrid } from "../types";

function baseInsight(overrides: Partial<GenerateInsightsV3Insight> = {}): GenerateInsightsV3Insight {
  const now = new Date().toISOString();
  return {
    insight_id: "insight-1",
    object_type: "insight_family",
    text: "Yield varies by farm sector. Evidence: table_id=abcdef1234567890 source_chunk_id=abcdef1234567890 row_index=0 evidence_cells=[(0,1)].",
    family_text: "Yield varies by farm sector. Evidence: table_id=abcdef1234567890.",
    metadata: [],
    tags: [],
    dimension_metadata: [
      {
        dimension_id: "dim-farm-sector",
        canonical_name: "farm_sector",
        display_name: "Farm Sector",
        dimension_type: "categorical",
        value_type: "string",
        created_at: now,
        updated_at: now,
      },
    ],
    insightfamilydata: {
      table_id: "table-1",
      family_id: "insight-1",
      dimensions: ["Farm Sector"],
      metric_columns: ["Actual Yield Bushels"],
      row_count: 1,
      rows: [
        {
          row_id: "row-1",
          family_id: "insight-1",
          filter_values: [
            {
              dimension_id: "dim-farm-sector",
              dimension_name: "Farm Sector",
              value: "sector_5",
              display_value: "Sector 5",
            },
          ],
          metric_name: "Actual Yield Bushels",
          metric_value: 151,
          value_text: "Farm Sector: Sector 5 | Actual Yield Bushels: 151",
          supporting_refs: [
            {
              table_id: "source-table-1",
              row_index: 0,
              evidence_cells: [{ row: 0, col: 1 }],
            },
          ],
        },
      ],
      table_text_chunk: "Farm Sector | Soil Factor | Actual Yield Bushels\nSector 5 | Nitrogen | 151",
      created_at: now,
      updated_at: now,
    },
    evidence_snippet: "Yield varies by farm sector.",
    s3_node: "pending",
    document_id: "doc-1",
    created_at: now,
    updated_at: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("generate-insights-v3 quality guards", () => {
  it("removes raw evidence identifiers from insight text and supplies fallback question", () => {
    const validation = validateInsightObject(baseInsight());
    expect(validation.valid).toBe(true);
    expect(validation.insight?.text).toBe("Yield varies by farm sector.");
    expect(validation.insight?.text).not.toMatch(/table_id|source_chunk_id|evidence_cells|row_index/);
    expect(validation.insight?.question_answered).toBe("How does Actual Yield Bushels vary by Farm Sector?");
  });

  it("rejects crop source insights that drift into loyalty-fraud vocabulary", () => {
    const validation = validateInsightObject(baseInsight({
      text: "Loyalty redemption fraud points are concentrated among store employees.",
      family_text: "Loyalty redemption fraud points are concentrated among store employees.",
    }));
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toMatch(/domain mismatch/i);
  });

  it("normalizes currency metrics, skips aggregate rows, and preserves table understanding artifacts", async () => {
    const grid: CandidateGrid = {
      grid_id: "grid-1",
      document_id: "doc-1",
      source_uri: "s3://bucket/crop.csv",
      source_mode: "table_element",
      confidence: 0.9,
      rationale: "test",
      raw_table: {
        table_id: "raw-1",
        document_id: "doc-1",
        source_chunk_id: "chunk-1",
        headers: ["Farm Sector", "Actual Yield Value ($)"],
        rows: [["Sector 5", "$112,000"], ["Total", "$200,000"]],
        extraction_source: "csv",
      },
      table_semantic_object: {
        table_id: "raw-1",
        document_id: "doc-1",
        source_chunk_id: "chunk-1",
        headers: ["Farm Sector", "Actual Yield Value ($)"],
        rows: [["Sector 5", "$112,000"], ["Total", "$200,000"]],
        subject_column: "Farm Sector",
        column_roles: [
          { column_name: "Farm Sector", role: "dimension", confidence: 0.9 },
          { column_name: "Actual Yield Value ($)", role: "metric", unit: "usd", confidence: 0.9 },
        ],
        candidate_facts: [],
        provider: "heuristic",
        confidence: 0.9,
      },
      table: {
        table_id: "raw-1",
        document_id: "doc-1",
        source_uri: "s3://bucket/crop.csv",
        element_type: "Table",
        raw_text: "Farm Sector | Actual Yield Value ($)",
        headers: ["Farm Sector", "Actual Yield Value ($)"],
        rows: [
          { row_index: 0, cells: ["Sector 5", "$112,000"] },
          { row_index: 1, cells: ["Total", "$200,000"] },
        ],
      },
    };

    const draft = await generateInsightsV3DefaultToolset.normalizeGrid(grid, "family-1");
    expect(draft.row_count).toBe(1);
    expect(draft.rows[0]?.metric_value).toBe(112000);
    expect(draft.rows[0]?.metric_unit).toBe("usd");
    expect(draft.raw_table).toBeDefined();
    expect(draft.table_semantic_object).toBeDefined();
    expect(draft.table_understanding_summary).toBeDefined();
  });

  it("promotes metric-like money/count columns even when semantic roles are imperfect", async () => {
    const grid: CandidateGrid = {
      grid_id: "grid-money",
      document_id: "doc-1",
      source_uri: "s3://bucket/loss.csv",
      source_mode: "table_element",
      confidence: 0.9,
      rationale: "test",
      table_semantic_object: {
        table_id: "raw-money",
        document_id: "doc-1",
        source_chunk_id: "chunk-1",
        headers: ["Category", "Metric Count", "Cash Equivalent ($)", "Recovery Status"],
        rows: [["Confirmed Fraud", "954 Redemptions", "$79,800", "Pending Legal"]],
        column_roles: [
          { column_name: "Category", role: "dimension", confidence: 0.9 },
          { column_name: "Metric Count", role: "metric", confidence: 0.9 },
          { column_name: "Cash Equivalent ($)", role: "dimension", confidence: 0.6 },
          { column_name: "Recovery Status", role: "dimension", confidence: 0.9 },
        ],
        candidate_facts: [],
        provider: "heuristic",
        confidence: 0.9,
      },
      table: {
        table_id: "raw-money",
        document_id: "doc-1",
        source_uri: "s3://bucket/loss.csv",
        element_type: "Table",
        raw_text: "Category | Metric Count | Cash Equivalent ($) | Recovery Status",
        headers: ["Category", "Metric Count", "Cash Equivalent ($)", "Recovery Status"],
        rows: [
          { row_index: 0, cells: ["Confirmed Fraud", "954 Redemptions", "$79,800", "Pending Legal"] },
        ],
      },
    };

    const draft = await generateInsightsV3DefaultToolset.normalizeGrid(grid, "family-money");
    expect(draft.metric_columns).toEqual(expect.arrayContaining(["Metric Count", "Cash Equivalent ($)"]));
    expect(draft.dimensions).not.toContain("Cash Equivalent ($)");
    expect(draft.rows.find((row) => row.metric_name === "Metric Count")?.metric_value).toBe(954);
    expect(draft.rows.find((row) => row.metric_name === "Cash Equivalent ($)")?.metric_value).toBe(79800);
  });

  it("deduplicates generated tags by tag key", () => {
    const validation = validateInsightObject(baseInsight({
      tags: [
        { comparison_basis: "fallback comparison" },
        { comparison_basis: "specific comparison" },
        { risk_signal: "generic risk" },
        { risk_signal: "temporal risk" },
      ],
    }));

    expect(validation.valid).toBe(true);
    expect(validation.insight?.tags).toEqual([
      { comparison_basis: "specific comparison" },
      { risk_signal: "temporal risk" },
    ]);
  });

  it("persists raw table and table understanding fields in insightfamilydata records", () => {
    const insight = baseInsight();
    const record = buildPersistedInsightFamilyDataRecord({
      table: {
        ...insight.insightfamilydata,
        raw_table: { table_id: "raw-1" },
        table_semantic_object: { table_id: "raw-1", provider: "heuristic" },
        table_understanding_summary: { provider: "heuristic" },
        question_answered: "How does Actual Yield Bushels vary by Farm Sector?",
      },
      documentIds: ["doc-1"],
      sourceTypes: ["csv"],
      scopeS3Node: "scope",
      primaryDocumentId: "doc-1",
    });
    expect(record.familyData.raw_table).toEqual({ table_id: "raw-1" });
    expect(record.familyData.table_semantic_object).toEqual({ table_id: "raw-1", provider: "heuristic" });
    expect(record.familyData.table_understanding_summary).toEqual({ provider: "heuristic" });
    expect(record.familyData.question_answered).toBe("How does Actual Yield Bushels vary by Farm Sector?");
  });
});
