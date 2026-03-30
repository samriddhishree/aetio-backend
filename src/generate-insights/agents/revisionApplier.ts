import {
  ALLOWED_METADATA_TAGS,
  MIN_METADATA_CONFIDENCE,
  collectMetadataStats,
  consolidateMetadata,
  getConsensusValue,
  normalizeTag,
  normalizeValue,
  type CritiqueIssue,
  type GraphStateCRV,
} from "../../common/services/insightMetadata";
import type { Insight, InsightMetadataEntry, SupportingChunkRef } from "../../types";
import {
  MIN_RETAINED_INSIGHT_CONFIDENCE_SCORE,
  clampConfidence,
  sanitizeInsightConfidence,
  isStrongHallucinationSuspicion,
} from "./insightConfidence";
import type { RevisedInsightAction } from "./revisionTypes";

const METADATA_ISSUE_TYPES: ReadonlySet<CritiqueIssue["type"]> = new Set([
  "low_confidence_metadata",
  "redundant_metadata",
  "low_value_metadata",
  "unsupported_metadata",
  "overly_specific_metadata",
  "metadata_inconsistency",
] as const);

function cloneInsight(insight: Insight): Insight {
  return {
    ...insight,
    supporting_chunks: insight.supporting_chunks ? [...insight.supporting_chunks] : undefined,
    metadata: insight.metadata ? [...insight.metadata] : undefined,
    confidence: insight.confidence ? { ...insight.confidence } : undefined,
  };
}

function dedupeSupportingChunks(
  refs: SupportingChunkRef[] | undefined,
): SupportingChunkRef[] | undefined {
  if (!refs || refs.length === 0) return undefined;
  const unique: SupportingChunkRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.chunk_id}|${ref.paragraph_index ?? ""}|${ref.line_index ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique.length > 0 ? unique : undefined;
}

function hasIssue(issues: CritiqueIssue[], type: string): boolean {
  return issues.some((issue) => issue.type === type);
}

function applyConfidenceUpdate(
  insight: Insight,
  revisedConfidence: RevisedInsightAction["revised_confidence"],
): Insight {
  const normalizedRevised = sanitizeInsightConfidence(revisedConfidence);
  if (normalizedRevised) {
    return { ...insight, confidence: normalizedRevised };
  }

  const existing = sanitizeInsightConfidence(insight.confidence);
  return {
    ...insight,
    confidence:
      existing
      ?? {
        score: 0.5,
        reasoning: "Confidence preserved through revision using available critique confidence.",
      },
  };
}

function retainWithLowConfidence(insight: Insight, reason: string): Insight {
  const existing = sanitizeInsightConfidence(insight.confidence);
  const loweredScore = Math.max(
    MIN_RETAINED_INSIGHT_CONFIDENCE_SCORE,
    Math.min(clampConfidence(existing?.score), 0.35),
  );
  return {
    ...insight,
    confidence: {
      score: loweredScore,
      reasoning: reason,
    },
  };
}

function shouldProcessMetadata(issues: CritiqueIssue[]): boolean {
  return issues.some((issue) => METADATA_ISSUE_TYPES.has(issue.type));
}

function sanitizeMetadataEntries(
  entries: InsightMetadataEntry[] | undefined,
): InsightMetadataEntry[] | undefined {
  const consolidated = consolidateMetadata(entries) ?? [];
  const cleaned = consolidated
    .map((entry) => ({
      tag: normalizeTag(entry.tag),
      value: normalizeValue(entry.value),
      confidence: entry.confidence,
    }))
    .filter((entry) => Boolean(entry.tag) && Boolean(entry.value))
    .filter((entry) => ALLOWED_METADATA_TAGS.has(entry.tag));

  return cleaned.length > 0 ? cleaned : undefined;
}

function applyIssueDrivenMetadataCleanup(
  insight: Insight,
  issues: CritiqueIssue[],
  stats: Map<string, Map<string, Map<string, number>>>,
): InsightMetadataEntry[] | undefined {
  let metadata = sanitizeMetadataEntries(insight.metadata);
  if (!metadata) return undefined;

  if (hasIssue(issues, "unsupported_metadata")) {
    return undefined;
  }

  if (hasIssue(issues, "low_confidence_metadata")) {
    metadata = metadata.filter((entry) => (entry.confidence ?? 1) >= MIN_METADATA_CONFIDENCE);
  }

  if (hasIssue(issues, "low_value_metadata")) {
    const lowerText = insight.text.trim().toLowerCase();
    metadata = metadata.filter((entry) => {
      const lowerValue = entry.value.trim().toLowerCase();
      return lowerValue && lowerValue !== lowerText;
    });
  }

  if (hasIssue(issues, "overly_specific_metadata")) {
    metadata = metadata.flatMap((entry) => {
      const consensus = getConsensusValue(stats, insight.document_id, entry.tag);
      if (consensus) {
        return [{
          ...entry,
          value: normalizeValue(consensus),
        }];
      }
      const tokenCount = entry.value.split(/\s+/).filter(Boolean).length;
      return tokenCount > 4 ? [] : [entry];
    });
  }

  if (hasIssue(issues, "metadata_inconsistency")) {
    metadata = metadata.map((entry) => {
      const consensus = getConsensusValue(stats, insight.document_id, entry.tag);
      if (!consensus) return entry;
      return {
        ...entry,
        value: normalizeValue(consensus),
        confidence: Math.max(entry.confidence ?? 0, MIN_METADATA_CONFIDENCE),
      };
    });
  }

  const deduped = sanitizeMetadataEntries(metadata);
  return deduped && deduped.length > 0 ? deduped : undefined;
}

function sanitizeActionMetadata(
  revisedMetadata: RevisedInsightAction["revised_metadata"],
  existingMetadata: InsightMetadataEntry[] | undefined,
): InsightMetadataEntry[] | undefined {
  if (revisedMetadata === undefined) return existingMetadata;
  if (revisedMetadata.length === 0) return undefined;

  const existingTags = new Set(
    (existingMetadata ?? [])
      .map((entry) => normalizeTag(entry.tag))
      .filter((tag) => ALLOWED_METADATA_TAGS.has(tag)),
  );

  // Conservative guardrail: revisions can clean up existing tags but should not invent new tag families.
  const cleaned = revisedMetadata
    .map((entry) => ({
      tag: normalizeTag(entry.tag),
      value: normalizeValue(entry.value),
      confidence:
        typeof entry.confidence === "number"
          ? Math.max(0, Math.min(1, entry.confidence))
          : undefined,
    }))
    .filter((entry) => Boolean(entry.tag) && Boolean(entry.value))
    .filter((entry) => ALLOWED_METADATA_TAGS.has(entry.tag))
    .filter((entry) => existingTags.size === 0 || existingTags.has(entry.tag));

  return sanitizeMetadataEntries(cleaned);
}

function resolveFinalMergeTarget(
  sourceId: string,
  initialTargetId: string,
  mergeIntents: Map<string, string>,
  removedIds: Set<string>,
): string | undefined {
  let current = initialTargetId;
  const seen = new Set<string>([sourceId]);
  while (mergeIntents.has(current)) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    current = mergeIntents.get(current)!;
  }
  if (seen.has(current)) return undefined;
  if (removedIds.has(current)) return undefined;
  return current;
}

function enforceHierarchyIntegrity(insights: Insight[]): Insight[] {
  const insightById = new Map(insights.map((insight) => [insight.insight_id, insight]));
  const cleaned: Insight[] = [];

  for (const insight of insights) {
    let parentId = insight.parent_insight_id;
    if (parentId) {
      const parent = insightById.get(parentId);
      if (!parent || parent.insight_id === insight.insight_id) {
        parentId = undefined;
      } else if (parent.document_id !== insight.document_id) {
        parentId = undefined;
      } else {
        const seen = new Set<string>([insight.insight_id]);
        let current: Insight | undefined = parent;
        while (current?.parent_insight_id) {
          if (seen.has(current.parent_insight_id)) {
            parentId = undefined;
            break;
          }
          seen.add(current.parent_insight_id);
          current = insightById.get(current.parent_insight_id);
          if (!current) break;
        }
      }
    }

    const trimmedText = insight.text.trim();
    if (!trimmedText) continue;
    cleaned.push({
      ...insight,
      text: trimmedText,
      parent_insight_id: parentId,
      supporting_chunks: dedupeSupportingChunks(insight.supporting_chunks),
    });
  }

  return cleaned;
}

export class RevisionApplier {
  apply(state: GraphStateCRV, actions: RevisedInsightAction[]): Insight[] {
    const critique = state.critiqueByInsightId ?? {};
    const metadataStats = collectMetadataStats(state.insights);
    const insightsById = new Map<string, Insight>();
    const orderedIds: string[] = [];
    for (const insight of state.insights) {
      insightsById.set(insight.insight_id, cloneInsight(insight));
      orderedIds.push(insight.insight_id);
    }

    const actionById = new Map(actions.map((action) => [action.insight_id, action]));
    const removedIds = new Set<string>();
    const mergeIntents = new Map<string, string>();

    for (const insightId of orderedIds) {
      const current = insightsById.get(insightId);
      if (!current) continue;
      const issues = critique[insightId] ?? [];
      const action = actionById.get(insightId);
      const isHallucinationRisk = isStrongHallucinationSuspicion(current, issues);

      if (isHallucinationRisk) {
        // TODO: Reassess deletion policy later.
        // For now, keep suspected hallucinations but downgrade confidence instead of deleting.
        let retained = retainWithLowConfidence(
          current,
          "Strong hallucination suspicion detected; deletion is currently disabled pending policy reassessment.",
        );
        if (hasIssue(issues, "hierarchy_error")) {
          const parentId = retained.parent_insight_id;
          if (!parentId || parentId === retained.insight_id || !insightsById.has(parentId)) {
            retained = { ...retained, parent_insight_id: undefined };
          }
        }
        retained = {
          ...retained,
          metadata: shouldProcessMetadata(issues)
            ? applyIssueDrivenMetadataCleanup(retained, issues, metadataStats)
            : sanitizeMetadataEntries(retained.metadata),
        };
        insightsById.set(insightId, retained);
        continue;
      }

      if (action?.action === "remove") {
        // TODO: Reassess deletion policy later.
        // For now, preserve insights and lower confidence instead of deleting.
        let retained = retainWithLowConfidence(
          current,
          "Requested removal was suppressed by conservative policy; retained with low confidence.",
        );
        if (hasIssue(issues, "hierarchy_error")) {
          const parentId = retained.parent_insight_id;
          if (!parentId || parentId === retained.insight_id || !insightsById.has(parentId)) {
            retained = { ...retained, parent_insight_id: undefined };
          }
        }
        retained = {
          ...retained,
          metadata: shouldProcessMetadata(issues)
            ? applyIssueDrivenMetadataCleanup(retained, issues, metadataStats)
            : sanitizeMetadataEntries(retained.metadata),
        };
        insightsById.set(insightId, retained);
        continue;
      }

      if (action?.action === "merge_into") {
        const targetId = action.merge_target_insight_id?.trim();
        if (targetId && targetId !== insightId && insightsById.has(targetId)) {
          mergeIntents.set(insightId, targetId);
          continue;
        }
      }

      let next = current;
      if (action?.action === "update") {
        const revisedText = action.revised_text?.trim();
        if (revisedText) {
          next = { ...next, text: revisedText };
        }

        if (Object.prototype.hasOwnProperty.call(action, "revised_parent_insight_id")) {
          next = {
            ...next,
            parent_insight_id: action.revised_parent_insight_id ?? undefined,
          };
        }

        if (Object.prototype.hasOwnProperty.call(action, "revised_metadata")) {
          next = {
            ...next,
            metadata: sanitizeActionMetadata(action.revised_metadata, next.metadata),
          };
        }
      }

      if (hasIssue(issues, "hierarchy_error")) {
        const parentId = next.parent_insight_id;
        if (!parentId || parentId === next.insight_id || !insightsById.has(parentId)) {
          next = { ...next, parent_insight_id: undefined };
        }
      }

      if (shouldProcessMetadata(issues)) {
        next = {
          ...next,
          metadata: applyIssueDrivenMetadataCleanup(next, issues, metadataStats),
        };
      } else {
        next = {
          ...next,
          metadata: sanitizeMetadataEntries(next.metadata),
        };
      }

      next = applyConfidenceUpdate(next, action?.revised_confidence);

      insightsById.set(insightId, next);
    }

    for (const [sourceId, intendedTargetId] of mergeIntents.entries()) {
      if (removedIds.has(sourceId)) continue;
      const finalTargetId = resolveFinalMergeTarget(
        sourceId,
        intendedTargetId,
        mergeIntents,
        removedIds,
      );
      if (!finalTargetId || finalTargetId === sourceId) continue;

      const source = insightsById.get(sourceId);
      const target = insightsById.get(finalTargetId);
      if (!source || !target) continue;
      if (source.document_id !== target.document_id) continue;

      const mergedSupporting = dedupeSupportingChunks([
        ...(target.supporting_chunks ?? []),
        ...(source.supporting_chunks ?? []),
      ]);
      const mergedMetadata = sanitizeMetadataEntries([
        ...(target.metadata ?? []),
        ...(source.metadata ?? []),
      ]);
      const mergedConfidence =
        sanitizeInsightConfidence(target.confidence)
        ?? sanitizeInsightConfidence(source.confidence);

      insightsById.set(finalTargetId, {
        ...target,
        supporting_chunks: mergedSupporting,
        metadata: mergedMetadata,
        confidence: mergedConfidence,
      });

      // Preserve hierarchy integrity by moving children under the surviving merged target.
      for (const candidate of insightsById.values()) {
        if (candidate.parent_insight_id !== sourceId) continue;
        candidate.parent_insight_id = finalTargetId;
      }

      removedIds.add(sourceId);
    }

    const retained: Insight[] = [];
    for (const insightId of orderedIds) {
      if (removedIds.has(insightId)) continue;
      const insight = insightsById.get(insightId);
      if (!insight) continue;

      if (insight.parent_insight_id && removedIds.has(insight.parent_insight_id)) {
        retained.push({
          ...insight,
          parent_insight_id: undefined,
        });
        continue;
      }
      retained.push(insight);
    }

    return enforceHierarchyIntegrity(retained);
  }
}

export const revisionApplier = new RevisionApplier();
