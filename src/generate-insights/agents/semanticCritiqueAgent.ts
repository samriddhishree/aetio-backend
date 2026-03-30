import type { Finding, Insight, InsightConfidence } from "../../types";
import { config } from "../../common/services/config";
import { OPENAI_HELPER_MODEL, openai } from "../../common/services/openai";
import { chunkArray, mapWithConcurrency } from "../../common/services/utils";
import { toCritiqueLLMInput, type FindingSummary } from "./llmInputProjections";
import { clampConfidence, sanitizeInsightConfidence } from "./insightConfidence";
import {
  CRITIQUE_SEVERITIES,
  SEMANTIC_CRITIQUE_ISSUE_TYPES,
  addIssue,
  type ConfidenceByInsightId,
  type CritiqueIssue,
  type CritiqueMap,
  type CritiqueSeverity,
  type GraphStateCRV,
  type SemanticCritiqueIssueType,
} from "../../common/services/insightMetadata";

const MAX_SNIPPETS_PER_INSIGHT = 3;
const MAX_CHILDREN_IN_PARENT_CONTEXT = 8;
const MAX_SIBLINGS_IN_GROUP_CONTEXT = 6;
const MAX_STANDALONE_CONTEXTS = 60;
const MAX_PARENT_CONTEXTS = 40;
const MAX_SIBLING_CONTEXTS = 40;
const MAX_CONTEXT_EVAL_CONCURRENCY = 3;
const MAX_CONFIDENCE_REASONS = 2;
const MAX_RELATED_FINDINGS = 4;
const GENERIC_CUE =
  /\b(important|various|several|significant|changed materially|improved|declined|mixed performance)\b/i;
const NUMBER_CUE = /\b\d+(?:\.\d+)?%?\b/;

const ISSUE_CONFIDENCE_PENALTY: Partial<Record<CritiqueIssue["type"], number>> = {
  missing_support: 0.35,
  weak_evidence_grounding: 0.2,
  irrelevant_insight: 0.2,
  too_generic: 0.15,
  redundant: 0.1,
  unsupported_by_children: 0.14,
  weak_child_support: 0.1,
  overgeneralized: 0.12,
  lost_quantitative_detail: 0.14,
  hierarchy_error: 0.09,
  metadata_inconsistency: 0.07,
  unsupported_metadata: 0.05,
};

const SEMANTIC_CRITIQUE_PROMPT = `
You are a semantic critique evaluator for a document intelligence pipeline.

Evaluate only the provided bounded context. Do not rewrite insights.
Return:
1) results[] where each item includes:
   - insight_id
   - issues[] strongly justified by context
   - confidence { score, reasoning } for that insight

Confidence meaning:
- high: grounded, specific, coherent, and evidence-faithful
- medium: useful but has weakness or uncertainty
- low: weakly grounded, generic, unsupported, irrelevant, or hallucination-prone

Score confidence using:
- evidence grounding
- specificity vs genericness
- relevance
- parent/child support coherence
- quantitative fidelity
- hallucination/unsupported inference risk

Guidance:
- Penalize generic, redundant, weakly grounded, and unsupported insights.
- Preserve high confidence for strong, specific, evidence-grounded insights.
- Do not inflate confidence.
- Keep reasoning concise and evidence-tied.
- evidence_snippets are provided from FindingExtractionAgent (finding.evidence_snipped); evaluate them as provided and do not invent new snippets.
- Do not invent facts or criticism.
- You MUST include one results[] entry for every allowed insight ID.

Return strict JSON matching schema.
`;

const SEMANTIC_CRITIQUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          insight_id: { type: "string" },
          issues: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: {
                  type: "string",
                  enum: SEMANTIC_CRITIQUE_ISSUE_TYPES,
                },
                severity: {
                  type: "string",
                  enum: CRITIQUE_SEVERITIES,
                },
                message: { type: "string" },
              },
              required: ["type", "severity", "message"],
            },
          },
          confidence: {
            type: "object",
            additionalProperties: false,
            properties: {
              score: { type: "number", minimum: 0, maximum: 1 },
              reasoning: { type: "string" },
            },
            required: ["score", "reasoning"],
          },
        },
        required: ["insight_id", "issues", "confidence"],
      },
    },
  },
  // Strict schema mode requires required to include every key in properties.
  required: ["results"],
} as const;

type EvidenceSnippet = {
  chunk_id: string;
  snippet: string;
};

type CritiqueInsightView = {
  insight_id: string;
  text: string;
  document_id: string;
  parent_insight_id?: string | null;
  metadata?: Insight["metadata"];
  evidence_snippets: EvidenceSnippet[];
  related_findings?: FindingSummary[];
};

type StandaloneCritiqueContext = {
  context_type: "standalone";
  insight: CritiqueInsightView;
};

type ParentChildrenCritiqueContext = {
  context_type: "parent_children";
  parent: CritiqueInsightView;
  children: CritiqueInsightView[];
};

type SiblingGroupCritiqueContext = {
  context_type: "sibling_group";
  document_id: string;
  parent_insight_id?: string | null;
  parent_text?: string;
  siblings: CritiqueInsightView[];
};

type SemanticCritiqueContext =
  | StandaloneCritiqueContext
  | ParentChildrenCritiqueContext
  | SiblingGroupCritiqueContext;

type SemanticCritiqueResult = {
  results: Array<{
    insight_id: string;
    issues: Array<{
      type: SemanticCritiqueIssueType;
      severity: CritiqueSeverity;
      message: string;
    }>;
    confidence: { score: number; reasoning: string };
  }>;
};

type IssueWithInsightId = {
  insightId: string;
  issue: CritiqueIssue;
};

type ContextEvaluation = {
  issues: IssueWithInsightId[];
  confidenceByInsightId: ConfidenceByInsightId;
};

type ConfidenceAccumulator = {
  score: number;
  reasons: string[];
};

function toView(
  insight: Insight,
  findingById: Map<string, Finding>,
  findingsByChunkId: Map<string, Finding[]>,
  maxSnippets: number,
  childSummaries?: Array<{ insight_id: string; text: string }>,
): CritiqueInsightView {
  const projected = toCritiqueLLMInput(insight, {
    evidence_snippets: getEvidenceSnippets(insight, findingById, findingsByChunkId, maxSnippets),
    child_summaries: childSummaries,
    related_findings: collectRelatedFindings(insight, findingById, findingsByChunkId),
  });

  return {
    insight_id: projected.insight_id,
    text: projected.text,
    document_id: insight.document_id,
    parent_insight_id: projected.parent_insight_id,
    metadata: projected.metadata,
    evidence_snippets: projected.evidence_snippets ?? [],
    related_findings: projected.related_findings,
  };
}

function getEvidenceSnippets(
  insight: Insight,
  findingById: Map<string, Finding>,
  findingsByChunkId: Map<string, Finding[]>,
  maxSnippets: number,
): EvidenceSnippet[] {
  const seen = new Set<string>();
  const snippets: EvidenceSnippet[] = [];
  const addSnippetFromFinding = (finding: Finding) => {
    const snippet = finding.evidence_snipped?.trim();
    if (!snippet) return;
    const chunkId = finding.supporting_chunks?.[0]?.chunk_id || finding.finding_id;
    const dedupeKey = `${chunkId}|${snippet}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    snippets.push({ chunk_id: chunkId, snippet });
  };

  for (const findingId of readFindingIds(insight)) {
    if (snippets.length >= maxSnippets) break;
    const finding = findingById.get(findingId);
    if (!finding) continue;
    addSnippetFromFinding(finding);
  }
  if (snippets.length >= maxSnippets) return snippets;

  for (const ref of insight.supporting_chunks ?? []) {
    const matches = findingsByChunkId.get(ref.chunk_id) ?? [];
    for (const finding of matches) {
      if (snippets.length >= maxSnippets) break;
      addSnippetFromFinding(finding);
    }
    if (snippets.length >= maxSnippets) break;
  }

  return snippets;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readFindingIds(insight: Insight): string[] {
  const record = asRecord(insight.additional_refs);
  if (!record) return [];
  const raw = record.finding_ids;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function toFindingSummary(finding: Finding): FindingSummary {
  const supportingChunkIds = Array.from(
    new Set(
      (finding.supporting_chunks ?? [])
        .map((ref) => ref.chunk_id?.trim())
        .filter((chunkId): chunkId is string => Boolean(chunkId)),
    ),
  );
  return {
    finding_id: finding.finding_id,
    text: finding.text,
    evidence_snipped: finding.evidence_snipped,
    evidence_type: finding.evidence_type,
    supporting_chunk_ids: supportingChunkIds.length > 0 ? supportingChunkIds : undefined,
  };
}

function buildFindingIndexes(state: GraphStateCRV): {
  findingById: Map<string, Finding>;
  findingsByChunkId: Map<string, Finding[]>;
} {
  const findingById = new Map<string, Finding>();
  const findingsByChunkId = new Map<string, Finding[]>();

  for (const finding of state.findings ?? []) {
    findingById.set(finding.finding_id, finding);
    for (const ref of finding.supporting_chunks ?? []) {
      const chunkId = ref.chunk_id?.trim();
      if (!chunkId) continue;
      const list = findingsByChunkId.get(chunkId) ?? [];
      list.push(finding);
      findingsByChunkId.set(chunkId, list);
    }
  }

  return { findingById, findingsByChunkId };
}

function collectRelatedFindings(
  insight: Insight,
  findingById: Map<string, Finding>,
  findingsByChunkId: Map<string, Finding[]>,
): FindingSummary[] | undefined {
  const related = new Map<string, FindingSummary>();

  for (const findingId of readFindingIds(insight)) {
    const finding = findingById.get(findingId);
    if (!finding) continue;
    related.set(finding.finding_id, toFindingSummary(finding));
    if (related.size >= MAX_RELATED_FINDINGS) break;
  }

  if (related.size < MAX_RELATED_FINDINGS) {
    for (const ref of insight.supporting_chunks ?? []) {
      const matches = findingsByChunkId.get(ref.chunk_id) ?? [];
      for (const finding of matches) {
        if (related.has(finding.finding_id)) continue;
        related.set(finding.finding_id, toFindingSummary(finding));
        if (related.size >= MAX_RELATED_FINDINGS) break;
      }
      if (related.size >= MAX_RELATED_FINDINGS) break;
    }
  }

  return related.size > 0 ? Array.from(related.values()) : undefined;
}

function buildContexts(state: GraphStateCRV): SemanticCritiqueContext[] {
  const insightById = new Map(state.insights.map((insight) => [insight.insight_id, insight]));
  const { findingById, findingsByChunkId } = buildFindingIndexes(state);
  const contexts: SemanticCritiqueContext[] = [];

  const standaloneContexts = state.insights
    .slice(0, MAX_STANDALONE_CONTEXTS)
    .map<StandaloneCritiqueContext>((insight) => ({
      context_type: "standalone",
      insight: toView(insight, findingById, findingsByChunkId, MAX_SNIPPETS_PER_INSIGHT),
    }));
  contexts.push(...standaloneContexts);

  const childrenByParent = new Map<string, Insight[]>();
  for (const insight of state.insights) {
    if (!insight.parent_insight_id) continue;
    const list = childrenByParent.get(insight.parent_insight_id) ?? [];
    list.push(insight);
    childrenByParent.set(insight.parent_insight_id, list);
  }

  const parentContexts: ParentChildrenCritiqueContext[] = [];
  for (const [parentId, children] of childrenByParent.entries()) {
    const parent = insightById.get(parentId);
    if (!parent || children.length === 0) continue;

    const limitedChildren = children.slice(0, MAX_CHILDREN_IN_PARENT_CONTEXT);
    parentContexts.push({
      context_type: "parent_children",
      parent: toView(
        parent,
        findingById,
        findingsByChunkId,
        MAX_SNIPPETS_PER_INSIGHT,
        limitedChildren.map((child) => ({
          insight_id: child.insight_id,
          text: child.text,
        })),
      ),
      children: limitedChildren.map((child) =>
        toView(child, findingById, findingsByChunkId, MAX_SNIPPETS_PER_INSIGHT)
      ),
    });
  }
  contexts.push(...parentContexts.slice(0, MAX_PARENT_CONTEXTS));

  const siblingGroupByKey = new Map<string, Insight[]>();
  for (const insight of state.insights) {
    const key = `${insight.document_id}::${insight.parent_insight_id ?? "__root__"}`;
    const list = siblingGroupByKey.get(key) ?? [];
    list.push(insight);
    siblingGroupByKey.set(key, list);
  }

  const siblingContexts: SiblingGroupCritiqueContext[] = [];
  for (const group of siblingGroupByKey.values()) {
    if (group.length < 2) continue;
    const batches = chunkArray(group, MAX_SIBLINGS_IN_GROUP_CONTEXT);
    for (const batch of batches) {
      if (batch.length < 2) continue;
      const parentId = batch[0]?.parent_insight_id;
      const parent = parentId ? insightById.get(parentId) : undefined;
      siblingContexts.push({
        context_type: "sibling_group",
        document_id: batch[0]?.document_id ?? "",
        parent_insight_id: parentId,
        parent_text: parent?.text,
        siblings: batch.map((insight) => toView(insight, findingById, findingsByChunkId, 1)),
      });
    }
  }
  contexts.push(...siblingContexts.slice(0, MAX_SIBLING_CONTEXTS));

  return contexts;
}

function collectAllowedInsightIds(context: SemanticCritiqueContext): Set<string> {
  if (context.context_type === "standalone") {
    return new Set([context.insight.insight_id]);
  }
  if (context.context_type === "parent_children") {
    return new Set([context.parent.insight_id, ...context.children.map((child) => child.insight_id)]);
  }
  return new Set(context.siblings.map((sibling) => sibling.insight_id));
}

function issueSeverityMultiplier(severity: CritiqueSeverity): number {
  if (severity === "high") return 1;
  if (severity === "medium") return 0.6;
  return 0.35;
}

function collectContextViews(context: SemanticCritiqueContext): Map<string, CritiqueInsightView> {
  if (context.context_type === "standalone") {
    return new Map([[context.insight.insight_id, context.insight]]);
  }
  if (context.context_type === "parent_children") {
    return new Map([
      [context.parent.insight_id, context.parent],
      ...context.children.map((child) => [child.insight_id, child] as const),
    ]);
  }
  return new Map(context.siblings.map((sibling) => [sibling.insight_id, sibling] as const));
}

function synthesizeConfidenceForView(
  view: CritiqueInsightView | undefined,
  issues: CritiqueIssue[],
): InsightConfidence {
  const evidenceCount = view?.evidence_snippets.length ?? 0;
  let score = 0.72;
  const reasons: string[] = [];

  if (evidenceCount === 0) {
    score -= 0.25;
    reasons.push("No direct evidence snippets in critique context.");
  } else if (evidenceCount === 1) {
    score -= 0.08;
    reasons.push("Limited evidence snippets available.");
  } else {
    score += 0.03;
    reasons.push("Multiple evidence snippets support this insight.");
  }

  const text = view?.text ?? "";
  if (text.length < 50) {
    score -= 0.07;
    reasons.push("Very short text may be underspecified.");
  }
  if (GENERIC_CUE.test(text) && !NUMBER_CUE.test(text)) {
    score -= 0.1;
    reasons.push("Wording appears generic without concrete detail.");
  } else if (NUMBER_CUE.test(text)) {
    score += 0.05;
    reasons.push("Contains concrete quantitative detail.");
  }

  for (const issue of issues) {
    const penalty = (ISSUE_CONFIDENCE_PENALTY[issue.type] ?? 0.06) * issueSeverityMultiplier(issue.severity);
    score -= penalty;
  }
  if (issues.length > 0) {
    reasons.push(`Critique flagged ${issues.length} issue(s).`);
  }

  return {
    score: clampConfidence(score),
    reasoning: reasons.slice(0, 2).join(" | ") || "Confidence synthesized from critique context.",
  };
}

function mergeConfidenceByInsightId(
  llmConfidence: ConfidenceByInsightId,
  synthesizedConfidence: ConfidenceByInsightId,
): ConfidenceByInsightId {
  const merged: ConfidenceByInsightId = { ...synthesizedConfidence };
  for (const [insightId, confidence] of Object.entries(llmConfidence)) {
    merged[insightId] = confidence;
  }
  return merged;
}

function defaultConfidenceForInsight(insight: Insight): InsightConfidence {
  const existing = sanitizeInsightConfidence(insight.confidence);
  if (existing) return existing;
  const view: CritiqueInsightView = {
    insight_id: insight.insight_id,
    text: insight.text,
    document_id: insight.document_id,
    parent_insight_id: insight.parent_insight_id,
    metadata: insight.metadata,
    evidence_snippets: [],
  };
  const synthesized = synthesizeConfidenceForView(view, []);
  return {
    score: synthesized.score,
    reasoning: `Fallback semantic confidence: ${synthesized.reasoning}`,
  };
}

export class SemanticCritiqueAgent {
  async process(state: GraphStateCRV): Promise<Partial<GraphStateCRV>> {
    console.log("SemanticCritiqueAgent:size", state.insights?.length ?? 0);
    console.debug("SemanticCritiqueAgent:start", { insights: state.insights.length });
    if (state.insights.length === 0) {
      return { critiqueByInsightId: {}, confidenceByInsightId: {}, insights: [] };
    }

    const contexts = buildContexts(state);
    if (contexts.length === 0) {
      const confidenceByInsightId = Object.fromEntries(
        state.insights.map((insight) => [insight.insight_id, defaultConfidenceForInsight(insight)]),
      ) as ConfidenceByInsightId;
      return {
        critiqueByInsightId: {},
        confidenceByInsightId,
        insights: state.insights.map((insight) => ({
          ...insight,
          confidence: confidenceByInsightId[insight.insight_id],
        })),
      };
    }

    const evaluatedContexts = await mapWithConcurrency(
      contexts,
      Math.max(1, Math.min(config.maxConcurrency, MAX_CONTEXT_EVAL_CONCURRENCY)),
      async (context) => {
        try {
          return await this.evaluateContext(context);
        } catch (error) {
          console.error("SemanticCritiqueAgent:context-failed", {
            contextType: context.context_type,
            error: error instanceof Error ? error.message : String(error),
          });
          return { issues: [], confidenceByInsightId: {} } as ContextEvaluation;
        }
      },
    );

    const critique: CritiqueMap = {};
    const confidenceAccumulator = new Map<string, ConfidenceAccumulator>();

    for (const evaluated of evaluatedContexts) {
      for (const item of evaluated.issues) {
        addIssue(critique, item.insightId, item.issue);
      }

      for (const [insightId, confidence] of Object.entries(evaluated.confidenceByInsightId)) {
        const existing = confidenceAccumulator.get(insightId);
        if (!existing) {
          confidenceAccumulator.set(insightId, {
            score: confidence.score,
            reasons: [confidence.reasoning],
          });
          continue;
        }

        existing.score = Math.min(existing.score, confidence.score);
        if (
          confidence.reasoning &&
          !existing.reasons.includes(confidence.reasoning) &&
          existing.reasons.length < MAX_CONFIDENCE_REASONS
        ) {
          existing.reasons.push(confidence.reasoning);
        }
      }
    }

    const confidenceByInsightId: ConfidenceByInsightId = {};
    for (const insight of state.insights) {
      const accumulated = confidenceAccumulator.get(insight.insight_id);
      if (!accumulated) {
        confidenceByInsightId[insight.insight_id] = defaultConfidenceForInsight(insight);
        continue;
      }

      confidenceByInsightId[insight.insight_id] = {
        score: clampConfidence(accumulated.score),
        reasoning: accumulated.reasons.join(" | "),
      };
    }

    const updatedInsights = state.insights.map((insight) => ({
      ...insight,
      confidence: confidenceByInsightId[insight.insight_id] ?? defaultConfidenceForInsight(insight),
    }));

    console.debug("SemanticCritiqueAgent:end", {
      issues: Object.keys(critique).length,
      confidenceCount: Object.keys(confidenceByInsightId).length,
    });
    return {
      critiqueByInsightId: critique,
      confidenceByInsightId,
      insights: updatedInsights,
    };
  }

  private async evaluateContext(
    context: SemanticCritiqueContext,
  ): Promise<ContextEvaluation> {
    const allowedInsightIds = collectAllowedInsightIds(context);
    console.log(
      "SemanticCritiqueAgent:llm-input-sample",
      JSON.stringify({
        context_type: context.context_type,
        allowed_insight_ids_count: allowedInsightIds.size,
        context_sample:
          context.context_type === "standalone"
            ? context.insight
            : context.context_type === "parent_children"
              ? {
                  parent: context.parent,
                  first_child: context.children[0],
                }
              : {
                  document_id: context.document_id,
                  first_sibling: context.siblings[0],
                },
      }),
    );

    const response = await openai.chat.completions.create({
      model: OPENAI_HELPER_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: SEMANTIC_CRITIQUE_PROMPT,
        },
        {
          role: "user",
          content: [
            "Evaluate this bounded context and return valid critique issues and confidence.",
            `Context type: ${context.context_type}`,
            `Allowed insight IDs: ${Array.from(allowedInsightIds).join(", ")}`,
            "Return one results[] entry for every allowed insight ID.",
            `Context JSON:\n${JSON.stringify(context, null, 2)}`,
          ].join("\n\n"),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "semantic_critique",
          schema: SEMANTIC_CRITIQUE_SCHEMA,
          strict: true,
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("Empty OpenAI response.");
    }

    const parsed = JSON.parse(content) as SemanticCritiqueResult;
    const normalizedEntries = this.normalizeCritiqueResults(parsed, allowedInsightIds);
    const normalizedIssues = normalizedEntries.flatMap((entry) =>
      entry.issues.map((issue) => ({
        insightId: entry.insightId,
        issue,
      }))
    );
    const llmConfidence = Object.fromEntries(
      normalizedEntries.map((entry) => [entry.insightId, entry.confidence]),
    ) as ConfidenceByInsightId;
    const issuesByInsightId = new Map<string, CritiqueIssue[]>();
    for (const issue of normalizedIssues) {
      const list = issuesByInsightId.get(issue.insightId) ?? [];
      list.push(issue.issue);
      issuesByInsightId.set(issue.insightId, list);
    }

    const viewsByInsightId = collectContextViews(context);
    const synthesizedConfidence: ConfidenceByInsightId = {};
    for (const insightId of allowedInsightIds) {
      synthesizedConfidence[insightId] = synthesizeConfidenceForView(
        viewsByInsightId.get(insightId),
        issuesByInsightId.get(insightId) ?? [],
      );
    }
    const missingLlmConfidenceIds = Array.from(allowedInsightIds).filter(
      (insightId) => !(insightId in llmConfidence),
    );
    console.debug("SemanticCritiqueAgent:confidence-coverage", {
      context_type: context.context_type,
      allowed_ids: allowedInsightIds.size,
      llm_confidence_ids: Object.keys(llmConfidence).length,
      fallback_ids: missingLlmConfidenceIds.length,
      fallback_sample: missingLlmConfidenceIds.slice(0, 5),
    });

    return {
      issues: normalizedIssues,
      confidenceByInsightId: mergeConfidenceByInsightId(llmConfidence, synthesizedConfidence),
    };
  }

  private normalizeCritiqueResults(
    result: SemanticCritiqueResult,
    allowedInsightIds: Set<string>,
  ): Array<{ insightId: string; issues: CritiqueIssue[]; confidence: InsightConfidence }> {
    const allowedTypes = new Set<SemanticCritiqueIssueType>(SEMANTIC_CRITIQUE_ISSUE_TYPES);
    const allowedSeverities = new Set<CritiqueSeverity>(CRITIQUE_SEVERITIES);
    const normalized: Array<{ insightId: string; issues: CritiqueIssue[]; confidence: InsightConfidence }> = [];

    for (const record of result.results ?? []) {
      if (!allowedInsightIds.has(record.insight_id)) continue;
      const confidence = sanitizeInsightConfidence(
        record.confidence,
        "Confidence scored by semantic critique from bounded context.",
      );
      if (!confidence) continue;

      const issues: CritiqueIssue[] = [];
      const seenIssues = new Set<string>();
      for (const issue of record.issues ?? []) {
        if (!allowedTypes.has(issue.type)) continue;
        if (!allowedSeverities.has(issue.severity)) continue;
        const message = issue.message?.trim();
        if (!message) continue;
        const dedupeKey = `${issue.type}|${issue.severity}|${message.toLowerCase()}`;
        if (seenIssues.has(dedupeKey)) continue;
        seenIssues.add(dedupeKey);
        issues.push({
          type: issue.type,
          severity: issue.severity,
          message,
        });
      }

      normalized.push({
        insightId: record.insight_id,
        issues,
        confidence,
      });
    }

    return normalized;
  }
}

export const semanticCritiqueAgent = new SemanticCritiqueAgent();
