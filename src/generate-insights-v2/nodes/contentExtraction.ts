import { config } from "../../common/services/config";
import { loadDocumentElements, type UnstructuredElement } from "../../common/services/document-loader";
import { mapWithConcurrency } from "../../common/services/utils";
import type { PipelineError } from "../../types";
import type { GenerateInsightsV2State, V2ExtractedDocument, V2ExtractedElement } from "../types";

function toMetadataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeElement(element: UnstructuredElement, index: number): V2ExtractedElement {
  const metadata = toMetadataRecord(element.metadata);
  const elementId =
    typeof element.element_id === "string" && element.element_id.trim().length > 0
      ? element.element_id
      : `element-${index}`;

  return {
    element_id: elementId,
    type:
      typeof element.type === "string" && element.type.trim().length > 0
        ? element.type
        : "Unknown",
    text: typeof element.text === "string" ? element.text.trim() : "",
    metadata,
  };
}

function isTableElement(element: V2ExtractedElement): boolean {
  const metadata = element.metadata;
  const hasTableHtml = typeof metadata.text_as_html === "string" && metadata.text_as_html.length > 0;
  return element.type.toLowerCase().includes("table") || hasTableHtml;
}

export async function contentExtractionNode(
  state: GenerateInsightsV2State,
): Promise<Partial<GenerateInsightsV2State>> {
  console.info("[content-extraction] starting", {
    documents: state.documents.length,
  });

  const extractionErrors: PipelineError[] = [];
  const extractionResults = await mapWithConcurrency(
    state.documents,
    Math.max(1, config.maxConcurrency),
    async (document): Promise<V2ExtractedDocument | null> => {
      try {
        const { elements, contentType } = await loadDocumentElements(document.source_uri);
        const normalizedElements = elements.map((element, index) => normalizeElement(element, index));
        const tableCount = normalizedElements.filter((element) => isTableElement(element)).length;
        const textCount = normalizedElements.filter((element) => element.text.length > 0).length;

        console.info("[content-extraction] extracted document", {
          document_id: document.document_id,
          source_uri: document.source_uri,
          textElements: textCount,
          tableElements: tableCount,
        });

        return {
          document_id: document.document_id,
          source_uri: document.source_uri,
          file_type: document.file_type,
          content_type: contentType,
          elements: normalizedElements,
        };
      } catch (error) {
        extractionErrors.push({
          stage: "content-extraction",
          message: error instanceof Error ? error.message : "Unknown error",
          url: document.source_uri,
          document_id: document.document_id,
          cause: error,
        });
        console.warn("[content-extraction] failed document", {
          document_id: document.document_id,
          source_uri: document.source_uri,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        return null;
      }
    },
  );

  const extractedDocuments = extractionResults.filter(
    (value): value is V2ExtractedDocument => value !== null,
  );

  console.info("[content-extraction] completed", {
    documents: extractedDocuments.length,
    failedDocuments: extractionErrors.length,
    textElements: extractedDocuments.reduce((sum, document) => sum + document.elements.length, 0),
    tables: extractedDocuments.reduce(
      (sum, document) => sum + document.elements.filter((element) => isTableElement(element)).length,
      0,
    ),
  });

  return {
    extractedDocuments,
    documents: state.documents.map((document) => {
      const extracted = extractedDocuments.find((item) => item.document_id === document.document_id);
      return extracted ? { ...document, content_type: extracted.content_type } : document;
    }),
    errors: state.errors.concat(extractionErrors),
  };
}
