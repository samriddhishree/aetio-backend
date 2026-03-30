import type { GraphState, PipelineError } from "../../types";
import { config } from "../../common/services/config";
import { openai, OPENAI_MODEL } from "../../common/services/openai";
import { loadDocumentText } from "../../common/services/document-loader";
import { mapWithConcurrency } from "../../common/services/utils";

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
  },
  required: ["summary"],
} as const;

type SummaryResponse = {
  summary: string;
};

async function summarizeText(text: string): Promise<string> {
  console.debug("SummarizeAgent:summarizeText:start", { length: text.length });
  console.log(
    "SummarizeAgent:summarizeText:llm-input-sample",
    JSON.stringify({
      text_preview: text.slice(0, 240),
    }),
  );
  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You summarize documents concisely. Use only information present in the text. Do not hallucinate.",
      },
      {
        role: "user",
        content: `Summarize the following document:\n\n${text}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "doc_summary",
        schema: SUMMARY_SCHEMA,
        strict: true,
      },
    },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty OpenAI response.");
  const parsed = JSON.parse(content) as SummaryResponse;
  const summary = parsed.summary.trim();
  console.debug("SummarizeAgent:summarizeText:done", { summaryLength: summary.length });
  return summary;
}

async function combineSummaries(
  inSummary: string,
  summaries: string[],
): Promise<string> {
  console.debug("SummarizeAgent:combine:start", {
    inSummaryLength: inSummary.length,
    summaries: summaries.length,
  });
  console.log(
    "SummarizeAgent:combine:llm-input-sample",
    JSON.stringify({
      input_summary_preview: inSummary.slice(0, 200),
      first_summary_preview: summaries[0]?.slice(0, 200),
    }),
  );
  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You consolidate summaries into a single concise summary. Use only the provided text. Do not hallucinate.",
      },
      {
        role: "user",
        content: `Input summary:\n${inSummary}\n\nFile summaries:\n${summaries
          .map((summary, index) => `(${index + 1}) ${summary}`)
          .join("\n")}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "combined_summary",
        schema: SUMMARY_SCHEMA,
        strict: true,
      },
    },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty OpenAI response.");
  const parsed = JSON.parse(content) as SummaryResponse;
  const summary = parsed.summary.trim();
  console.debug("SummarizeAgent:combine:done", { summaryLength: summary.length });
  return summary;
}

export async function summarizeAgent(
  state: GraphState,
): Promise<Partial<GraphState>> {
  console.log("SummarizeAgent:size", state.insights?.length ?? 0);
  console.debug("SummarizeAgent:start", {
    contextUrls: state.contextUrls?.length ?? 0,
    hasResearchContext: Boolean(state.researchContext?.trim()),
  });
  const errors: PipelineError[] = [];
  const contextUrls = state.contextUrls ?? [];
  const inSummary = state.researchContext ?? "";

  if (contextUrls.length === 0 && !inSummary) {
    console.debug("SummarizeAgent:skip", { reason: "no_context_or_research" });
    return { summary: state.summary, errors: state.errors };
  }

  const summaries = await mapWithConcurrency(
    contextUrls,
    config.maxConcurrency,
    async (url) => {
      console.debug("SummarizeAgent:load:start", { url });
      try {
        const { text } = await loadDocumentText(url);
        console.debug("SummarizeAgent:load:done", { url, length: text.length });
        return await summarizeText(text.slice(0, 12000));
      } catch (error) {
        errors.push({
          stage: "SummarizeAgent",
          message: error instanceof Error ? error.message : "Unknown error",
          url,
          cause: error,
        });
        console.debug("SummarizeAgent:error", {
          url,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        return "";
      }
    },
  );

  const filtered = summaries.filter((summary) => summary.trim().length > 0);
  let summary = inSummary.trim();

  if (filtered.length > 0) {
    try {
      summary = await combineSummaries(summary, filtered);
    } catch (error) {
      errors.push({
        stage: "SummarizeAgent",
        message: error instanceof Error ? error.message : "Unknown error",
        cause: error,
      });
      console.debug("SummarizeAgent:combine:error", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  console.debug("SummarizeAgent:done", {
    summaryLength: summary.length,
    errors: errors.length,
  });
  return {
    summary,
    errors: state.errors.concat(errors),
  };
}
