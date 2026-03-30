import {
  mergeCritiqueMaps,
  type CritiqueMap,
  type GraphStateCRV,
} from "../../common/services/insightMetadata";
import {
  DeterministicCritiqueAgent,
  deterministicCritiqueAgent,
} from "./deterministicCritiqueAgent";
import {
  SemanticCritiqueAgent,
  semanticCritiqueAgent,
} from "./semanticCritiqueAgent";

export class HybridCritiqueAgent {
  constructor(
    private readonly deterministicAgent: DeterministicCritiqueAgent = deterministicCritiqueAgent,
    private readonly semanticAgent: SemanticCritiqueAgent = semanticCritiqueAgent,
  ) {}

  async process(state: GraphStateCRV): Promise<Partial<GraphStateCRV>> {
    console.log("HybridCritiqueAgent:size", state.insights?.length ?? 0);
    console.debug("HybridCritiqueAgent:start", { insights: state.insights.length });

    const [deterministicResult, semanticResult] = await Promise.all([
      this.deterministicAgent.process(state),
      this.semanticAgent.process(state),
    ]);

    const merged = mergeCritiqueMaps(
      (deterministicResult.critiqueByInsightId ?? {}) as CritiqueMap,
      (semanticResult.critiqueByInsightId ?? {}) as CritiqueMap,
    );
    console.debug("HybridCritiqueAgent:issues", merged);

    console.debug("HybridCritiqueAgent:end", { issues: Object.keys(merged).length });
    return {
      critiqueByInsightId: merged,
      // Semantic critique is the canonical confidence producer.
      confidenceByInsightId: semanticResult.confidenceByInsightId,
      insights: semanticResult.insights ?? state.insights,
    };
  }
}

export const hybridCritiqueAgent = new HybridCritiqueAgent();
