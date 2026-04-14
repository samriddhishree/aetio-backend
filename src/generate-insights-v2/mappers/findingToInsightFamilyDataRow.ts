import { hashId } from "../../common/services/utils";
import type {
  Finding,
  InsightFamily,
  InsightFamilyDataRow,
  SupportingRef,
} from "../types";
import type { DimensionMetadataRegistry } from "../services/metadataService";
import {
  getOrCreateDimensionMetadata,
  getOrCreateDimensionValueMetadata,
  normalizeDimensionName,
} from "../services/metadataService";

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function dedupeRefs(refs: SupportingRef[]): SupportingRef[] {
  const seen = new Set<string>();
  const output: SupportingRef[] = [];

  for (const ref of refs) {
    const key = [
      ref.chunk_id ?? "",
      ref.table_id ?? "",
      ref.row_index ?? "",
      ref.page ?? "",
      ref.section_title ?? "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(ref);
  }

  return output;
}

function parseMetricFromText(text: string): { metricValue?: string | number; metricUnit?: string } {
  const numberMatch = text.match(/[-+]?\d[\d,.]*(?:\.\d+)?%?/);
  if (!numberMatch) return {};

  const rawValue = numberMatch[0];
  if (rawValue.endsWith("%")) {
    const numeric = Number(rawValue.replace(/[% ,]/g, ""));
    return Number.isFinite(numeric)
      ? { metricValue: numeric, metricUnit: "%" }
      : { metricValue: rawValue, metricUnit: "%" };
  }

  const tail = text.slice(numberMatch.index! + rawValue.length);
  const unitMatch = tail.match(/^\s*(million|billion|thousand|k|m|bn|people|usd|dollars?)/i);
  const unit = unitMatch?.[1]?.toLowerCase();

  const normalizedNumber = Number(rawValue.replace(/,/g, ""));
  const metricValue =
    Number.isFinite(normalizedNumber) && rawValue.length < 16 ? normalizedNumber : rawValue;
  return unit ? { metricValue, metricUnit: unit } : { metricValue };
}

function buildMeasureValue(finding: Finding): string {
  const stripped = normalizeText(
    finding.text
      .replace(/[-+]?\d[\d,.]*(?:\.\d+)?%?/g, "")
      .replace(/\b(over|about|approximately|around|more than|less than)\b/gi, "")
      .replace(/\b(the document|this document|there are|there is)\b/gi, "")
      .replace(/\s+/g, " "),
  );

  if (stripped.length >= 6) return stripped.slice(0, 140);
  return normalizeText(finding.text).slice(0, 140);
}

function isUnknownLike(value: string): boolean {
  const normalized = normalizeText(value).toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "unknown" ||
    normalized === "n/a" ||
    normalized === "na" ||
    normalized === "not_available" ||
    normalized === "not available"
  );
}

function resolveFilterValues(
  finding: Finding,
  dimensions: string[],
  metadataRegistry: DimensionMetadataRegistry,
): InsightFamilyDataRow["filter_values"] | null {
  if (dimensions.length === 0) return [];
  const hasSourceContext = (finding.dimensions ?? []).length > 0;

  const dimensionMap = new Map<string, string>();
  for (const dimension of finding.dimensions ?? []) {
    const canonicalName = normalizeDimensionName(dimension.tag);
    if (!canonicalName) continue;
    if (!dimensionMap.has(canonicalName)) {
      dimensionMap.set(canonicalName, normalizeText(dimension.value));
    }
  }

  const filterValues = dimensions.map((dimensionName) => {
    const sourceMeasureValue = dimensionMap.get("measure");
    const rawValue =
      dimensionName === "measure"
        ? sourceMeasureValue ?? buildMeasureValue(finding)
        : dimensionMap.get(dimensionName) ?? (hasSourceContext ? "" : "Unknown");

    if (hasSourceContext && dimensionName !== "measure" && isUnknownLike(rawValue)) {
      return null;
    }

    const dimensionMetadata = getOrCreateDimensionMetadata(metadataRegistry, {
      dimensionName,
    });
    const valueMetadata = getOrCreateDimensionValueMetadata(metadataRegistry, {
      dimensionName: dimensionMetadata.canonical_name,
      dimensionId: dimensionMetadata.dimension_id,
      rawValue,
    });

    return {
      dimension_id: dimensionMetadata.dimension_id,
      dimension_name: dimensionMetadata.canonical_name,
      value_id: valueMetadata.value.value_id,
      value: valueMetadata.value.canonical_value,
      display_value: valueMetadata.value.display_value,
    };
  });

  if (filterValues.some((entry) => !entry)) return null;
  const resolved = filterValues.filter(
    (entry): entry is NonNullable<(typeof filterValues)[number]> => Boolean(entry),
  );

  const sourceNonMeasureDimensions = Array.from(dimensionMap.keys()).filter(
    (dimensionName) => dimensionName !== "measure",
  );
  const includesNonMeasureDimension = resolved.some((entry) => entry.dimension_name !== "measure");

  // Do not persist metric-only rows when source row context exists.
  if (hasSourceContext && sourceNonMeasureDimensions.length > 0 && !includesNonMeasureDimension) {
    return null;
  }

  return resolved;
}

export function buildRowIdentity(row: InsightFamilyDataRow): string {
  const filterKey = row.filter_values
    .slice()
    .sort((left, right) => left.dimension_name.localeCompare(right.dimension_name))
    .map((filterValue) =>
      `${filterValue.dimension_id}:${filterValue.value_id ?? filterValue.value}`,
    )
    .join("|");
  return [
    row.family_id,
    filterKey,
    row.metric_name ?? "",
    row.metric_value ?? "",
    row.metric_unit ?? "",
  ].join("::");
}

export function mapFindingToInsightFamilyDataRow(input: {
  family: InsightFamily;
  finding: Finding;
  dimensions: string[];
  metricName: string;
  metadataRegistry: DimensionMetadataRegistry;
}): InsightFamilyDataRow | null {
  const filterValues = resolveFilterValues(
    input.finding,
    input.dimensions,
    input.metadataRegistry,
  );
  if (!filterValues) return null;

  const directMetricValue = input.finding.metric_value;
  const fallbackMetric = directMetricValue === undefined
    ? parseMetricFromText(input.finding.text)
    : {};

  const metricValue = directMetricValue ?? fallbackMetric.metricValue;
  const metricUnit = input.finding.metric_unit ?? fallbackMetric.metricUnit;
  const refs = dedupeRefs(input.finding.supporting_refs ?? []);

  if (refs.length === 0) return null;

  const rowSeed = [
    input.family.family_id,
    input.finding.finding_id,
    filterValues.map((entry) => `${entry.dimension_id}:${entry.value_id ?? entry.value}`).join("|"),
    metricValue ?? "",
    metricUnit ?? "",
  ].join("|");

  return {
    row_id: hashId(rowSeed),
    family_id: input.family.family_id,
    filter_values: filterValues,
    metric_name: input.metricName,
    metric_value: metricValue,
    metric_unit: metricUnit,
    value_text: normalizeText(input.finding.text),
    supporting_refs: refs,
  };
}
