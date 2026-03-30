import type { FindingRef, Insight, InsightMetadataEntry, SupportingChunkRef } from "../../types";

type InsightRefs = {
  sourceBatchIds: Set<string>;
  mergedFromInsightIds: Set<string>;
  findingIds: Set<string>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeMetadataTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function normalizeMetadataValue(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeInsightText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s%.-]/g, " ")
    .replace(/\s+/g, " ");
}

function tokenize(text: string): Set<string> {
  const tokens = normalizeInsightText(text)
    .split(" ")
    .filter((token) => token.length >= 3);
  return new Set(tokens);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function toChunkKey(ref: SupportingChunkRef): string {
  return `${ref.chunk_id}:${ref.paragraph_index ?? ""}:${ref.line_index ?? ""}`;
}

function supportingChunkSimilarity(left: Insight, right: Insight): number {
  const leftRefs = new Set((left.supporting_chunks ?? []).map(toChunkKey));
  const rightRefs = new Set((right.supporting_chunks ?? []).map(toChunkKey));
  if (leftRefs.size === 0 || rightRefs.size === 0) return 0;

  let overlap = 0;
  for (const key of leftRefs) {
    if (rightRefs.has(key)) overlap += 1;
  }
  const minSize = Math.min(leftRefs.size, rightRefs.size);
  return minSize === 0 ? 0 : overlap / minSize;
}

function metadataSimilarity(left: Insight, right: Insight): number {
  const leftSet = new Set(
    (left.metadata ?? []).map(
      (entry) => `${normalizeMetadataTag(entry.tag)}:${normalizeMetadataValue(entry.value)}`,
    ),
  );
  const rightSet = new Set(
    (right.metadata ?? []).map(
      (entry) => `${normalizeMetadataTag(entry.tag)}:${normalizeMetadataValue(entry.value)}`,
    ),
  );
  return jaccard(leftSet, rightSet);
}

export function isNearDuplicateInsight(left: Insight, right: Insight): boolean {
  if (left.document_id !== right.document_id) return false;

  const leftText = normalizeInsightText(left.text);
  const rightText = normalizeInsightText(right.text);
  if (!leftText || !rightText) return false;
  if (leftText === rightText) return true;

  const tokenSimilarity = jaccard(tokenize(left.text), tokenize(right.text));
  const chunkSimilarity = supportingChunkSimilarity(left, right);
  const metadataSim = metadataSimilarity(left, right);

  if (chunkSimilarity >= 0.5 && tokenSimilarity >= 0.55) return true;
  if (tokenSimilarity >= 0.78 && metadataSim >= 0.3) return true;
  if (tokenSimilarity >= 0.88) return true;
  return false;
}

function numericSignalCount(text: string): number {
  return (text.match(/\b\d+(?:\.\d+)?%?\b/g) ?? []).length;
}

function insightQualityScore(insight: Insight): number {
  const numericSignals = numericSignalCount(insight.text);
  const supportCount = insight.supporting_chunks?.length ?? 0;
  const metadataCount = insight.metadata?.length ?? 0;
  const textLengthScore = Math.min(insight.text.length, 240) / 240;
  return numericSignals * 4 + supportCount * 2 + metadataCount + textLengthScore;
}

export function selectPreferredInsight(
  left: Insight,
  right: Insight,
  leftOrder: number,
  rightOrder: number,
): { preferred: Insight; secondary: Insight } {
  const leftScore = insightQualityScore(left);
  const rightScore = insightQualityScore(right);
  if (leftScore > rightScore) return { preferred: left, secondary: right };
  if (rightScore > leftScore) return { preferred: right, secondary: left };

  // Stable tie-breaker keeps upstream ordering deterministic.
  if (leftOrder <= rightOrder) return { preferred: left, secondary: right };
  return { preferred: right, secondary: left };
}

function mergeSupportingChunks(
  preferred: Insight,
  secondary: Insight,
): SupportingChunkRef[] | undefined {
  const merged = new Map<string, SupportingChunkRef>();
  for (const ref of preferred.supporting_chunks ?? []) {
    merged.set(toChunkKey(ref), ref);
  }
  for (const ref of secondary.supporting_chunks ?? []) {
    merged.set(toChunkKey(ref), ref);
  }
  return merged.size > 0 ? Array.from(merged.values()) : undefined;
}

function mergeMetadata(
  preferred: Insight,
  secondary: Insight,
): InsightMetadataEntry[] | undefined {
  const merged = new Map<string, InsightMetadataEntry>();
  const put = (entry: InsightMetadataEntry) => {
    const tag = entry.tag?.trim();
    const value = entry.value?.trim();
    if (!tag || !value) return;
    const key = `${normalizeMetadataTag(tag)}:${normalizeMetadataValue(value)}`;
    const existing = merged.get(key);
    if (!existing || (entry.confidence ?? 0) > (existing.confidence ?? 0)) {
      merged.set(key, {
        tag,
        value,
        confidence: entry.confidence,
      });
    }
  };

  for (const entry of preferred.metadata ?? []) put(entry);
  for (const entry of secondary.metadata ?? []) put(entry);

  return merged.size > 0 ? Array.from(merged.values()) : undefined;
}

function normalizeInsightConfidence(confidence: Insight["confidence"]): Insight["confidence"] {
  if (!confidence) return undefined;
  if (typeof confidence.score !== "number" || !Number.isFinite(confidence.score)) return undefined;
  const reasoning = (confidence.reasoning ?? "").trim();
  return {
    score: Math.max(0, Math.min(1, confidence.score)),
    reasoning: reasoning || "Confidence propagated from merged insight.",
  };
}

function readFindingRefsFromAdditionalRefs(insight: Insight): FindingRef[] {
  const record = asRecord(insight.additional_refs);
  if (!record) return [];
  const raw = record.findings;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is FindingRef => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const candidate = item as Partial<FindingRef>;
      return (
        typeof candidate.finding_id === "string" && candidate.finding_id.trim().length > 0
      );
    })
    .map((finding) => ({ ...finding, finding_id: finding.finding_id!.trim() }));
}

function mergeFindingRefs(preferred: Insight, secondary: Insight): FindingRef[] | undefined {
  const merged = new Map<string, FindingRef>();
  const put = (finding: FindingRef) => {
    const findingId = finding.finding_id?.trim();
    if (!findingId) return;
    const existing = merged.get(findingId);
    // Prefer entries that carry evidence_snipped, otherwise keep insertion order stable.
    if (!existing || (!existing.evidence_snipped && finding.evidence_snipped)) {
      merged.set(findingId, { ...existing, ...finding, finding_id: findingId });
    }
  };

  for (const finding of preferred.findings ?? []) put(finding);
  for (const finding of secondary.findings ?? []) put(finding);
  for (const finding of readFindingRefsFromAdditionalRefs(preferred)) put(finding);
  for (const finding of readFindingRefsFromAdditionalRefs(secondary)) put(finding);

  return merged.size > 0 ? Array.from(merged.values()) : undefined;
}

function mergeInsightConfidence(preferred: Insight, secondary: Insight): Insight["confidence"] {
  const preferredConfidence = normalizeInsightConfidence(preferred.confidence);
  const secondaryConfidence = normalizeInsightConfidence(secondary.confidence);
  return preferredConfidence ?? secondaryConfidence;
}

export function collectInsightRefs(insight: Insight, sourceBatchId?: string): InsightRefs {
  const refs: InsightRefs = {
    sourceBatchIds: new Set<string>(),
    mergedFromInsightIds: new Set<string>(),
    findingIds: new Set<string>(),
  };

  if (sourceBatchId) refs.sourceBatchIds.add(sourceBatchId);
  refs.mergedFromInsightIds.add(insight.insight_id);

  const record = asRecord(insight.additional_refs);
  if (!record) return refs;

  for (const id of readStringArray(record, "source_batch_ids")) refs.sourceBatchIds.add(id);
  const singleBatchId = readString(record, "source_batch_id");
  if (singleBatchId) refs.sourceBatchIds.add(singleBatchId);

  for (const id of readStringArray(record, "merged_from_insight_ids")) {
    refs.mergedFromInsightIds.add(id);
  }

  for (const id of readStringArray(record, "finding_ids")) refs.findingIds.add(id);
  return refs;
}

export function mergeInsightPair(
  preferred: Insight,
  secondary: Insight,
  preferredRefs: InsightRefs,
  secondaryRefs: InsightRefs,
): { merged: Insight; refs: InsightRefs } {
  const mergedRefs: InsightRefs = {
    sourceBatchIds: new Set([...preferredRefs.sourceBatchIds, ...secondaryRefs.sourceBatchIds]),
    mergedFromInsightIds: new Set([
      ...preferredRefs.mergedFromInsightIds,
      ...secondaryRefs.mergedFromInsightIds,
    ]),
    findingIds: new Set([...preferredRefs.findingIds, ...secondaryRefs.findingIds]),
  };

  const preferredRecord = asRecord(preferred.additional_refs) ?? {};
  const secondaryRecord = asRecord(secondary.additional_refs) ?? {};
  const additionalRefs: Record<string, unknown> = {
    ...secondaryRecord,
    ...preferredRecord,
  };
  const mergedFindingRefs = mergeFindingRefs(preferred, secondary);

  if (mergedRefs.sourceBatchIds.size > 0) {
    additionalRefs.source_batch_ids = Array.from(mergedRefs.sourceBatchIds);
    additionalRefs.source_batch_id = additionalRefs.source_batch_id
      ?? Array.from(mergedRefs.sourceBatchIds)[0];
  }
  if (mergedRefs.mergedFromInsightIds.size > 0) {
    additionalRefs.merged_from_insight_ids = Array.from(mergedRefs.mergedFromInsightIds);
  }
  if (mergedRefs.findingIds.size > 0) {
    additionalRefs.finding_ids = Array.from(mergedRefs.findingIds);
  }
  if (mergedFindingRefs && mergedFindingRefs.length > 0) {
    additionalRefs.findings = mergedFindingRefs;
  }

  const merged: Insight = {
    ...preferred,
    text: preferred.text,
    parent_insight_id: preferred.parent_insight_id ?? secondary.parent_insight_id,
    supporting_chunks: mergeSupportingChunks(preferred, secondary),
    metadata: mergeMetadata(preferred, secondary),
    confidence: mergeInsightConfidence(preferred, secondary),
    findings: mergedFindingRefs,
    additional_refs: additionalRefs,
  };

  return { merged, refs: mergedRefs };
}
