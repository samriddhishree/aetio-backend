import { Annotation, StateGraph } from "@langchain/langgraph";
import type {
  Chunk,
  Document,
  GraphState,
  Insight,
  ImageBlock,
  ImageChunk,
  PipelineError,
} from "./types";
import { assertConfig } from "./services/config";
import { documentLoaderNode } from "./agents/documentLoader";
import { chunkingNode } from "./agents/chunkingNode";
//import { imageExtractionAgent } from "./agents/imageExtractionAgent";
import { insightExtractionAgent } from "./agents/insightExtractionAgent";
import { hierarchyBuilderAgent } from "./agents/hierarchyBuilderAgent";
import { metadataAgent } from "./agents/metadataAgent";
import { critiqueAgent } from "./agents/critiqueAgent";
import { reviseAgent } from "./agents/reviseAgent";
import { validateAgent } from "./agents/validateAgent";
import { metadataConsolidationAgent } from "./agents/metadataConsolidationAgent";
import { persistenceNode } from "./agents/persistenceNode";
import { indexingNode } from "./agents/indexingNode";
import { summarizeAgent } from "./agents/summarizeAgent";
import { persistInsights } from "./services/dynamo";
import { hashId } from "./services/utils";

const START = "__start__";
const END = "__end__";

const mergeArray = <T>(left: T[], right: T[]) => left.concat(right);
const overwrite = <T>(left: T, right: T) => right ?? left;
const mergeRecord = (left: Record<string, string>, right: Record<string, string>) => ({
  ...left,
  ...right,
});

const mergeIssues = (
  left: Record<string, string[]>,
  right: Record<string, string[]>,
) => {
  const merged: Record<string, string[]> = { ...left };
  for (const [insightId, issues] of Object.entries(right)) {
    merged[insightId] = (merged[insightId] ?? []).concat(issues);
  }
  return merged;
};

const mergeInsights = (left: Insight[], right: Insight[]) => {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const byId = new Map<string, Insight>();
  const order: string[] = [];

  for (const insight of left) {
    byId.set(insight.insight_id, insight);
    order.push(insight.insight_id);
  }

  for (const insight of right) {
    const existing = byId.get(insight.insight_id);
    if (!existing) {
      byId.set(insight.insight_id, insight);
      order.push(insight.insight_id);
      continue;
    }
    byId.set(insight.insight_id, {
      ...existing,
      ...insight,
      supporting_chunks: insight.supporting_chunks ?? existing.supporting_chunks,
      metadata: insight.metadata ?? existing.metadata,
      parent_insight_id: insight.parent_insight_id ?? existing.parent_insight_id,
    });
  }

  return order.map((id) => byId.get(id)!).filter(Boolean);
};

const GraphStateAnnotation = Annotation.Root({
  outputUrls: Annotation<string[]>({ value: mergeArray, default: () => [] }),
  contextUrls: Annotation<string[] | undefined>({ value: overwrite, default: () => undefined }),
  researchContext: Annotation<string | undefined>({ value: overwrite, default: () => undefined }),
  userId: Annotation<string | undefined>({ value: overwrite, default: () => undefined }),
  projectId: Annotation<string | undefined>({ value: overwrite, default: () => undefined }),
  summary: Annotation<string | undefined>({ value: overwrite, default: () => undefined }),
  imageDocumentId: Annotation<string | undefined>({ value: overwrite, default: () => undefined }),
  imageBlocks: Annotation<ImageBlock[]>({ value: mergeArray, default: () => [] }),
  documents: Annotation<Document[]>({ value: mergeArray, default: () => [] }),
  chunks: Annotation<Chunk[]>({ value: mergeArray, default: () => [] }),
  imageChunks: Annotation<ImageChunk[]>({ value: mergeArray, default: () => [] }),
  insights: Annotation<Insight[]>({ value: mergeInsights, default: () => [] }),
  critiqueByInsightId: Annotation<Record<string, string[]>>({
    value: mergeIssues,
    default: () => ({}),
  }),
  revisedInsights: Annotation<Insight[] | undefined>({ value: overwrite, default: () => undefined }),
  validatedInsights: Annotation<Insight[] | undefined>({ value: overwrite, default: () => undefined }),
  sourceTextByS3Node: Annotation<Record<string, string>>({
    value: mergeRecord,
    default: () => ({}),
  }),
  errors: Annotation<PipelineError[]>({ value: mergeArray, default: () => [] }),
});



export function buildIngestionGraph() {
  return new StateGraph(GraphStateAnnotation)
    .addNode("DocumentLoader", documentLoaderNode)
    .addNode("ChunkingNode", chunkingNode)
    //.addNode("ImageExtractionAgent", imageExtractionAgent)
    .addNode("InsightExtractionAgent", insightExtractionAgent)
    .addNode("CritiqueAgent", (state) => critiqueAgent.process(state))
    .addNode("ReviseAgent", (state) => reviseAgent.process(state))
    .addNode("ValidateAgent", (state) => validateAgent.process(state))
    .addNode("MetadataConsolidationAgent", (state) =>
      metadataConsolidationAgent.process(state),
    )
    .addNode("HierarchyBuilderAgent", hierarchyBuilderAgent)
    //.addNode("MetadataAgent", metadataAgent)
    .addNode("PersistenceNode", persistenceNode)
    //.addNode("IndexingNode", indexingNode)
    .addEdge(START, "DocumentLoader")
    .addEdge("DocumentLoader", "ChunkingNode")
    .addEdge("ChunkingNode", "InsightExtractionAgent")
    //.addEdge("ImageExtractionAgent", "InsightExtractionAgent")
    .addEdge("InsightExtractionAgent", "CritiqueAgent")
    .addEdge("CritiqueAgent", "ReviseAgent")
    .addEdge("ReviseAgent", "ValidateAgent")
    .addEdge("ValidateAgent", "MetadataConsolidationAgent")
    .addEdge("MetadataConsolidationAgent", "HierarchyBuilderAgent")
    //.addEdge("HierarchyBuilderAgent", "MetadataAgent")
   .addEdge("HierarchyBuilderAgent", "PersistenceNode")
    // .addEdge("PersistenceNode", "IndexingNode")
    // .addEdge("IndexingNode", END)
    .addEdge("PersistenceNode", END)
    .compile();
}

export async function summarizeProject(
  contextUrls: string[],
  researchContext: string,
  options?: {
    userId?: string;
    status?: string;
    documentId?: string;
  },
): Promise<{ summary: string; insight_id?: string }> {
  const state: GraphState = {
    outputUrls: [],
    contextUrls,
    researchContext,
    summary: undefined,
    imageDocumentId: undefined,
    imageBlocks: [],
    documents: [],
    chunks: [],
    imageChunks: [],
    insights: [],
    sourceTextByS3Node: {},
    errors: [],
  };

  const result = await summarizeAgent(state);
  const summary = result.summary?.trim() ?? "";

  if (!summary) {
    return { summary: "" };
  }

  const documentId =
    options?.documentId ??
    hashId(`${researchContext}:${contextUrls.join("|")}`);
  const insightId = hashId(`${documentId}:summary`);

  await persistInsights([
    {
      insight_id: insightId,
      text: summary,
      s3_node: `summary:${documentId}`,
      document_id: documentId,
      additional_refs: { contextUrls },
      user_id: options?.userId,
      status: options?.status ?? "In Progress",
    },
  ]);

  return { summary, insight_id: insightId };
}

export async function runIngestionPipeline(
  outputUrls: string[],
  imageBlocks: ImageBlock[] = [],
  imageDocumentId?: string,
  userId?: string,
  projectId?: string,
): Promise<GraphState> {
  assertConfig();
  const graph = buildIngestionGraph();
  return graph.invoke({
    outputUrls,
    imageBlocks,
    imageDocumentId: imageDocumentId ?? undefined,
    userId: userId ?? undefined,
    projectId: projectId ?? undefined,
  });
}
