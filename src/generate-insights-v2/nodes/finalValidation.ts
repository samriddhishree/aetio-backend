import type { GenerateInsightsV2State, InsightFamily, InsightInstanceRow } from "../types";

function hasEvidenceRef(row: InsightInstanceRow): boolean {
  return row.supporting_refs.some((ref) => Boolean(ref.chunk_id || ref.table_id));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeKey(value: string): string {
  return normalizeText(value).toLowerCase();
}

function countNumericTokens(value: string): number {
  const matches = value.match(/[-+]?\d[\d,.]*%?/g);
  return matches?.length ?? 0;
}

function stripNumericTokens(value: string): string {
  return normalizeText(value.replace(/[-+]?\d[\d,.]*%?/g, " "));
}

function tokenize(value: string): string[] {
  const stopwords = new Set([
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
  ]);

  return normalizeKey(value)
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopwords.has(token));
}

function isBoilerplateQuestion(value: string): boolean {
  const normalized = normalizeKey(value);
  const boilerplate = [
    "what does the data show",
    "what do the data show",
    "what is happening",
    "what are the trends",
    "what is the trend",
    "what does this show",
  ];
  return boilerplate.some((phrase) => normalized.includes(phrase));
}

function hasStrongQuestion(value: string): boolean {
  const normalized = normalizeText(value);
  return normalized.length > 15 && !isBoilerplateQuestion(normalized);
}

function isTooCloseToRows(familyText: string, familyRows: InsightInstanceRow[]): boolean {
  const normalizedFamily = normalizeKey(familyText);
  return familyRows.some((row) => {
    const normalizedRow = normalizeKey(row.value_text);
    if (!normalizedRow) return false;
    if (normalizedRow === normalizedFamily) return true;
    if (normalizedRow.includes(normalizedFamily) && normalizedFamily.length > 20) return true;
    return false;
  });
}

function hasMultipleSegmentValues(
  family: InsightFamily,
  supportingFindings: GenerateInsightsV2State["validatedFindings"],
): boolean {
  const tagToValues = new Map<string, Set<string>>();

  for (const finding of supportingFindings) {
    for (const dimension of finding.dimensions ?? []) {
      const tag = normalizeKey(dimension.tag);
      if (!tag || !family.filters.includes(tag)) continue;
      const value = normalizeKey(dimension.value);
      if (!value) continue;
      const existing = tagToValues.get(tag) ?? new Set<string>();
      existing.add(value);
      tagToValues.set(tag, existing);
    }
  }

  return Array.from(tagToValues.values()).some((values) => values.size > 1);
}

function isOverlyNarrowFamilyText(
  familyText: string,
  family: InsightFamily,
  supportingFindings: GenerateInsightsV2State["validatedFindings"],
): boolean {
  const normalizedFamilyText = normalizeKey(familyText);
  if (!normalizedFamilyText) return true;

  const tagToValues = new Map<string, Set<string>>();
  for (const finding of supportingFindings) {
    for (const dimension of finding.dimensions ?? []) {
      const tag = normalizeKey(dimension.tag);
      if (!tag || !family.filters.includes(tag)) continue;
      const value = normalizeKey(dimension.value);
      if (!value) continue;
      const existing = tagToValues.get(tag) ?? new Set<string>();
      existing.add(value);
      tagToValues.set(tag, existing);
    }
  }

  for (const values of tagToValues.values()) {
    if (values.size <= 1) continue;
    const matches = Array.from(values).filter((value) => normalizedFamilyText.includes(value));
    if (matches.length === 1) return true;
  }

  return false;
}

function isQuestionSemanticallyAligned(
  questionAnswered: string,
  supportingFindings: GenerateInsightsV2State["validatedFindings"],
  familyFilters: string[],
): boolean {
  const questionTokens = new Set(tokenize(questionAnswered));
  if (questionTokens.size === 0) return false;

  for (const filter of familyFilters) {
    const filterToken = normalizeKey(filter);
    if (questionTokens.has(filterToken.replace(/_/g, "")) || questionAnswered.toLowerCase().includes(filterToken.replace(/_/g, " "))) {
      return true;
    }
  }

  const supportingText = supportingFindings.map((finding) => finding.text).join(" ");
  const supportingTokens = new Set(tokenize(supportingText));
  let overlap = 0;
  for (const token of questionTokens) {
    if (supportingTokens.has(token)) overlap += 1;
    if (overlap >= 1) return true;
  }
  return false;
}

function buildFallbackFamilyText(
  currentFamilyText: string,
  familyFilters: string[],
  supportingFindings: GenerateInsightsV2State["validatedFindings"],
): string {
  const stripped = stripNumericTokens(currentFamilyText);
  if (stripped.length > 18) return stripped;

  const firstFindingText = stripNumericTokens(supportingFindings[0]?.text ?? "");
  if (firstFindingText.length > 22) return firstFindingText;

  if (familyFilters.length > 0) {
    return `Patterns differ across ${familyFilters.join(", ")} in the supporting findings.`;
  }
  return "Supporting findings indicate a recurring evidence-backed pattern.";
}

function buildFallbackQuestionAnswered(familyText: string, familyFilters: string[]): string {
  if (familyFilters.length > 0) {
    return `How does this pattern vary across ${familyFilters.join(", ")}?`;
  }
  return `What does the evidence show about ${familyText.toLowerCase()}?`;
}

function normalizeUserInfo(
  userInfo: GenerateInsightsV2State["userInfo"],
): InsightFamily["user_info"] | undefined {
  const full_name =
    typeof userInfo?.full_name === "string" ? userInfo.full_name.trim() : undefined;
  const email_address =
    typeof userInfo?.email_address === "string" ? userInfo.email_address.trim() : undefined;

  if (!full_name && !email_address) return undefined;
  return { full_name, email_address };
}

function toIsoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function addOneYearIso(baseIso: string): string {
  const next = new Date(baseIso);
  next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next.toISOString();
}

export async function finalValidationNode(
  state: GenerateInsightsV2State,
): Promise<Partial<GenerateInsightsV2State>> {
  console.info("[final-validation] starting", {
    validatedFindings: state.validatedFindings.length,
    families: state.insightFamilies.length,
    insightFamilyData: state.insightFamilyData.length,
    rows: state.insightRows.length,
  });

  const findingById = new Map(
    state.validatedFindings.map((finding) => [finding.finding_id, finding]),
  );

  const droppedFamilies: InsightFamily[] = [];
  const groundedFamilies: InsightFamily[] = [];
  const familyUserInfo = normalizeUserInfo(state.userInfo);
  const tableById = new Map(state.insightFamilyData.map((table) => [table.table_id, table]));
  const firstTableByFamilyId = new Map(state.insightFamilyData.map((table) => [table.family_id, table]));
  let missingFamilyTextBeforeValidation = 0;
  let missingQuestionBeforeValidation = 0;
  let revisedFamilyTextCount = 0;
  let revisedQuestionCount = 0;
  let droppedForFamilyQuality = 0;
  let markedNonTabularForConsistency = 0;
  const validatedTableIds = new Set<string>();

  for (const family of state.insightFamilies) {
    const supportingFindingIds = family.supporting_finding_ids.filter((findingId) =>
      findingById.has(findingId),
    );

    if (supportingFindingIds.length === 0) {
      droppedFamilies.push(family);
      continue;
    }

    const supportingFindings = supportingFindingIds
      .map((findingId) => findingById.get(findingId))
      .filter((finding): finding is NonNullable<typeof finding> => Boolean(finding));

    const availableTags = new Set<string>();
    for (const finding of supportingFindings) {
      for (const dimension of finding.dimensions ?? []) {
        availableTags.add(dimension.tag.trim().toLowerCase());
      }
    }

    const groundedFilters = family.filters.filter((filter) =>
      availableTags.has(filter.trim().toLowerCase()),
    );

    const linkedTable =
      (family.insight_family_data_id ? tableById.get(family.insight_family_data_id) : undefined) ??
      firstTableByFamilyId.get(family.family_id);
    const familyRows = linkedTable?.rows ?? state.insightRows.filter((row) => row.family_id === family.family_id);
    let familyText = normalizeText(family.family_text ?? "");
    let questionAnswered = normalizeText(family.question_answered ?? "");

    if (!familyText) {
      missingFamilyTextBeforeValidation += 1;
      familyText = buildFallbackFamilyText(familyText, groundedFilters, supportingFindings);
      revisedFamilyTextCount += 1;
    }

    if (!questionAnswered) {
      missingQuestionBeforeValidation += 1;
      questionAnswered = buildFallbackQuestionAnswered(familyText, groundedFilters);
      revisedQuestionCount += 1;
    }

    const tooQuantitative = countNumericTokens(familyText) > 0 && supportingFindings.length > 1;
    const tooCloseToRows = isTooCloseToRows(familyText, familyRows);
    const overlyNarrow =
      hasMultipleSegmentValues(family, supportingFindings) &&
      isOverlyNarrowFamilyText(familyText, { ...family, filters: groundedFilters }, supportingFindings);

    if (tooQuantitative || tooCloseToRows || overlyNarrow) {
      const revised = buildFallbackFamilyText(familyText, groundedFilters, supportingFindings);
      if (normalizeKey(revised) !== normalizeKey(familyText)) {
        familyText = revised;
        revisedFamilyTextCount += 1;
      }
    }

    if (
      !hasStrongQuestion(questionAnswered) ||
      !isQuestionSemanticallyAligned(questionAnswered, supportingFindings, groundedFilters)
    ) {
      const revisedQuestion = buildFallbackQuestionAnswered(familyText, groundedFilters);
      if (normalizeKey(revisedQuestion) !== normalizeKey(questionAnswered)) {
        questionAnswered = revisedQuestion;
        revisedQuestionCount += 1;
      }
    }

    if (!familyText || !questionAnswered || !hasStrongQuestion(questionAnswered)) {
      droppedForFamilyQuality += 1;
      continue;
    }

    const createdAtIso = toIsoOrUndefined(family.created_at) ?? new Date().toISOString();
    const expiresAtIso = toIsoOrUndefined(family.expires_at) ?? addOneYearIso(createdAtIso);

    const completedFamily: InsightFamily = {
      ...family,
      family_text: familyText,
      question_answered: questionAnswered,
      user_info: familyUserInfo,
      created_at: createdAtIso,
      expires_at: expiresAtIso,
      filters: groundedFilters,
      supporting_finding_ids: supportingFindingIds,
    };

    if (completedFamily.has_grid) {
      if (!linkedTable || linkedTable.row_count <= 0) {
        markedNonTabularForConsistency += 1;
        groundedFamilies.push({
          ...completedFamily,
          has_grid: false,
          insight_family_data_id: undefined,
          row_count: undefined,
          table_dimensions: undefined,
          metric_columns: undefined,
        });
      } else {
        validatedTableIds.add(linkedTable.table_id);
        groundedFamilies.push({
          ...completedFamily,
          has_grid: true,
          insight_family_data_id: linkedTable.table_id,
          row_count: linkedTable.row_count,
          table_dimensions: linkedTable.dimensions,
          metric_columns: linkedTable.metric_columns,
        });
      }
    } else {
      groundedFamilies.push({
        ...completedFamily,
        has_grid: false,
        insight_family_data_id: undefined,
        row_count: undefined,
        table_dimensions: undefined,
        metric_columns: undefined,
      });
    }
  }

  const familyById = new Map(groundedFamilies.map((family) => [family.family_id, family]));
  const validatedTables = state.insightFamilyData.filter((table) => {
    if (!validatedTableIds.has(table.table_id)) return false;
    const family = familyById.get(table.family_id);
    return family?.has_grid === true && family.insight_family_data_id === table.table_id;
  });

  const validatedRows = validatedTables
    .flatMap((table) => table.rows)
    .filter((row) => hasEvidenceRef(row));
  const droppedRows = state.insightRows.length - validatedRows.length;
  const tabularFamilies = groundedFamilies.filter((family) => family.has_grid).length;
  const narrativeFamilies = groundedFamilies.length - tabularFamilies;

  console.info("[final-validation] completed", {
    findings: state.validatedFindings.length,
    families: groundedFamilies.length,
    tabularFamilies,
    narrativeFamilies,
    insightFamilyData: validatedTables.length,
    rows: validatedRows.length,
    droppedFamilies: droppedFamilies.length,
    droppedForFamilyQuality,
    markedNonTabularForConsistency,
    missingFamilyTextBeforeValidation,
    missingQuestionBeforeValidation,
    revisedFamilyTextCount,
    revisedQuestionCount,
    droppedRows,
  });

  return {
    validatedFindings: state.validatedFindings,
    insightFamilies: groundedFamilies,
    insightFamilyData: validatedTables,
    insightRows: validatedRows,
  };
}
