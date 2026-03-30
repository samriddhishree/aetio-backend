import type {
  BatchInsightResult,
  Chunk,
  Finding,
  FindingBatch,
  FindingRef,
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

Your job is to transform a set of extracted findings into a structured set of insights.

Important:
- The findings are already the evidence-bearing units.
- Do NOT behave like a document summarizer.
- Do NOT generate vague high-level summaries unless they are directly supported by multiple findings.
- Your role is to organize, refine, deduplicate, and compose findings into a coherent insight set.
- Write each insight as the underlying claim or finding itself, not as a description of what a source, citation, study, chunk, or document says.

Primary goal:
Produce a set of evidence-backed insights that preserve the important informational value of the findings and organize them into parent/child relationships where appropriate.

Inputs:
You will receive extracted findings. Each finding may be quantitative, qualitative, or mixed.

Each finding is already grounded in document evidence and may include:
- finding text
- evidence_snipped
- supporting_chunks
- evidence_type
- optional structured attributes such as metric, value, comparison, segment, region, or timeframe

Instructions:

1. Treat findings as the primary source material.
   - Build insights from findings.
   - Do not ignore the findings and re-summarize the document from scratch.

2. Preserve evidence fidelity.
   - If a finding contains important numeric, comparative, segmented, or time-based information, preserve that information in the resulting insight text.
   - Do NOT paraphrase away important numbers, percentages, deltas, rankings, comparisons, or segment-specific differences.

3. Prefer evidence-rich insights over vague summaries.
   - Bad: "Performance was mixed across segments."
   - Better: "Enterprise revenue increased 18% YoY while SMB revenue declined 6% YoY."
   - Bad: "Retention worsened in some regions."
   - Better: "APAC churn increased by 3 percentage points while North America churn remained flat."

4. Promote atomic findings into leaf insights when appropriate.
   - Findings that contain concrete evidence should often become leaf/sub-insights.
   - Parent insights may group multiple closely related findings when a shared pattern is clearly supported.

5. Only create parent insights when justified.
   - Parent insights should represent a real common pattern across multiple findings.
   - Parent insights must remain specific and evidence-backed.
   - Do NOT create generic themes like "Market Trends", "Performance Overview", or "Business Challenges" unless those phrases are truly supported and precise.

6. Deduplicate and normalize where useful.
   - If multiple findings express the same underlying fact, merge them into the strongest, clearest insight.
   - Preserve the best evidence and supporting chunks.

7. Parent-child guidance:
   - Child insights should usually be the more concrete or specific findings.
   - Parent insights should usually be a slightly more general statement supported by those children.
   - Do not force hierarchy if the findings do not naturally group.

8. Support all document types.
   - For quantitative/data-driven findings: preserve metrics, values, changes, comparisons, and scope.
   - For qualitative findings: preserve claims, arguments, observations, and conclusions.
   - For mixed findings: preserve both the factual claim and its evidentiary detail.

9. Every insight must include:
   - text
   - supporting_chunks
   - optional sub_insights
   - metadata entries supported by evidence

Metadata guidelines:
- Metadata represents categorical descriptors that may apply across many insights.
- Examples include: topic, region, industry, product, market_segment, company, technology, policy_area, timeframe.
- Do NOT limit yourself only to these examples.
- Only generate metadata fields that are broadly reusable across insights.
- Avoid overly specific or one-off metadata fields.
- If metadata is weakly supported, omit it.

Metadata format:
{
  "tag": "string",
  "value": "string",
  "confidence": number between 0 and 1
}

Additional rules:
- Each insight must have at least one supporting chunk.
- Metadata should describe the insight, not simply restate the text.
- Most strong insights should include 1–3 metadata entries when clearly supported.
- Preserve comparisons, directionality, scope, and important qualifiers when they are material.
- Prefer a smaller number of high-quality insights to a large number of weak or redundant ones.
- If a parent insight would become too vague, do not create it.
- If findings are best left as standalone insights, keep them standalone.

Desired behavior:
- Leaf insights should often correspond closely to atomic findings.
- Parent insights should organize and synthesize related findings without losing specificity.
- The final insight set should be useful for downstream critique, revision, validation, hierarchy building, metadata consolidation, search, and AI-assisted exploration.

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
              required: ["text", "supporting_chunks", "metadata"],
            },
          },
        },
        required: ["text", "sub_insights", "supporting_chunks", "metadata"],
      },
    },
  },
  required: ["insights"],
} as const;

type InsightResponse = {
  insights: Array<{
    text: string;
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

const MAX_FINDINGS_PER_FALLBACK_BATCH = 12;
const MAX_CHUNK_CONTEXT_CHARS = 700;

function normalizeForMatch(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function findParagraphIndex(paragraphs: string[] | undefined, text: string): number | undefined {
  if (!paragraphs || paragraphs.length === 0) return undefined;
  const needle = normalizeForMatch(text);
  if (!needle) return undefined;
  return paragraphs.findIndex((paragraph) => normalizeForMatch(paragraph).includes(needle));
}

function findLineIndex(content: string, text: string): number | undefined {
  if (!content.includes("\n")) return undefined;
  const needle = normalizeForMatch(text);
  if (!needle) return undefined;
  const lines = content.split(/\r?\n/);
  return lines.findIndex((line) => normalizeForMatch(line).includes(needle));
}

function buildSupportingChunks(
  chunk: Chunk,
  insightText: string,
): SupportingChunkRef[] {
  const paragraphIndex = findParagraphIndex(chunk.paragraphs, insightText);
  const lineIndex =
    paragraphIndex === undefined ? findLineIndex(chunk.content, insightText) : undefined;

  const entry: SupportingChunkRef = {
    chunk_id: chunk.chunk_id,
    ...(paragraphIndex !== undefined && paragraphIndex >= 0
      ? { paragraph_index: paragraphIndex }
      : {}),
    ...(lineIndex !== undefined && lineIndex >= 0 ? { line_index: lineIndex } : {}),
  };

  return [entry];
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
    }));

  return normalized.length > 0 ? normalized : fallback;
}

function toFindingRef(finding: Finding): FindingRef {
  return {
    finding_id: finding.finding_id,
    text: finding.text,
    evidence_snipped: finding.evidence_snipped,
    evidence_type: finding.evidence_type,
    supporting_chunks: finding.supporting_chunks,
    document_id: finding.document_id,
    s3_node: finding.s3_node,
    metric: finding.metric,
    value: finding.value,
    comparison: finding.comparison,
    segment: finding.segment,
    timeframe: finding.timeframe,
  };
}

function resolveSupportingFindings(
  findings: Finding[],
  supportingChunks: SupportingChunkRef[],
): FindingRef[] {
  if (findings.length === 0) return [];
  const supportingChunkIds = new Set(
    supportingChunks
      .map((ref) => ref.chunk_id?.trim())
      .filter((chunkId): chunkId is string => Boolean(chunkId)),
  );

  const matched = findings.filter((finding) =>
    finding.supporting_chunks.some((ref) => supportingChunkIds.has(ref.chunk_id)),
  );
  const source = matched.length > 0 ? matched : findings;
  return source.map(toFindingRef);
}

function fallbackFindingBatches(findings: Finding[]): FindingBatch[] {
  if (findings.length === 0) return [];
  const batchSize =
    Number.isFinite(config.findingBatchSize) && config.findingBatchSize > 0
      ? Math.floor(config.findingBatchSize)
      : MAX_FINDINGS_PER_FALLBACK_BATCH;
  const groupedByDocument = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = groupedByDocument.get(finding.document_id) ?? [];
    list.push(finding);
    groupedByDocument.set(finding.document_id, list);
  }

  const batches: FindingBatch[] = [];
  for (const [documentId, docFindings] of groupedByDocument.entries()) {
    const chunks = chunkArray(docFindings, batchSize);
    for (const [batchIndex, findingChunk] of chunks.entries()) {
      batches.push({
        batch_id: hashId(`${documentId}:fallback-finding-batch:${batchIndex}`),
        findings: findingChunk,
      });
    }
  }
  return batches;
}

function collectBatchSupportingChunks(findings: Finding[]): SupportingChunkRef[] {
  const unique = new Map<string, SupportingChunkRef>();
  for (const finding of findings) {
    for (const ref of finding.supporting_chunks) {
      const key = `${ref.chunk_id}:${ref.paragraph_index ?? ""}:${ref.line_index ?? ""}`;
      if (unique.has(key)) continue;
      unique.set(key, ref);
    }
  }
  return Array.from(unique.values());
}

function getChunkContext(chunkById: Map<string, Chunk>, chunkId: string): string | undefined {
  const content = chunkById.get(chunkId)?.content?.trim();
  if (!content) return undefined;
  if (content.length <= MAX_CHUNK_CONTEXT_CHARS) return content;
  return `${content.slice(0, MAX_CHUNK_CONTEXT_CHARS - 1).trimEnd()}...`;
}

function buildBatchInput(batch: FindingBatch, chunkById: Map<string, Chunk>) {
  return {
    batch_id: batch.batch_id,
    findings: batch.findings.map((finding) => {
      const firstChunkId = finding.supporting_chunks[0]?.chunk_id;
      return {
        finding_id: finding.finding_id,
        text: finding.text,
        evidence_snipped: finding.evidence_snipped,
        evidence_type: finding.evidence_type,
        supporting_chunks: finding.supporting_chunks,
        metric: finding.metric,
        value: finding.value,
        comparison: finding.comparison,
        segment: finding.segment,
        timeframe: finding.timeframe,
        chunk_context: firstChunkId ? getChunkContext(chunkById, firstChunkId) : undefined,
      };
    }),
  };
}

function mapBatchResponseToInsights(
  batch: FindingBatch,
  response: InsightResponse,
  chunkById: Map<string, Chunk>,
): Insight[] {
  const findings = batch.findings;
  if (findings.length === 0) return [];

  const primaryDocumentId = findings[0].document_id;
  const primaryS3Node = findings[0].s3_node || `finding-batch:${batch.batch_id}`;
  const fallbackSupportingChunks = collectBatchSupportingChunks(findings);
  const fallbackFromChunkContext =
    fallbackSupportingChunks.length > 0
      ? fallbackSupportingChunks
      : findings[0].supporting_chunks.length > 0
        ? findings[0].supporting_chunks
        : (() => {
            const chunkId = findings[0].supporting_chunks[0]?.chunk_id;
            const chunk = chunkId ? chunkById.get(chunkId) : undefined;
            return chunk ? buildSupportingChunks(chunk, findings[0].text) : [];
          })();
  const findingIds = findings.map((finding) => finding.finding_id);

  const insights: Insight[] = [];
  for (const item of response.insights ?? []) {
    const text = item.text?.trim();
    if (!text) continue;

    const parentId = hashId(`${primaryDocumentId}:${batch.batch_id}:${text}`);
    const supportingChunks = normalizeSupportingChunks(
      item.supporting_chunks,
      fallbackFromChunkContext,
    );
    const supportingFindings = resolveSupportingFindings(findings, supportingChunks);

    insights.push({
      insight_id: parentId,
      text,
      s3_node: primaryS3Node,
      document_id: primaryDocumentId,
      supporting_chunks: supportingChunks,
      findings: supportingFindings,
      metadata: item.metadata ?? [],
      additional_refs: {
        findings: supportingFindings,
        finding_ids: findingIds,
        source_batch_id: batch.batch_id,
      },
    });

    for (const sub of item.sub_insights ?? []) {
      const subText = sub.text?.trim();
      if (!subText) continue;

      const subSupportingChunks = normalizeSupportingChunks(
        sub.supporting_chunks,
        supportingChunks,
      );
      const subSupportingFindings = resolveSupportingFindings(findings, subSupportingChunks);

      insights.push({
        insight_id: hashId(`${parentId}:${subText}`),
        parent_insight_id: parentId,
        text: subText,
        s3_node: primaryS3Node,
        document_id: primaryDocumentId,
        supporting_chunks: subSupportingChunks,
        findings: subSupportingFindings,
        metadata: sub.metadata ?? [],
        additional_refs: {
          findings: subSupportingFindings,
          finding_ids: findingIds,
          source_batch_id: batch.batch_id,
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
  const findingBatches =
    state.finding_batches.length > 0
      ? state.finding_batches
      : fallbackFindingBatches(state.findings);

  console.debug("InsightExtractionAgent:start", {
    findings: state.findings.length,
    findingBatches: findingBatches.length,
  });

  if (findingBatches.length === 0) {
    return {
      findings: state.findings,
      batch_insights: [],
      insights: [],
      errors: state.errors,
    };
  }

  const errors: PipelineError[] = [];
  const batchResults = await mapWithConcurrency(
    findingBatches,
    Math.max(1, config.maxConcurrency),
    async (batch): Promise<BatchInsightResult> => {
      try {
        const sampleFinding = batch.findings[0];
        console.log(
          "InsightExtractionAgent:llm-input-sample",
          JSON.stringify({
            batch_id: batch.batch_id,
            findings_in_batch: batch.findings.length,
            sample_finding: sampleFinding
              ? {
                  finding_id: sampleFinding.finding_id,
                  text: sampleFinding.text,
                  evidence_snipped: sampleFinding.evidence_snipped,
                  evidence_type: sampleFinding.evidence_type,
                  supporting_chunks: sampleFinding.supporting_chunks.slice(0, 1),
                }
              : undefined,
          }),
        );
        const response = await openai.chat.completions.create({
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
                "Build insights from this bounded finding batch.",
                "Treat findings as primary evidence and preserve quantitative detail.",
                `Batch id: ${batch.batch_id}`,
                `Batch findings JSON:\n${JSON.stringify(buildBatchInput(batch, chunkById), null, 2)}`,
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

        const mappedInsights = mapBatchResponseToInsights(batch, parsed, chunkById);
        console.log(
          "InsightExtractionAgent:insights-with-findings-json",
          JSON.stringify({
            batch_id: batch.batch_id,
            insights: mappedInsights,
          }),
        );

        return {
          batch_id: batch.batch_id,
          insights: mappedInsights,
        };
      } catch (error) {
        errors.push({
          stage: "InsightExtractionAgent",
          message: error instanceof Error ? error.message : "Unknown error",
          document_id: batch.findings[0]?.document_id,
          cause: error,
        });
        return { batch_id: batch.batch_id, insights: [] };
      }
    },
  );

  // Keep backward compatibility by returning flattened insights in addition to
  // per-batch outputs. CrossBatchMergeAgent consumes batch_insights in the new flow.
  const flattenedInsights = batchResults.flatMap((result) => result.insights);
  console.debug("InsightExtractionAgent:end", {
    batchInsights: batchResults.length,
    insights: flattenedInsights.length,
    errors: errors.length,
  });

  return {
    findings: state.findings,
    batch_insights: batchResults,
    insights: flattenedInsights,
    errors: state.errors.concat(errors),
  };
}
