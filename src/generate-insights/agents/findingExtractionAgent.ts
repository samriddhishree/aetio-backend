import type {
  Chunk,
  Finding,
  FindingEvidenceType,
  GraphState,
  PipelineError,
  SupportingChunkRef,
} from "../../types";
import { config } from "../../common/services/config";
import { openai, OPENAI_MODEL } from "../../common/services/openai";
import { hashId, mapWithConcurrency } from "../../common/services/utils";

const FINDING_PROMPT = `
You are a finding extraction agent.

Goal:
Extract evidence-bearing findings from a document chunk.

The chunk may be:
- quantitative / data-heavy
- qualitative / narrative
- mixed

For quantitative evidence, capture findings such as:
- metric changes
- comparisons
- trends
- outliers
- segment differences
- time-based deltas
- explicit numeric observations

For qualitative evidence, capture findings such as:
- claims
- observations
- arguments
- conclusions
- causal statements
- notable facts

Rules:
- Findings must be grounded in the provided chunk text.
- Keep finding text concise and specific.
- Include evidence_snipped as a short direct evidence snippet from the chunk.
- Use evidence_type = "quantitative", "qualitative", or "mixed".
- Populate optional structured fields (metric, value, comparison, segment, timeframe) only when clearly supported.
- If the chunk has no meaningful evidence, return an empty findings array.

Return ONLY valid JSON matching the schema.
`;

const FINDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          evidence_snipped: { type: "string" },
          evidence_type: {
            type: "string",
            enum: ["quantitative", "qualitative", "mixed"],
          },
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
          metric: { type: ["string", "null"] },
          value: { type: ["string", "null"] },
          comparison: { type: ["string", "null"] },
          segment: { type: ["string", "null"] },
          timeframe: { type: ["string", "null"] },
        },
        required: [
          "text",
          "evidence_snipped",
          "evidence_type",
          "supporting_chunks",
          "metric",
          "value",
          "comparison",
          "segment",
          "timeframe",
        ],
      },
    },
  },
  required: ["findings"],
} as const;

type FindingResponse = {
  findings: Array<{
    text: string;
    evidence_snipped: string;
    evidence_type: FindingEvidenceType;
    supporting_chunks?: SupportingChunkRef[];
    metric?: string | null;
    value?: string | null;
    comparison?: string | null;
    segment?: string | null;
    timeframe?: string | null;
  }>;
};

const MAX_EVIDENCE_SNIPPED_CHARS = 320;

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

function buildSupportingChunks(chunk: Chunk, findingText: string): SupportingChunkRef[] {
  const paragraphIndex = findParagraphIndex(chunk.paragraphs, findingText);
  const lineIndex =
    paragraphIndex === undefined ? findLineIndex(chunk.content, findingText) : undefined;

  const entry: SupportingChunkRef = {
    chunk_id: chunk.chunk_id,
    ...(paragraphIndex !== undefined && paragraphIndex >= 0
      ? { paragraph_index: paragraphIndex }
      : {}),
    ...(lineIndex !== undefined && lineIndex >= 0 ? { line_index: lineIndex } : {}),
  };

  return [entry];
}

function inferEvidenceType(text: string): FindingEvidenceType {
  const numericSignals = /\b\d+(?:\.\d+)?%?\b/.test(text);
  const comparisonSignals =
    /(increase|decrease|up|down|trend|grew|declined|compared|versus|vs\.?|delta|rate)/i.test(
      text,
    );

  if (numericSignals && comparisonSignals) return "mixed";
  if (numericSignals) return "quantitative";
  return "qualitative";
}

function normalizeEvidenceType(
  evidenceType: string | undefined,
  fallbackText: string,
): FindingEvidenceType {
  if (evidenceType === "quantitative" || evidenceType === "qualitative" || evidenceType === "mixed") {
    return evidenceType;
  }
  return inferEvidenceType(fallbackText);
}

function normalizeSupportingChunks(
  refs: SupportingChunkRef[] | undefined,
  chunk: Chunk,
  findingText: string,
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

  if (normalized.length > 0) {
    return normalized;
  }

  return buildSupportingChunks(chunk, findingText);
}

function classifyChunkMode(content: string): "data-heavy" | "mixed" | "narrative" {
  const numericCount = (content.match(/\b\d+(?:\.\d+)?%?\b/g) ?? []).length;
  const narrativeSignals =
    /(because|therefore|suggests|indicates|argues|concludes|observed|reported)/i.test(content);

  if (numericCount >= 3) return "data-heavy";
  if (numericCount > 0 && narrativeSignals) return "mixed";
  if (numericCount > 0) return "data-heavy";
  return "narrative";
}

function cleanOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}...`;
}

function cleanEvidenceSnipped(value: string | null | undefined): string | undefined {
  const compact = value?.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return truncate(compact, MAX_EVIDENCE_SNIPPED_CHARS);
}

function deriveEvidenceSnipped(
  chunk: Chunk,
  findingText: string,
  supportingChunks: SupportingChunkRef[],
): string {
  for (const ref of supportingChunks) {
    if (
      typeof ref.paragraph_index === "number" &&
      Array.isArray(chunk.paragraphs) &&
      ref.paragraph_index >= 0 &&
      ref.paragraph_index < chunk.paragraphs.length
    ) {
      const paragraph = chunk.paragraphs[ref.paragraph_index];
      const snippet = cleanEvidenceSnipped(paragraph);
      if (snippet) return snippet;
    }
  }

  return (
    cleanEvidenceSnipped(findingText) ??
    cleanEvidenceSnipped(chunk.content) ??
    "No evidence snippet available."
  );
}

export class FindingExtractionAgent {
  // Added as a generalized evidence extraction layer so downstream insight extraction
  // works consistently for quantitative, qualitative, and mixed documents.
  async process(state: GraphState): Promise<Partial<GraphState>> {
    console.log("FindingExtractionAgent:size", state.insights?.length ?? 0);
    console.debug("FindingExtractionAgent:start", { chunks: state.chunks.length });
    const errors: PipelineError[] = [];

    // Reuse the same OpenAI + JSON-schema + concurrency pattern as existing extraction agents
    // so this stage can be introduced incrementally without changing downstream contracts.
    const findingsByChunk = await mapWithConcurrency(
      state.chunks,
      config.maxConcurrency,
      async (chunk) => {
        try {
          const chunkText = chunk.content?.trim();
          if (!chunkText) return [];

          const chunkMode = classifyChunkMode(chunkText);
          console.log(
            "FindingExtractionAgent:llm-input-sample",
            JSON.stringify({
              document_id: chunk.document_id,
              chunk_id: chunk.chunk_id,
              chunk_mode: chunkMode,
              chunk_preview: chunkText.slice(0, 240),
            }),
          );
          const response = await openai.chat.completions.create({
            model: OPENAI_MODEL,
            temperature: 0.1,
            messages: [
              {
                role: "system",
                content: FINDING_PROMPT,
              },
              {
                role: "user",
                content: [
                  `Chunk mode hint: ${chunkMode}`,
                  `document_id: ${chunk.document_id}`,
                  `chunk_id: ${chunk.chunk_id}`,
                  "Chunk content:",
                  chunkText,
                ].join("\n\n"),
              },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "finding_extraction",
                schema: FINDING_SCHEMA,
                strict: true,
              },
            },
          });

          const content = response.choices[0]?.message?.content;
          if (!content) throw new Error("Empty OpenAI response.");

          let parsed: FindingResponse;
          try {
            parsed = JSON.parse(content) as FindingResponse;
            console.log(
              "FindingExtractionAgent:llm-output-json",
              JSON.stringify({
                chunk_id: chunk.chunk_id,
                output: parsed,
              }),
            );
          } catch (error) {
            console.error("FindingExtractionAgent:failed-to-parse", {
              content,
              chunkId: chunk.chunk_id,
            });
            throw error;
          }

          const findings: Finding[] = [];
          for (const [index, finding] of (parsed.findings ?? []).entries()) {
            const text = finding.text?.trim();
            if (!text) continue;
            const supportingChunks = normalizeSupportingChunks(
              finding.supporting_chunks,
              chunk,
              text,
            );
            const evidenceSnipped =
              cleanEvidenceSnipped(finding.evidence_snipped) ??
              deriveEvidenceSnipped(chunk, text, supportingChunks);

            findings.push({
              finding_id: hashId(
                `${chunk.document_id}:${chunk.s3_node}:finding:${index}:${text}`,
              ),
              text,
              evidence_snipped: evidenceSnipped,
              evidence_type: normalizeEvidenceType(finding.evidence_type, text),
              supporting_chunks: supportingChunks,
              document_id: chunk.document_id,
              s3_node: chunk.s3_node,
              metric: cleanOptional(finding.metric),
              value: cleanOptional(finding.value),
              comparison: cleanOptional(finding.comparison),
              segment: cleanOptional(finding.segment),
              timeframe: cleanOptional(finding.timeframe),
            });
          }

          return findings;
        } catch (error) {
          errors.push({
            stage: "FindingExtractionAgent",
            message: error instanceof Error ? error.message : "Unknown error",
            document_id: chunk.document_id,
            cause: error,
          });
          return [];
        }
      },
    );

    const findings = findingsByChunk.flat();
    console.debug("FindingExtractionAgent:end", {
      findings: findings.length,
      errors: errors.length,
    });

    return {
      findings,
      errors: state.errors.concat(errors),
    };
  }
}

export const findingExtractionAgent = new FindingExtractionAgent();
