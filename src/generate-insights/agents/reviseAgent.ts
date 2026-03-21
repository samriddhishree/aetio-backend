import type { Insight, InsightMetadataEntry } from "../../types";
import {
  ALLOWED_METADATA_TAGS,
  MIN_METADATA_CONFIDENCE,
  collectMetadataStats,
  consolidateMetadata,
  getConsensusValue,
  normalizeTag,
  normalizeValue,
  type GraphStateCRV,
} from "../../common/services/insightMetadata";

export class ReviseAgent {
  // Input: insights[] + critiqueByInsightId
  // Output: revised insights (same schema as input insights)
  async process(state: GraphStateCRV): Promise<Partial<GraphStateCRV>> {
    console.debug("ReviseAgent:start", { insights: state.insights.length });

    const critique = state.critiqueByInsightId ?? {};
    const metadataStats = collectMetadataStats(state.insights);
    const revised: Insight[] = [];

    for (const insight of state.insights) {
      const issues = critique[insight.insight_id] ?? [];
      const hasSupport = (insight.supporting_chunks?.length ?? 0) > 0;

      if (!hasSupport || issues.some((issue) => issue.toLowerCase().includes("unsupported"))) {
        continue;
      }

      const trimmedText = insight.text.trim();
      if (!trimmedText) continue;

      let metadata = consolidateMetadata(insight.metadata) ?? [];
      metadata = metadata.filter(
        (entry) => (entry.confidence ?? 1) >= MIN_METADATA_CONFIDENCE,
      );

      const alignedMetadata: InsightMetadataEntry[] = [];
      for (const entry of metadata) {
        const tag = normalizeTag(entry.tag);
        if (!ALLOWED_METADATA_TAGS.has(tag)) continue;
        const consensus = getConsensusValue(metadataStats, insight.document_id, tag);
        if (consensus && normalizeValue(entry.value) !== consensus) {
          alignedMetadata.push({
            tag,
            value: consensus,
            confidence: Math.max(entry.confidence ?? 0, MIN_METADATA_CONFIDENCE),
          });
          continue;
        }
        alignedMetadata.push({
          tag,
          value: normalizeValue(entry.value),
          confidence: entry.confidence ?? 1,
        });
      }

      revised.push({
        ...insight,
        text: trimmedText,
        metadata: alignedMetadata.length > 0 ? alignedMetadata : undefined,
      });
    }

    console.debug("ReviseAgent:end", { revised: revised.length });
    return { insights: revised, revisedInsights: revised };
  }
}

export const reviseAgent = new ReviseAgent();
