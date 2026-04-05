import type {
  Chunk,
  GraphState,
  Insight,
  PipelineError,
  SupportingChunkRef,
} from "../../types";
import { config } from "../../common/services/config";
import { openai, OPENAI_MODEL } from "../../common/services/openai";
import { chunkArray, hashId, mapWithConcurrency } from "../../common/services/utils";

const INSIGHT_EXTRACTION_PROMPT = `
You are an Insight Extraction Agent.

Your job is to extract a structured set of insights directly from document chunks and contextual snippets.

Primary goal:
Extract evidence-backed insights that are directly relevant to the main thesis, analytical purpose, or substantive point of the document.

Important:
- Do NOT behave like a generic document summarizer.
- Do NOT extract every factual statement.
- Extract only the findings, claims, comparisons, conclusions, or observations that materially contribute to the document's main point.
- Write each insight as the underlying claim or finding itself, not as a description of what a source, citation, chunk, study, or document says.

Relevance requirement:
- First infer the likely purpose of the document from the provided chunk content.
- Then prioritize insights that directly support, explain, compare, or materially contribute to that purpose.
- Deprioritize or omit:
  - author disclosures
  - conflict of interest statements
  - acknowledgments
  - funding statements
  - copyright notices
  - citation metadata
  - references to the existence of sources rather than their substantive content
  - boilerplate administrative text

Grounding requirement:
- Every insight must be directly supported by the provided text.
- Every insight must include:
  - insight text
  - evidence_snippet
  - supporting_chunks
  - metadata entries supported by evidence
- The evidence_snippet must be a concise textual excerpt or close paraphrase of the specific text grounding the insight.
- Do not invent evidence.

Writing rules:
1. Express the substantive finding or claim directly.
2. Do NOT write:
   - "The document states..."
   - "The supporting chunk includes..."
   - "A study found..."
   - "The paper titled..."
3. Preserve important numbers, percentages, deltas, rankings, comparisons, trends, and directional changes when material.
4. Preserve important qualifiers such as region, segment, cohort, timeframe, product, or condition when material.
5. Prefer evidence-rich, specific insights over vague summaries.
6. If no substantive insight is present in a chunk/context, do not invent one.

Metadata guidelines:
- Metadata should be broadly reusable across insights.
- Examples include: topic, region, industry, product, market_segment, company, technology, policy_area, timeframe.
- Do NOT limit yourself only to these examples.
- Avoid overly specific or one-off metadata.
- If metadata is weakly supported, omit it.

Metadata format:
{
  "tag": "string",
  "value": "string",
  "confidence": number between 0 and 1
}

Additional rules:
- Each insight must have at least one supporting chunk.
- Metadata should describe the insight, not restate it.
- Most strong insights should include 1–3 metadata entries when clearly supported.
- Prefer fewer strong insights over many weak or redundant ones.
- If a candidate insight is mostly boilerplate or peripheral to the document's point, discard it.

Return ONLY valid JSON matching the schema.
`;

const INSIGHT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    insights: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          evidence_snippet: { type: "string" },
          supporting_chunks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                chunk_id: { type: "string" },
                paragraph_index: { type: ["number", "null"] },
                line_index: { type: ["number", "null"] },
              },
              required: ["chunk_id", "paragraph_index", "line_index"],
            },
          },
          metadata: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                tag: { type: "string" },
                value: { type: "string" },
                confidence: { type: "number" },
              },
              required: ["tag", "value", "confidence"],
            },
          },
          sub_insights: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                text: { type: "string" },
                evidence_snippet: { type: "string" },
                supporting_chunks: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      chunk_id: { type: "string" },
                      paragraph_index: { type: ["number", "null"] },
                      line_index: { type: ["number", "null"] },
                    },
                    required: ["chunk_id", "paragraph_index", "line_index"],
                  },
                },
                metadata: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      tag: { type: "string" },
                      value: { type: "string" },
                      confidence: { type: "number" },
                    },
                    required: ["tag", "value", "confidence"],
                  },
                },
              },
              required: ["text", "evidence_snippet", "supporting_chunks", "metadata"],
            },
          },
        },
        required: ["text", "evidence_snippet", "supporting_chunks", "metadata"],
      },
    },
  },
  required: ["insights"],
} as const;

type InsightResponse = {
  insights: Array<{
    text: string;
    evidence_snippet: string;
    supporting_chunks?: Array<{
      chunk_id: string;
      paragraph_index?: number | null;
      line_index?: number | null;
    }>;
    metadata?: Array<{
      tag: string;
      value: string;
      confidence: number;
    }>;
    sub_insights?: Array<{
      text: string;
      evidence_snippet: string;
      supporting_chunks?: Array<{
        chunk_id: string;
        paragraph_index?: number | null;
        line_index?: number | null;
      }>;
      metadata?: Array<{
        tag: string;
        value: string;
        confidence: number;
      }>;
    }>;
  }>;
};

type ChunkBatch = {
  batch_id: string;
  document_id: string;
  chunks: Chunk[];
};

const MAX_CHUNK_CONTEXT_CHARS = 900;
const MAX_EVIDENCE_SNIPPET_CHARS = 320;
const DEFAULT_BATCH_SIZE = 8;
const MIN_BATCH_SIZE = 4;
const MAX_BATCH_SIZE = 16;

function sanitizeBatchSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_BATCH_SIZE;
  return Math.max(MIN_BATCH_SIZE, Math.min(MAX_BATCH_SIZE, Math.floor(size)));
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}...`;
}

function cleanSnippet(value: string | null | undefined): string | undefined {
  const compact = value?.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return truncate(compact, MAX_EVIDENCE_SNIPPET_CHARS);
}

function buildFallbackSupportingChunks(batch: ChunkBatch): SupportingChunkRef[] {
  if (batch.chunks.length === 0) return [];
  return batch.chunks.slice(0, 3).map((chunk) => ({ chunk_id: chunk.chunk_id }));
}

function getChunkContext(chunk: Chunk): string {
  const content = chunk.content?.trim() ?? "";
  if (!content) return "";
  if (content.length <= MAX_CHUNK_CONTEXT_CHARS) return content;
  return truncate(content, MAX_CHUNK_CONTEXT_CHARS);
}

function buildChunkBatches(chunks: Chunk[]): ChunkBatch[] {
  if (chunks.length === 0) return [];
  const batchSize = sanitizeBatchSize(config.findingBatchSize);
  const groupedByDocument = new Map<string, Chunk[]>();

  // Removed finding-based batching: chunk grouping now happens inside insight extraction.
  for (const chunk of chunks) {
    const list = groupedByDocument.get(chunk.document_id) ?? [];
    list.push(chunk);
    groupedByDocument.set(chunk.document_id, list);
  }

  const batches: ChunkBatch[] = [];
  for (const [documentId, docChunks] of groupedByDocument.entries()) {
    const groups = chunkArray(docChunks, batchSize);
    for (const [index, group] of groups.entries()) {
      batches.push({
        batch_id: hashId(`${documentId}:chunk-batch:${index}`),
        document_id: documentId,
        chunks: group,
      });
    }
  }

  return batches;
}

function buildBatchInput(batch: ChunkBatch) {
  return {
    batch_id: batch.batch_id,
    document_id: batch.document_id,
    chunks: batch.chunks.map((chunk) => ({
      chunk_id: chunk.chunk_id,
      type: chunk.type,
      source_url: chunk.source_url,
      page: chunk.page,
      s3_node: chunk.s3_node,
      content: getChunkContext(chunk),
    })),
  };
}

function normalizeSupportingChunks(
  refs:
    | Array<{
        chunk_id: string;
        paragraph_index?: number | null;
        line_index?: number | null;
      }>
    | undefined,
  fallback: SupportingChunkRef[],
  chunkById: Map<string, Chunk>,
): SupportingChunkRef[] {
  const normalized = (refs ?? [])
    .filter((ref) => typeof ref.chunk_id === "string" && ref.chunk_id.trim().length > 0)
    .map((ref) => ({
      chunk_id: ref.chunk_id.trim(),
      ...(typeof ref.paragraph_index === "number" && ref.paragraph_index >= 0
        ? { paragraph_index: ref.paragraph_index }
        : {}),
      ...(typeof ref.line_index === "number" && ref.line_index >= 0
        ? { line_index: ref.line_index }
        : {}),
    }))
    .filter((ref) => chunkById.has(ref.chunk_id));

  return normalized.length > 0 ? normalized : fallback;
}

function normalizeMetadata(
  metadata:
    | Array<{
        tag: string;
        value: string;
        confidence: number;
      }>
    | undefined,
) {
  return (metadata ?? [])
    .map((entry) => ({
      tag: entry.tag?.trim(),
      value: entry.value?.trim(),
      confidence:
        typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
          ? Math.max(0, Math.min(1, entry.confidence))
          : undefined,
    }))
    .filter((entry) => Boolean(entry.tag) && Boolean(entry.value))
    .map((entry) => ({
      tag: entry.tag as string,
      value: entry.value as string,
      ...(typeof entry.confidence === "number"
        ? { confidence: entry.confidence }
        : {}),
    }));
}

function deriveEvidenceSnippet(
  provided: string | undefined,
  supportingChunks: SupportingChunkRef[],
  chunkById: Map<string, Chunk>,
  fallbackText: string,
): string {
  // Keep evidence_snippet explicitly grounded in either model-provided evidence,
  // supporting chunk text, or (last resort) the insight text itself.
  const direct = cleanSnippet(provided);
  if (direct) return direct;

  for (const ref of supportingChunks) {
    const chunk = chunkById.get(ref.chunk_id);
    if (!chunk) continue;

    if (
      typeof ref.paragraph_index === "number" &&
      Array.isArray(chunk.paragraphs) &&
      ref.paragraph_index >= 0 &&
      ref.paragraph_index < chunk.paragraphs.length
    ) {
      const paragraph = cleanSnippet(chunk.paragraphs[ref.paragraph_index]);
      if (paragraph) return paragraph;
    }

    const contentSnippet = cleanSnippet(chunk.content);
    if (contentSnippet) return contentSnippet;
  }

  return cleanSnippet(fallbackText) ?? "No supporting evidence snippet available.";
}

function mapBatchResponseToInsights(
  batch: ChunkBatch,
  response: InsightResponse,
  chunkById: Map<string, Chunk>,
): Insight[] {
  if (batch.chunks.length === 0) return [];

  const primaryS3Node = batch.chunks[0].s3_node || `chunk-batch:${batch.batch_id}`;
  const fallbackSupportingChunks = buildFallbackSupportingChunks(batch);

  const insights: Insight[] = [];
  for (const item of response.insights ?? []) {
    const text = item.text?.trim();
    if (!text) continue;

    const parentId = hashId(`${batch.document_id}:${batch.batch_id}:${text}`);
    const supportingChunks = normalizeSupportingChunks(
      item.supporting_chunks,
      fallbackSupportingChunks,
      chunkById,
    );

    const evidenceSnippet = deriveEvidenceSnippet(
      item.evidence_snippet,
      supportingChunks,
      chunkById,
      text,
    );

    insights.push({
      insight_id: parentId,
      text,
      evidence_snippet: evidenceSnippet,
      s3_node: primaryS3Node,
      document_id: batch.document_id,
      supporting_chunks: supportingChunks,
      metadata: normalizeMetadata(item.metadata),
      additional_refs: {
        source_batch_id: batch.batch_id,
        source_chunk_ids: Array.from(new Set(supportingChunks.map((ref) => ref.chunk_id))),
      },
    });

    for (const sub of item.sub_insights ?? []) {
      const subText = sub.text?.trim();
      if (!subText) continue;

      const subSupportingChunks = normalizeSupportingChunks(
        sub.supporting_chunks,
        supportingChunks,
        chunkById,
      );

      const subEvidenceSnippet = deriveEvidenceSnippet(
        sub.evidence_snippet,
        subSupportingChunks,
        chunkById,
        subText,
      );

      insights.push({
        insight_id: hashId(`${parentId}:${subText}`),
        parent_insight_id: parentId,
        text: subText,
        evidence_snippet: subEvidenceSnippet,
        s3_node: primaryS3Node,
        document_id: batch.document_id,
        supporting_chunks: subSupportingChunks,
        metadata: normalizeMetadata(sub.metadata),
        additional_refs: {
          source_batch_id: batch.batch_id,
          source_chunk_ids: Array.from(new Set(subSupportingChunks.map((ref) => ref.chunk_id))),
        },
      });
    }
  }

  return insights;
}

export async function insightExtractionAgent(
  state: GraphState,
): Promise<Partial<GraphState>> {
  console.log("InsightExtractionAgent:size", state.insights?.length ?? 0);
  const chunkById = new Map(state.chunks.map((chunk) => [chunk.chunk_id, chunk]));
  const chunkBatches = buildChunkBatches(state.chunks);

  console.debug("InsightExtractionAgent:start", {
    chunks: state.chunks.length,
    chunkBatches: chunkBatches.length,
  });

  if (chunkBatches.length === 0) {
    return {
      insights: [],
      errors: state.errors,
    };
  }

  const errors: PipelineError[] = [];
  const batchInsights = await mapWithConcurrency(
    chunkBatches,
    Math.max(1, config.maxConcurrency),
    async (batch) => {
      try {
        const sampleChunk = batch.chunks[0];
        console.log(
          "InsightExtractionAgent:llm-input-sample",
          JSON.stringify({
            batch_id: batch.batch_id,
            chunks_in_batch: batch.chunks.length,
            sample_chunk: sampleChunk
              ? {
                  chunk_id: sampleChunk.chunk_id,
                  type: sampleChunk.type,
                  content_preview: getChunkContext(sampleChunk).slice(0, 220),
                }
              : undefined,
          }),
        );

        const response = await openai.chat.completions.create({
          // Reuses existing OpenAI client + strict JSON-schema parsing pattern.
          model: OPENAI_MODEL,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: INSIGHT_EXTRACTION_PROMPT,
            },
            {
              role: "user",
              content: [
                "Extract grounded insights from this bounded chunk group.",
                "Infer document purpose from the chunk context and keep only materially relevant insights.",
                `Batch id: ${batch.batch_id}`,
                `Chunk group JSON:\n${JSON.stringify(buildBatchInput(batch), null, 2)}`,
              ].join("\n\n"),
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "insight_extraction",
              schema: INSIGHT_SCHEMA,
              strict: true,
            },
          },
        });

        const content = response.choices[0]?.message?.content;
        if (!content) throw new Error("Empty OpenAI response.");

        let parsed: InsightResponse;
        try {
          parsed = JSON.parse(content) as InsightResponse;
          console.log(
            "InsightExtractionAgent:llm-output-json",
            JSON.stringify({
              batch_id: batch.batch_id,
              output: parsed,
            }),
          );
        } catch (error) {
          console.error("InsightExtractionAgent:failed-to-parse", {
            batchId: batch.batch_id,
            content,
          });
          throw error;
        }

        return mapBatchResponseToInsights(batch, parsed, chunkById);
      } catch (error) {
        errors.push({
          stage: "InsightExtractionAgent",
          message: error instanceof Error ? error.message : "Unknown error",
          document_id: batch.document_id,
          cause: error,
        });
        return [];
      }
    },
  );

  const flattenedInsights = batchInsights.flat();
  console.debug("InsightExtractionAgent:end", {
    batchInsights: batchInsights.length,
    insights: flattenedInsights.length,
    errors: errors.length,
  });

  return {
    insights: flattenedInsights,
    errors: state.errors.concat(errors),
  };
}
