import type { GenerateInsightsV2State, SourceFileType, V2DocumentDescriptor } from "../types";
import { hashId } from "../../common/services/utils";
import { randomUUID } from "crypto";
import { upsertPendingProject } from "../../common/services/projectsTable";

function getFileName(sourceUri: string): string {
  try {
    if (sourceUri.startsWith("s3://")) {
      const [, ...rest] = sourceUri.replace("s3://", "").split("/");
      return rest.pop() ?? "unknown";
    }
    const parsed = new URL(sourceUri);
    return parsed.pathname.split("/").filter(Boolean).pop() ?? "unknown";
  } catch {
    return sourceUri.split("/").filter(Boolean).pop() ?? "unknown";
  }
}

function normalizeDocumentIdComponent(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[_\-.]+|[_\-.]+$/g, "");
}

function buildBaseDocumentId(fileName: string): string {
  const normalized = normalizeDocumentIdComponent(fileName);
  if (!normalized) return "document";
  // Keep filename semantics; if extremely long, preserve the tail.
  return normalized.length <= 160 ? normalized : normalized.slice(-160);
}

function buildWorkflowProjectId(): string {
  return `project-v2-${randomUUID()}`;
}

function detectFileType(sourceUri: string): SourceFileType {
  const fileName = getFileName(sourceUri).toLowerCase();
  if (fileName.endsWith(".pdf")) return "pdf";
  if (fileName.endsWith(".xlsx")) return "xlsx";
  if (fileName.endsWith(".xls")) return "xls";
  if (fileName.endsWith(".csv")) return "csv";
  if (fileName.endsWith(".tsv")) return "tsv";
  if (fileName.endsWith(".txt")) return "txt";
  if (fileName.endsWith(".html") || fileName.endsWith(".htm")) return "html";
  if (fileName.endsWith(".json")) return "json";
  return "unknown";
}

export async function documentIntakeNode(
  state: GenerateInsightsV2State,
): Promise<Partial<GenerateInsightsV2State>> {
  console.info("[document-intake] starting", {
    uris: state.sourceUris.length,
  });

  const seenDocumentIds = new Set<string>();
  const documents: V2DocumentDescriptor[] = state.sourceUris.map((sourceUri) => {
    const fileName = getFileName(sourceUri);
    const baseDocumentId = buildBaseDocumentId(fileName);
    let documentId = baseDocumentId;

    if (seenDocumentIds.has(documentId)) {
      // Colliding filenames: keep readability + ensure deterministic uniqueness.
      documentId = `${baseDocumentId}-${hashId(sourceUri).slice(0, 8)}`;
    }
    seenDocumentIds.add(documentId);

    return {
      document_id: documentId,
      source_uri: sourceUri,
      file_type: detectFileType(sourceUri),
      file_name: fileName,
    };
  });

  const projectId = state.projectId?.trim() || buildWorkflowProjectId();
  const userId = state.userId?.trim();

  if (userId) {
    await upsertPendingProject({
      userId,
      projectId,
      userInfo: state.userInfo,
      uploadMode: state.uploadMode,
      researchContext: state.researchContext,
      contextUrls: state.contextUrls,
      outputUrls: state.outputUrls,
      rawDataUrls: state.rawDataUrls,
    });
  } else {
    console.warn("[document-intake] project row not persisted: missing userId", { projectId });
  }

  console.info("[document-intake] normalized documents", {
    documents: documents.length,
    projectId,
    fileTypes: documents.reduce<Record<string, number>>((acc, document) => {
      acc[document.file_type] = (acc[document.file_type] ?? 0) + 1;
      return acc;
    }, {}),
  });

  return {
    documents,
    projectId,
  };
}
