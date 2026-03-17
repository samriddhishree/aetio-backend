import type { Document, GraphState, PipelineError } from "../types";
import { config } from "../services/config";
import { loadDocumentText } from "../services/document-loader";
import { hashId, mapWithConcurrency } from "../services/utils";

export async function documentLoaderNode(
  state: GraphState,
): Promise<Partial<GraphState>> {
  console.debug("DocumentLoader:start", { urls: state.outputUrls.length });
  const errors: PipelineError[] = [];

  const documents = await mapWithConcurrency(
    state.outputUrls,
    config.maxConcurrency,
    async (url) => {
      try {
        const { text } = await loadDocumentText(url);
        const document: Document = {
          document_id: hashId(url),
          url,
          text,
        };
        return document;
      } catch (error) {
        errors.push({
          stage: "DocumentLoader",
          message: error instanceof Error ? error.message : "Unknown error",
          url,
          cause: error,
        });
        return null;
      }
    },
  );

  return {
    documents: documents.filter(Boolean) as Document[],
    errors: state.errors.concat(errors),
  };
}
