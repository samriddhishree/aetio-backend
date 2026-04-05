import type { Finding, InsightFamily } from "../types";

export type InferredInsightFamilyDataSchema = {
  has_grid: boolean;
  dimensions: string[];
  metric_columns: string[];
  tabularity_confidence: number;
  reasoning: string;
};

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeTag(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_\- ]+/g, "")
    .replace(/\s+/g, "_");
}

function hasNumericSignal(finding: Finding): boolean {
  if (finding.metric_value !== undefined) return true;
  return /[-+]?\d[\d,.]*%?/.test(finding.text);
}

function inferMetricColumnName(family: InsightFamily, findings: Finding[]): string {
  const familyContext = `${family.family_text} ${family.question_answered}`.toLowerCase();
  const metricUnits = findings
    .map((finding) => (finding.metric_unit ?? "").toLowerCase())
    .filter(Boolean);
  const hasPercentUnit = metricUnits.some((unit) => unit.includes("%") || unit.includes("percent"));

  if (familyContext.includes("conversion")) return "conversion_rate_change";
  if (familyContext.includes("growth") && hasPercentUnit) return "growth_rate";
  if (
    familyContext.includes("count") ||
    familyContext.includes("people") ||
    familyContext.includes("population") ||
    familyContext.includes("incarcer") ||
    familyContext.includes("probation") ||
    familyContext.includes("record")
  ) {
    return "count";
  }
  if (hasPercentUnit) return "percentage";
  return "value";
}

export function inferInsightFamilyDataSchema(input: {
  family: InsightFamily;
  findings: Finding[];
}): InferredInsightFamilyDataSchema {
  const { family, findings } = input;
  if (findings.length === 0) {
    return {
      has_grid: false,
      dimensions: [],
      metric_columns: [],
      tabularity_confidence: 0,
      reasoning: "No supporting findings available.",
    };
  }

  const dimensionStats = new Map<string, { findingCount: number; values: Set<string> }>();
  let findingsWithDimensions = 0;
  let findingsWithNumericSignals = 0;

  for (const finding of findings) {
    if ((finding.dimensions ?? []).length > 0) findingsWithDimensions += 1;
    if (hasNumericSignal(finding)) findingsWithNumericSignals += 1;

    const seenTags = new Set<string>();
    for (const dimension of finding.dimensions ?? []) {
      const tag = normalizeTag(dimension.tag);
      const value = normalizeText(dimension.value);
      if (!tag || !value) continue;

      const existing = dimensionStats.get(tag) ?? { findingCount: 0, values: new Set<string>() };
      existing.values.add(value.toLowerCase());
      if (!seenTags.has(tag)) {
        existing.findingCount += 1;
        seenTags.add(tag);
      }
      dimensionStats.set(tag, existing);
    }
  }

  const filterSet = new Set((family.filters ?? []).map((filter) => normalizeTag(filter)));
  const dimensionalCandidates = Array.from(dimensionStats.entries())
    .filter(([, stats]) => stats.findingCount >= 2 && stats.values.size >= 2)
    .sort((left, right) => {
      const [leftTag, leftStats] = left;
      const [rightTag, rightStats] = right;
      const leftFilterBoost = filterSet.has(leftTag) ? 1 : 0;
      const rightFilterBoost = filterSet.has(rightTag) ? 1 : 0;
      if (leftFilterBoost !== rightFilterBoost) return rightFilterBoost - leftFilterBoost;
      if (leftStats.findingCount !== rightStats.findingCount) {
        return rightStats.findingCount - leftStats.findingCount;
      }
      return rightStats.values.size - leftStats.values.size;
    })
    .map(([tag]) => tag)
    .slice(0, 3);

  const metricColumn = inferMetricColumnName(family, findings);

  const dimensionSignal =
    dimensionStats.size > 0 ? dimensionalCandidates.length / Math.max(dimensionStats.size, 1) : 0;
  const numericSignal = findingsWithNumericSignals / Math.max(findings.length, 1);
  const shapeSignal = findingsWithDimensions / Math.max(findings.length, 1);
  const tabularityConfidence = Number(
    Math.max(0, Math.min(1, dimensionSignal * 0.55 + numericSignal * 0.35 + shapeSignal * 0.1))
      .toFixed(3),
  );

  if (dimensionalCandidates.length > 0) {
    return {
      has_grid: true,
      dimensions: dimensionalCandidates,
      metric_columns: [metricColumn],
      tabularity_confidence: tabularityConfidence,
      reasoning: "Stable dimensions detected across findings.",
    };
  }

  if (findingsWithNumericSignals >= 2) {
    return {
      has_grid: true,
      dimensions: ["measure"],
      metric_columns: [metricColumn === "value" ? "count" : metricColumn],
      tabularity_confidence: Number(Math.max(0.55, tabularityConfidence).toFixed(3)),
      reasoning: "Numeric measure list detected without stable explicit dimensions.",
    };
  }

  return {
    has_grid: false,
    dimensions: [],
    metric_columns: [],
    tabularity_confidence: tabularityConfidence,
    reasoning: "Insufficient structure for a stable grid.",
  };
}
