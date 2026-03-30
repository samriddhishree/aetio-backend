import type {
  GraphState,
  Insight,
  InsightConfidence,
  InsightMetadataEntry,
} from "../../types";

export type CritiqueIssueType =
  | "missing_support"
  | "hierarchy_error"
  | "low_confidence_metadata"
  | "metadata_inconsistency"
  | "possible_missing_subinsights"
  | "irrelevant_insight"
  | "too_generic"
  | "redundant"
  | "unsupported_by_children"
  | "weak_child_support"
  | "overgeneralized"
  | "lost_quantitative_detail"
  | "weak_evidence_grounding"
  | "redundant_metadata"
  | "low_value_metadata"
  | "unsupported_metadata"
  | "overly_specific_metadata";


export type CritiqueSeverity = "low" | "medium" | "high";

export const SEMANTIC_CRITIQUE_ISSUE_TYPES = [
  "irrelevant_insight",
  "too_generic",
  "redundant",
  "unsupported_by_children",
  "weak_child_support",
  "overgeneralized",
  "lost_quantitative_detail",
  "weak_evidence_grounding",
  "redundant_metadata",
  "low_value_metadata",
  "unsupported_metadata",
  "overly_specific_metadata",
  "metadata_inconsistency",
] as const;

export type SemanticCritiqueIssueType =
  typeof SEMANTIC_CRITIQUE_ISSUE_TYPES[number];
  
export const CRITIQUE_SEVERITIES: CritiqueSeverity[] = ["low", "medium", "high"];

export type CritiqueIssue = {
  type: CritiqueIssueType;
  severity: CritiqueSeverity;
  message: string;
};

export type CritiqueIssueInput = CritiqueIssue | string;
export type CritiqueMap = Record<string, CritiqueIssue[]>;
export type ConfidenceByInsightId = Record<string, InsightConfidence>;

export type GraphStateCRV = GraphState & {
  critiqueByInsightId?: CritiqueMap;
  confidenceByInsightId?: ConfidenceByInsightId;
  revisedInsights?: Insight[];
  validatedInsights?: Insight[];
};

export const ALLOWED_METADATA_TAGS = new Set(["topic", "region", "timeframe", "tags"]);
export const MIN_METADATA_CONFIDENCE = 0.4;
const SUB_INSIGHT_CUE =
  /(include|including|such as|e\.g\.|for example|consists of|key (points|areas)|main (points|areas)|following)/i;

export const normalizeTag = (tag?: string): string => {
  const normalized = (tag ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized === "time frame") return "timeframe";
  if (normalized === "topics") return "topic";
  if (normalized === "regions") return "region";
  if (normalized === "label" || normalized === "labels" || normalized === "tag") return "tags";
  return normalized;
};

export const normalizeValue = (value?: string) => (value ?? "").trim();

export const shouldHaveSubInsights = (text: string) => SUB_INSIGHT_CUE.test(text);

const FALLBACK_ISSUE_TYPE: CritiqueIssueType = "weak_evidence_grounding";

export const toCritiqueIssue = (issue: CritiqueIssueInput): CritiqueIssue => {
  if (typeof issue !== "string") {
    return {
      ...issue,
      message: issue.message.trim(),
    };
  }

  const message = issue.trim();
  const normalized = message.toLowerCase();
  if (normalized.includes("missing supporting_chunks")) {
    return { type: "missing_support", severity: "high", message };
  }
  if (normalized.includes("hierarchy issue")) {
    return { type: "hierarchy_error", severity: "high", message };
  }
  if (normalized.includes("low-confidence metadata")) {
    return { type: "low_confidence_metadata", severity: "low", message };
  }
  if (normalized.includes("metadata inconsistency")) {
    return { type: "metadata_inconsistency", severity: "medium", message };
  }
  if (normalized.includes("redundant metadata")) {
    return { type: "redundant_metadata", severity: "medium", message };
  }
  if (normalized.includes("low-value metadata") || normalized.includes("low value metadata")) {
    return { type: "low_value_metadata", severity: "low", message };
  }
  if (normalized.includes("unsupported metadata")) {
    return { type: "unsupported_metadata", severity: "high", message };
  }
  if (
    normalized.includes("overly specific metadata")
    || normalized.includes("overly-specific metadata")
  ) {
    return { type: "overly_specific_metadata", severity: "medium", message };
  }
  if (normalized.includes("missing sub-insights")) {
    return { type: "possible_missing_subinsights", severity: "low", message };
  }
  return { type: FALLBACK_ISSUE_TYPE, severity: "medium", message };
};

export const addIssue = (
  critique: CritiqueMap,
  insightId: string,
  issue: CritiqueIssueInput,
) => {
  const normalized = toCritiqueIssue(issue);
  if (!normalized.message) return;
  critique[insightId] = critique[insightId] ?? [];
  critique[insightId].push(normalized);
};

export const issueToString = (issue: CritiqueIssueInput): string =>
  typeof issue === "string" ? issue : issue.message;

export const issueImpliesUnsupported = (issue: CritiqueIssueInput): boolean => {
  const normalized = toCritiqueIssue(issue);
  if (normalized.type === "missing_support") return true;
  return normalized.message.toLowerCase().includes("unsupported");
};

export const mergeCritiqueMaps = (left: CritiqueMap, right: CritiqueMap): CritiqueMap => {
  const merged: CritiqueMap = {};

  for (const [insightId, issues] of Object.entries(left)) {
    merged[insightId] = issues.map((issue) => toCritiqueIssue(issue));
  }

  for (const [insightId, issues] of Object.entries(right)) {
    const existing = merged[insightId] ?? [];
    const seen = new Set(
      existing.map((issue) => `${issue.type}|${issue.severity}|${issue.message.toLowerCase()}`),
    );
    for (const issue of issues) {
      const normalized = toCritiqueIssue(issue);
      const key = `${normalized.type}|${normalized.severity}|${normalized.message.toLowerCase()}`;
      if (seen.has(key)) continue;
      existing.push(normalized);
      seen.add(key);
    }
    if (existing.length > 0) {
      merged[insightId] = existing;
    }
  }

  return merged;
};

export const collectMetadataStats = (insights: Insight[]) => {
  const stats = new Map<string, Map<string, Map<string, number>>>();

  for (const insight of insights) {
    const docStats = stats.get(insight.document_id) ?? new Map();
    for (const entry of insight.metadata ?? []) {
      const tag = normalizeTag(entry.tag);
      const value = normalizeValue(entry.value);
      if (!tag || !value || !ALLOWED_METADATA_TAGS.has(tag)) continue;
      const tagStats = docStats.get(tag) ?? new Map();
      tagStats.set(value, (tagStats.get(value) ?? 0) + 1);
      docStats.set(tag, tagStats);
    }
    stats.set(insight.document_id, docStats);
  }

  return stats;
};

export const getConsensusValue = (
  stats: Map<string, Map<string, Map<string, number>>>,
  documentId: string,
  tag: string,
) => {
  const docStats = stats.get(documentId);
  if (!docStats) return undefined;
  const tagStats = docStats.get(tag);
  if (!tagStats) return undefined;

  let topValue: string | undefined;
  let topCount = -1;
  for (const [value, count] of tagStats.entries()) {
    if (count > topCount) {
      topCount = count;
      topValue = value;
    }
  }
  return topValue;
};

export const consolidateMetadata = (
  entries?: InsightMetadataEntry[],
): InsightMetadataEntry[] | undefined => {
  if (!entries || entries.length === 0) return undefined;

  const tagBuckets = new Map<
    string,
    { values: Set<string>; maxConfidence: number }
  >();

  for (const entry of entries) {
    const tag = normalizeTag(entry.tag);
    const value = normalizeValue(entry.value);
    if (!tag || !value || !ALLOWED_METADATA_TAGS.has(tag)) continue;

    const bucket = tagBuckets.get(tag) ?? {
      values: new Set<string>(),
      maxConfidence: 0,
    };
    bucket.values.add(value);
    bucket.maxConfidence = Math.max(bucket.maxConfidence, entry.confidence ?? 0);
    tagBuckets.set(tag, bucket);
  }

  const consolidated: InsightMetadataEntry[] = [];
  for (const [tag, bucket] of tagBuckets.entries()) {
    const value = tag === "tags"
      ? Array.from(bucket.values).join(", ")
      : Array.from(bucket.values).slice(0, 1)[0];
    if (!value) continue;
    consolidated.push({
      tag,
      value,
      confidence: bucket.maxConfidence,
    });
  }

  return consolidated.length > 0 ? consolidated : undefined;
};
