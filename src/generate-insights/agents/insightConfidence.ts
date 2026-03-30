import type { CritiqueIssue } from "../../common/services/insightMetadata";
import type { Insight, InsightConfidence } from "../../types";

export type ConfidenceSignalSource =
  | "deterministic_critique"
  | "semantic_critique"
  | "revision"
  | "validation";

export type ConfidenceSignal = {
  delta: number;
  reason: string;
  source: ConfidenceSignalSource;
};

export const DEFAULT_INSIGHT_CONFIDENCE_SCORE = 0.65;
export const MIN_RETAINED_INSIGHT_CONFIDENCE_SCORE = 0.15;

const MAX_REASONING_SEGMENTS = 3;
const HALLUCINATION_FOCUS_ISSUES = new Set<CritiqueIssue["type"]>([
  "missing_support",
  "weak_evidence_grounding",
  "irrelevant_insight",
  "unsupported_by_children",
] as const);

const ISSUE_BASE_DELTA: Partial<Record<CritiqueIssue["type"], number>> = {
  missing_support: -0.45,
  weak_evidence_grounding: -0.2,
  lost_quantitative_detail: -0.14,
  overgeneralized: -0.12,
  unsupported_by_children: -0.12,
  weak_child_support: -0.08,
  too_generic: -0.1,
  irrelevant_insight: -0.2,
  redundant: -0.08,
  hierarchy_error: -0.09,
  possible_missing_subinsights: -0.04,
  metadata_inconsistency: -0.06,
  low_confidence_metadata: -0.03,
  redundant_metadata: -0.02,
  low_value_metadata: -0.02,
  unsupported_metadata: -0.05,
  overly_specific_metadata: -0.04,
};

function severityMultiplier(severity: CritiqueIssue["severity"]): number {
  if (severity === "high") return 1;
  if (severity === "medium") return 0.7;
  return 0.45;
}

function normalizeReasoning(reasoning: string | undefined, fallback: string): string {
  const normalized = (reasoning ?? "").replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

export function clampConfidence(score?: number, fallback = DEFAULT_INSIGHT_CONFIDENCE_SCORE): number {
  if (typeof score !== "number" || Number.isNaN(score) || !Number.isFinite(score)) return fallback;
  return Math.max(0, Math.min(1, score));
}

export function sanitizeInsightConfidence(
  confidence: Partial<InsightConfidence> | null | undefined,
  fallbackReasoning = "Confidence initialized from available evidence and critique context.",
): InsightConfidence | undefined {
  if (!confidence) return undefined;

  const hasScore = typeof confidence.score === "number" && Number.isFinite(confidence.score);
  const hasReasoning = typeof confidence.reasoning === "string" && confidence.reasoning.trim().length > 0;
  if (!hasScore && !hasReasoning) return undefined;

  return {
    score: clampConfidence(hasScore ? confidence.score : undefined),
    reasoning: normalizeReasoning(
      hasReasoning ? confidence.reasoning : undefined,
      fallbackReasoning,
    ),
  };
}

export function buildCritiqueConfidenceSignals(issues: CritiqueIssue[]): ConfidenceSignal[] {
  const signals: ConfidenceSignal[] = [];
  for (const issue of issues) {
    const baseDelta = ISSUE_BASE_DELTA[issue.type] ?? -0.05;
    const delta = baseDelta * severityMultiplier(issue.severity);
    if (delta === 0) continue;
    signals.push({
      delta,
      source: "revision",
      reason: `${issue.type}: ${issue.message}`,
    });
  }
  return signals;
}

export function summarizeConfidenceSignals(signals: ConfidenceSignal[]): string {
  if (signals.length === 0) {
    return "No major critique concerns were detected.";
  }

  const sorted = [...signals].sort((left, right) => left.delta - right.delta);
  return sorted
    .slice(0, MAX_REASONING_SEGMENTS)
    .map((signal) => signal.reason.replace(/\s+/g, " ").trim())
    .join(" | ");
}

export function deriveConfidenceFromCritique(params: {
  existingConfidence?: InsightConfidence;
  issues: CritiqueIssue[];
  extraSignals?: ConfidenceSignal[];
  fallbackReasoning?: string;
}): InsightConfidence {
  const base = params.existingConfidence?.score ?? DEFAULT_INSIGHT_CONFIDENCE_SCORE;
  const critiqueSignals = buildCritiqueConfidenceSignals(params.issues);
  const allSignals = critiqueSignals.concat(params.extraSignals ?? []);
  const delta = allSignals.reduce((sum, signal) => sum + signal.delta, 0);
  const score = clampConfidence(base + delta);
  const reasoning = normalizeReasoning(
    params.fallbackReasoning,
    summarizeConfidenceSignals(allSignals),
  );
  return { score, reasoning };
}

export function isStrongHallucinationSuspicion(
  insight: Pick<Insight, "supporting_chunks">,
  issues: CritiqueIssue[],
): boolean {
  const hasNoSupport = (insight.supporting_chunks?.length ?? 0) === 0;
  if (hasNoSupport) return true;

  const highRiskIssues = issues.filter((issue) =>
    HALLUCINATION_FOCUS_ISSUES.has(issue.type) && issue.severity === "high"
  );
  if (highRiskIssues.length >= 2) return true;

  return issues.some((issue) => issue.type === "missing_support" && issue.severity === "high");
}

export function ensureInsightConfidence(
  insight: Insight,
  issues: CritiqueIssue[],
  fallbackReasoning?: string,
): InsightConfidence {
  const sanitizedExisting = sanitizeInsightConfidence(insight.confidence);
  return deriveConfidenceFromCritique({
    existingConfidence: sanitizedExisting,
    issues,
    fallbackReasoning:
      fallbackReasoning
      ?? sanitizedExisting?.reasoning
      ?? "Confidence adjusted from critique findings and evidence support.",
  });
}
