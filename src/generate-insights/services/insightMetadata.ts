import type { GraphState, Insight, InsightMetadataEntry } from "../../types";

export type CritiqueMap = Record<string, string[]>;

export type GraphStateCRV = GraphState & {
  critiqueByInsightId?: CritiqueMap;
  revisedInsights?: Insight[];
  validatedInsights?: Insight[];
};

export const ALLOWED_METADATA_TAGS = new Set(["topic", "region", "timeframe", "tags"]);
export const MIN_METADATA_CONFIDENCE = 0.4;
const SUB_INSIGHT_CUE =
  /(include|including|such as|e\.g\.|for example|consists of|key (points|areas)|main (points|areas)|following)/i;

export const normalizeTag = (tag?: string) => (tag ?? "").trim().toLowerCase();
export const normalizeValue = (value?: string) => (value ?? "").trim();

export const shouldHaveSubInsights = (text: string) => SUB_INSIGHT_CUE.test(text);

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
