import type { GraphStateCRV } from "../../common/services/insightMetadata";
import { HybridCritiqueAgent, hybridCritiqueAgent } from "./hybridCritiqueAgent";

export class CritiqueAgent {
  // Backward-compatible entrypoint used by the graph node.
  // Delegates to the new hybrid deterministic + semantic critique pipeline.
  constructor(private readonly agent: HybridCritiqueAgent = hybridCritiqueAgent) {}

  async process(state: GraphStateCRV): Promise<Partial<GraphStateCRV>> {
    console.log("CritiqueAgent:size", state.insights?.length ?? 0);
    return this.agent.process(state);
  }
}

export const critiqueAgent = new CritiqueAgent();
