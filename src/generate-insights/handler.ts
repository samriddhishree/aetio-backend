import { runIngestionPipeline, summarizeProject } from "./graph";
import { listInsights, persistInsights } from "./services/dynamo";
import type { Insight } from "../types";

export type GenerateInsightsArguments = {
  outputUrls?: string[];
  contextUrls?: string[];
  researchContext?: string;
  userId?: string;
  image_blocks?: Array<{ block_id: string; image_s3: string; page: number }>;
  document_id?: string;
};

export type GenerateInsightsEvent = {
  arguments: GenerateInsightsArguments;
};

export const handler = async (event: GenerateInsightsEvent) => {
  const { outputUrls, contextUrls, researchContext, userId } = event.arguments;
  if (!userId) {
    throw new Error("userId is required");
  }
  console.log("userId in generateInsights", userId);
  const extraArgs = event.arguments as unknown as {
    image_blocks?: Array<{ block_id: string; image_s3: string; page: number }>;
    document_id?: string;
  };
  const imageBlocks = extraArgs.image_blocks ?? [];
  const imageDocumentId = extraArgs.document_id;

  if (!outputUrls || outputUrls.length === 0) {
    return JSON.stringify({
      ok: false,
      message: "No outputUrls provided.",
      insights: 0,
      errors: [],
    });
  }

  const safeContextUrls = (contextUrls ?? []).filter(
    (url): url is string => typeof url === "string",
  );
  const safeOutputUrls = (outputUrls ?? []).filter(
    (url): url is string => typeof url === "string",
  );
  const summaryResult = await summarizeProject(
    safeContextUrls,
    researchContext ?? "",
    { userId },
  );
  const { summary, insight_id: projectId} = summaryResult;
  console.log("summaryResult", summaryResult);

  const result = await runIngestionPipeline(
    safeOutputUrls,
    imageBlocks,
    imageDocumentId,
    userId,
    projectId,
  );
  const pendingInsightsNum = result.insights.length;
  // TODO persist summary.additional_refs.pendingInsightsNum = pendingInsightsNum

  return JSON.stringify({
    ok: result.errors.length === 0,
    insights: result.insights.length,
    documents: result.documents.length,
    chunks: result.chunks.length,
    image_chunks: result.imageChunks.length,
    summary: summaryResult.summary,
    errors: result.errors.map((error) => ({
      stage: error.stage,
      message: error.message,
      url: error.url,
      document_id: error.document_id,
    })),
  });
};
