import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { toFile } from "openai";
import { PDFDocument } from "pdf-lib";
import { UnstructuredClient } from "unstructured-client";
import { Strategy } from "unstructured-client/sdk/models/shared";
import { setMaxListeners } from "node:events";
import { getCachedAwsAssumeRoleProvider } from "./aws";
import { config } from "./config";
import { openai, OPENAI_HELPER_MODEL } from "./openai";
import { compactWhitespace, mapWithConcurrency, sleep } from "./utils";

export type LoadedDocument = {
  text: string;
  contentType: string;
};

export type UnstructuredElement = {
  element_id?: string | null;
  type?: string | null;
  text?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type LoadedDocumentElements = {
  elements: UnstructuredElement[];
  contentType: string;
};

let unstructuredClient: UnstructuredClient | null = null;

function getUnstructuredClient(): UnstructuredClient {
  if (!unstructuredClient) {
    unstructuredClient = new UnstructuredClient({
      serverURL: config.unstructuredApiUrl || "https://api.unstructuredapp.io",
      timeoutMs: config.unstructuredRequestTimeoutMs,
      security: {
        apiKeyAuth: config.unstructuredApiKey,
      },
    });
  }
  return unstructuredClient;
}

function getFileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return last || "document.pdf";
  } catch {
    return "document.pdf";
  }
}

function isPdfLike(url: string, contentType?: string): boolean {
  if (contentType?.toLowerCase().includes("pdf")) return true;
  return url.toLowerCase().endsWith(".pdf");
}

function getNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function getElementPageNumber(element: UnstructuredElement): number | undefined {
  const metadata = element.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const record = metadata as Record<string, unknown>;
  const page =
    getNumber(record.page_number)
    ?? getNumber(record.pageNumber)
    ?? getNumber(record.page);
  if (!page) return undefined;
  const normalized = Math.floor(page);
  return normalized > 0 ? normalized : undefined;
}

function countNonEmptyElements(elements: UnstructuredElement[]): number {
  return elements.filter((element) => (element.text ?? "").trim().length > 0).length;
}

function computePageCoverage(
  elements: UnstructuredElement[],
  startPage: number,
  endPage: number,
): { coveredPages: Set<number>; hasPageMetadata: boolean } {
  const coveredPages = new Set<number>();
  let hasPageMetadata = false;
  for (const element of elements) {
    const page = getElementPageNumber(element);
    if (!page) continue;
    hasPageMetadata = true;
    if (page >= startPage && page <= endPage) {
      coveredPages.add(page);
    }
  }
  return { coveredPages, hasPageMetadata };
}

type PartitionRequestInput = {
  client: UnstructuredClient;
  fileBuffer: Buffer;
  fileName: string;
  strategy: Strategy;
  pdfInferTableStructure: boolean;
  startingPageNumber?: number;
  splitPdfPage: boolean;
  splitPdfAllowFailed?: boolean;
  splitPdfConcurrencyLevel?: number;
};

type PartitionRequestResult = {
  statusCode: number | null;
  elements: UnstructuredElement[];
};

type UnstructuredErrorInfo = {
  name: string;
  message: string;
  statusCode?: number;
  contentType?: string;
  detail?: unknown;
  body?: string;
  causeName?: string;
  causeMessage?: string;
};

type OpenAiFallbackExtractionResponse = {
  elements: Array<{
    type: string;
    text: string;
    page_number: number | null;
    section_title: string | null;
  }>;
};

const OPENAI_FALLBACK_EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    elements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string" },
          text: { type: "string" },
          page_number: {
            anyOf: [
              { type: "integer" },
              { type: "null" },
            ],
          },
          section_title: {
            anyOf: [
              { type: "string" },
              { type: "null" },
            ],
          },
        },
        required: ["type", "text", "page_number", "section_title"],
      },
    },
  },
  required: ["elements"],
} as const;

function extractUnstructuredErrorInfo(error: unknown): UnstructuredErrorInfo {
  const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};

  const top = asRecord(error);
  const cause = asRecord(top.cause);
  return {
    name: typeof top.name === "string" ? top.name : "UnknownError",
    message: typeof top.message === "string" ? top.message : "Unknown error",
    statusCode: typeof top.statusCode === "number" ? top.statusCode : undefined,
    contentType: typeof top.contentType === "string" ? top.contentType : undefined,
    detail: top.detail ?? top.data$ ?? undefined,
    body: typeof top.body === "string" && top.body.length > 0 ? top.body : undefined,
    causeName: typeof cause.name === "string" ? cause.name : undefined,
    causeMessage: typeof cause.message === "string" ? cause.message : undefined,
  };
}

function shouldUseOpenAiExtractionFallback(
  info: UnstructuredErrorInfo,
  aborted: boolean,
): boolean {
  const message = (info.message ?? "").toLowerCase();
  const causeMessage = (info.causeMessage ?? "").toLowerCase();
  const isTimeoutError =
    info.name === "RequestTimeoutError"
    || info.causeName === "TimeoutError"
    || message.includes("timed out")
    || causeMessage.includes("timed out");
  const isConnectionError =
    info.name === "ConnectionError"
    || message.includes("unable to make request")
    || message.includes("fetch failed")
    || causeMessage.includes("fetch failed");
  return isTimeoutError || isConnectionError || aborted;
}

async function extractElementsWithOpenAiFallback(
  url: string,
  fileBuffer: Buffer,
  contentType: string,
): Promise<UnstructuredElement[]> {
  if (!config.openaiApiKey) {
    throw new Error("OpenAI API key missing for fallback extraction.");
  }

  const fileName = getFileNameFromUrl(url);
  const file = await toFile(fileBuffer, fileName, { type: contentType });
  const uploaded = await openai.files.create({
    file,
    purpose: "user_data",
  });

  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_HELPER_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "Extract document content into ordered elements for downstream insight pipelines.",
            "Prioritize faithful extraction. Do not invent content.",
            "Return concise element types like Title, NarrativeText, Table, ListItem, Header, Footer.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "The Unstructured parser failed due to network/timeout.",
                "Parse this file and output structured elements.",
                "For each element include: type, text, page_number (or null), section_title (or null).",
                "Keep original order. Exclude empty elements.",
              ].join("\n"),
            },
            {
              type: "file",
              file: {
                file_id: uploaded.id,
              },
            },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "openai_document_fallback_extraction_v1",
          strict: true,
          schema: OPENAI_FALLBACK_EXTRACTION_SCHEMA,
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("Empty OpenAI fallback response.");

    const parsed = JSON.parse(content) as OpenAiFallbackExtractionResponse;
    const elements = parsed.elements.reduce<UnstructuredElement[]>((acc, element, index) => {
      const text = compactWhitespace(element.text ?? "");
      if (!text) return acc;
      acc.push({
        element_id: `openai-fallback-${index + 1}`,
        type: element.type || "NarrativeText",
        text,
        metadata: {
          page_number: element.page_number ?? undefined,
          section_title: element.section_title ?? undefined,
          source_parser: "openai_fallback",
        },
      });
      return acc;
    }, []);

    if (elements.length === 0) {
      throw new Error("OpenAI fallback returned no usable elements.");
    }

    return elements;
  } finally {
    try {
      await openai.files.del(uploaded.id);
    } catch (error) {
      console.warn("document-loader:openai-fallback:file:cleanup:error", {
        fileId: uploaded.id,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}

async function runPartitionRequest(input: PartitionRequestInput): Promise<PartitionRequestResult> {
  try {
    const response = await input.client.general.partition({
      partitionParameters: {
        files: {
          content: input.fileBuffer,
          fileName: input.fileName,
        },
        pdfInferTableStructure: input.pdfInferTableStructure,
        strategy: input.strategy,
        splitPdfPage: input.splitPdfPage,
        ...(typeof input.splitPdfAllowFailed === "boolean"
          ? { splitPdfAllowFailed: input.splitPdfAllowFailed }
          : {}),
        ...(typeof input.splitPdfConcurrencyLevel === "number"
          ? { splitPdfConcurrencyLevel: input.splitPdfConcurrencyLevel }
          : {}),
        ...(typeof input.startingPageNumber === "number"
          ? { startingPageNumber: input.startingPageNumber }
          : {}),
      },
    }, {
      timeoutMs: config.unstructuredRequestTimeoutMs,
      retries: {
        strategy: "none",
      },
      retryCodes: [],
    });
    return {
      statusCode: response.statusCode ?? null,
      elements: (response.elements as UnstructuredElement[] | undefined) ?? [],
    };
  } catch (error) {
    const info = extractUnstructuredErrorInfo(error);
    console.warn("document-loader:partitionWithUnstructured:request:error", {
      startingPageNumber: input.startingPageNumber ?? null,
      splitPdfPage: input.splitPdfPage,
      splitPdfAllowFailed: input.splitPdfAllowFailed ?? null,
      splitPdfConcurrencyLevel: input.splitPdfConcurrencyLevel ?? null,
      strategy: input.strategy,
      pdfInferTableStructure: input.pdfInferTableStructure,
      timeoutMs: config.unstructuredRequestTimeoutMs,
      error: info,
    });
    throw error;
  }
}

type PdfChunk = {
  index: number;
  startPage: number;
  endPage: number;
  fileBuffer: Buffer;
};

type PdfChunkResult = {
  chunk: PdfChunk;
  elements: UnstructuredElement[];
  attempts: number;
  statusCode: number | null;
  hasPageMetadata: boolean;
  coveredPages: Set<number>;
  errorMessage?: string;
  error?: UnstructuredErrorInfo;
};

function buildPdfRanges(totalPages: number, chunkSize: number): Array<{ startPage: number; endPage: number }> {
  const ranges: Array<{ startPage: number; endPage: number }> = [];
  for (let start = 1; start <= totalPages; start += chunkSize) {
    ranges.push({
      startPage: start,
      endPage: Math.min(totalPages, start + chunkSize - 1),
    });
  }
  return ranges;
}

async function createPdfChunkBuffers(
  sourceBuffer: Buffer,
  chunkSize: number,
): Promise<{ chunks: PdfChunk[]; totalPages: number }> {
  const sourcePdf = await PDFDocument.load(sourceBuffer);
  const totalPages = sourcePdf.getPageCount();
  const ranges = buildPdfRanges(totalPages, chunkSize);
  const chunks: PdfChunk[] = [];

  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const chunkPdf = await PDFDocument.create();
    const pageIndexes = Array.from(
      { length: range.endPage - range.startPage + 1 },
      (_value, offset) => range.startPage - 1 + offset,
    );
    const copiedPages = await chunkPdf.copyPages(sourcePdf, pageIndexes);
    for (const page of copiedPages) chunkPdf.addPage(page);
    chunks.push({
      index: index + 1,
      startPage: range.startPage,
      endPage: range.endPage,
      fileBuffer: Buffer.from(await chunkPdf.save()),
    });
  }

  return { chunks, totalPages };
}

async function partitionSinglePdfChunk(
  client: UnstructuredClient,
  fileName: string,
  chunk: PdfChunk,
  strategy: Strategy,
  pdfInferTableStructure: boolean,
): Promise<PartitionRequestResult> {
  return runPartitionRequest({
    client,
    fileBuffer: chunk.fileBuffer,
    fileName,
    strategy,
    pdfInferTableStructure,
    startingPageNumber: chunk.startPage,
    splitPdfPage: false,
  });
}

async function partitionChunkWithRetries(
  client: UnstructuredClient,
  fileName: string,
  chunk: PdfChunk,
  strategy: Strategy,
  pdfInferTableStructure: boolean,
): Promise<PdfChunkResult> {
  const maxAttempts = config.unstructuredPdfSplitMaxRetries + 1;
  let lastMessage = "Unknown error";
  let lastStatusCode: number | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    try {
      const response = await partitionSinglePdfChunk(
        client,
        fileName,
        chunk,
        strategy,
        pdfInferTableStructure,
      );
      lastStatusCode = response.statusCode;
      if (response.statusCode && response.statusCode >= 300) {
        lastMessage = `status ${response.statusCode}`;
        throw new Error(lastMessage);
      }

      const coverage = computePageCoverage(response.elements, chunk.startPage, chunk.endPage);
      const expectedPages = chunk.endPage - chunk.startPage + 1;
      const coveredCount = coverage.coveredPages.size;
      const coverageRatio = expectedPages > 0 ? coveredCount / expectedPages : 1;
      const hasCoverageGap = coverage.hasPageMetadata
        && coverage.coveredPages.size > 0
        && coverageRatio < config.unstructuredPdfMinCoverageRatio;

      if (hasCoverageGap) {
        lastMessage = `coverage gap ${coveredCount}/${expectedPages}`;
        throw new Error(lastMessage);
      }

      console.debug("document-loader:partitionWithUnstructured:chunk:done", {
        chunkIndex: chunk.index,
        pageRange: `${chunk.startPage}-${chunk.endPage}`,
        attempt,
        attemptsAllowed: maxAttempts,
        statusCode: response.statusCode ?? null,
        elementCount: response.elements.length,
        nonEmptyElementCount: countNonEmptyElements(response.elements),
        coveredPages: coverage.coveredPages.size,
        expectedPages,
        hasPageMetadata: coverage.hasPageMetadata,
        elapsedMs: Date.now() - attemptStartedAt,
      });

      return {
        chunk,
        elements: response.elements,
        attempts: attempt,
        statusCode: response.statusCode,
        hasPageMetadata: coverage.hasPageMetadata,
        coveredPages: coverage.coveredPages,
      };
    } catch (error) {
      const info = extractUnstructuredErrorInfo(error);
      lastMessage = info.message;
      console.warn("document-loader:partitionWithUnstructured:chunk:failed", {
        chunkIndex: chunk.index,
        pageRange: `${chunk.startPage}-${chunk.endPage}`,
        attempt,
        attemptsAllowed: maxAttempts,
        statusCode: lastStatusCode,
        message: lastMessage,
        error: info,
      });
      if (attempt < maxAttempts) {
        await sleep(Math.min(500 * attempt, 1500));
      }
    }
  }

  return {
    chunk,
    elements: [],
    attempts: maxAttempts,
    statusCode: lastStatusCode,
    hasPageMetadata: false,
    coveredPages: new Set<number>(),
    errorMessage: lastMessage,
    error: {
      name: "ChunkPartitionFailed",
      message: lastMessage,
      statusCode: lastStatusCode ?? undefined,
    },
  };
}

async function partitionPdfInChunksWithCoverage(
  client: UnstructuredClient,
  url: string,
  fileName: string,
  fileBuffer: Buffer,
  strategy: Strategy,
  pdfInferTableStructure: boolean,
): Promise<UnstructuredElement[]> {
  const chunkBuildStartedAt = Date.now();
  const { chunks, totalPages } = await createPdfChunkBuffers(
    fileBuffer,
    config.unstructuredPdfSplitChunkSizePages,
  );
  const splitPdfConcurrencyLevel = Math.max(1, chunks.length);
  console.debug("document-loader:partitionWithUnstructured:chunking:prepared", {
    url,
    totalPages,
    chunkCount: chunks.length,
    chunkSizePages: config.unstructuredPdfSplitChunkSizePages,
    strictMode: config.unstructuredPdfSplitStrictMode,
    concurrency: splitPdfConcurrencyLevel,
    retries: config.unstructuredPdfSplitMaxRetries,
    elapsedMs: Date.now() - chunkBuildStartedAt,
  });

  const results = await mapWithConcurrency(
    chunks,
    splitPdfConcurrencyLevel,
    async (chunk) => partitionChunkWithRetries(
      client,
      fileName,
      chunk,
      strategy,
      pdfInferTableStructure,
    ),
  );

  const failedChunks = results.filter((result) => result.errorMessage);
  const mergedElements = results.flatMap((result) => result.elements);

  if (failedChunks.length > 0) {
    console.warn("document-loader:partitionWithUnstructured:chunking:failed-chunks", {
      url,
      failedChunkCount: failedChunks.length,
      failedChunks: failedChunks.map((result) => ({
        chunkIndex: result.chunk.index,
        pageRange: `${result.chunk.startPage}-${result.chunk.endPage}`,
        attempts: result.attempts,
        statusCode: result.statusCode,
        message: result.errorMessage,
        error: result.error,
      })),
    });
  }

  const coveragePages = new Set<number>();
  let hasAnyPageMetadata = false;
  for (const result of results) {
    if (result.hasPageMetadata) hasAnyPageMetadata = true;
    for (const page of result.coveredPages) coveragePages.add(page);
  }

  const coverageRatio = totalPages > 0 ? coveragePages.size / totalPages : 1;
  const coverageByChunkRatio = chunks.length > 0 ? (chunks.length - failedChunks.length) / chunks.length : 1;
  const strictCoverageFailed = hasAnyPageMetadata
    ? coverageRatio < config.unstructuredPdfMinCoverageRatio
    : failedChunks.length > 0;

  console.debug("document-loader:partitionWithUnstructured:chunking:summary", {
    url,
    totalPages,
    chunkCount: chunks.length,
    failedChunkCount: failedChunks.length,
    coveredPages: coveragePages.size,
    hasAnyPageMetadata,
    coverageRatio,
    coverageByChunkRatio,
    strictCoverageFailed,
    strictMode: config.unstructuredPdfSplitStrictMode,
    elementCount: mergedElements.length,
  });

  if (!strictCoverageFailed) {
    return mergedElements;
  }

  console.warn("document-loader:partitionWithUnstructured:chunking:fallback:start", {
    url,
    reason: "coverage_validation_failed",
    strictMode: config.unstructuredPdfSplitStrictMode,
    failedChunks: failedChunks.map((result) => ({
      chunkIndex: result.chunk.index,
      pageRange: `${result.chunk.startPage}-${result.chunk.endPage}`,
      attempts: result.attempts,
      statusCode: result.statusCode,
      message: result.errorMessage,
      error: result.error,
    })),
  });

  let fallbackResponse: PartitionRequestResult;
  try {
    fallbackResponse = await runPartitionRequest({
      client,
      fileBuffer,
      fileName,
      strategy,
      pdfInferTableStructure,
      splitPdfPage: false,
    });
  } catch (error) {
    const info = extractUnstructuredErrorInfo(error);
    console.warn("document-loader:partitionWithUnstructured:chunking:fallback:error", {
      url,
      timeoutMs: config.unstructuredRequestTimeoutMs,
      error: info,
    });
    throw error;
  }
  if (fallbackResponse.statusCode && fallbackResponse.statusCode >= 300) {
    throw new Error(`Unstructured fallback partition failed: ${fallbackResponse.statusCode}`);
  }

  const fallbackCoverage = computePageCoverage(fallbackResponse.elements, 1, totalPages);
  const fallbackCoverageRatio = totalPages > 0
    ? fallbackCoverage.coveredPages.size / totalPages
    : 1;
  const fallbackCoverageValid = fallbackCoverage.hasPageMetadata
    ? fallbackCoverageRatio >= config.unstructuredPdfMinCoverageRatio
    : fallbackResponse.elements.length > 0;

  console.debug("document-loader:partitionWithUnstructured:chunking:fallback:done", {
    url,
    statusCode: fallbackResponse.statusCode,
    elementCount: fallbackResponse.elements.length,
    nonEmptyElementCount: countNonEmptyElements(fallbackResponse.elements),
    fallbackHasPageMetadata: fallbackCoverage.hasPageMetadata,
    fallbackCoveredPages: fallbackCoverage.coveredPages.size,
    fallbackCoverageRatio,
    fallbackCoverageValid,
  });

  if (!fallbackCoverageValid && config.unstructuredPdfSplitStrictMode) {
    throw new Error(
      `Unstructured partition coverage below threshold after fallback (${fallbackCoverage.coveredPages.size}/${totalPages} pages).`,
    );
  }
  if (!fallbackCoverageValid && !config.unstructuredPdfSplitStrictMode) {
    console.warn("document-loader:partitionWithUnstructured:chunking:fallback:partial", {
      url,
      fallbackCoveredPages: fallbackCoverage.coveredPages.size,
      totalPages,
      fallbackCoverageRatio,
    });
  }

  return fallbackResponse.elements;
}

async function partitionWithUnstructured(
  url: string,
  buffer: ArrayBuffer,
  contentType?: string,
  requireTableStructure = false,
): Promise<UnstructuredElement[]> {
  const startedAt = Date.now();
  console.debug("document-loader:partitionWithUnstructured:start", {
    url,
    bufferBytes: buffer.byteLength,
    contentType,
    hasApiKey: Boolean(config.unstructuredApiKey),
    apiUrl: config.unstructuredApiUrl ?? null,
  });

  if (!config.unstructuredApiKey) {
    console.debug("document-loader:partitionWithUnstructured:error", {
      url,
      message: "UNSTRUCTURED_API_KEY is required for document extraction.",
    });
    throw new Error(
      "UNSTRUCTURED_API_KEY is required for document extraction.",
    );
  }

  try {
    const client = getUnstructuredClient();
    console.debug("document-loader:partitionWithUnstructured:client:ready", { url });
    const fileName = getFileNameFromUrl(url);
    const fileBuffer = Buffer.from(buffer);
    const pdfLike = isPdfLike(url, contentType);
    const strategy = requireTableStructure ? Strategy.HiRes : Strategy.Auto;
    const pdfInferTableStructure = requireTableStructure;
    console.debug("document-loader:partitionWithUnstructured:file:prepared", {
      url,
      fileName,
      fileBytes: fileBuffer.length,
      pdfLike,
    });
    console.debug("document-loader:partitionWithUnstructured:partition:start", {
      url,
      fileName,
      strategy,
      pdfInferTableStructure,
      useLegacySplitMode: pdfLike ? config.unstructuredUseLegacySplitMode : false,
      legacySplitAllowFailed: pdfLike ? config.unstructuredLegacySplitAllowFailed : undefined,
      legacySplitConcurrency: pdfLike ? config.unstructuredLegacySplitConcurrency : undefined,
      splitPdfEnabled: pdfLike ? config.unstructuredPdfSplitEnabled : false,
      splitPdfStrictMode: pdfLike ? config.unstructuredPdfSplitStrictMode : undefined,
      splitPdfConcurrencyLevel: pdfLike ? config.unstructuredPdfSplitConcurrency : undefined,
      splitPdfChunkSizePages: pdfLike ? config.unstructuredPdfSplitChunkSizePages : undefined,
      splitPdfRetries: pdfLike ? config.unstructuredPdfSplitMaxRetries : undefined,
      splitPdfMinCoverageRatio: pdfLike ? config.unstructuredPdfMinCoverageRatio : undefined,
    });

    const elements = pdfLike && config.unstructuredUseLegacySplitMode
      ? (
        await runPartitionRequest({
          client,
          fileBuffer,
          fileName,
          strategy,
          pdfInferTableStructure,
          splitPdfPage: true,
          splitPdfAllowFailed: config.unstructuredLegacySplitAllowFailed,
          splitPdfConcurrencyLevel: config.unstructuredLegacySplitConcurrency,
        })
      ).elements
      : (
        pdfLike && config.unstructuredPdfSplitEnabled
          ? await partitionPdfInChunksWithCoverage(
            client,
            url,
            fileName,
            fileBuffer,
            strategy,
            pdfInferTableStructure,
          )
          : (
            await runPartitionRequest({
              client,
              fileBuffer,
              fileName,
              strategy,
              pdfInferTableStructure,
              splitPdfPage: false,
            })
          ).elements
      );
    const nonEmptyElementCount = countNonEmptyElements(elements);
    console.debug("document-loader:partitionWithUnstructured:elements:stats", {
      url,
      elementCount: elements.length,
      nonEmptyElementCount,
      emptyElementCount: elements.length - nonEmptyElementCount,
      elapsedMs: Date.now() - startedAt,
    });
    return elements;
  } catch (error) {
    const info = extractUnstructuredErrorInfo(error);
    console.debug("document-loader:partitionWithUnstructured:error", {
      url,
      message: info.message,
      error: info,
      stack: error instanceof Error ? error.stack : undefined,
      elapsedMs: Date.now() - startedAt,
    });
    throw error;
  }
}

async function extractPdfWithUnstructured(
  url: string,
  buffer: ArrayBuffer,
  requireTableStructure = false,
): Promise<string> {
  const elements = await partitionWithUnstructured(
    url,
    buffer,
    "application/pdf",
    requireTableStructure,
  );
  const textParts = elements.map((element) => element.text ?? "");
  const joinedText = textParts.filter(Boolean).join("\n\n");
  const text = compactWhitespace(joinedText);

  if (!text) {
    console.debug("document-loader:extractPdfWithUnstructured:empty-text", {
      url,
      elementCount: elements.length,
    });
    throw new Error("Unstructured returned no text elements.");
  }

  console.debug("document-loader:extractPdfWithUnstructured:success", {
    url,
    extractedLength: text.length,
    elementCount: elements.length,
  });
  return text;
}

function stripHtml(html: string): string {
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const withoutStyles = withoutScripts.replace(/<style[\s\S]*?<\/style>/gi, " ");
  const withoutTags = withoutStyles.replace(/<[^>]+>/g, " ");
  return compactWhitespace(withoutTags);
}

export function parseS3Url(url: string): { bucket: string; key: string } {
  console.debug("document-loader:parseS3Url:start", { url });
  const trimmed = url.replace("s3://", "");
  const [bucket, ...rest] = trimmed.split("/");
  if (!bucket || rest.length === 0) {
    console.debug("document-loader:parseS3Url:error", { url });
    throw new Error(`Invalid s3 url: ${url}`);
  }
  const key = rest.join("/");
  console.debug("document-loader:parseS3Url:success", { bucket, key });
  return { bucket, key };
}

export async function bodyToBuffer(body: unknown): Promise<Buffer> {
  console.debug("document-loader:bodyToBuffer:start", {
    hasBody: Boolean(body),
    bodyType: body ? typeof body : "nullish",
  });
  if (!body) throw new Error("S3 object has no body.");
  if (Buffer.isBuffer(body)) {
    console.debug("document-loader:bodyToBuffer:buffer", { length: body.length });
    return body;
  }
  if (typeof body === "string") {
    const converted = Buffer.from(body);
    console.debug("document-loader:bodyToBuffer:string", { length: converted.length });
    return converted;
  }
  if (body instanceof Uint8Array) {
    const converted = Buffer.from(body);
    console.debug("document-loader:bodyToBuffer:uint8array", { length: converted.length });
    return converted;
  }

  if (typeof (body as Blob).arrayBuffer === "function") {
    console.debug("document-loader:bodyToBuffer:blob:start");
    const arrayBuffer = await (body as Blob).arrayBuffer();
    const converted = Buffer.from(arrayBuffer);
    console.debug("document-loader:bodyToBuffer:blob:done", { length: converted.length });
    return converted;
  }

  if (typeof (body as NodeJS.ReadableStream).on === "function") {
    console.debug("document-loader:bodyToBuffer:stream:start");
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      (body as NodeJS.ReadableStream)
        .on("data", (chunk) => chunks.push(Buffer.from(chunk)))
        .on("error", (error) => {
          console.debug("document-loader:bodyToBuffer:stream:error", {
            message: error instanceof Error ? error.message : "Unknown error",
          });
          reject(error);
        })
        .on("end", () => {
          const converted = Buffer.concat(chunks);
          console.debug("document-loader:bodyToBuffer:stream:done", {
            chunks: chunks.length,
            length: converted.length,
          });
          resolve(converted);
        });
    });
  }

  console.debug("document-loader:bodyToBuffer:error", {
    reason: "unsupported_body_type",
  });
  throw new Error("Unsupported S3 body type.");
}

async function fetchS3Document(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  const { bucket, key } = parseS3Url(url);
  const s3 = new S3Client({
    credentials: getCachedAwsAssumeRoleProvider(),
  });

  console.debug("document-loader:fetchS3Document:getObject:start", { bucket, key });
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
  const contentType = response.ContentType ?? "application/octet-stream";
  const buffer = await bodyToBuffer(response.Body);
  console.debug("document-loader:fetchS3Document:getObject:done", {
    bucket,
    key,
    contentType,
    bytes: buffer.byteLength,
  });
  return { buffer, contentType };
}

export async function loadDocumentElements(url: string): Promise<LoadedDocumentElements> {
  console.debug("document-loader:loadDocumentElements:start", { url });
  const controller = new AbortController();
  setMaxListeners(25, controller.signal);
  const timeout = setTimeout(
    () => controller.abort(),
    config.requestTimeoutMs,
  );

  try {
    let contentType = "application/octet-stream";
    let buffer: ArrayBuffer;
    let sourceBuffer: Buffer | null = null;

    if (url.startsWith("s3://")) {
      const s3Document = await fetchS3Document(url);
      contentType = s3Document.contentType;
      sourceBuffer = s3Document.buffer;
      buffer = Uint8Array.from(sourceBuffer).buffer;
    } else {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": "aetio-ingestion/1.0",
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
      }
      contentType = response.headers.get("content-type") ?? "application/octet-stream";
      buffer = await response.arrayBuffer();
      sourceBuffer = Buffer.from(buffer);
    }

    const elements = await partitionWithUnstructured(url, buffer, contentType, true);
    console.debug("document-loader:loadDocumentElements:done", {
      url,
      contentType,
      elementCount: elements.length,
    });
    return { elements, contentType };
  } catch (error) {
    const info = extractUnstructuredErrorInfo(error);
    if (shouldUseOpenAiExtractionFallback(info, controller.signal.aborted)) {
      try {
        let fallbackContentType = "application/octet-stream";
        let fallbackBuffer: Buffer | null = null;

        if (url.startsWith("s3://")) {
          const s3Document = await fetchS3Document(url);
          fallbackContentType = s3Document.contentType;
          fallbackBuffer = s3Document.buffer;
        }

        if (fallbackBuffer) {
          console.warn("document-loader:loadDocumentElements:fallback:openai:start", {
            url,
            reason: info.message,
            causeName: info.causeName,
            causeMessage: info.causeMessage,
            aborted: controller.signal.aborted,
          });
          const fallbackElements = await extractElementsWithOpenAiFallback(
            url,
            fallbackBuffer,
            fallbackContentType,
          );
          console.warn("document-loader:loadDocumentElements:fallback:openai:done", {
            url,
            contentType: fallbackContentType,
            elementCount: fallbackElements.length,
          });
          return {
            elements: fallbackElements,
            contentType: fallbackContentType,
          };
        }
      } catch (fallbackError) {
        console.warn("document-loader:loadDocumentElements:fallback:openai:error", {
          url,
          message: fallbackError instanceof Error ? fallbackError.message : "Unknown error",
        });
      }
    }

    console.debug("document-loader:loadDocumentElements:error", {
      url,
      message: info.message,
      aborted: controller.signal.aborted,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadDocumentText(url: string): Promise<LoadedDocument> {
  console.debug("document-loader:load:start", { url });
  const controller = new AbortController();
  // Some downstream HTTP clients attach multiple abort listeners per request.
  // Raise the limit on this per-request signal to avoid false-positive warnings.
  setMaxListeners(25, controller.signal);
  const timeout = setTimeout(
    () => controller.abort(),
    config.requestTimeoutMs,
  );
  try {
    if (url.startsWith("s3://")) {
      console.debug("document-loader:load:s3:start", { url });
      const { buffer, contentType } = await fetchS3Document(url);
      const decoder = new TextDecoder("utf-8");
      let text = decoder.decode(buffer);
      if (contentType.includes("application/pdf")) {
        console.debug("document-loader:load:s3:parse:pdf", { url, contentType });
        const arrayBuffer = Uint8Array.from(buffer).buffer;
        text = await extractPdfWithUnstructured(url, arrayBuffer, false);
      } else if (
        contentType.includes("text/html") ||
        contentType.includes("application/xhtml+xml")
      ) {
        console.debug("document-loader:load:s3:parse:html", { url, contentType });
        text = stripHtml(text);
      } else {
        console.debug("document-loader:load:s3:parse:text", { url, contentType });
        text = compactWhitespace(text);
      }

      if (!text) {
        throw new Error("Empty document text after parsing.");
      }

      console.debug("document-loader:load:success", {
        url,
        contentType,
        length: text.length,
      });
      return { text, contentType };
    }

    console.debug("document-loader:load:http:start", { url });
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "aetio-ingestion/1.0",
      },
    });
    console.debug("document-loader:load:http:response", {
      url,
      status: response.status,
      ok: response.ok,
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "text/plain";
    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder("utf-8");
    console.debug("document-loader:load:http:buffer", {
      url,
      contentType,
      bytes: buffer.byteLength,
    });
    let text = decoder.decode(buffer);
    if (contentType.includes("application/pdf")) {
      console.debug("document-loader:load:http:parse:pdf", { url, contentType });
      text = await extractPdfWithUnstructured(url, buffer, false);
    } else if (
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml+xml")
    ) {
      console.debug("document-loader:load:http:parse:html", { url, contentType });
      text = stripHtml(text);
    } else {
      console.debug("document-loader:load:http:parse:text", { url, contentType });
      text = compactWhitespace(text);
    }

    if (!text) {
      throw new Error("Empty document text after parsing.");
    }

    console.debug("document-loader:load:success", {
      url,
      contentType,
      length: text.length,
    });
    return { text, contentType };
  } catch (error) {
    console.debug("document-loader:load:error", {
      url,
      aborted: controller.signal.aborted,
      message: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
    console.debug("document-loader:load:finish", {
      url,
      aborted: controller.signal.aborted,
    });
  }
}
