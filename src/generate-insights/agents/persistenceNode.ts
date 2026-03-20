import type { GraphState, PipelineError } from "../../types";
import { persistInsights } from "../services/dynamo";

export async function persistenceNode(
  state: GraphState,
): Promise<Partial<GraphState>> {
  console.debug("PersistenceNode:start", { insights: state.insights.length });
  const errors: PipelineError[] = [];
  try {
    await persistInsights(state.insights);
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
