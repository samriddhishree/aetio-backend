import type { Document, GraphState, PipelineError } from "../../types";
import { config } from "../../common/services/config";
import { loadDocumentText } from "../../common/services/document-loader";
import { hashId, mapWithConcurrency } from "../../common/services/utils";

export async function documentLoaderNode(
  state: GraphState,
): Promise<Partial<GraphState>> {
  console.debug("DocumentLoader:start", { urls: state.outputUrls.length });
  try {
    const documents = await mapWithConcurrency(
      state.outputUrls,
      config.maxConcurrency,
      async (url) => {
        const { text } = await loadDocumentText(url);
        const document: Document = {
          document_id: hashId(url),
          url,
          text,
        };
        return document;
      },
    );

    return {
      documents,
      errors: state.errors,
    };
  } catch (error) {
    const pipelineError: PipelineError = {
      stage: "DocumentLoader",
      message: error instanceof Error ? error.message : "Unknown error",
      cause: error,
    };
    const wrapped = new Error(`DocumentLoader failed: ${pipelineError.message}`);
    (wrapped as Error & { cause?: unknown }).cause = pipelineError;
    throw wrapped;
  }
}
