import type { GraphState, Insight, PipelineError } from "../../types";
import { config } from "../services/config";
import { openai, OPENAI_MODEL } from "../services/openai";
import { mapWithConcurrency } from "../services/utils";

const METADATA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    metadata: {
      type: "object",
      additionalProperties: false,
      properties: {
        topic: { type: "string" },
        region: { type: "string" },
        timeframe: { type: "string" },
        tags: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: [],
    },
  },
  required: ["metadata"],
} as const;

type MetadataResponse = {
  metadata?: {
    topic?: string;
    region?: string;
    timeframe?: string;
    tags?: string[];
  };
};

function buildSourceText(
  insight: Insight,
  sourceTextByS3Node: Record<string, string>,
  childTextByParent: Map<string, string>,
): string {
  if (sourceTextByS3Node[insight.s3_node]) {
    return sourceTextByS3Node[insight.s3_node];
  }
  if (childTextByParent.has(insight.insight_id)) {
    return childTextByParent.get(insight.insight_id) ?? insight.text;
  }
  return insight.text;
}

function normalizeMetadata(metadata?: MetadataResponse["metadata"]) {
  if (!metadata) return undefined;
  const cleaned: MetadataResponse["metadata"] = {
    topic: metadata.topic?.trim(),
    region: metadata.region?.trim(),
    timeframe: metadata.timeframe?.trim(),
    tags: metadata.tags?.map((tag) => tag.trim()).filter(Boolean),
  };

  const hasValues =
    cleaned.topic || cleaned.region || cleaned.timeframe || (cleaned.tags?.length ?? 0) > 0;

  return hasValues ? cleaned : undefined;
}

export async function metadataAgent(
  state: GraphState,
): Promise<Partial<GraphState>> {
  console.debug("MetadataAgent:start", { insights: state.insights.length });
  const errors: PipelineError[] = [];
  const childTextByParent = new Map<string, string>();

  for (const insight of state.insights) {
    if (!insight.parent_insight_id) continue;
    const existing = childTextByParent.get(insight.parent_insight_id) ?? "";
    childTextByParent.set(
      insight.parent_insight_id,
      `${existing}\n${insight.text}`.trim(),
    );
  }

  const enriched = await mapWithConcurrency(
    state.insights,
    config.maxConcurrency,
    async (insight) => {
      try {
        const sourceText = buildSourceText(
          insight,
          state.sourceTextByS3Node,
          childTextByParent,
        ).slice(0, 6000);

        const response = await openai.chat.completions.create({
          model: OPENAI_MODEL,
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "You are a metadata extraction agent. Only add metadata fields that are strongly supported by the source text. If none are supported, return {\"metadata\": {}}.",
            },
            {
              role: "user",
              content: `Insight:\n${insight.text}\n\nSource:\n${sourceText}\n\nReturn JSON.`,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "metadata_extraction",
              schema: METADATA_SCHEMA,
              strict: true,
            },
          },
        });

        const content = response.choices[0]?.message?.content;
        if (!content) throw new Error("Empty OpenAI response.");

        const parsed = JSON.parse(content) as MetadataResponse;
        const metadata = normalizeMetadata(parsed.metadata);
        return metadata ? { ...insight, metadata } : insight;
      } catch (error) {
        errors.push({
          stage: "MetadataAgent",
          message: error instanceof Error ? error.message : "Unknown error",
          document_id: insight.document_id,
          cause: error,
        });
        return insight;
      }
    },
  );

  let response = {
    insights: enriched,
    errors: state.errors.concat(errors),
  };
  console.debug("MetadataAgent:end", response);

  return response;
}
