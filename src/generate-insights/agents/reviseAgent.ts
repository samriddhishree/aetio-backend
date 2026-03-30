import type { GraphStateCRV } from "../../common/services/insightMetadata";
import { revisionApplier, RevisionApplier } from "./revisionApplier";
import { semanticRevisionPlanner, SemanticRevisionPlanner } from "./semanticRevisionPlanner";

export class ReviseAgent {
  constructor(
    private readonly planner: SemanticRevisionPlanner = semanticRevisionPlanner,
    private readonly applier: RevisionApplier = revisionApplier,
  ) {}

  // Input: insights[] + critiqueByInsightId
  // Output: revised insights (same schema as input insights)
  async process(state: GraphStateCRV): Promise<Partial<GraphStateCRV>> {
    console.log("ReviseAgent:size", state.insights?.length ?? 0);
    console.debug("ReviseAgent:start", { insights: state.insights.length });
    const plannedActions = await this.planner.plan(state);
    const revised = this.applier.apply(state, plannedActions);

    console.debug("ReviseAgent:end", { revised: revised.length });
    return { insights: revised, revisedInsights: revised };
  }
}

export const reviseAgent = new ReviseAgent();
