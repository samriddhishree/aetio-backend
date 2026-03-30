import { Annotation, StateGraph } from "@langchain/langgraph";
import type {
  BatchInsightResult,
  Chunk,
  Document,
  Finding,
  FindingBatch,
  GraphState,
  Insight,
  InsightConfidence,
  ImageBlock,
  ImageChunk,
  PipelineError,
  UserInfo,
} from "../types";
import { assertConfig } from "../common/services/config";
import { documentLoaderNode } from "./agents/documentLoader";
import { chunkingNode } from "./agents/chunkingNode";
//import { imageExtractionAgent } from "./agents/imageExtractionAgent";
import { findingExtractionAgent } from "./agents/findingExtractionAgent";
import { findingBatchingAgent } from "./agents/findingBatchingAgent";
import { insightExtractionAgent } from "./agents/insightExtractionAgent";
import { crossBatchMergeAgent } from "./agents/crossBatchMergeAgent";
import { hierarchyFinalizeAgent } from "./agents/hierarchyFinalizeAgent";
import { critiqueAgent } from "./agents/critiqueAgent";
import { reviseAgent } from "./agents/reviseAgent";
import { validateAgent } from "./agents/validateAgent";
import { metadataConsolidationAgent } from "./agents/metadataConsolidationAgent";
import { persistenceNode } from "./agents/persistenceNode";
import { summarizeAgent } from "./agents/summarizeAgent";
import { persistInsights } from "../common/services/dynamo";
import { hashId } from "../common/services/utils";
import { mergeCritiqueMaps, type CritiqueMap } from "../common/services/insightMetadata";

const START = "__start__";
const END = "__end__";

const mergeArray = <T>(left: T[], right: T[]) => left.concat(right);
const overwrite = <T>(left: T, right: T) => right ?? left;
const mergeRecord = (left: Record<string, string>, right: Record<string, string>) => ({
  ...left,
  ...right,
});

const mergeIssues = (left: CritiqueMap, right: CritiqueMap) => mergeCritiqueMaps(left, right);

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

const mergeFindings = (left: Finding[], right: Finding[]) => {
  if (left.length === 0) return right;
  if (right.length === 0) return left;

  const byId = new Map<string, Finding>();
  const order: string[] = [];

  for (const finding of left) {
    byId.set(finding.finding_id, finding);
    order.push(finding.finding_id);
  }

  for (const finding of right) {
    if (!byId.has(finding.finding_id)) {
      order.push(finding.finding_id);
    }
    byId.set(finding.finding_id, finding);
  }

  return order.map((id) => byId.get(id)!).filter(Boolean);
};

const GraphStateAnnotation = Annotation.Root({
  outputUrls: Annotation<string[]>({ value: mergeArray, default: () => [] }),
  contextUrls: Annotation<string[] | undefined>({ value: overwrite, default: () => undefined }),
  researchContext: Annotation<string | undefined>({ value: overwrite, default: () => undefined }),
  userId: Annotation<string | undefined>({ value: overwrite, default: () => undefined }),
  userInfo: Annotation<UserInfo | undefined>({ value: overwrite, default: () => undefined }),
  projectId: Annotation<string | undefined>({ value: overwrite, default: () => undefined }),
  summary: Annotation<string | undefined>({ value: overwrite, default: () => undefined }),
  imageDocumentId: Annotation<string | undefined>({ value: overwrite, default: () => undefined }),
  imageBlocks: Annotation<ImageBlock[]>({ value: mergeArray, default: () => [] }),
  documents: Annotation<Document[]>({ value: mergeArray, default: () => [] }),
  chunks: Annotation<Chunk[]>({ value: mergeArray, default: () => [] }),
  findings: Annotation<Finding[]>({ value: mergeFindings, default: () => [] }),
  finding_batches: Annotation<FindingBatch[]>({ value: overwrite, default: () => [] }),
  batch_insights: Annotation<BatchInsightResult[]>({ value: overwrite, default: () => [] }),
  imageChunks: Annotation<ImageChunk[]>({ value: mergeArray, default: () => [] }),
  insights: Annotation<Insight[]>({ value: overwrite, default: () => [] }),
  critiqueByInsightId: Annotation<CritiqueMap>({
    value: mergeIssues,
    default: () => ({}),
  }),
  confidenceByInsightId: Annotation<Record<string, InsightConfidence> | undefined>({
    value: overwrite,
    default: () => undefined,
  }),
  revisedInsights: Annotation<Insight[] | undefined>({ value: overwrite, default: () => undefined }),
  validatedInsights: Annotation<Insight[] | undefined>({ value: overwrite, default: () => undefined }),
  sourceTextByS3Node: Annotation<Record<string, string>>({
    value: mergeRecord,
    default: () => ({}),
  }),
  errors: Annotation<PipelineError[]>({ value: mergeArray, default: () => [] }),
});



export function buildIngestionGraph(options?: { skipDocumentAndChunking?: boolean }) {
  const skipDocumentAndChunking = options?.skipDocumentAndChunking ?? false;

  if (skipDocumentAndChunking) {
    return new StateGraph(GraphStateAnnotation)
      // Finding extraction is a generalized evidence layer for both data-heavy and narrative documents.
      .addNode("FindingExtractionAgent", (state) => findingExtractionAgent.process(state))
      .addNode("FindingBatchingAgent", (state) => findingBatchingAgent.process(state))
      //.addNode("ImageExtractionAgent", imageExtractionAgent)
      .addNode("InsightExtractionAgent", insightExtractionAgent)
      .addNode("CrossBatchMergeAgent", (state) => crossBatchMergeAgent.process(state))
      .addNode("CritiqueAgent", (state) => critiqueAgent.process(state))
      .addNode("ReviseAgent", (state) => reviseAgent.process(state))
      .addNode("ValidateAgent", (state) => validateAgent.process(state))
      .addNode("MetadataConsolidationAgent", (state) =>
        metadataConsolidationAgent.process(state),
      )
      .addNode("HierarchyFinalizeAgent", (state) => hierarchyFinalizeAgent.process(state))
      .addNode("PersistenceNode", persistenceNode)
      .addEdge(START, "FindingExtractionAgent")
      .addEdge("FindingExtractionAgent", "FindingBatchingAgent")
      .addEdge("FindingBatchingAgent", "InsightExtractionAgent")
      //.addEdge("ImageExtractionAgent", "InsightExtractionAgent")
      .addEdge("InsightExtractionAgent", "CrossBatchMergeAgent")
      .addEdge("CrossBatchMergeAgent", "CritiqueAgent")
      .addEdge("CritiqueAgent", "ReviseAgent")
      .addEdge("ReviseAgent", "ValidateAgent")
      .addEdge("ValidateAgent", "MetadataConsolidationAgent")
      .addEdge("MetadataConsolidationAgent", "HierarchyFinalizeAgent")
      .addEdge("HierarchyFinalizeAgent", "PersistenceNode")
      .addEdge("PersistenceNode", END)
      .compile();
  }

  return new StateGraph(GraphStateAnnotation)
    .addNode("DocumentLoader", documentLoaderNode)
    .addNode("ChunkingNode", chunkingNode)
    // Finding extraction is a generalized evidence layer for both data-heavy and narrative documents.
    .addNode("FindingExtractionAgent", (state) => findingExtractionAgent.process(state))
    .addNode("FindingBatchingAgent", (state) => findingBatchingAgent.process(state))
    //.addNode("ImageExtractionAgent", imageExtractionAgent)
    .addNode("InsightExtractionAgent", insightExtractionAgent)
    .addNode("CrossBatchMergeAgent", (state) => crossBatchMergeAgent.process(state))
    .addNode("CritiqueAgent", (state) => critiqueAgent.process(state))
    .addNode("ReviseAgent", (state) => reviseAgent.process(state))
    .addNode("ValidateAgent", (state) => validateAgent.process(state))
    .addNode("MetadataConsolidationAgent", (state) =>
      metadataConsolidationAgent.process(state),
    )
    .addNode("HierarchyFinalizeAgent", (state) => hierarchyFinalizeAgent.process(state))
    .addNode("PersistenceNode", persistenceNode)
    .addEdge(START, "DocumentLoader")
    .addEdge("DocumentLoader", "ChunkingNode")
    .addEdge("ChunkingNode", "FindingExtractionAgent")
    .addEdge("FindingExtractionAgent", "FindingBatchingAgent")
    .addEdge("FindingBatchingAgent", "InsightExtractionAgent")
    //.addEdge("ImageExtractionAgent", "InsightExtractionAgent")
    .addEdge("InsightExtractionAgent", "CrossBatchMergeAgent")
    .addEdge("CrossBatchMergeAgent", "CritiqueAgent")
    .addEdge("CritiqueAgent", "ReviseAgent")
    .addEdge("ReviseAgent", "ValidateAgent")
    .addEdge("ValidateAgent", "MetadataConsolidationAgent")
    .addEdge("MetadataConsolidationAgent", "HierarchyFinalizeAgent")
    .addEdge("HierarchyFinalizeAgent", "PersistenceNode")
    .addEdge("PersistenceNode", END)
    .compile();
}

export async function summarizeProject(
  contextUrls: string[],
  researchContext: string,
  options?: {
    userId?: string;
    userInfo?: UserInfo;
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
    findings: [],
    finding_batches: [],
    batch_insights: [],
    imageChunks: [],
    insights: [],
    sourceTextByS3Node: {},
    errors: [],
  };

  const result = await summarizeAgent(state);
  const summarizeErrors = (result.errors ?? []).filter(
    (error) => error.stage === "SummarizeAgent",
  );
  if (summarizeErrors.length > 0) {
    const firstError = summarizeErrors[0];
    const errorDetails = firstError.url
      ? `${firstError.message} (url: ${firstError.url})`
      : firstError.message;
    throw new Error(`SummarizeAgent failed: ${errorDetails}`);
  }
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
      parent_insight_id: undefined,
      text: summary,
      s3_node: `summary:${documentId}`,
      document_id: documentId,
      additional_refs: { contextUrls },
      confidence: {
        score: 0.7,
        reasoning: "Project summary generated from consolidated context inputs.",
      },
      user_id: options?.userId,
      user_info: options?.userInfo,
      status: options?.status ?? "Pending",
    },
  ]);
  console.log("New project ID is ", insightId)
  return { summary, insight_id: insightId };
}

export async function runIngestionPipeline(
  outputUrls: string[],
  imageBlocks: ImageBlock[] = [],
  imageDocumentId?: string,
  userId?: string,
  userInfo?: UserInfo,
  projectId?: string,
): Promise<GraphState> {
  assertConfig();
  const graph = buildIngestionGraph();
  return graph.invoke({
    outputUrls,
    imageBlocks,
    imageDocumentId: imageDocumentId ?? undefined,
    userId: userId ?? undefined,
    userInfo: userInfo ?? undefined,
    projectId: projectId ?? undefined,
  });
}

export async function runIngestionPipelineFromChunks(
  chunks: Chunk[],
  userId?: string,
  userInfo?: UserInfo,
  projectId?: string,
): Promise<GraphState> {
  assertConfig();
  const graph = buildIngestionGraph({ skipDocumentAndChunking: true });
  const sourceTextByS3Node = chunks.reduce<Record<string, string>>((acc, chunk) => {
    acc[chunk.s3_node] = chunk.content;
    return acc;
  }, {});

  return graph.invoke({
    outputUrls: [],
    documents: [],
    chunks,
    findings: [],
    finding_batches: [],
    batch_insights: [],
    imageChunks: [],
    insights: [],
    sourceTextByS3Node,
    errors: [],
    userId: userId ?? undefined,
    userInfo: userInfo ?? undefined,
    projectId: projectId ?? undefined,
  });
}
