import type { Insight, InsightMetadataEntry } from "../../types";
import type { PersistedInsightFamilyData } from "../../common/services/insightFamilyDataTable";

export type ExtractionMode = "deterministic_completion" | "agentic";
export type SourceMode = "explicit_nearby_text" | "synthesized_from_grid";

export type InsightReviewEventType =
  | "accepted"
  | "accepted_after_edit"
  | "declined"
  | "deleted"
  | "text_edited"
  | "metadata_added"
  | "metadata_removed"
  | "metadata_edited"
  | "grid_row_edited"
  | "grid_row_added"
  | "grid_row_deleted";

export type InsightOutcomeClass =
  | "accepted_unchanged"
  | "accepted_after_small_edit"
  | "accepted_after_major_edit"
  | "declined"
  | "deleted";

export type InsightEvalState = {
  text?: string;
  family_text?: string;
  question_answered?: string;
  status?: string;
  metadata?: InsightMetadataEntry[];
  dimensions?: string[];
  rows?: PersistedInsightFamilyData["rows"];
};

export type ExtractionTrace = {
  run_id: string;
  project_id?: string;
  document_id: string;
  insight_id: string;
  table_id?: string;
  pipeline_version: string;
  extraction_mode: ExtractionMode;
  model_name: string;
  prompt_version: string;
  source_mode?: SourceMode;
  file_type?: string;
  chosen_grid_id?: string;
  candidate_grid_count?: number;
  family_text?: string;
  question_answered?: string;
  dimensions_detected?: string[];
  row_count?: number;
  validation_flags?: string[];
  created_at: string;
  updated_at: string;
};

export type InsightReviewEvent = {
  event_id: string;
  event_type: InsightReviewEventType;
  occurred_at: string;
  project_id: string;
  insight_id: string;
  document_id?: string;
  table_id?: string;
  run_id?: string;
  pipeline_version?: string;
  extraction_mode?: ExtractionMode;
  model_name?: string;
  prompt_version?: string;
  source_mode?: SourceMode;
  user_id?: string;
  before_state?: InsightEvalState;
  after_state?: InsightEvalState;
  delta?: InsightDelta;
};

export type InsightDelta = {
  insight_id?: string;
  project_id?: string;
  text_edit_distance: number;
  text_changed: boolean;
  question_changed: boolean;
  metadata_delta_count: number;
  metadata_added_count: number;
  metadata_removed_count: number;
  metadata_edited_count: number;
  dimensions_changed: boolean;
  row_delta_count: number;
  row_added_count: number;
  row_removed_count: number;
  row_edited_count: number;
  row_change_pct: number;
  rows_missing_dimension_context: number;
  metric_only_broken_rows: number;
  row_correction_rate: number;
  dimension_correction_rate: number;
  dimension_normalization_correction_rate: number;
  corrected_dimensions: string[];
  outcome: InsightOutcomeClass;
  review_quality_score: number;
};

export type InsightScoreConfig = {
  accepted_unchanged: number;
  accepted_after_small_edit: number;
  accepted_after_major_edit: number;
  declined: number;
  deleted: number;
  minor_edit_threshold: number;
};

export type EvaluationAggregate = {
  total: number;
  acceptance_rate: number;
  unchanged_acceptance_rate: number;
  decline_rate: number;
  deletion_rate: number;
  average_metadata_edits_per_insight: number;
  average_row_edits_per_insight: number;
  average_text_edit_distance: number;
  metadata_add_rate: number;
  metadata_remove_rate: number;
  metadata_edit_rate: number;
  dimension_normalization_correction_rate: number;
  row_correction_rate: number;
  dimension_correction_rate: number;
  average_rows_missing_dimension_context: number;
  average_metric_only_broken_rows: number;
  common_dimensions_most_corrected: Array<{ dimension: string; count: number }>;
};

export type EvaluationSummary = {
  overall: EvaluationAggregate;
  by_pipeline_version: Record<string, EvaluationAggregate>;
  by_extraction_mode: Record<string, EvaluationAggregate>;
  by_file_type: Record<string, EvaluationAggregate>;
  by_model_name: Record<string, EvaluationAggregate>;
  by_prompt_version: Record<string, EvaluationAggregate>;
  by_source_mode: Record<string, EvaluationAggregate>;
};

export type TerminalReviewAction = "accepted" | "declined" | "deleted";

export type DeltaInput = {
  action: TerminalReviewAction;
  beforeInsight?: Insight;
  afterInsight?: Insight;
  beforeTable?: PersistedInsightFamilyData;
  afterTable?: PersistedInsightFamilyData;
  scoreConfig?: Partial<InsightScoreConfig>;
};

export type V2TraceBuildInput = {
  run_id: string;
  model_name: string;
  prompt_version: string;
  pipeline_version: string;
  documents: Array<{ document_id: string; file_type?: string }>;
  insight_families: Array<
    Pick<
      Insight,
      | "insight_id"
      | "project_id"
      | "document_id"
      | "insight_family_data_id"
      | "family_text"
      | "question_answered"
      | "table_dimensions"
      | "row_count"
    >
  >;
  insight_family_data: Array<Pick<PersistedInsightFamilyData, "table_id" | "row_count" | "dimensions">>;
};

export type V3TraceBuildInput = {
  run_id: string;
  model_name: string;
  prompt_version: string;
  pipeline_version: string;
  insights: Array<
    Pick<
      Insight,
      | "insight_id"
      | "project_id"
      | "document_id"
      | "insight_family_data_id"
      | "family_text"
      | "question_answered"
      | "table_dimensions"
      | "row_count"
      | "insight_source_mode"
    >
  >;
  documents: Array<{ document_id: string; file_type?: string }>;
};
