import type { GraphState, PipelineError } from "../../types";
import { persistInsights } from "../../common/services/dynamo";
import { sanitizeInsightConfidence } from "./insightConfidence";

export async function persistenceNode(
  state: GraphState,
): Promise<Partial<GraphState>> {
  console.log("PersistenceNode:size", state.insights?.length ?? 0);
  console.debug("PersistenceNode:start", { insights: state.insights.length });
  const errors: PipelineError[] = [];
  try {
    const insightsToPersist = state.insights.map((insight) => ({
      ...insight,
      confidence: sanitizeInsightConfidence(
        insight.confidence,
        "Confidence persisted from validated pipeline state.",
      ),
    }));
    await persistInsights(insightsToPersist);
  } catch (error) {
    errors.push({
      stage: "PersistenceNode",
      message: error instanceof Error ? error.message : "Unknown error",
      cause: error,
    });
  }
  let response = {
    errors: state.errors.concat(errors),
  };
  console.debug("PersistenceNode:end", response);
  return response;
}
