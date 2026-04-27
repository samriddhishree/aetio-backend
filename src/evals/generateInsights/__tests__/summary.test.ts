import { describe, expect, it } from "vitest";
import { summarizeEvaluation } from "../summary";

describe("summarizeEvaluation", () => {
  it("aggregates core acceptance and edit metrics", () => {
    const traces = [
      {
        run_id: "run-1",
        project_id: "project-1",
        document_id: "doc-1",
        insight_id: "insight-1",
        pipeline_version: "generate-insights-v2",
        extraction_mode: "deterministic_completion" as const,
        model_name: "gpt-5.2",
        prompt_version: "v2-default",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        run_id: "run-1",
        project_id: "project-1",
        document_id: "doc-1",
        insight_id: "insight-2",
        pipeline_version: "generate-insights-v3",
        extraction_mode: "agentic" as const,
        model_name: "gpt-5.2",
        prompt_version: "v3-default",
        source_mode: "synthesized_from_grid" as const,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const deltas = [
      {
        insight_id: "insight-1",
        outcome: "accepted_unchanged" as const,
        review_quality_score: 1,
        text_edit_distance: 0,
        text_changed: false,
        question_changed: false,
        metadata_delta_count: 0,
        metadata_added_count: 0,
        metadata_removed_count: 0,
        metadata_edited_count: 0,
        dimensions_changed: false,
        row_delta_count: 0,
        row_added_count: 0,
        row_removed_count: 0,
        row_edited_count: 0,
        row_change_pct: 0,
        rows_missing_dimension_context: 0,
        metric_only_broken_rows: 0,
        row_correction_rate: 0,
        dimension_correction_rate: 0,
        dimension_normalization_correction_rate: 0,
        corrected_dimensions: [],
      },
      {
        insight_id: "insight-2",
        outcome: "declined" as const,
        review_quality_score: -0.7,
        text_edit_distance: 10,
        text_changed: true,
        question_changed: true,
        metadata_delta_count: 2,
        metadata_added_count: 1,
        metadata_removed_count: 1,
        metadata_edited_count: 0,
        dimensions_changed: true,
        row_delta_count: 1,
        row_added_count: 1,
        row_removed_count: 0,
        row_edited_count: 0,
        row_change_pct: 0.5,
        rows_missing_dimension_context: 1,
        metric_only_broken_rows: 1,
        row_correction_rate: 0,
        dimension_correction_rate: 0,
        dimension_normalization_correction_rate: 0.5,
        corrected_dimensions: ["region"],
      },
    ];

    const summary = summarizeEvaluation({ deltas, traces });

    expect(summary.overall.total).toBe(2);
    expect(summary.overall.acceptance_rate).toBe(0.5);
    expect(summary.overall.decline_rate).toBe(0.5);
    expect(summary.by_pipeline_version["generate-insights-v2"].total).toBe(1);
    expect(summary.by_extraction_mode.agentic.total).toBe(1);
    expect(summary.by_source_mode.synthesized_from_grid.total).toBe(1);
  });
});
