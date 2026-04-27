import type { Insight, InsightMetadataEntry } from "../../types";
import { normalizeDimensionName } from "../../generate-insights-v2/services/metadataService";
import { computeGridRowCompletenessStats } from "../../generate-insights-v3/validators";
import type {
  DeltaInput,
  InsightDelta,
  InsightOutcomeClass,
  InsightScoreConfig,
} from "./types";

const DEFAULT_SCORE_CONFIG: InsightScoreConfig = {
  accepted_unchanged: 1.0,
  accepted_after_small_edit: 0.6,
  accepted_after_major_edit: 0.3,
  declined: -0.7,
  deleted: -1.0,
  minor_edit_threshold: 0.35,
};

function compact(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;

  const dp: number[] = new Array(right.length + 1).fill(0);
  for (let j = 0; j <= right.length; j += 1) dp[j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    let prev = dp[0];
    dp[0] = i;

    for (let j = 1; j <= right.length; j += 1) {
      const temp = dp[j];
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + cost,
      );
      prev = temp;
    }
  }

  return dp[right.length];
}

function metadataKey(entry: InsightMetadataEntry): string {
  return `${compact(entry.tag).toLowerCase()}::${compact(entry.value).toLowerCase()}`;
}

function toMetadataMap(metadata: InsightMetadataEntry[] | undefined): Map<string, InsightMetadataEntry> {
  const map = new Map<string, InsightMetadataEntry>();
  for (const entry of metadata ?? []) {
    const tag = compact(entry.tag);
    const value = compact(entry.value);
    if (!tag || !value) continue;
    map.set(`${tag.toLowerCase()}::${value.toLowerCase()}`, { ...entry, tag, value });
  }
  return map;
}

function normalizeDimensions(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => normalizeDimensionName(value))
    .filter((value) => value.length > 0)
    .sort();
}

function toRowComparableKey(row: {
  row_id: string;
  filter_values: Array<{ dimension_name: string; value: string }>;
  metric_name?: string;
  metric_value?: string | number;
  metric_unit?: string;
  value_text: string;
}): string {
  const filters = (row.filter_values ?? [])
    .map((item) => `${normalizeDimensionName(item.dimension_name)}=${compact(item.value).toLowerCase()}`)
    .sort()
    .join("|");

  return [
    row.row_id,
    filters,
    compact(row.metric_name).toLowerCase(),
    String(row.metric_value ?? ""),
    compact(row.metric_unit).toLowerCase(),
    compact(row.value_text).toLowerCase(),
  ].join("::");
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function scoreForOutcome(outcome: InsightOutcomeClass, cfg: InsightScoreConfig): number {
  switch (outcome) {
    case "accepted_unchanged":
      return cfg.accepted_unchanged;
    case "accepted_after_small_edit":
      return cfg.accepted_after_small_edit;
    case "accepted_after_major_edit":
      return cfg.accepted_after_major_edit;
    case "declined":
      return cfg.declined;
    case "deleted":
      return cfg.deleted;
  }
}

function resolveOutcome(input: {
  action: "accepted" | "declined" | "deleted";
  changeIntensity: number;
  cfg: InsightScoreConfig;
}): InsightOutcomeClass {
  if (input.action === "deleted") return "deleted";
  if (input.action === "declined") return "declined";
  if (input.changeIntensity === 0) return "accepted_unchanged";
  if (input.changeIntensity <= input.cfg.minor_edit_threshold) return "accepted_after_small_edit";
  return "accepted_after_major_edit";
}

function dimensionNormalizationCorrectionRate(
  beforeMetadata: InsightMetadataEntry[] | undefined,
  afterMetadata: InsightMetadataEntry[] | undefined,
): { rate: number; corrected: string[] } {
  const before = beforeMetadata ?? [];
  const after = afterMetadata ?? [];
  if (after.length === 0) return { rate: 0, corrected: [] };

  const beforeByNorm = new Map<string, string>();
  for (const entry of before) {
    const normalized = normalizeDimensionName(entry.tag);
    if (!normalized) continue;
    beforeByNorm.set(`${normalized}::${compact(entry.value).toLowerCase()}`, compact(entry.tag));
  }

  let corrected = 0;
  const correctedDims = new Set<string>();

  for (const entry of after) {
    const normalized = normalizeDimensionName(entry.tag);
    if (!normalized) continue;
    const key = `${normalized}::${compact(entry.value).toLowerCase()}`;
    const priorTag = beforeByNorm.get(key);
    if (!priorTag) continue;
    const priorNorm = normalizeDimensionName(priorTag);
    const afterTag = compact(entry.tag);
    if (priorTag !== afterTag && priorNorm === normalized) {
      corrected += 1;
      correctedDims.add(normalized);
    }
  }

  return {
    rate: clamp01(corrected / Math.max(after.length, 1)),
    corrected: Array.from(correctedDims.values()),
  };
}

function inferDimensions(insight?: Insight, tableDims?: string[]): string[] {
  if (tableDims && tableDims.length > 0) return tableDims;
  if (Array.isArray(insight?.table_dimensions) && insight.table_dimensions.length > 0) {
    return insight.table_dimensions;
  }
  return [];
}

export function computeInsightDelta(input: DeltaInput): InsightDelta {
  const cfg: InsightScoreConfig = {
    ...DEFAULT_SCORE_CONFIG,
    ...(input.scoreConfig ?? {}),
  };

  const beforeInsight = input.beforeInsight;
  const afterInsight = input.afterInsight;

  const beforeText = compact(beforeInsight?.text ?? beforeInsight?.family_text);
  const afterText = compact(afterInsight?.text ?? afterInsight?.family_text);
  const textDistance = levenshteinDistance(beforeText, afterText);
  const textChanged = textDistance > 0;

  const beforeQuestion = compact(beforeInsight?.question_answered);
  const afterQuestion = compact(afterInsight?.question_answered);
  const questionChanged = beforeQuestion !== afterQuestion;

  const beforeMetadataMap = toMetadataMap(beforeInsight?.metadata);
  const afterMetadataMap = toMetadataMap(afterInsight?.metadata);

  const metadataAdded = Array.from(afterMetadataMap.keys()).filter((key) => !beforeMetadataMap.has(key));
  const metadataRemoved = Array.from(beforeMetadataMap.keys()).filter((key) => !afterMetadataMap.has(key));
  const metadataEdited = Array.from(afterMetadataMap.values()).filter((entry) => {
    const base = beforeMetadataMap.get(metadataKey(entry));
    if (!base) return false;
    const left = base.confidence;
    const right = entry.confidence;
    return typeof left === "number" || typeof right === "number"
      ? left !== right
      : false;
  });

  const beforeDims = normalizeDimensions(inferDimensions(beforeInsight, input.beforeTable?.dimensions));
  const afterDims = normalizeDimensions(inferDimensions(afterInsight, input.afterTable?.dimensions));
  const dimensionsChanged = JSON.stringify(beforeDims) !== JSON.stringify(afterDims);

  const beforeRows = input.beforeTable?.rows ?? [];
  const afterRows = input.afterTable?.rows ?? [];

  const beforeRowById = new Map(beforeRows.map((row) => [row.row_id, row]));
  const afterRowById = new Map(afterRows.map((row) => [row.row_id, row]));

  let rowAddedCount = 0;
  let rowRemovedCount = 0;
  let rowEditedCount = 0;

  for (const rowId of afterRowById.keys()) {
    if (!beforeRowById.has(rowId)) rowAddedCount += 1;
  }
  for (const rowId of beforeRowById.keys()) {
    if (!afterRowById.has(rowId)) rowRemovedCount += 1;
  }
  for (const [rowId, beforeRow] of beforeRowById.entries()) {
    const afterRow = afterRowById.get(rowId);
    if (!afterRow) continue;
    if (toRowComparableKey(beforeRow) !== toRowComparableKey(afterRow)) {
      rowEditedCount += 1;
    }
  }

  const rowDeltaCount = rowAddedCount + rowRemovedCount + rowEditedCount;
  const rowChangePct = clamp01(rowDeltaCount / Math.max(beforeRows.length, afterRows.length, 1));

  const beforeStats = input.beforeTable ? computeGridRowCompletenessStats(input.beforeTable) : undefined;
  const afterStats = input.afterTable ? computeGridRowCompletenessStats(input.afterTable) : undefined;

  const beforeProblemRows = (beforeStats?.metric_only_rows ?? 0) + (beforeStats?.missing_dimension_rows ?? 0);
  const afterProblemRows = (afterStats?.metric_only_rows ?? 0) + (afterStats?.missing_dimension_rows ?? 0);

  const rowCorrectionRate = beforeProblemRows > 0
    ? clamp01((beforeProblemRows - afterProblemRows) / beforeProblemRows)
    : 0;

  const dimensionCorrectionRate = (beforeStats?.missing_dimension_rows ?? 0) > 0
    ? clamp01(((beforeStats?.missing_dimension_rows ?? 0) - (afterStats?.missing_dimension_rows ?? 0)) / (beforeStats?.missing_dimension_rows ?? 1))
    : 0;

  const normalizationCorrection = dimensionNormalizationCorrectionRate(
    beforeInsight?.metadata,
    afterInsight?.metadata,
  );

  const textRatio = clamp01(textDistance / Math.max(beforeText.length, afterText.length, 1));
  const metadataRatio = clamp01((metadataAdded.length + metadataRemoved.length + metadataEdited.length) / 6);

  const changeIntensity = clamp01(
    (textRatio * 0.5)
    + (rowChangePct * 0.25)
    + (metadataRatio * 0.2)
    + (questionChanged || dimensionsChanged ? 0.05 : 0),
  );

  const outcome = resolveOutcome({ action: input.action, changeIntensity, cfg });

  return {
    insight_id: afterInsight?.insight_id ?? beforeInsight?.insight_id,
    project_id: afterInsight?.project_id ?? beforeInsight?.project_id,
    text_edit_distance: textDistance,
    text_changed: textChanged,
    question_changed: questionChanged,
    metadata_delta_count: metadataAdded.length + metadataRemoved.length + metadataEdited.length,
    metadata_added_count: metadataAdded.length,
    metadata_removed_count: metadataRemoved.length,
    metadata_edited_count: metadataEdited.length,
    dimensions_changed: dimensionsChanged,
    row_delta_count: rowDeltaCount,
    row_added_count: rowAddedCount,
    row_removed_count: rowRemovedCount,
    row_edited_count: rowEditedCount,
    row_change_pct: rowChangePct,
    rows_missing_dimension_context: afterStats?.missing_dimension_rows ?? 0,
    metric_only_broken_rows: afterStats?.metric_only_rows ?? 0,
    row_correction_rate: rowCorrectionRate,
    dimension_correction_rate: dimensionCorrectionRate,
    dimension_normalization_correction_rate: normalizationCorrection.rate,
    corrected_dimensions: normalizationCorrection.corrected,
    outcome,
    review_quality_score: scoreForOutcome(outcome, cfg),
  };
}
