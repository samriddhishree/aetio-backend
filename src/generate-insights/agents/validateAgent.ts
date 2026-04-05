import type { Insight, InsightMetadataEntry, PipelineError } from "../../types";
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
import { clampConfidence, sanitizeInsightConfidence } from "./insightConfidence";

const HALLUCINATION_RISK_ISSUES = new Set<string>([
  "missing_support",
  "weak_evidence_grounding",
  "irrelevant_insight",
  "unsupported_by_children",
] as const);

function applyValidationConfidence(
  insight: Insight,
  unresolvedHighIssueTypes: string[],
): Insight["confidence"] {
  const base = sanitizeInsightConfidence(
    insight.confidence,
    "Confidence initialized during validation because critique confidence was missing.",
  ) ?? {
    score: 0.5,
    reasoning: "Confidence initialized during validation because critique confidence was missing.",
  };

  if (unresolvedHighIssueTypes.length === 0) {
    return base;
  }

  const hasHallucinationRisk = unresolvedHighIssueTypes.some((type) =>
    HALLUCINATION_RISK_ISSUES.has(type)
  );
  const penalty = hasHallucinationRisk
    ? 0.25
    : Math.min(0.15, unresolvedHighIssueTypes.length * 0.05);

  return {
    score: clampConfidence(base.score - penalty),
    reasoning: `Validation lowered confidence due unresolved high-severity issues: ${unresolvedHighIssueTypes.join(", ")}.`,
  };
}

export class ValidateAgent {
  // Input: revised insights[]
  // Output: validated insights[] with metadata/hierarchy cleanup and confidence sanity checks
  async process(state: GraphStateCRV): Promise<Partial<GraphStateCRV>> {
    console.log("ValidateAgent:size", state.insights?.length ?? 0);
    console.debug("ValidateAgent:start", { insights: state.insights.length });

    const errors: PipelineError[] = [];
    const validated: Insight[] = [];
    const metadataStats = collectMetadataStats(state.insights);
    const critique = state.critiqueByInsightId ?? {};
    const insightById = new Map(state.insights.map((insight) => [insight.insight_id, insight]));

    for (const insight of state.insights) {
      if (!insight.supporting_chunks || insight.supporting_chunks.length === 0) {
        errors.push({
          stage: "ValidateAgent",
          message: `Insight ${insight.insight_id} missing supporting_chunks.`,
          document_id: insight.document_id,
        });
      }
      if (!insight.evidence_snippet || insight.evidence_snippet.trim().length === 0) {
        errors.push({
          stage: "ValidateAgent",
          message: `Insight ${insight.insight_id} missing evidence_snippet.`,
          document_id: insight.document_id,
        });
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

      const unresolvedHighIssueTypes = (critique[insight.insight_id] ?? [])
        .filter((issue) => issue.severity === "high")
        .map((issue) => issue.type);

      validated.push({
        ...insight,
        // Preserve a non-empty evidence_snippet for downstream persistence/search.
        evidence_snippet: insight.evidence_snippet?.trim() || insight.text,
        parent_insight_id: parentId,
        metadata: alignedMetadata.length > 0 ? alignedMetadata : undefined,
        confidence: applyValidationConfidence(insight, unresolvedHighIssueTypes),
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
