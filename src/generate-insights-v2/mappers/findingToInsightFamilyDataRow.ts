import { hashId } from "../../common/services/utils";
import type {
  Finding,
  InsightFamily,
  InsightFamilyDataRow,
  MetadataDimension,
  SupportingRef,
} from "../types";

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeTag(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_\- ]+/g, "")
    .replace(/\s+/g, "_");
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

function resolveFilterValues(
  finding: Finding,
  dimensions: string[],
): MetadataDimension[] | null {
  if (dimensions.length === 0) return [];
  if (dimensions.length === 1 && dimensions[0] === "measure") {
    return [{ tag: "measure", value: buildMeasureValue(finding) }];
  }

  const dimensionMap = new Map(
    (finding.dimensions ?? []).map((dimension) => [normalizeTag(dimension.tag), dimension.value]),
  );

  const filterValues = dimensions
    .map((tag) => {
      const value = dimensionMap.get(tag);
      return value ? { tag, value: normalizeText(value) } : null;
    })
    .filter((value): value is MetadataDimension => Boolean(value));

  if (filterValues.length !== dimensions.length) return null;
  return filterValues;
}

export function buildRowIdentity(row: InsightFamilyDataRow): string {
  const filterKey = row.filter_values
    .slice()
    .sort((left, right) => left.tag.localeCompare(right.tag))
    .map((filterValue) => `${filterValue.tag}:${filterValue.value}`)
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
}): InsightFamilyDataRow | null {
  const filterValues = resolveFilterValues(input.finding, input.dimensions);
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
    filterValues.map((entry) => `${entry.tag}:${entry.value}`).join("|"),
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
