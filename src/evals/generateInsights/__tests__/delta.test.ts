import { describe, expect, it } from "vitest";
import { computeInsightDelta } from "../delta";
import type { Insight } from "../../../types";
import type { PersistedInsightFamilyData } from "../../../common/services/insightFamilyDataTable";

function buildInsight(overrides: Partial<Insight> = {}): Insight {
  return {
    insight_id: overrides.insight_id ?? "insight-1",
    text: overrides.text ?? "Revenue increased in Q1.",
    family_text: overrides.family_text ?? "Revenue increased in Q1.",
    question_answered: overrides.question_answered ?? "How did revenue change?",
    metadata: overrides.metadata ?? [{ tag: "region", value: "north" }],
    evidence_snippet: overrides.evidence_snippet ?? "Revenue increased in Q1.",
    s3_node: overrides.s3_node ?? "test",
    document_id: overrides.document_id ?? "doc-1",
    project_id: overrides.project_id ?? "project-1",
    ...overrides,
  };
}

function buildTable(overrides: Partial<PersistedInsightFamilyData> = {}): PersistedInsightFamilyData {
  return {
    table_id: overrides.table_id ?? "table-1",
    family_id: overrides.family_id ?? "insight-1",
    s3_node: overrides.s3_node ?? "test",
    document_id: overrides.document_id ?? "doc-1",
    document_ids: overrides.document_ids ?? ["doc-1"],
    source_types: overrides.source_types ?? ["csv"],
    row_count: overrides.row_count ?? 1,
    dimensions: overrides.dimensions ?? ["region"],
    metric_columns: overrides.metric_columns ?? ["revenue"],
    source_modalities: overrides.source_modalities ?? ["table"],
    rows: overrides.rows ?? [
      {
        row_id: "row-1",
        family_id: "insight-1",
        filter_values: [{ dimension_id: "region", dimension_name: "region", value: "north" }],
        metric_name: "revenue",
        metric_value: 10,
        value_text: "10",
        supporting_refs: [],
      },
    ],
    created_at: overrides.created_at ?? new Date().toISOString(),
    updated_at: overrides.updated_at ?? new Date().toISOString(),
    ...overrides,
  };
}

describe("computeInsightDelta", () => {
  it("classifies unchanged accepted insight", () => {
    const before = buildInsight();
    const after = buildInsight();
    const table = buildTable();

    const delta = computeInsightDelta({
      action: "accepted",
      beforeInsight: before,
      afterInsight: after,
      beforeTable: table,
      afterTable: table,
    });

    expect(delta.outcome).toBe("accepted_unchanged");
    expect(delta.text_changed).toBe(false);
    expect(delta.metadata_delta_count).toBe(0);
  });

  it("classifies major edit with row and metadata changes", () => {
    const before = buildInsight();
    const after = buildInsight({
      text: "Revenue dropped in Q1 in north and south regions.",
      metadata: [{ tag: "region", value: "south" }, { tag: "channel", value: "retail" }],
    });

    const beforeTable = buildTable();
    const afterTable = buildTable({
      rows: [
        {
          row_id: "row-1",
          family_id: "insight-1",
          filter_values: [{ dimension_id: "region", dimension_name: "region", value: "south" }],
          metric_name: "revenue",
          metric_value: 3,
          value_text: "3",
          supporting_refs: [],
        },
        {
          row_id: "row-2",
          family_id: "insight-1",
          filter_values: [{ dimension_id: "region", dimension_name: "region", value: "north" }],
          metric_name: "revenue",
          metric_value: 8,
          value_text: "8",
          supporting_refs: [],
        },
      ],
      row_count: 2,
    });

    const delta = computeInsightDelta({
      action: "accepted",
      beforeInsight: before,
      afterInsight: after,
      beforeTable,
      afterTable,
    });

    expect(delta.outcome).toBe("accepted_after_major_edit");
    expect(delta.row_delta_count).toBeGreaterThan(0);
    expect(delta.metadata_delta_count).toBeGreaterThan(0);
  });
});
