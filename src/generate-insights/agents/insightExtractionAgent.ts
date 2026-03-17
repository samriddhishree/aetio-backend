import type { GraphState, Insight, PipelineError } from "../types";
import { config } from "../services/config";
import { openai, OPENAI_MODEL } from "../services/openai";
import { hashId, mapWithConcurrency } from "../services/utils";

const INSIGHT_PROMPT = `
You are an insight extraction agent.

Extract key insights and optional sub-insights from the provided document chunks.

Each insight must include:
- insight text
- supporting_chunks (with chunk_id and paragraph_index or line_index when possible)
- metadata entries supported by evidence in the text

Metadata guidelines:

Metadata represents categorical descriptors that may apply to many insights in a document.

Examples of valid metadata categories include:
topic, region, industry, product, market_segment, company, technology, policy_area, timeframe.

However:
- Do NOT limit yourself to only these examples.
- Only generate metadata fields that are broadly reusable across insights.
- Avoid creating overly specific or one-off fields.

Evidence requirements:
- Metadata must be supported by the supporting chunks.
- If evidence is weak or unclear, omit the metadata instead of guessing.

Metadata format:

{
  "tag": "string",
  "value": "string",
  "confidence": number between 0 and 1
}

Additional rules:

- Prefer a small number of meaningful metadata fields rather than many weak ones.
- Each insight must have at least one supporting chunk.
- Sub-insights should refine or support their parent insight.
- Metadata should describe the insight, not restate the insight text.
- Most insights should include 1–3 metadata entries when strong evidence exists.

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
                paragraph_index: { type: "number" },
                line_index: { type: "number" },
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
                      paragraph_index: { type: "number" },
                      line_index: { type: "number" },
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
      paragraph_index?: number;
      line_index?: number;
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
        paragraph_index?: number;
        line_index?: number;
      }>;
      metadata?: Array<{
        tag: string;
        value: string;
        confidence: number;
      }>;
    }>;
  }>;
};

function normalizeForMatch(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function findParagraphIndex(paragraphs: string[] | undefined, text: string): number | undefined {
  if (!paragraphs || paragraphs.length === 0) return undefined;
  const needle = normalizeForMatch(text);
  if (!needle) return undefined;
  return paragraphs.findIndex((paragraph) =>
    normalizeForMatch(paragraph).includes(needle),
  );
}

function findLineIndex(content: string, text: string): number | undefined {
  if (!content.includes("\n")) return undefined;
  const needle = normalizeForMatch(text);
  if (!needle) return undefined;
  const lines = content.split(/\r?\n/);
  return lines.findIndex((line) =>
    normalizeForMatch(line).includes(needle),
  );
}

function buildSupportingChunks(
  chunk: GraphState["chunks"][number],
  insightText: string,
): Insight["supporting_chunks"] {
  const paragraphIndex = findParagraphIndex(chunk.paragraphs, insightText);
  const lineIndex =
    paragraphIndex === undefined ? findLineIndex(chunk.content, insightText) : undefined;

  const entry: NonNullable<Insight["supporting_chunks"]>[number] = {
    chunk_id: chunk.chunk_id,
    ...(paragraphIndex !== undefined && paragraphIndex >= 0
      ? { paragraph_index: paragraphIndex }
      : {}),
    ...(lineIndex !== undefined && lineIndex >= 0 ? { line_index: lineIndex } : {}),
  };

  return [entry];
}

export async function insightExtractionAgent(
  state: GraphState,
): Promise<Partial<GraphState>> {
  console.debug("InsightExtractionAgent:start", { chunks: state.chunks.length });
  const errors: PipelineError[] = [];

  const allInsights = await mapWithConcurrency(
    state.chunks,
    config.maxConcurrency,
    async (chunk) => {
      try {
        const chunkText = chunk.content?.trim();
        if (!chunkText) return [];
        const response = await openai.chat.completions.create({
          model: OPENAI_MODEL,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content:
                INSIGHT_PROMPT,
            },
            {
              role: "user",
              content: `Return JSON for this chunk:\n\n${chunkText}`,
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
        } catch (error) {
          console.error("InsightExtractionAgent:failed-to-parse", {
            content,
            chunkText
          });
          throw error;
        }
        const insights: Insight[] = [];

        for (const item of parsed.insights ?? []) {
          const parentId = hashId(
            `${chunk.document_id}:${chunk.s3_node}:${item.text}`,
          );
          insights.push({
            insight_id: parentId,
            text: item.text,
            s3_node: chunk.s3_node,
            document_id: chunk.document_id,
            supporting_chunks: buildSupportingChunks(chunk, item.text),
            metadata: item.metadata ?? [],
          });

          for (const sub of item.sub_insights ?? []) {
            insights.push({
              insight_id: hashId(`${parentId}:${sub.text}`),
              parent_insight_id: parentId,
              text: sub.text,
              s3_node: chunk.s3_node,
              document_id: chunk.document_id,
              supporting_chunks: buildSupportingChunks(chunk, sub.text),
              metadata: sub.metadata ?? [],
            });
          }
        }

        return insights;
      } catch (error) {
        errors.push({
          stage: "InsightExtractionAgent",
          message: error instanceof Error ? error.message : "Unknown error",
          document_id: chunk.document_id,
          cause: error,
        });
        return [];
      }
    },
  );
  let response = {
    insights: allInsights.flat(),
    errors: state.errors.concat(errors),
  }
  console.debug("InsightExtractionAgent:end", response);

  return response;
}
