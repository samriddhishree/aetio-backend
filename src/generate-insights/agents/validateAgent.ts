import type { Insight, InsightMetadataEntry, PipelineError } from "../types";
import {
  ALLOWED_METADATA_TAGS,
  MIN_METADATA_CONFIDENCE,
  collectMetadataStats,
  consolidateMetadata,
  getConsensusValue,
  normalizeTag,
  normalizeValue,
  type GraphStateCRV,
} from "../services/insightMetadata";

export class ValidateAgent {
  // Input: revised insights[]
  // Output: validated insights[] (insights that pass validation)
  async process(state: GraphStateCRV): Promise<Partial<GraphStateCRV>> {
    console.debug("ValidateAgent:start", { insights: state.insights.length });

    const errors: PipelineError[] = [];
    const validated: Insight[] = [];
    const metadataStats = collectMetadataStats(state.insights);
    const insightById = new Map(
      state.insights.map((insight) => [insight.insight_id, insight]),
    );

    for (const insight of state.insights) {
      if (!insight.supporting_chunks || insight.supporting_chunks.length === 0) {
        errors.push({
          stage: "ValidateAgent",
          message: `Insight ${insight.insight_id} missing supporting_chunks.`,
          document_id: insight.document_id,
        });
        continue;
      }

      let metadata = consolidateMetadata(insight.metadata) ?? [];
      metadata = metadata.filter((entry) => ALLOWED_METADATA_TAGS.has(normalizeTag(entry.tag)));

      const alignedMetadata: InsightMetadataEntry[] = [];
      for (const entry of metadata) {
        const tag = normalizeTag(entry.tag);
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

      let parentId = insight.parent_insight_id;
      if (parentId && !insightById.has(parentId)) {
        errors.push({
          stage: "ValidateAgent",
          message: `Insight ${insight.insight_id} references missing parent ${parentId}.`,
          document_id: insight.document_id,
        });
        parentId = undefined;
      }

      validated.push({
        ...insight,
        parent_insight_id: parentId,
        metadata: alignedMetadata.length > 0 ? alignedMetadata : undefined,
      });
    }

    console.debug("ValidateAgent:end", {
      validated: validated.length,
      errors: errors.length,
    });

    return {
      insights: validated,
      validatedInsights: validated,
      errors: state.errors.concat(errors),
    };
  }
}

export const validateAgent = new ValidateAgent();
