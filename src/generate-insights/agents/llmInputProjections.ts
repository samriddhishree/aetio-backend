import type { CritiqueIssue } from "../../common/services/insightMetadata";
import type {
  Insight,
  InsightConfidence,
  InsightMetadataEntry,
  SupportingChunkRef,
} from "../../types";
import { sanitizeInsightConfidence } from "./insightConfidence";

type EvidenceSnippet = {
  chunk_id: string;
  snippet: string;
};

type ChildSummary = {
  insight_id: string;
  text: string;
};

export type FindingSummary = {
  finding_id: string;
  text: string;
  evidence_snipped?: string;
  evidence_type?: string;
  supporting_chunk_ids?: string[];
};

const MAX_METADATA_ENTRIES = 6;
const MAX_CHUNK_IDS = 8;
const MAX_CHILD_SUMMARIES = 8;
const MAX_NEARBY_INSIGHTS = 6;
const MAX_RELATED_FINDINGS = 5;

function compactText(value?: string): string | undefined {
  if (!value) return undefined;
  const compacted = value.replace(/\s+/g, " ").trim();
  return compacted.length > 0 ? compacted : undefined;
}

function normalizeMetadata(metadata?: InsightMetadataEntry[]): InsightMetadataEntry[] | undefined {
  if (!metadata || metadata.length === 0) return undefined;
  const cleaned = metadata
    .map((entry) => ({
      tag: compactText(entry.tag),
      value: compactText(entry.value),
      confidence: entry.confidence,
    }))
    .filter((entry) => entry.tag && entry.value)
    .slice(0, MAX_METADATA_ENTRIES) as InsightMetadataEntry[];
  return cleaned.length > 0 ? cleaned : undefined;
}

function toChildSummaries(children?: ChildSummary[]): ChildSummary[] | undefined {
  if (!children || children.length === 0) return undefined;
  const cleaned = children
    .map((child) => ({
      insight_id: compactText(child.insight_id),
      text: compactText(child.text),
    }))
    .filter((child) => child.insight_id && child.text)
    .slice(0, MAX_CHILD_SUMMARIES) as ChildSummary[];
  return cleaned.length > 0 ? cleaned : undefined;
}

function toSupportingChunkIds(
  supportingChunks?: SupportingChunkRef[],
): string[] | undefined {
  if (!supportingChunks || supportingChunks.length === 0) return undefined;
  const unique = new Set<string>();
  for (const ref of supportingChunks) {
    const chunkId = ref.chunk_id?.trim();
    if (!chunkId) continue;
    unique.add(chunkId);
    if (unique.size >= MAX_CHUNK_IDS) break;
  }
  return unique.size > 0 ? Array.from(unique) : undefined;
}

function normalizeEvidenceSnippets(
  snippets?: EvidenceSnippet[],
): EvidenceSnippet[] | undefined {
  if (!snippets || snippets.length === 0) return undefined;
  const cleaned = snippets
    .map((snippet) => ({
      chunk_id: compactText(snippet.chunk_id),
      snippet: compactText(snippet.snippet),
    }))
    .filter((snippet) => snippet.chunk_id && snippet.snippet) as EvidenceSnippet[];
  return cleaned.length > 0 ? cleaned : undefined;
}

function normalizeRelatedFindings(
  findings?: FindingSummary[],
): FindingSummary[] | undefined {
  if (!findings || findings.length === 0) return undefined;
  const cleaned = findings
    .map((finding) => ({
      finding_id: compactText(finding.finding_id),
      text: compactText(finding.text),
      evidence_snipped: compactText(finding.evidence_snipped),
      evidence_type: compactText(finding.evidence_type),
      supporting_chunk_ids: finding.supporting_chunk_ids
        ?.map((chunkId) => compactText(chunkId))
        .filter((chunkId): chunkId is string => Boolean(chunkId)),
    }))
    .filter((finding) => finding.finding_id && finding.text)
    .slice(0, MAX_RELATED_FINDINGS) as FindingSummary[];
  return cleaned.length > 0 ? cleaned : undefined;
}

export type CritiqueLLMInput = {
  insight_id: string;
  text: string;
  parent_insight_id?: string | null;
  metadata?: InsightMetadataEntry[];
  evidence_snippets?: EvidenceSnippet[];
  child_summaries?: ChildSummary[];
  related_findings?: FindingSummary[];
};

export function toCritiqueLLMInput(
  insight: Insight,
  context?: {
    evidence_snippets?: EvidenceSnippet[];
    child_summaries?: ChildSummary[];
    related_findings?: FindingSummary[];
  },
): CritiqueLLMInput {
  return {
    insight_id: insight.insight_id,
    text: compactText(insight.text) ?? insight.text,
    parent_insight_id: insight.parent_insight_id,
    metadata: normalizeMetadata(insight.metadata),
    evidence_snippets: normalizeEvidenceSnippets(context?.evidence_snippets),
    child_summaries: toChildSummaries(context?.child_summaries),
    related_findings: normalizeRelatedFindings(context?.related_findings),
  };
}

export type RevisionLLMInput = {
  insight_id: string;
  text: string;
  parent_insight_id?: string | null;
  metadata?: InsightMetadataEntry[];
  confidence?: InsightConfidence;
  supporting_chunk_ids?: string[];
  evidence_snippets?: EvidenceSnippet[];
  critique_issues?: CritiqueIssue[];
  child_summaries?: ChildSummary[];
  related_findings?: FindingSummary[];
};

export function toRevisionLLMInput(
  insight: Insight,
  critiqueIssues?: CritiqueIssue[],
  context?: {
    evidence_snippets?: EvidenceSnippet[];
    child_summaries?: ChildSummary[];
    related_findings?: FindingSummary[];
  },
): RevisionLLMInput {
  return {
    insight_id: insight.insight_id,
    text: compactText(insight.text) ?? insight.text,
    parent_insight_id: insight.parent_insight_id,
    metadata: normalizeMetadata(insight.metadata),
    confidence: sanitizeInsightConfidence(insight.confidence),
    supporting_chunk_ids: toSupportingChunkIds(insight.supporting_chunks),
    evidence_snippets: normalizeEvidenceSnippets(context?.evidence_snippets),
    critique_issues: critiqueIssues && critiqueIssues.length > 0 ? critiqueIssues : undefined,
    child_summaries: toChildSummaries(context?.child_summaries),
    related_findings: normalizeRelatedFindings(context?.related_findings),
  };
}

export type ValidationLLMInput = {
  insight_id: string;
  text: string;
  parent_insight_id?: string | null;
  metadata?: InsightMetadataEntry[];
  confidence?: InsightConfidence;
  supporting_chunk_ids?: string[];
  critique_issues?: CritiqueIssue[];
};

export function toValidationLLMInput(
  insight: Insight,
  context?: { critique_issues?: CritiqueIssue[] },
): ValidationLLMInput {
  return {
    insight_id: insight.insight_id,
    text: compactText(insight.text) ?? insight.text,
    parent_insight_id: insight.parent_insight_id,
    metadata: normalizeMetadata(insight.metadata),
    confidence: sanitizeInsightConfidence(insight.confidence),
    supporting_chunk_ids: toSupportingChunkIds(insight.supporting_chunks),
    critique_issues:
      context?.critique_issues && context.critique_issues.length > 0
        ? context.critique_issues
        : undefined,
  };
}

export type MetadataConsolidationLLMInput = {
  insight_id: string;
  text: string;
  parent_insight_id?: string | null;
  metadata?: InsightMetadataEntry[];
  nearby_insights?: Array<{
    insight_id: string;
    text: string;
    metadata?: InsightMetadataEntry[];
  }>;
};

export function toMetadataConsolidationLLMInput(
  insight: Insight,
  context?: { nearby_insights?: Insight[] },
): MetadataConsolidationLLMInput {
  const nearby = (context?.nearby_insights ?? [])
    .filter((candidate) => candidate.insight_id !== insight.insight_id)
    .slice(0, MAX_NEARBY_INSIGHTS)
    .map((candidate) => ({
      insight_id: candidate.insight_id,
      text: compactText(candidate.text) ?? candidate.text,
      metadata: normalizeMetadata(candidate.metadata),
    }));

  return {
    insight_id: insight.insight_id,
    text: compactText(insight.text) ?? insight.text,
    parent_insight_id: insight.parent_insight_id,
    metadata: normalizeMetadata(insight.metadata),
    nearby_insights: nearby.length > 0 ? nearby : undefined,
  };
}
