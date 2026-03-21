import type { GraphState, PipelineError } from "../../types";
import { indexInsights } from "../../common/services/elasticsearch";

export async function indexingNode(
  state: GraphState,
): Promise<Partial<GraphState>> {
  console.debug("IndexingNode:start", { insights: state.insights.length });
  const errors: PipelineError[] = [];
  try {
    await indexInsights(state.insights);
  } catch (error) {
    errors.push({
      stage: "IndexingNode",
      message: error instanceof Error ? error.message : "Unknown error",
      cause: error,
    });
  }

  return {
    errors: state.errors.concat(errors),
  };
}
