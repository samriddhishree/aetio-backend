import type { CritiqueIssue } from "../../common/services/insightMetadata";
import type { InsightConfidence, InsightMetadataEntry } from "../../types";

export type RevisedInsightActionType = "keep" | "update" | "remove" | "merge_into";

export type RevisedInsightAction = {
  insight_id: string;
  action: RevisedInsightActionType;
  merge_target_insight_id?: string;
  revised_text?: string;
  revised_parent_insight_id?: string | null;
  revised_metadata?: Array<{
    tag: string;
    value: string;
    confidence?: number;
  }>;
  revised_confidence?: InsightConfidence;
  reasoning?: string;
};

export type RevisionEvidenceSnippet = {
  chunk_id: string;
  snippet: string;
};

export type RevisionFindingSummary = {
  finding_id: string;
  text: string;
  evidence_snipped?: string;
  evidence_type?: string;
  supporting_chunk_ids?: string[];
};

export type RevisionInsightView = {
  insight_id: string;
  text: string;
  document_id: string;
  parent_insight_id?: string | null;
  supporting_chunk_ids?: string[];
  evidence_snippets: RevisionEvidenceSnippet[];
  related_findings?: RevisionFindingSummary[];
  metadata?: InsightMetadataEntry[];
  confidence?: InsightConfidence;
};

export type RevisionContext = {
  context_type: "insight_local";
  focus_insight_id: string;
  critique_issues: CritiqueIssue[];
  insight: RevisionInsightView;
  parent?: RevisionInsightView;
  children: RevisionInsightView[];
  sibling_candidates: RevisionInsightView[];
};

export type RevisionPlanResult = {
  actions: RevisedInsightAction[];
};
