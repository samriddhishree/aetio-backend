import type { Insight } from "../../types";
import {
  ALLOWED_METADATA_TAGS,
  MIN_METADATA_CONFIDENCE,
  collectMetadataStats,
  shouldHaveSubInsights,
  type CritiqueMap,
  type GraphStateCRV,
} from "../../common/services/insightMetadata";

const addIssue = (critique: CritiqueMap, insightId: string, issue: string) => {
  critique[insightId] = critique[insightId] ?? [];
  critique[insightId].push(issue);
};

export class CritiqueAgent {
  // Input: insights[] (flat list with parent_insight_id representing hierarchy)
  // Output: critiqueByInsightId: { [insight_id]: string[] }
  async process(state: GraphStateCRV): Promise<Partial<GraphStateCRV>> {
    console.debug("CritiqueAgent:start", { insights: state.insights.length });

    const critique: CritiqueMap = {};
    const insightById = new Map(
      state.insights.map((insight) => [insight.insight_id, insight]),
    );
    const childrenByParent = new Map<string, Insight[]>();

    for (const insight of state.insights) {
      if (!insight.parent_insight_id) continue;
      const list = childrenByParent.get(insight.parent_insight_id) ?? [];
      list.push(insight);
      childrenByParent.set(insight.parent_insight_id, list);

      if (!insightById.has(insight.parent_insight_id)) {
        addIssue(
          critique,
          insight.insight_id,
          "Hierarchy issue: parent_insight_id not found.",
        );
      }
    }

    const metadataStats = collectMetadataStats(state.insights);

    for (const insight of state.insights) {
      if (!insight.supporting_chunks || insight.supporting_chunks.length === 0) {
        addIssue(
          critique,
          insight.insight_id,
          "Missing supporting_chunks; insight may be unsupported.",
        );
      }

      for (const entry of insight.metadata ?? []) {
        if ((entry.confidence ?? 1) < MIN_METADATA_CONFIDENCE) {
          addIssue(
            critique,
            insight.insight_id,
            `Low-confidence metadata: ${entry.tag} (${entry.confidence}).`,
          );
        }
      }

      if (!childrenByParent.has(insight.insight_id) && shouldHaveSubInsights(insight.text)) {
        addIssue(
          critique,
          insight.insight_id,
          "Possible missing sub-insights based on phrasing.",
        );
      }

      if (insight.parent_insight_id === insight.insight_id) {
        addIssue(
          critique,
          insight.insight_id,
          "Hierarchy issue: insight references itself as parent.",
        );
      }
    }

    for (const insight of state.insights) {
      let current = insight;
      const seen = new Set<string>([insight.insight_id]);
      while (current.parent_insight_id) {
        const parent = insightById.get(current.parent_insight_id);
        if (!parent) break;
        if (seen.has(parent.insight_id)) {
          addIssue(
            critique,
            insight.insight_id,
            "Hierarchy issue: cycle detected in parent chain.",
          );
          break;
        }
        seen.add(parent.insight_id);
        current = parent;
      }
    }

    for (const insight of state.insights) {
      const docStats = metadataStats.get(insight.document_id);
      if (!docStats) continue;

      for (const entry of insight.metadata ?? []) {
        const tag = (entry.tag ?? "").trim().toLowerCase();
        if (!ALLOWED_METADATA_TAGS.has(tag)) continue;
        const values = docStats.get(tag);
        if (!values || values.size <= 1) continue;
        addIssue(
          critique,
          insight.insight_id,
          `Metadata inconsistency for ${tag}: multiple values observed.`,
        );
      }
    }

    console.debug("CritiqueAgent:end", { issues: Object.keys(critique).length });
    return { critiqueByInsightId: critique };
  }
}

export const critiqueAgent = new CritiqueAgent();
