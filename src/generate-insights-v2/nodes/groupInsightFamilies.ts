import { openai, OPENAI_HELPER_MODEL } from "../../common/services/openai";
import { hashId } from "../../common/services/utils";
import type { PipelineError } from "../../types";
import { FAMILY_GROUPING_PROMPT, FAMILY_GROUPING_SCHEMA } from "../prompts";
import type {
  GenerateInsightsV2State,
  InsightFamily,
  NormalizedResearchContext,
} from "../types";

type FamilyGroupingResponse = {
  families: Array<{
    family_text: string;
    question_answered: string;
    filters: string[];
    summary?: string | null;
    supporting_finding_ids: string[];
  }>;
};

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "what",
  "does",
  "data",
  "show",
  "across",
  "into",
  "from",
  "are",
  "how",
  "much",
  "which",
  "when",
  "where",
  "about",
  "through",
  "among",
  "over",
  "under",
  "more",
  "less",
]);

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeKey(value: string): string {
  return normalizeText(value).toLowerCase();
}

function normalizeFilterTag(value: string): string {
  return normalizeKey(value).replace(/\s+/g, "_");
}

function countNumericTokens(value: string): number {
  const matches = value.match(/[-+]?\d[\d,.]*%?/g);
  return matches?.length ?? 0;
}

function tokenize(value: string): string[] {
  return normalizeKey(value)
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function normalizedContextLength(context: NormalizedResearchContext | undefined): number {
  if (!context) return 0;
  return Buffer.byteLength(JSON.stringify(context), "utf8");
}

function isQuestionBoilerplate(value: string): boolean {
  const normalized = normalizeKey(value);
  const boilerplate = [
    "what does the data show",
    "what do the data show",
    "what is happening",
    "what is the trend",
    "what are the trends",
    "what can we learn",
    "what does this show",
  ];
  return boilerplate.some((phrase) => normalized.includes(phrase));
}

function hasStrongQuestion(value: string): boolean {
  const normalized = normalizeText(value);
  return normalized.length > 15 && !isQuestionBoilerplate(normalized);
}

function buildGroundingVocabulary(
  supportingFindings: GenerateInsightsV2State["validatedFindings"],
  filters: string[],
): Set<string> {
  const vocabulary = new Set<string>();

  for (const token of tokenize(filters.join(" "))) {
    vocabulary.add(token);
  }

  for (const finding of supportingFindings) {
    for (const token of tokenize(finding.text)) {
      vocabulary.add(token);
    }
    for (const dimension of finding.dimensions ?? []) {
      for (const token of tokenize(dimension.tag)) {
        vocabulary.add(token);
      }
      for (const token of tokenize(dimension.value)) {
        vocabulary.add(token);
      }
    }
  }

  return vocabulary;
}

function overlapCount(tokens: string[], vocabulary: Set<string>): number {
  let overlap = 0;
  for (const token of tokens) {
    if (vocabulary.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
}

function isGroundedPhrase(
  value: string,
  vocabulary: Set<string>,
  minOverlap = 1,
): boolean {
  const tokens = tokenize(value);
  if (tokens.length === 0) return true;
  return overlapCount(tokens, vocabulary) >= minOverlap;
}

function buildLensTokens(context: NormalizedResearchContext | undefined): Set<string> {
  if (!context) return new Set<string>();
  return new Set(
    tokenize(
      [
        context.short_summary,
        context.key_topics.join(" "),
        context.key_questions.join(" "),
      ].join(" "),
    ),
  );
}

function scoreFindingRelevance(
  finding: GenerateInsightsV2State["validatedFindings"][number],
  lensTokens: Set<string>,
): number {
  if (lensTokens.size === 0) return 0;

  const findingTokens = tokenize(
    [
      finding.text,
      (finding.dimensions ?? []).map((dimension) => `${dimension.tag} ${dimension.value}`).join(" "),
    ].join(" "),
  );

  return overlapCount(findingTokens, lensTokens);
}

function prioritizeFindingsByContext(
  findings: GenerateInsightsV2State["validatedFindings"],
  context: NormalizedResearchContext | undefined,
): {
  prioritizedFindings: GenerateInsightsV2State["validatedFindings"];
  usedContext: boolean;
} {
  const lensTokens = buildLensTokens(context);
  if (lensTokens.size === 0) {
    return {
      prioritizedFindings: findings,
      usedContext: false,
    };
  }

  const scoredFindings = findings.map((finding, index) => ({
    finding,
    index,
    score: scoreFindingRelevance(finding, lensTokens),
  }));

  const usedContext = scoredFindings.some((item) => item.score > 0);
  const prioritizedFindings = scoredFindings
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.index - right.index;
    })
    .map((item) => item.finding);

  return {
    prioritizedFindings,
    usedContext,
  };
}

function selectGroundedContextTopic(
  context: NormalizedResearchContext | undefined,
  vocabulary: Set<string>,
): string | undefined {
  if (!context) return undefined;

  for (const topic of context.key_topics) {
    const normalizedTopic = normalizeText(topic);
    if (!normalizedTopic) continue;
    if (isGroundedPhrase(normalizedTopic, vocabulary, 1)) {
      return normalizedTopic;
    }
  }

  return undefined;
}

function selectGroundedContextQuestion(
  context: NormalizedResearchContext | undefined,
  vocabulary: Set<string>,
): string | undefined {
  if (!context) return undefined;

  for (const question of context.key_questions) {
    const normalizedQuestion = normalizeText(question).replace(/[?!.]+$/g, "");
    if (!normalizedQuestion) continue;
    const completedQuestion = `${normalizedQuestion}?`;
    if (hasStrongQuestion(completedQuestion) && isGroundedPhrase(completedQuestion, vocabulary, 1)) {
      return completedQuestion;
    }
  }

  return undefined;
}

function generalizeFamilyText(
  rawFamilyText: string,
  filters: string[],
  contextTopic?: string,
): string {
  const stripped = normalizeText(rawFamilyText).replace(/[-+]?\d[\d,.]*%?/g, "").trim();
  if (stripped.length > 18) return stripped;
  if (filters.length > 0 && contextTopic) {
    return `Patterns in ${contextTopic.toLowerCase()} vary across ${filters.join(", ")}.`;
  }
  if (filters.length > 0) {
    return `Performance and outcomes vary across ${filters.join(", ")}.`;
  }
  if (contextTopic) {
    return `Supporting findings show a recurring pattern in ${contextTopic.toLowerCase()}.`;
  }
  return "Supporting findings reveal a recurring cross-source pattern.";
}

function buildQuestionAnswered(input: {
  rawQuestion: string;
  familyText: string;
  filters: string[];
  context: NormalizedResearchContext | undefined;
  groundingVocabulary: Set<string>;
}): { questionAnswered: string; usedContextQuestion: boolean } {
  const normalizedQuestion = normalizeText(input.rawQuestion);

  if (hasStrongQuestion(normalizedQuestion) && isGroundedPhrase(normalizedQuestion, input.groundingVocabulary, 1)) {
    return {
      questionAnswered: normalizedQuestion.endsWith("?") ? normalizedQuestion : `${normalizedQuestion}?`,
      usedContextQuestion: false,
    };
  }

  const contextQuestion = selectGroundedContextQuestion(input.context, input.groundingVocabulary);
  if (contextQuestion) {
    return {
      questionAnswered: contextQuestion,
      usedContextQuestion: true,
    };
  }

  if (input.filters.length > 0) {
    return {
      questionAnswered: `How does this pattern vary across ${input.filters.join(", ")}?`,
      usedContextQuestion: false,
    };
  }

  return {
    questionAnswered: `What does the evidence show about ${input.familyText.toLowerCase()}?`,
    usedContextQuestion: false,
  };
}

function isOverlyNarrowFamilyText(
  familyText: string,
  supportingFindingIds: string[],
  findingById: Map<string, GenerateInsightsV2State["validatedFindings"][number]>,
): boolean {
  const normalizedText = normalizeKey(familyText);
  const valuesByTag = new Map<string, Set<string>>();

  for (const findingId of supportingFindingIds) {
    const finding = findingById.get(findingId);
    if (!finding) continue;
    for (const dimension of finding.dimensions ?? []) {
      const tag = normalizeKey(dimension.tag);
      const value = normalizeKey(dimension.value);
      if (!tag || !value) continue;
      const existing = valuesByTag.get(tag) ?? new Set<string>();
      existing.add(value);
      valuesByTag.set(tag, existing);
    }
  }

  for (const values of valuesByTag.values()) {
    if (values.size <= 1) continue;
    const valueList = Array.from(values);
    const matches = valueList.filter((value) => normalizedText.includes(value));
    if (matches.length === 1) return true;
  }

  return false;
}

function buildFamilySearchText(input: {
  familyText: string;
  questionAnswered: string;
  summary?: string;
  filters: string[];
}): string {
  return [input.familyText, input.questionAnswered, input.summary ?? "", input.filters.join(" ")]
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .join(" ");
}

export async function groupInsightFamiliesNode(
  state: GenerateInsightsV2State,
): Promise<Partial<GenerateInsightsV2State>> {
  const rawContextLength = normalizeText(state.researchContext ?? "").length;
  const normalizedContextLengthBytes = normalizedContextLength(state.normalizedResearchContext);

  console.info("[family-grouping] starting", {
    findings: state.validatedFindings.length,
    metadataFilters: state.metadataFilters.length,
    rawContextLength,
    normalizedContextLength: normalizedContextLengthBytes,
  });

  if (state.validatedFindings.length === 0) {
    return {
      insightFamilies: [],
    };
  }

  const findingById = new Map(state.validatedFindings.map((finding) => [finding.finding_id, finding]));

  const prioritized = prioritizeFindingsByContext(
    state.validatedFindings,
    state.normalizedResearchContext,
  );

  let rawFamilies: FamilyGroupingResponse["families"] = [];
  const groupingErrors: PipelineError[] = [];

  try {
    const requestPayload: Record<string, unknown> = {
      available_filters: state.metadataFilters,
      guidance_examples: [
        {
          row_facts: ["Instagram | 18-30 | +15%", "Instagram | 30+ | +7%", "Facebook | 18-30 | +4%"],
          family_text: "Conversion performance differs across marketing channels and age groups",
          question_answered:
            "How does conversion performance vary across channels and demographic segments?",
        },
        {
          row_facts: ["Local jail | pretrial | 426000", "Federal pretrial detention | pretrial | 24000"],
          family_text:
            "A large share of incarceration is concentrated in jail detention, especially among people held pretrial",
          question_answered:
            "How much of incarceration is concentrated in jails, and what role does pretrial detention play?",
        },
      ],
      findings: prioritized.prioritizedFindings.map((finding) => ({
        finding_id: finding.finding_id,
        text: finding.text,
        dimensions: finding.dimensions ?? [],
        source_modality: finding.source_modality,
      })),
    };

    if (state.normalizedResearchContext) {
      requestPayload.research_context = state.normalizedResearchContext;
    }

    const response = await openai.chat.completions.create({
      model: OPENAI_HELPER_MODEL,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: FAMILY_GROUPING_PROMPT,
        },
        {
          role: "user",
          content: [
            "Research context is for guidance only. Do NOT introduce unsupported facts.",
            JSON.stringify(requestPayload, null, 2),
          ].join("\n\n"),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "family_grouping_v2",
          schema: FAMILY_GROUPING_SCHEMA,
          strict: true,
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("Empty OpenAI response.");

    const parsed = JSON.parse(content) as FamilyGroupingResponse;
    rawFamilies = parsed.families ?? [];
  } catch (error) {
    groupingErrors.push({
      stage: "family-grouping",
      message: error instanceof Error ? error.message : "Unknown error",
      cause: error,
    });
    console.warn("[family-grouping] semantic grouping failed, using fallback", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }

  if (rawFamilies.length === 0) {
    rawFamilies = [
      {
        family_text: "General findings",
        question_answered: "What recurring evidence-backed patterns appear across the findings?",
        filters: state.metadataFilters.slice(0, 6),
        summary: "Fallback grouping when semantic family generation was unavailable.",
        supporting_finding_ids: state.validatedFindings.map((finding) => finding.finding_id),
      },
    ];
  }

  const insightFamilies: InsightFamily[] = [];
  let missingStrongQuestionBeforeValidation = 0;
  let revisedForNarrowOrQuantitative = 0;
  let revisedForUngrounded = 0;
  let usedContextInGeneration = false;
  const searchablePreview: Array<{ family_id: string; search_text_preview: string }> = [];

  for (const [index, family] of rawFamilies.entries()) {
    const rawFamilyText = normalizeText(family.family_text ?? "");
    if (!rawFamilyText) continue;

    const supportingFindingIds = (family.supporting_finding_ids ?? []).filter((findingId) =>
      findingById.has(findingId),
    );

    if (supportingFindingIds.length === 0) continue;

    const supportingFindings = supportingFindingIds
      .map((findingId) => findingById.get(findingId))
      .filter((finding): finding is NonNullable<typeof finding> => Boolean(finding));

    const deterministicFilterSet = new Set<string>();
    for (const findingId of supportingFindingIds) {
      const finding = findingById.get(findingId);
      if (!finding) continue;
      for (const dimension of finding.dimensions ?? []) {
        const tag = normalizeFilterTag(dimension.tag);
        if (state.metadataFilters.includes(tag)) {
          deterministicFilterSet.add(tag);
        }
      }
    }

    const rawQuestion = normalizeText(family.question_answered ?? "");
    if (!hasStrongQuestion(rawQuestion)) {
      missingStrongQuestionBeforeValidation += 1;
    }

    const modelFilterSet = new Set(
      (family.filters ?? [])
        .map((filter) => normalizeFilterTag(filter))
        .filter((filter) => deterministicFilterSet.has(filter)),
    );
    const resolvedFilters =
      modelFilterSet.size > 0 ? Array.from(modelFilterSet) : Array.from(deterministicFilterSet);

    const groundingVocabulary = buildGroundingVocabulary(supportingFindings, resolvedFilters);
    const groundedContextTopic = selectGroundedContextTopic(
      state.normalizedResearchContext,
      groundingVocabulary,
    );

    const tooQuantitative = countNumericTokens(rawFamilyText) > 0;
    const tooNarrow = isOverlyNarrowFamilyText(rawFamilyText, supportingFindingIds, findingById);
    const ungroundedFamilyText = !isGroundedPhrase(rawFamilyText, groundingVocabulary, 1);

    let familyText = rawFamilyText;
    if (tooQuantitative || tooNarrow) {
      familyText = generalizeFamilyText(rawFamilyText, resolvedFilters, groundedContextTopic);
      if (tooQuantitative || tooNarrow) {
        revisedForNarrowOrQuantitative += 1;
      }
    }
    if (ungroundedFamilyText) {
      familyText = generalizeFamilyText("", resolvedFilters, groundedContextTopic);
      revisedForUngrounded += 1;
    }

    if (
      groundedContextTopic &&
      normalizeKey(familyText).includes(normalizeKey(groundedContextTopic))
    ) {
      usedContextInGeneration = true;
    }

    const questionResult = buildQuestionAnswered({
      rawQuestion,
      familyText,
      filters: resolvedFilters,
      context: state.normalizedResearchContext,
      groundingVocabulary,
    });
    if (questionResult.usedContextQuestion) {
      usedContextInGeneration = true;
    }

    const summary = typeof family.summary === "string" ? normalizeText(family.summary) : undefined;

    const familyId = hashId(`${familyText}:${questionResult.questionAnswered}:${index}`);
    insightFamilies.push({
      family_id: familyId,
      family_text: familyText,
      question_answered: questionResult.questionAnswered,
      summary,
      filters: resolvedFilters,
      supporting_finding_ids: Array.from(new Set(supportingFindingIds)),
    });

    searchablePreview.push({
      family_id: familyId,
      search_text_preview: buildFamilySearchText({
        familyText,
        questionAnswered: questionResult.questionAnswered,
        summary,
        filters: resolvedFilters,
      }).slice(0, 220),
    });
  }

  console.info("[family-grouping] completed", {
    families: insightFamilies.length,
    withFilters: insightFamilies.filter((family) => family.filters.length > 0).length,
    missingStrongQuestionBeforeValidation,
    revisedForNarrowOrQuantitative,
    revisedForUngrounded,
    rawContextLength,
    normalizedContextLength: normalizedContextLengthBytes,
    contextUsedInGrouping: prioritized.usedContext,
    contextUsedInGeneration: usedContextInGeneration,
    searchablePreview: searchablePreview.slice(0, 3),
  });

  return {
    insightFamilies,
    errors: state.errors.concat(groupingErrors),
  };
}
