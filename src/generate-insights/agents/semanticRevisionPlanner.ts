import { config } from "../../common/services/config";
import { OPENAI_HELPER_MODEL, openai } from "../../common/services/openai";
import { chunkArray, mapWithConcurrency } from "../../common/services/utils";
import type { CritiqueMap, GraphStateCRV } from "../../common/services/insightMetadata";
import type { Insight } from "../../types";
import type { RevisedInsightAction, RevisionContext, RevisionPlanResult } from "./revisionTypes";
import {
  MIN_RETAINED_INSIGHT_CONFIDENCE_SCORE,
  sanitizeInsightConfidence,
} from "./insightConfidence";
import { toRevisionLLMInput } from "./llmInputProjections";

const MAX_CONTEXTS = 120;
const MAX_CONTEXTS_PER_CALL = 8;
const MAX_CALL_CONCURRENCY = 2;
const MAX_SNIPPETS_PER_INSIGHT = 3;
const MAX_CHILDREN_PER_CONTEXT = 8;
const MAX_SIBLINGS_PER_CONTEXT = 5;
const MAX_EVIDENCE_SNIPPET_CHARS = 320;

const REVISION_PLANNER_PROMPT = `
You are a conservative revision planner in a LangGraph-based document intelligence pipeline.

Task:
- For each focus insight, decide one action: keep, update, or merge_into.
- revised_confidence is optional and should be set only if revision materially changes quality.
- Use only the provided critique issues and bounded context.
- evidence_snippets are provided from extracted insights and chunk context; evaluate them as provided and do not invent new snippets.
- Do not invent unsupported facts, numbers, or metadata.
- Do not rewrite insights unless critique issues justify it.
- Strongly prefer action = "update" when any critique issue is actionable and can be addressed conservatively.
- Use action = "keep" only when issues are absent or purely informational with no concrete safe edit.

Required principles:
1) Never add unsupported facts or metadata.
2) Preserve supporting_chunks grounding; do not widen evidence claims.
3) Preserve material quantitative detail when present.
4) Prefer narrowing weak claims over broadening claims.
5) Prefer removing bad metadata over inventing better metadata.
6) Prefer standalone insights over weak hierarchy.
7) Be conservative about deletion: default to keep/update with lower confidence.
8) Deletion is not allowed in this planner; give a best-effort update when critiques indicate problems.
9) When in doubt between keep vs update, choose update with a minimal evidence-grounded revision.

Issue guidance:
- too_generic: rewrite more specific while preserving evidence.
- overgeneralized: narrow claim to evidence or children.
- lost_quantitative_detail: restore key numbers, deltas, comparisons, directions.
- weak_evidence_grounding: tighten wording to match evidence.
- irrelevant_insight: prefer retain + lower confidence unless severe unsupportedness is clear.
- redundant: merge into stronger equivalent when safe, else keep weaker duplicate with lower confidence.
- unsupported_by_children / weak_child_support: adjust parent text or detach hierarchy conservatively.
- hierarchy_error: fix or detach invalid parent references safely.
- low_confidence_metadata / redundant_metadata / low_value_metadata / unsupported_metadata:
  remove weak or duplicated metadata.
- overly_specific_metadata: broaden only if strongly supported; otherwise remove.
- metadata_inconsistency: align metadata to insight context without invention.
- possible_missing_subinsights: do not invent sub-insights; narrow parent if needed.
- For low/medium severity issues, prefer minimal text/metadata updates rather than keep.

Confidence guidance:
- Confidence reflects grounding in evidence, specificity, hierarchy support, and critique severity.
- Do not inflate confidence.
- Lower confidence when concerns remain unresolved, even if the insight is retained.
- If revision is minor and quality is unchanged, omit revised_confidence and preserve existing confidence.

Structured output only:
Return strict JSON matching schema with one action per focus insight ID.

Reference interfaces:
\`\`\`ts
interface CritiqueIssue {
  type:
    | "missing_support"
    | "hierarchy_error"
    | "low_confidence_metadata"
    | "metadata_inconsistency"
    | "possible_missing_subinsights"
    | "irrelevant_insight"
    | "too_generic"
    | "redundant"
    | "unsupported_by_children"
    | "weak_child_support"
    | "overgeneralized"
    | "lost_quantitative_detail"
    | "weak_evidence_grounding"
    | "redundant_metadata"
    | "low_value_metadata"
    | "unsupported_metadata"
    | "overly_specific_metadata";
  severity: "low" | "medium" | "high";
  message: string;
}

interface Insight {
  insight_id: string;
  parent_insight_id?: string | null;
  text: string;
  supporting_chunk_ids?: string[];
  metadata?: Array<{ tag: string; value: string; confidence?: number }>;
  confidence?: { score: number; reasoning: string };
  document_id: string;
}
\`\`\`

Concrete example:
\`\`\`json
{
  "focus_insight": {
    "insight_id": "i-12",
    "text": "Revenue performance changed materially.",
    "supporting_chunk_ids": ["c-1"]
  },
  "critique_issues": [
    { "type": "too_generic", "severity": "high", "message": "Insight omits the 18% QoQ increase." },
    { "type": "lost_quantitative_detail", "severity": "high", "message": "Missing 18% QoQ detail." }
  ],
  "expected_action": {
    "insight_id": "i-12",
    "action": "update",
    "revised_text": "Revenue increased 18% quarter-over-quarter.",
    "revised_confidence": {
      "score": 0.89,
      "reasoning": "Quantitative detail restored and directly grounded in evidence."
    },
    "reasoning": "Restores quantitative detail already present in evidence."
  }
}
\`\`\`
`;

const REVISION_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          insight_id: { type: "string" },
          action: {
            type: "string",
            enum: ["keep", "update", "remove", "merge_into"],
          },
          merge_target_insight_id: { type: ["string", "null"] },
          revised_text: { type: ["string", "null"] },
          revised_parent_insight_id: {
            type: ["string", "null"],
          },
          revised_metadata: {
            type: ["array", "null"],
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                tag: { type: "string" },
                value: { type: "string" },
                confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
              },
              required: ["tag", "value", "confidence"],
            },
          },
          revised_confidence: {
            type: ["object", "null"],
            additionalProperties: false,
            properties: {
              score: { type: "number", minimum: 0, maximum: 1 },
              reasoning: { type: "string" },
            },
            required: ["score", "reasoning"],
          },
          reasoning: { type: ["string", "null"] },
        },
        required: [
          "insight_id",
          "action",
          "merge_target_insight_id",
          "revised_text",
          "revised_parent_insight_id",
          "revised_metadata",
          "revised_confidence",
          "reasoning",
        ],
      },
    },
  },
  required: ["actions"],
} as const;

function compactSnippet(value: string | undefined): string | undefined {
  const compact = value?.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  if (compact.length <= MAX_EVIDENCE_SNIPPET_CHARS) return compact;
  return `${compact.slice(0, MAX_EVIDENCE_SNIPPET_CHARS - 1).trimEnd()}...`;
}

function buildChunkContextById(state: GraphStateCRV): Map<string, string> {
  const byId = new Map<string, string>();
  // Findings state was removed, so revision evidence snippets come from chunk/source text.
  for (const chunk of state.chunks) {
    const snippet = compactSnippet(chunk.content);
    if (snippet) {
      byId.set(chunk.chunk_id, snippet);
      continue;
    }
    const fallback = compactSnippet(state.sourceTextByS3Node[chunk.s3_node]);
    if (fallback) byId.set(chunk.chunk_id, fallback);
  }
  return byId;
}

function toEvidenceSnippets(
  insight: Insight,
  chunkContextById: Map<string, string>,
) {
  const seen = new Set<string>();
  const snippets: Array<{ chunk_id: string; snippet: string }> = [];

  const addSnippet = (chunkId: string, rawSnippet: string | undefined) => {
    const snippet = compactSnippet(rawSnippet);
    if (!snippet) return;
    const dedupeKey = `${chunkId}|${snippet}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    snippets.push({
      chunk_id: chunkId,
      snippet,
    });
  };

  const primaryChunkId = insight.supporting_chunks?.[0]?.chunk_id ?? insight.insight_id;
  addSnippet(primaryChunkId, insight.evidence_snippet);
  if (snippets.length >= MAX_SNIPPETS_PER_INSIGHT) return snippets;

  for (const ref of insight.supporting_chunks ?? []) {
    addSnippet(ref.chunk_id, chunkContextById.get(ref.chunk_id));
    if (snippets.length >= MAX_SNIPPETS_PER_INSIGHT) break;
  }

  return snippets;
}

function toView(
  insight: Insight,
  chunkContextById: Map<string, string>,
) {
  const projected = toRevisionLLMInput(insight, undefined, {
    evidence_snippets: toEvidenceSnippets(insight, chunkContextById),
  });

  return {
    insight_id: projected.insight_id,
    text: projected.text,
    document_id: insight.document_id,
    parent_insight_id: projected.parent_insight_id,
    supporting_chunk_ids: projected.supporting_chunk_ids,
    evidence_snippets: projected.evidence_snippets ?? [],
    related_findings: projected.related_findings,
    metadata: projected.metadata,
    confidence: projected.confidence,
  };
}

function buildContexts(state: GraphStateCRV, critique: CritiqueMap): RevisionContext[] {
  const insightById = new Map(state.insights.map((insight) => [insight.insight_id, insight]));
  const chunkContextById = buildChunkContextById(state);
  const childrenByParent = new Map<string, Insight[]>();
  const siblingsByKey = new Map<string, Insight[]>();

  for (const insight of state.insights) {
    if (insight.parent_insight_id) {
      const children = childrenByParent.get(insight.parent_insight_id) ?? [];
      children.push(insight);
      childrenByParent.set(insight.parent_insight_id, children);
    }
    const siblingKey = `${insight.document_id}:${insight.parent_insight_id ?? "__root__"}`;
    const siblings = siblingsByKey.get(siblingKey) ?? [];
    siblings.push(insight);
    siblingsByKey.set(siblingKey, siblings);
  }

  const contexts: RevisionContext[] = [];
  for (const insight of state.insights) {
    const issues = critique[insight.insight_id] ?? [];
    if (issues.length === 0) continue;

    const siblingKey = `${insight.document_id}:${insight.parent_insight_id ?? "__root__"}`;
    const siblings = (siblingsByKey.get(siblingKey) ?? [])
      .filter((candidate) => candidate.insight_id !== insight.insight_id)
      .slice(0, MAX_SIBLINGS_PER_CONTEXT);

    const children = (childrenByParent.get(insight.insight_id) ?? []).slice(
      0,
      MAX_CHILDREN_PER_CONTEXT,
    );
    const parent = insight.parent_insight_id
      ? insightById.get(insight.parent_insight_id)
      : undefined;

    contexts.push({
      context_type: "insight_local",
      focus_insight_id: insight.insight_id,
      critique_issues: issues,
      insight: toView(insight, chunkContextById),
      parent: parent ? toView(parent, chunkContextById) : undefined,
      children: children.map((child) => toView(child, chunkContextById)),
      sibling_candidates: siblings.map((sibling) => toView(sibling, chunkContextById)),
    });

    if (contexts.length >= MAX_CONTEXTS) break;
  }

  return contexts;
}

function parseParentId(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed;
}

function normalizeConfidence(raw: unknown): RevisedInsightAction["revised_confidence"] {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const score = typeof record.score === "number" ? record.score : undefined;
  const reasoning = typeof record.reasoning === "string" ? record.reasoning : undefined;
  return sanitizeInsightConfidence(
    {
      score,
      reasoning,
    },
    "Confidence revised from critique and evidence context.",
  );
}

function normalizeMetadata(raw: unknown): RevisedInsightAction["revised_metadata"] {
  if (!Array.isArray(raw)) return undefined;
  const normalized: NonNullable<RevisedInsightAction["revised_metadata"]> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const tag = typeof record.tag === "string" ? record.tag.trim() : "";
    const value = typeof record.value === "string" ? record.value.trim() : "";
    if (!tag || !value) continue;
    const confidenceRaw = record.confidence;
    const confidence =
      typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
        ? Math.max(0, Math.min(1, confidenceRaw))
        : undefined;
    normalized.push({ tag, value, confidence });
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeActions(
  actions: RevisedInsightAction[],
  allowedInsightIds: Set<string>,
  allowedMergeTargets: Set<string>,
): RevisedInsightAction[] {
  const seen = new Set<string>();
  const normalized: RevisedInsightAction[] = [];
  const allowedActions = new Set<RevisedInsightAction["action"]>([
    "keep",
    "update",
    "remove",
    "merge_into",
  ]);

  for (const action of actions) {
    if (!allowedInsightIds.has(action.insight_id)) continue;
    if (seen.has(action.insight_id)) continue;
    if (!allowedActions.has(action.action)) continue;

    const reasoning = action.reasoning?.trim();
    const base: RevisedInsightAction = {
      insight_id: action.insight_id,
      action: action.action,
      reasoning: reasoning || undefined,
    };
    const revisedConfidence = normalizeConfidence(action.revised_confidence);
    if (revisedConfidence) {
      base.revised_confidence = revisedConfidence;
    }

    if (action.action === "merge_into") {
      const target = action.merge_target_insight_id?.trim();
      if (!target) continue;
      if (target === action.insight_id) continue;
      if (!allowedMergeTargets.has(target)) continue;
      base.merge_target_insight_id = target;
    }

    if (action.action === "update" || action.action === "merge_into") {
      const revisedText = action.revised_text?.trim();
      if (revisedText) {
        base.revised_text = revisedText;
      }

      const parentId = parseParentId(action.revised_parent_insight_id);
      if (parentId !== undefined) {
        base.revised_parent_insight_id = parentId;
      }

      const revisedMetadata = normalizeMetadata(action.revised_metadata);
      if (revisedMetadata) {
        base.revised_metadata = revisedMetadata;
      }
    }

    seen.add(base.insight_id);
    normalized.push(base);
  }

  return normalized;
}

export class SemanticRevisionPlanner {
  async plan(state: GraphStateCRV): Promise<RevisedInsightAction[]> {
    console.log("SemanticRevisionPlanner:size", state.insights?.length ?? 0);
    const critique = state.critiqueByInsightId ?? {};
    const contexts = buildContexts(state, critique);
    if (contexts.length === 0) {
      return [];
    }

    const batches = chunkArray(contexts, MAX_CONTEXTS_PER_CALL);
    const concurrency = Math.max(1, Math.min(config.maxConcurrency, MAX_CALL_CONCURRENCY));
    const actionBatches = await mapWithConcurrency(
      batches,
      concurrency,
      async (batch) => {
        try {
          return await this.planBatch(batch);
        } catch (error) {
          console.error("SemanticRevisionPlanner:batch-failed", {
            error: error instanceof Error ? error.message : String(error),
            batchSize: batch.length,
          });
          return [];
        }
      },
    );

    const focusInsightIds = new Set(contexts.map((context) => context.focus_insight_id));
    const mergeTargetIds = new Set(state.insights.map((insight) => insight.insight_id));
    const plannedActions = normalizeActions(actionBatches.flat(), focusInsightIds, mergeTargetIds);
    this.debugRemovedInsights(state, plannedActions);
    const conservativeActions = this.enforceConservativeDeletionPolicy(state, plannedActions);
    return conservativeActions;
  }

  private enforceConservativeDeletionPolicy(
    _state: GraphStateCRV,
    actions: RevisedInsightAction[],
  ): RevisedInsightAction[] {
    return actions.map((action) => {
      if (action.action !== "remove") return action;

      // TODO: Reassess deletion policy later.
      // For now, preserve insights and suppress remove actions entirely.
      return {
        ...action,
        action: "update",
        revised_confidence: action.revised_confidence ?? {
          score: MIN_RETAINED_INSIGHT_CONFIDENCE_SCORE,
          reasoning:
            "Removal suppressed by conservative policy; retained with low confidence pending deletion-policy reassessment.",
        },
        reasoning:
          action.reasoning
          ?? "Removal downgraded to update by conservative no-delete policy.",
      };
    });
  }

  private debugRemovedInsights(state: GraphStateCRV, actions: RevisedInsightAction[]): void {
    const removeActions = actions.filter((action) => action.action === "remove");
    if (removeActions.length === 0) return;

    const insightById = new Map(state.insights.map((insight) => [insight.insight_id, insight]));
    const removedInsights = removeActions.map((action) => {
      const insight = insightById.get(action.insight_id);
      return {
        insight_id: action.insight_id,
        document_id: insight?.document_id,
        parent_insight_id: insight?.parent_insight_id,
        text: insight?.text,
        reasoning: action.reasoning,
      };
    });

    console.debug("SemanticRevisionPlanner:remove-actions", {
      count: removedInsights.length,
      todo: "TODO: Reassess deletion policy later; remove actions are currently suppressed.",
      insights: JSON.stringify(removedInsights),
    });
  }

  private async planBatch(contexts: RevisionContext[]): Promise<RevisedInsightAction[]> {
    const focusInsightIds = new Set(contexts.map((context) => context.focus_insight_id));
    const mergeTargetIds = new Set<string>();
    for (const context of contexts) {
      mergeTargetIds.add(context.insight.insight_id);
      if (context.parent) mergeTargetIds.add(context.parent.insight_id);
      for (const child of context.children) {
        mergeTargetIds.add(child.insight_id);
      }
      for (const sibling of context.sibling_candidates) {
        mergeTargetIds.add(sibling.insight_id);
      }
    }
    console.log(
      "SemanticRevisionPlanner:llm-input-sample",
      JSON.stringify({
        contexts_in_batch: contexts.length,
        focus_insight_ids_count: focusInsightIds.size,
        merge_target_ids_count: mergeTargetIds.size,
        context_sample: contexts[0],
        critique_issues_sample_json: JSON.stringify(contexts[0]?.critique_issues ?? []),
      }),
    );

    const response = await openai.chat.completions.create({
      model: OPENAI_HELPER_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: REVISION_PLANNER_PROMPT,
        },
        {
          role: "user",
          content: [
            "Plan revisions for each focus insight ID listed below.",
            `Focus insight IDs (must return one action per ID): ${Array.from(focusInsightIds).join(", ")}`,
            `Allowed merge target IDs: ${Array.from(mergeTargetIds).join(", ")}`,
            "Bounded contexts JSON:",
            JSON.stringify(contexts, null, 2),
          ].join("\n\n"),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "revision_plan",
          schema: REVISION_PLAN_SCHEMA,
          strict: true,
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("Empty OpenAI response.");
    }

    const parsed = JSON.parse(content) as RevisionPlanResult;
    const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
    return normalizeActions(actions, focusInsightIds, mergeTargetIds);
  }
}

export const semanticRevisionPlanner = new SemanticRevisionPlanner();
