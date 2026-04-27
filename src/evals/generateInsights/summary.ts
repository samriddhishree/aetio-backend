import type { EvaluationAggregate, EvaluationSummary, ExtractionTrace, InsightDelta } from "./types";

function zeroAggregate(): EvaluationAggregate {
  return {
    total: 0,
    acceptance_rate: 0,
    unchanged_acceptance_rate: 0,
    decline_rate: 0,
    deletion_rate: 0,
    average_metadata_edits_per_insight: 0,
    average_row_edits_per_insight: 0,
    average_text_edit_distance: 0,
    metadata_add_rate: 0,
    metadata_remove_rate: 0,
    metadata_edit_rate: 0,
    dimension_normalization_correction_rate: 0,
    row_correction_rate: 0,
    dimension_correction_rate: 0,
    average_rows_missing_dimension_context: 0,
    average_metric_only_broken_rows: 0,
    common_dimensions_most_corrected: [],
  };
}

type AggregateAccumulator = {
  total: number;
  accepted: number;
  acceptedUnchanged: number;
  declined: number;
  deleted: number;
  metadataDelta: number;
  rowDelta: number;
  textDistance: number;
  metadataAdded: number;
  metadataRemoved: number;
  metadataEdited: number;
  normalizationRate: number;
  rowCorrectionRate: number;
  dimensionCorrectionRate: number;
  rowsMissingDimensionContext: number;
  metricOnlyRows: number;
  correctedDimensionCounts: Map<string, number>;
};

function newAccumulator(): AggregateAccumulator {
  return {
    total: 0,
    accepted: 0,
    acceptedUnchanged: 0,
    declined: 0,
    deleted: 0,
    metadataDelta: 0,
    rowDelta: 0,
    textDistance: 0,
    metadataAdded: 0,
    metadataRemoved: 0,
    metadataEdited: 0,
    normalizationRate: 0,
    rowCorrectionRate: 0,
    dimensionCorrectionRate: 0,
    rowsMissingDimensionContext: 0,
    metricOnlyRows: 0,
    correctedDimensionCounts: new Map<string, number>(),
  };
}

function toAggregate(acc: AggregateAccumulator): EvaluationAggregate {
  if (acc.total === 0) return zeroAggregate();

  const dimCounts = Array.from(acc.correctedDimensionCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([dimension, count]) => ({ dimension, count }));

  return {
    total: acc.total,
    acceptance_rate: acc.accepted / acc.total,
    unchanged_acceptance_rate: acc.acceptedUnchanged / acc.total,
    decline_rate: acc.declined / acc.total,
    deletion_rate: acc.deleted / acc.total,
    average_metadata_edits_per_insight: acc.metadataDelta / acc.total,
    average_row_edits_per_insight: acc.rowDelta / acc.total,
    average_text_edit_distance: acc.textDistance / acc.total,
    metadata_add_rate: acc.metadataAdded / acc.total,
    metadata_remove_rate: acc.metadataRemoved / acc.total,
    metadata_edit_rate: acc.metadataEdited / acc.total,
    dimension_normalization_correction_rate: acc.normalizationRate / acc.total,
    row_correction_rate: acc.rowCorrectionRate / acc.total,
    dimension_correction_rate: acc.dimensionCorrectionRate / acc.total,
    average_rows_missing_dimension_context: acc.rowsMissingDimensionContext / acc.total,
    average_metric_only_broken_rows: acc.metricOnlyRows / acc.total,
    common_dimensions_most_corrected: dimCounts,
  };
}

function applyDelta(acc: AggregateAccumulator, delta: InsightDelta): void {
  acc.total += 1;
  if (delta.outcome === "declined") acc.declined += 1;
  if (delta.outcome === "deleted") acc.deleted += 1;
  if (delta.outcome.startsWith("accepted")) acc.accepted += 1;
  if (delta.outcome === "accepted_unchanged") acc.acceptedUnchanged += 1;

  acc.metadataDelta += delta.metadata_delta_count;
  acc.rowDelta += delta.row_delta_count;
  acc.textDistance += delta.text_edit_distance;
  acc.metadataAdded += delta.metadata_added_count;
  acc.metadataRemoved += delta.metadata_removed_count;
  acc.metadataEdited += delta.metadata_edited_count;
  acc.normalizationRate += delta.dimension_normalization_correction_rate;
  acc.rowCorrectionRate += delta.row_correction_rate;
  acc.dimensionCorrectionRate += delta.dimension_correction_rate;
  acc.rowsMissingDimensionContext += delta.rows_missing_dimension_context;
  acc.metricOnlyRows += delta.metric_only_broken_rows;

  for (const dimension of delta.corrected_dimensions) {
    const next = (acc.correctedDimensionCounts.get(dimension) ?? 0) + 1;
    acc.correctedDimensionCounts.set(dimension, next);
  }
}

function groupByTrace<T>(input: {
  tracesByInsightId: Map<string, ExtractionTrace>;
  deltas: Array<InsightDelta & { insight_id?: string }>;
  keySelector: (trace: ExtractionTrace) => string | undefined;
}): Record<string, EvaluationAggregate> {
  const grouped = new Map<string, AggregateAccumulator>();

  for (const delta of input.deltas) {
    const trace = input.tracesByInsightId.get(delta.insight_id ?? "");
    const key = trace ? input.keySelector(trace) : undefined;
    if (!key) continue;
    const acc = grouped.get(key) ?? newAccumulator();
    applyDelta(acc, delta);
    grouped.set(key, acc);
  }

  return Object.fromEntries(
    Array.from(grouped.entries()).map(([key, acc]) => [key, toAggregate(acc)]),
  );
}

export function summarizeEvaluation(input: {
  deltas: Array<InsightDelta & { insight_id?: string }>;
  traces: ExtractionTrace[];
}): EvaluationSummary {
  const overallAcc = newAccumulator();
  for (const delta of input.deltas) {
    applyDelta(overallAcc, delta);
  }

  const tracesByInsightId = new Map(input.traces.map((trace) => [trace.insight_id, trace]));

  return {
    overall: toAggregate(overallAcc),
    by_pipeline_version: groupByTrace({
      tracesByInsightId,
      deltas: input.deltas,
      keySelector: (trace) => trace.pipeline_version,
    }),
    by_extraction_mode: groupByTrace({
      tracesByInsightId,
      deltas: input.deltas,
      keySelector: (trace) => trace.extraction_mode,
    }),
    by_file_type: groupByTrace({
      tracesByInsightId,
      deltas: input.deltas,
      keySelector: (trace) => trace.file_type,
    }),
    by_model_name: groupByTrace({
      tracesByInsightId,
      deltas: input.deltas,
      keySelector: (trace) => trace.model_name,
    }),
    by_prompt_version: groupByTrace({
      tracesByInsightId,
      deltas: input.deltas,
      keySelector: (trace) => trace.prompt_version,
    }),
    by_source_mode: groupByTrace({
      tracesByInsightId,
      deltas: input.deltas,
      keySelector: (trace) => trace.source_mode,
    }),
  };
}
