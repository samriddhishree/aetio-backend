import { openai, OPENAI_HELPER_MODEL } from "../../common/services/openai";
import type { PipelineError } from "../../types";
import {
  RESEARCH_CONTEXT_NORMALIZATION_PROMPT,
  RESEARCH_CONTEXT_NORMALIZATION_SCHEMA,
} from "../prompts";
import type { GenerateInsightsV2State, NormalizedResearchContext } from "../types";

type ResearchContextNormalizationResponse = {
  short_summary: string;
  key_topics: string[];
  key_questions: string[];
};

const LONG_CONTEXT_THRESHOLD_CHARS = 1400;
const MAX_CONTEXT_INPUT_CHARS = 12000;
const MAX_SUMMARY_CHARS = 420;
const MAX_ITEMS = 6;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function ensureQuestion(value: string): string {
  const normalized = normalizeText(value).replace(/[?!.]+$/g, "");
  if (!normalized) return "";
  return `${normalized}?`;
}

function dedupeNormalized(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= MAX_ITEMS) break;
  }
  return output;
}

function splitSentences(value: string): string[] {
  const matches = value.match(/[^.!?\n]+[.!?]?/g) ?? [];
  return matches.map((sentence) => normalizeText(sentence)).filter(Boolean);
}

function normalizeContextLens(
  input: Partial<ResearchContextNormalizationResponse>,
  fallbackRawContext: string,
): NormalizedResearchContext {
  const shortSummary = truncate(
    normalizeText(input.short_summary ?? "") || truncate(normalizeText(fallbackRawContext), MAX_SUMMARY_CHARS),
    MAX_SUMMARY_CHARS,
  );

  const questions = dedupeNormalized((input.key_questions ?? []).map(ensureQuestion).filter(Boolean));
  const topics = dedupeNormalized(input.key_topics ?? []);

  return {
    short_summary: shortSummary,
    key_topics: topics,
    key_questions: questions,
  };
}

function buildLightweightNormalizedContext(rawContext: string): NormalizedResearchContext {
  const normalized = normalizeText(rawContext);
  const lines = rawContext
    .split(/\r?\n/)
    .map((line) => normalizeText(line.replace(/^[-*\u2022\d.)\s]+/, "")))
    .filter(Boolean);

  const sentenceCandidates = splitSentences(normalized);

  const keyQuestions = dedupeNormalized(
    sentenceCandidates
      .filter((sentence) => sentence.endsWith("?"))
      .map((sentence) => ensureQuestion(sentence)),
  );

  const keyTopics = dedupeNormalized(
    lines
      .filter((line) => !line.endsWith("?"))
      .concat(
        sentenceCandidates
          .filter((sentence) => !sentence.endsWith("?"))
          .map((sentence) => sentence.replace(/[.!]+$/g, "")),
      )
      .map((topic) => truncate(topic, 120)),
  );

  return {
    short_summary: truncate(normalized, MAX_SUMMARY_CHARS),
    key_topics: keyTopics,
    key_questions: keyQuestions,
  };
}

function normalizedContextLength(context: NormalizedResearchContext | undefined): number {
  if (!context) return 0;
  return Buffer.byteLength(JSON.stringify(context), "utf8");
}

export async function preprocessResearchContextNode(
  state: GenerateInsightsV2State,
): Promise<Partial<GenerateInsightsV2State>> {
  const rawContext = normalizeText(state.researchContext ?? "");
  const rawLength = rawContext.length;

  console.info("[research-context] preprocessing start", {
    rawLength,
  });

  if (!rawContext) {
    console.info("[research-context] preprocessing skipped", {
      rawLength,
      normalizedLength: 0,
      usedLlm: false,
    });
    return {
      normalizedResearchContext: undefined,
    };
  }

  if (rawLength <= LONG_CONTEXT_THRESHOLD_CHARS) {
    const normalized = buildLightweightNormalizedContext(rawContext);
    console.info("[research-context] preprocessing completed", {
      rawLength,
      normalizedLength: normalizedContextLength(normalized),
      keyTopics: normalized.key_topics.length,
      keyQuestions: normalized.key_questions.length,
      usedLlm: false,
    });
    return {
      normalizedResearchContext: normalized,
    };
  }

  const preprocessingErrors: PipelineError[] = [];

  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_HELPER_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: RESEARCH_CONTEXT_NORMALIZATION_PROMPT,
        },
        {
          role: "user",
          content: [
            "Research context is for guidance only. Do NOT introduce unsupported facts.",
            "Normalize this research context:",
            truncate(rawContext, MAX_CONTEXT_INPUT_CHARS),
          ].join("\n\n"),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "research_context_normalization_v2",
          schema: RESEARCH_CONTEXT_NORMALIZATION_SCHEMA,
          strict: true,
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("Empty OpenAI response.");

    const parsed = JSON.parse(content) as ResearchContextNormalizationResponse;
    const normalized = normalizeContextLens(parsed, rawContext);

    console.info("[research-context] preprocessing completed", {
      rawLength,
      normalizedLength: normalizedContextLength(normalized),
      keyTopics: normalized.key_topics.length,
      keyQuestions: normalized.key_questions.length,
      usedLlm: true,
    });

    return {
      normalizedResearchContext: normalized,
    };
  } catch (error) {
    preprocessingErrors.push({
      stage: "research-context-preprocessing",
      message: error instanceof Error ? error.message : "Unknown error",
      cause: error,
    });

    const fallbackNormalized = buildLightweightNormalizedContext(rawContext);
    console.warn("[research-context] llm preprocessing failed, using lightweight fallback", {
      rawLength,
      normalizedLength: normalizedContextLength(fallbackNormalized),
      message: error instanceof Error ? error.message : "Unknown error",
    });

    return {
      normalizedResearchContext: fallbackNormalized,
      errors: state.errors.concat(preprocessingErrors),
    };
  }
}
