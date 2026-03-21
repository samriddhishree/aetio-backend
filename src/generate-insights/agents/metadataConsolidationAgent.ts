import {
  consolidateMetadata,
  type GraphStateCRV,
} from "../../common/services/insightMetadata";

export class MetadataConsolidationAgent {
  // Input: insights[]
  // Output: insights[] with minimal, consolidated metadata tags
  async process(state: GraphStateCRV): Promise<Partial<GraphStateCRV>> {
    console.debug("MetadataConsolidationAgent:start", { insights: state.insights.length });

    const consolidated = state.insights.map((insight) => ({
      ...insight,
      metadata: consolidateMetadata(insight.metadata) ?? undefined,
    }));

    console.debug("MetadataConsolidationAgent:end", { insights: consolidated.length });
    return { insights: consolidated };
  }
}

export const metadataConsolidationAgent = new MetadataConsolidationAgent();
