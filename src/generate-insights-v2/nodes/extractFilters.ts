import { openai, OPENAI_HELPER_MODEL } from "../../common/services/openai";
import type { PipelineError } from "../../types";
import {
  FILTER_EXTRACTION_PROMPT,
  FILTER_EXTRACTION_SCHEMA,
} from "../prompts";
import type { GenerateInsightsV2State } from "../types";

type FilterResponse = {
  filters: string[];
};

function normalizeTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\- ]+/g, "")
    .replace(/\s+/g, "_");
}

export async function extractFiltersNode(
  state: GenerateInsightsV2State,
): Promise<Partial<GenerateInsightsV2State>> {
  console.info("[filter-extraction] starting", {
    findings: state.validatedFindings.length,
  });

  const counts = new Map<string, number>();
  for (const finding of state.validatedFindings) {
    for (const dimension of finding.dimensions ?? []) {
      const tag = normalizeTag(dimension.tag);
      if (!tag) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  const sortedTags = Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([tag]) => tag);

  const deterministicPrimary = Array.from(counts.entries())
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1])
    .map(([tag]) => tag)
    .slice(0, 12);

  const deterministicFallback = sortedTags.slice(0, 8);
  const critiqueErrors: PipelineError[] = [];

  let llmFilters: string[] = [];
  if (state.validatedFindings.length > 0 && deterministicFallback.length > 0) {
    try {
      const response = await openai.chat.completions.create({
        model: OPENAI_HELPER_MODEL,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: FILTER_EXTRACTION_PROMPT,
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                candidate_tags: deterministicFallback,
                findings: state.validatedFindings.slice(0, 120).map((finding) => ({
                  finding_id: finding.finding_id,
                  dimensions: finding.dimensions ?? [],
                  text: finding.text,
                })),
              },
              null,
              2,
            ),
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "filters_v2",
            schema: FILTER_EXTRACTION_SCHEMA,
            strict: true,
          },
        },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("Empty OpenAI response.");

      const parsed = JSON.parse(content) as FilterResponse;
      llmFilters = (parsed.filters ?? []).map(normalizeTag).filter(Boolean);
    } catch (error) {
      critiqueErrors.push({
        stage: "filter-extraction",
        message: error instanceof Error ? error.message : "Unknown error",
        cause: error,
      });
      console.warn("[filter-extraction] semantic filter extraction failed", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  const groundedTags = new Set(sortedTags);
  const llmGrounded = llmFilters.filter((tag) => groundedTags.has(tag));

  const metadataFilters = (
    llmGrounded.length > 0
      ? llmGrounded
      : deterministicPrimary.length > 0
        ? deterministicPrimary
        : deterministicFallback
  ).slice(0, 12);

  console.info("[filter-extraction] completed", {
    metadataFilters: metadataFilters.length,
    deterministicCandidates: deterministicPrimary.length,
    llmGrounded: llmGrounded.length,
  });

  return {
    metadataFilters,
    errors: state.errors.concat(critiqueErrors),
  };
}
