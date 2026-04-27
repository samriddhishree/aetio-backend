import { hashId } from "../common/services/utils";
import { assertConfig } from "../common/services/config";
import { persistInsights, listInsights } from "../common/services/dynamo";
import { upsertInsightDocument } from "../common/services/elasticsearch";
import {
  updatePendingProjectInsightIds,
  updatePendingProjectMetadataDimensionIds,
} from "../common/services/projectsTable";
import { configureRuntimeLogging } from "../common/services/logging";
import { emptyGenerateInsightsV2State } from "../generate-insights-v2/state";
import { documentIntakeNode } from "../generate-insights-v2/nodes/documentIntake";
import { contentExtractionNode } from "../generate-insights-v2/nodes/contentExtraction";
import { normalizeContentNode } from "../generate-insights-v2/nodes/normalizeContent";
import {
  buildDimensionMetadataPersistenceScope,
  syncDimensionMetadata,
} from "../generate-insights-v2/services/dimensionMetadataPersistence";
import {
  buildFamilyPersistenceScope,
  toOpenSearchInsightDocument,
} from "../generate-insights-v2/services/familyPersistence";
import {
  buildInsightFamilyDataPersistenceScope,
  syncInsightFamilyData,
} from "../generate-insights-v2/services/insightFamilyDataPersistence";
import { mergeDimensionMetadata } from "../generate-insights-v2/services/metadataService";
import type { PipelineError } from "../types";
import { mergeToolsetOverrides } from "./tools";
import type {
  GenerateInsightsV3AgentDependencies,
  GenerateInsightsV3AgentState,
  GenerateInsightsV3Input,
  GenerateInsightsV3Insight,
  GenerateInsightsV3RunResult,
  GenerateInsightsV3Toolset,
  GridContext,
  GridRowWithContext,
  GridWorkState,
  V3DocumentBundle,
} from "./types";

configureRuntimeLogging();

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max = 300): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function isDebugEnabled(): boolean {
  const value = process.env.GENERATE_INSIGHTS_V3_DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function logDebug(message: string, payload: Record<string, unknown>): void {
  if (!isDebugEnabled()) return;
  console.info(message, payload);
}

const MAX_ACTION_ATTEMPTS_PER_INPUT = 3;

function actionInputSignature(input: {
  action: string;
  documentId: string;
  activeGridId?: string;
  pendingGridCount: number;
  parsedContentPresent: boolean;
  work?: {
    hasContext: boolean;
    hasExplicitInsight: boolean;
    explicitInsightFound: boolean;
    hasSynthesizedInsight: boolean;
    hasNormalizedGridDraft: boolean;
    normalizedGridDraftRowCount?: number;
    hasNormalizedGrid: boolean;
    hasMetadata: boolean;
    hasTags: boolean;
    hasValidatedInsight: boolean;
    validationErrorsCount: number;
  };
}): string {
  const workSignature = input.work
    ? [
        `ctx:${input.work.hasContext ? 1 : 0}`,
        `exp:${input.work.hasExplicitInsight ? 1 : 0}`,
        `expf:${input.work.explicitInsightFound ? 1 : 0}`,
        `syn:${input.work.hasSynthesizedInsight ? 1 : 0}`,
        `draft:${input.work.hasNormalizedGridDraft ? 1 : 0}`,
        `draftrows:${input.work.normalizedGridDraftRowCount ?? -1}`,
        `norm:${input.work.hasNormalizedGrid ? 1 : 0}`,
        `meta:${input.work.hasMetadata ? 1 : 0}`,
        `tags:${input.work.hasTags ? 1 : 0}`,
        `valid:${input.work.hasValidatedInsight ? 1 : 0}`,
        `verr:${input.work.validationErrorsCount}`,
      ].join("|")
    : "work:none";

  return [
    `action:${input.action}`,
    `doc:${input.documentId}`,
    `grid:${input.activeGridId ?? "none"}`,
    `parsed:${input.parsedContentPresent ? 1 : 0}`,
    `pending:${input.pendingGridCount}`,
    workSignature,
  ].join("||");
}

function detectBroadFileType(sourceUri: string): string {
  const lower = sourceUri.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".doc")) return "doc";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".txt")) return "txt";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".tsv")) return "tsv";
  if (lower.endsWith(".xls")) return "xls";
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".ppt")) return "ppt";
  if (lower.endsWith(".pptx")) return "pptx";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".json")) return "json";
  return "unknown";
}

function buildProjectScopedV3InsightId(input: {
  projectId?: string;
  documentId: string;
  gridId: string;
  tableId?: string;
  sourceUri?: string;
}): string {
  const seed = [
    "insight-v3",
    `project:${input.projectId?.trim() || "none"}`,
    `document:${input.documentId}`,
    `grid:${input.gridId}`,
    `table:${input.tableId ?? "none"}`,
    `source:${input.sourceUri ?? "none"}`,
  ].join("::");
  return hashId(seed);
}

function buildDocumentBundles(input: {
  documents: ReturnType<typeof emptyGenerateInsightsV2State>["documents"];
  extractedDocuments: ReturnType<typeof emptyGenerateInsightsV2State>["extractedDocuments"];
  chunks: ReturnType<typeof emptyGenerateInsightsV2State>["chunks"];
  tables: ReturnType<typeof emptyGenerateInsightsV2State>["tables"];
}): V3DocumentBundle[] {
  return input.documents.map((document) => ({
    descriptor: document,
    extracted: input.extractedDocuments.find((item) => item.document_id === document.document_id),
    chunks: input.chunks.filter((chunk) => chunk.document_id === document.document_id),
    tables: input.tables.filter((table) => table.document_id === document.document_id),
  }));
}

function dedupeDimensionMetadataFromInsights(insights: GenerateInsightsV3Insight[]) {
  const byId = new Map<string, GenerateInsightsV3Insight["dimension_metadata"][number]>();

  for (const insight of insights) {
    for (const dimension of insight.dimension_metadata) {
      const existing = byId.get(dimension.dimension_id);
      if (!existing) {
        byId.set(dimension.dimension_id, dimension);
      } else {
        byId.set(dimension.dimension_id, mergeDimensionMetadata(existing, dimension));
      }
    }
  }

  return Array.from(byId.values()).sort((left, right) =>
    left.canonical_name.localeCompare(right.canonical_name),
  );
}

function hasNarrativeContext(context?: GridContext): boolean {
  if (!context) return false;
  if (context.captions.some((value) => compact(value).length > 0)) return true;
  return context.nearby_paragraphs.some((value) => compact(value).length > 0);
}

function completeGridFailureMessage(work: GridWorkState): string {
  const rowCount = work.normalizedGridDraft?.row_count;
  if (typeof rowCount === "number" && rowCount <= 0) {
    return "Grid dropped: normalized grid produced zero rows.";
  }
  if (work.validationErrors && work.validationErrors.length > 0) {
    return `Grid dropped: insight failed validation (${work.validationErrors.join("; ")})`;
  }
  return "Grid dropped: completed without a validated insight.";
}

function cleanHumanInsightText(value: string): string {
  return compact(value)
    .replace(/\s*Evidence:\s*.*$/is, "")
    .replace(/\s*\(?\btable(?:_id)?\s*=?\s*[a-f0-9]{12,}\)?/gi, "")
    .replace(/\s*\(?\bsource_chunk_id\s*=?\s*[a-f0-9]{12,}\)?/gi, "")
    .replace(/\s*\(?\brow_index\s*=?\s*\d+\)?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fallbackQuestionForInsightFamilyData(input: {
  dimensions: string[];
  metric_columns: string[];
}): string {
  const metric = input.metric_columns[0] ?? "reported values";
  const dimension = input.dimensions[0] ?? "segments";
  return `How does ${metric} vary by ${dimension}?`;
}

function selectEvidenceRowsForInsight(work: GridWorkState): GridRowWithContext[] {
  const rows = work.normalizedGrid?.insightFamilyData.rows ?? [];
  const insightText = cleanHumanInsightText(
    work.candidateInsightText
    ?? work.explicitInsight?.insight_text
    ?? work.synthesizedInsight?.insight_text
    ?? "",
  ).toLowerCase();
  const metricColumns = work.normalizedGrid?.insightFamilyData.metric_columns ?? [];
  const namedMetricSet = new Set(
    metricColumns
      .filter((metric) => insightText.includes(metric.toLowerCase()))
      .map((metric) => metric.toLowerCase()),
  );
  const matched = namedMetricSet.size > 0
    ? rows.filter((row) => row.metric_name && namedMetricSet.has(row.metric_name.toLowerCase()))
    : rows;
  return matched.length > 0 ? matched : rows;
}

function ensureScopeS3Node(input: {
  projectId?: string;
  userId?: string;
  documentIds: string[];
}): string {
  const baseScope = buildFamilyPersistenceScope({
    projectId: input.projectId,
    userId: input.userId,
    documentIds: input.documentIds,
  });

  if (input.projectId && input.projectId.trim().length > 0) {
    return baseScope;
  }

  return `${baseScope}:docs:${hashId(input.documentIds.slice().sort().join("|"))}`;
}

type RunDocumentAgentInput = {
  bundle: V3DocumentBundle;
  runtime: {
    userId?: string;
    userInfo?: GenerateInsightsV3Input["userInfo"];
    projectId?: string;
    organizationId?: string;
    status?: string;
  };
  toolset: GenerateInsightsV3Toolset;
  maxSteps: number;
};

export async function runDocumentAgentOnBundle(
  input: RunDocumentAgentInput,
): Promise<{
  insights: GenerateInsightsV3Insight[];
  errors: PipelineError[];
}> {
  const state: GenerateInsightsV3AgentState = {
    document: input.bundle.descriptor,
    parsedContent: undefined,
    candidateGrids: [],
    candidateGridDiscoveryDone: false,
    pendingGridIds: [],
    processedGridIds: [],
    activeGridId: undefined,
    gridWorkById: new Map(),
    insights: [],
    trace: [],
    steps: 0,
  };

  const errors: PipelineError[] = [];
  const actionAttemptsBySignature = new Map<string, number>();

  while (state.steps < input.maxSteps) {
    state.steps += 1;

    const action = await input.toolset.decideNextAction(state);
    state.trace.push({
      step: state.steps,
      action: action.action,
      reason: action.reason,
      grid_id: state.activeGridId,
    });

    const activeGridWork = state.activeGridId
      ? state.gridWorkById.get(state.activeGridId)
      : undefined;
    const actionSignature = actionInputSignature({
      action: action.action,
      documentId: state.document.document_id,
      activeGridId: state.activeGridId,
      pendingGridCount: state.pendingGridIds.length,
      parsedContentPresent: Boolean(state.parsedContent),
      work: activeGridWork
        ? {
            hasContext: Boolean(activeGridWork.context),
            hasExplicitInsight: Boolean(activeGridWork.explicitInsight),
            explicitInsightFound: activeGridWork.explicitInsight?.found_explicit_insight ?? false,
            hasSynthesizedInsight: Boolean(activeGridWork.synthesizedInsight),
            hasNormalizedGridDraft: Boolean(activeGridWork.normalizedGridDraft),
            normalizedGridDraftRowCount: activeGridWork.normalizedGridDraft?.row_count,
            hasNormalizedGrid: Boolean(activeGridWork.normalizedGrid),
            hasMetadata: Boolean(activeGridWork.metadata),
            hasTags: Boolean(activeGridWork.tags),
            hasValidatedInsight: Boolean(activeGridWork.validatedInsight),
            validationErrorsCount: activeGridWork.validationErrors?.length ?? 0,
          }
        : undefined,
    });
    const actionAttemptCount = (actionAttemptsBySignature.get(actionSignature) ?? 0) + 1;
    actionAttemptsBySignature.set(actionSignature, actionAttemptCount);

    logDebug("[agent][debug] step start", {
      document_id: state.document.document_id,
      step: state.steps,
      action: action.action,
      reason: action.reason,
      active_grid_id: state.activeGridId,
      pending_grids: state.pendingGridIds.length,
      processed_grids: state.processedGridIds.length,
      insights: state.insights.length,
      active_grid_progress: activeGridWork
        ? {
            has_context: Boolean(activeGridWork.context),
            has_explicit_insight: Boolean(activeGridWork.explicitInsight),
            explicit_insight_found: activeGridWork.explicitInsight?.found_explicit_insight ?? false,
            has_synthesized_insight: Boolean(activeGridWork.synthesizedInsight),
            has_normalized_grid_draft: Boolean(activeGridWork.normalizedGridDraft),
            has_normalized_grid: Boolean(activeGridWork.normalizedGrid),
            has_metadata: Boolean(activeGridWork.metadata),
            has_tags: Boolean(activeGridWork.tags),
            has_validated_insight: Boolean(activeGridWork.validatedInsight),
            validation_errors: activeGridWork.validationErrors?.length ?? 0,
          }
        : null,
      action_signature_attempts: actionAttemptCount,
    });

    if (actionAttemptCount > MAX_ACTION_ATTEMPTS_PER_INPUT) {
      const message =
        `Action ${action.action} exceeded max attempts (${MAX_ACTION_ATTEMPTS_PER_INPUT}) for same input signature.`;
      errors.push({
        stage: "agent:loop-guard",
        message,
        document_id: state.document.document_id,
      });

      console.warn("[agent] loop guard tripped", {
        document_id: state.document.document_id,
        step: state.steps,
        action: action.action,
        action_signature: actionSignature,
        attempts: actionAttemptCount,
        active_grid_id: state.activeGridId,
      });

      if (state.activeGridId) {
        state.pendingGridIds = state.pendingGridIds.filter((gridId) => gridId !== state.activeGridId);
        state.processedGridIds.push(state.activeGridId);
        state.activeGridId = undefined;
        continue;
      }

      break;
    }

    try {
      switch (action.action) {
        case "parse_file": {
          console.info("[agent] parsing file ...", {
            document_id: state.document.document_id,
          });
          state.parsedContent = await input.toolset.parseFile(input.bundle);
          break;
        }

        case "find_candidate_grids": {
          if (!state.parsedContent) {
            logDebug("[agent][debug] action no-op: find_candidate_grids missing parsedContent", {
              document_id: state.document.document_id,
              step: state.steps,
            });
            break;
          }
          const candidateGrids = await input.toolset.findCandidateGrids(state.parsedContent);
          state.candidateGrids = candidateGrids;
          state.candidateGridDiscoveryDone = true;
          state.pendingGridIds = candidateGrids.map((grid) => grid.grid_id);

          console.info("[agent] found candidate grids", {
            document_id: state.document.document_id,
            candidate_grid_count: candidateGrids.length,
          });
          break;
        }

        case "select_next_grid": {
          if (state.pendingGridIds.length === 0) {
            logDebug("[agent][debug] action no-op: select_next_grid with no pending grids", {
              document_id: state.document.document_id,
              step: state.steps,
            });
            break;
          }
          const nextGridId = state.pendingGridIds[0];
          const grid = state.candidateGrids.find((candidate) => candidate.grid_id === nextGridId);
          if (!grid) {
            console.warn("[agent] pending grid missing from candidate set; dropping grid id", {
              document_id: state.document.document_id,
              grid_id: nextGridId,
              pending_count: state.pendingGridIds.length,
              candidate_count: state.candidateGrids.length,
            });
            state.pendingGridIds = state.pendingGridIds.filter((gridId) => gridId !== nextGridId);
            break;
          }

          state.activeGridId = nextGridId;
          if (!state.gridWorkById.has(nextGridId)) {
            const insightId = buildProjectScopedV3InsightId({
              projectId: input.runtime.projectId,
              documentId: state.document.document_id,
              gridId: nextGridId,
              tableId: grid.table.table_id,
              sourceUri: grid.source_uri,
            });
            state.gridWorkById.set(nextGridId, { grid, insightId });
          }
          break;
        }

        case "inspect_grid_context": {
          if (!activeGridWork || !state.parsedContent) {
            logDebug("[agent][debug] action no-op: inspect_grid_context missing activeGridWork or parsedContent", {
              document_id: state.document.document_id,
              step: state.steps,
              active_grid_id: state.activeGridId,
              has_parsed_content: Boolean(state.parsedContent),
            });
            break;
          }
          console.info("[agent] inspecting context for grid ...", {
            grid_id: activeGridWork.grid.grid_id,
          });
          activeGridWork.context = await input.toolset.inspectGridContext(
            activeGridWork.grid,
            state.parsedContent,
          );
          if (!activeGridWork.explicitInsight && !hasNarrativeContext(activeGridWork.context)) {
            activeGridWork.explicitInsight = {
              found_explicit_insight: false,
              supporting_snippets: [],
              confidence: 0,
              reasoning: "Skipped explicit insight extraction: no nearby narrative context available.",
            };
            console.info("[agent] skipped explicit insight extraction due to missing narrative context", {
              document_id: state.document.document_id,
              grid_id: activeGridWork.grid.grid_id,
            });
          }
          break;
        }

        case "extract_explicit_insight": {
          if (!activeGridWork?.context) {
            logDebug("[agent][debug] action no-op: extract_explicit_insight missing context", {
              document_id: state.document.document_id,
              step: state.steps,
              active_grid_id: state.activeGridId,
            });
            break;
          }
          const explicitInsight = await input.toolset.extractExplicitInsight(
            activeGridWork.grid,
            activeGridWork.context,
          );
          activeGridWork.explicitInsight = explicitInsight;

          if (explicitInsight.found_explicit_insight && explicitInsight.insight_text) {
            activeGridWork.candidateInsightText = explicitInsight.insight_text;
            activeGridWork.insightSourceMode = "explicit_nearby_text";
            console.info("[agent] explicit insight found", {
              grid_id: activeGridWork.grid.grid_id,
            });
          } else {
            console.info("[agent] explicit insight not found; synthesis required", {
              grid_id: activeGridWork.grid.grid_id,
            });
          }
          break;
        }

        case "synthesize_insight": {
          if (!activeGridWork?.context) {
            logDebug("[agent][debug] action no-op: synthesize_insight missing context", {
              document_id: state.document.document_id,
              step: state.steps,
              active_grid_id: state.activeGridId,
            });
            break;
          }
          const synthesized = await input.toolset.synthesizeInsightFromGrid(
            activeGridWork.grid,
            activeGridWork.context,
          );
          activeGridWork.synthesizedInsight = synthesized;

          if (!activeGridWork.explicitInsight?.found_explicit_insight) {
            activeGridWork.candidateInsightText = synthesized.insight_text;
            activeGridWork.candidateQuestionAnswered = synthesized.question_answered;
            activeGridWork.insightSourceMode = "synthesized_from_grid";
            console.info("[agent] synthesized insight", {
              grid_id: activeGridWork.grid.grid_id,
            });
          }
          break;
        }

        case "normalize_grid": {
          if (!activeGridWork?.insightId) {
            logDebug("[agent][debug] action no-op: normalize_grid missing activeGridWork/insightId", {
              document_id: state.document.document_id,
              step: state.steps,
              active_grid_id: state.activeGridId,
            });
            break;
          }
          activeGridWork.normalizedGridDraft = await input.toolset.normalizeGrid(
            activeGridWork.grid,
            activeGridWork.insightId,
          );
          console.info("[agent] normalized grid draft", {
            grid_id: activeGridWork.grid.grid_id,
            row_count: activeGridWork.normalizedGridDraft.row_count,
          });
          if (activeGridWork.normalizedGridDraft.row_count <= 0) {
            activeGridWork.validationErrors = ["Normalized grid produced zero rows."];
            activeGridWork.validationWarnings = [];
            console.warn("[agent] normalized grid has zero rows; skipping downstream stages", {
              document_id: state.document.document_id,
              grid_id: activeGridWork.grid.grid_id,
              table_id: activeGridWork.grid.table.table_id,
              headers: activeGridWork.grid.table.headers,
              column_roles: activeGridWork.grid.table_semantic_object?.column_roles,
              metric_columns: activeGridWork.normalizedGridDraft.metric_columns,
              dimensions: activeGridWork.normalizedGridDraft.dimensions,
              first_row_shape: activeGridWork.grid.table.rows[0]?.cells.map((cell) => compact(cell).length),
            });
          }
          break;
        }

        case "normalize_dimension_metadata": {
          if (!activeGridWork?.normalizedGridDraft) {
            logDebug("[agent][debug] action no-op: normalize_dimension_metadata missing normalizedGridDraft", {
              document_id: state.document.document_id,
              step: state.steps,
              active_grid_id: state.activeGridId,
            });
            break;
          }
          activeGridWork.normalizedGrid = await input.toolset.normalizeDimensionMetadata(
            activeGridWork.normalizedGridDraft,
          );
          console.info("[agent] normalized dimensions", {
            grid_id: activeGridWork.grid.grid_id,
            dimensions: activeGridWork.normalizedGrid.dimensionMetadata.length,
            rows: activeGridWork.normalizedGrid.insightFamilyData.row_count,
          });
          break;
        }

        case "build_insight_metadata": {
          if (!activeGridWork?.normalizedGrid || !activeGridWork.context) {
            logDebug("[agent][debug] action no-op: build_insight_metadata missing normalizedGrid/context", {
              document_id: state.document.document_id,
              step: state.steps,
              active_grid_id: state.activeGridId,
              has_normalized_grid: Boolean(activeGridWork?.normalizedGrid),
              has_context: Boolean(activeGridWork?.context),
            });
            break;
          }
          const insightText = activeGridWork.candidateInsightText
            ?? activeGridWork.synthesizedInsight?.insight_text
            ?? activeGridWork.explicitInsight?.insight_text
            ?? "";

          const sourceMode = activeGridWork.insightSourceMode
            ?? (activeGridWork.explicitInsight?.found_explicit_insight
              ? "explicit_nearby_text"
              : "synthesized_from_grid");

          activeGridWork.metadata = await input.toolset.buildInsightMetadata({
            insightText,
            context: activeGridWork.context,
            grid: activeGridWork.normalizedGrid,
            sourceMode,
          });
          break;
        }

        case "build_insight_tags": {
          if (!activeGridWork?.normalizedGrid || !activeGridWork.context || !activeGridWork.metadata) {
            logDebug("[agent][debug] action no-op: build_insight_tags missing normalizedGrid/context/metadata", {
              document_id: state.document.document_id,
              step: state.steps,
              active_grid_id: state.activeGridId,
              has_normalized_grid: Boolean(activeGridWork?.normalizedGrid),
              has_context: Boolean(activeGridWork?.context),
              has_metadata: Boolean(activeGridWork?.metadata),
            });
            break;
          }

          const sourceMode = activeGridWork.insightSourceMode
            ?? (activeGridWork.explicitInsight?.found_explicit_insight
              ? "explicit_nearby_text"
              : "synthesized_from_grid");

          const insightText = compact(
            activeGridWork.candidateInsightText
            ?? activeGridWork.synthesizedInsight?.insight_text
            ?? activeGridWork.explicitInsight?.insight_text
            ?? "",
          );

          activeGridWork.tags = await input.toolset.buildInsightTags({
            insightText,
            context: activeGridWork.context,
            grid: activeGridWork.normalizedGrid,
            sourceMode,
            metadata: activeGridWork.metadata,
          });
          break;
        }

        case "validate_insight": {
          if (!activeGridWork?.normalizedGrid || !activeGridWork.context) {
            logDebug("[agent][debug] action no-op: validate_insight missing normalizedGrid/context", {
              document_id: state.document.document_id,
              step: state.steps,
              active_grid_id: state.activeGridId,
            });
            break;
          }

          const sourceMode = activeGridWork.insightSourceMode
            ?? (activeGridWork.explicitInsight?.found_explicit_insight
              ? "explicit_nearby_text"
              : "synthesized_from_grid");

          const insightText = cleanHumanInsightText(
            activeGridWork.candidateInsightText
            ?? activeGridWork.explicitInsight?.insight_text
            ?? activeGridWork.synthesizedInsight?.insight_text
            ?? "",
          );

          if (!insightText) {
            activeGridWork.validationErrors = ["Insight text is empty after extraction/synthesis."];
            console.warn("[agent] insight validation blocked: empty insight text", {
              document_id: state.document.document_id,
              grid_id: activeGridWork.grid.grid_id,
              step: state.steps,
              explicit_insight_found: activeGridWork.explicitInsight?.found_explicit_insight ?? false,
              has_synthesized_insight: Boolean(activeGridWork.synthesizedInsight),
            });
            break;
          }

          const questionAnswered = compact(
            activeGridWork.candidateQuestionAnswered
            ?? activeGridWork.synthesizedInsight?.question_answered
            ?? fallbackQuestionForInsightFamilyData(activeGridWork.normalizedGrid.insightFamilyData),
          );
          const insightFamilyData = {
            ...activeGridWork.normalizedGrid.insightFamilyData,
            question_answered: questionAnswered,
          };

          const now = new Date().toISOString();
          const evidenceSnippet = compact(
            activeGridWork.context.captions[0]
            ?? activeGridWork.context.nearby_paragraphs[0]
            ?? insightText,
          );
          const tableSupportingChunks = selectEvidenceRowsForInsight(activeGridWork)
            .flatMap((row) => row.supporting_refs ?? [])
            .filter((ref) => ref.chunk_id || ref.table_id)
            .map((ref) => ({
              chunk_id: ref.chunk_id ?? activeGridWork.grid.table.table_region ?? activeGridWork.grid.table.table_id,
              table_id: ref.table_id ?? activeGridWork.grid.table.table_id,
              evidence_cells: ref.evidence_cells,
              row_indices: ref.row_indices ?? (typeof ref.row_index === "number" ? [ref.row_index] : undefined),
            }))
            .filter((ref, index, all) =>
              all.findIndex((candidate) =>
                candidate.chunk_id === ref.chunk_id
                && candidate.table_id === ref.table_id
                && JSON.stringify(candidate.row_indices ?? []) === JSON.stringify(ref.row_indices ?? [])
              ) === index
            );

          const insight: GenerateInsightsV3Insight = {
            insight_id: activeGridWork.insightId ?? buildProjectScopedV3InsightId({
              projectId: input.runtime.projectId,
              documentId: state.document.document_id,
              gridId: activeGridWork.grid.grid_id,
              tableId: activeGridWork.grid.table.table_id,
              sourceUri: activeGridWork.grid.source_uri,
            }),
            object_type: "insight_family",
            text: insightText,
            family_text: insightText,
            ...(questionAnswered ? { question_answered: questionAnswered } : {}),
            metadata: activeGridWork.metadata ?? [],
            tags: activeGridWork.tags ?? [],
            dimension_metadata: activeGridWork.normalizedGrid.dimensionMetadata,
            insightfamilydata: insightFamilyData,
            insight_source_mode: sourceMode,
            has_grid: true,
            insight_family_data_id: insightFamilyData.table_id,
            row_count: insightFamilyData.row_count,
            table_dimensions: insightFamilyData.dimensions,
            metric_columns: insightFamilyData.metric_columns,
            evidence_snippet: truncate(evidenceSnippet, 300),
            supporting_chunks: tableSupportingChunks,
            s3_node: "generate-insights-v3:pending",
            document_id: state.document.document_id,
            document_ids: [state.document.document_id],
            source_types: [detectBroadFileType(state.document.source_uri)],
            ...(input.runtime.projectId ? { project_id: input.runtime.projectId } : {}),
            ...(input.runtime.userId ? { user_id: input.runtime.userId } : {}),
            ...(input.runtime.userInfo ? { user_info: input.runtime.userInfo } : {}),
            ...(input.runtime.organizationId ? { organization_id: input.runtime.organizationId } : {}),
            status: input.runtime.status ?? "Pending",
            created_at: now,
            updated_at: now,
            createdAt: now,
            updatedAt: now,
          };

          const validation = await input.toolset.validateInsight(insight);
          activeGridWork.validationErrors = validation.errors;
          activeGridWork.validationWarnings = validation.warnings;
          if (validation.valid && validation.insight) {
            activeGridWork.validatedInsight = validation.insight;
            console.info("[agent] insight validated", {
              document_id: state.document.document_id,
              grid_id: activeGridWork.grid.grid_id,
              insight_id: validation.insight.insight_id,
              warnings: validation.warnings.length,
            });
          } else {
            console.warn("[agent] insight failed validation", {
              document_id: state.document.document_id,
              grid_id: activeGridWork.grid.grid_id,
              errors: validation.errors,
              warnings: validation.warnings,
            });
          }

          break;
        }

        case "complete_grid": {
          if (!activeGridWork || !state.activeGridId) {
            logDebug("[agent][debug] action no-op: complete_grid missing activeGridWork/activeGridId", {
              document_id: state.document.document_id,
              step: state.steps,
            });
            break;
          }

          if (activeGridWork.validatedInsight) {
            const exists = state.insights.some(
              (insight) => insight.insight_id === activeGridWork.validatedInsight?.insight_id,
            );
            if (!exists) {
              state.insights.push(activeGridWork.validatedInsight);
              console.info("[agent] built insight", {
                grid_id: activeGridWork.grid.grid_id,
                insight_id: activeGridWork.validatedInsight.insight_id,
                insight_source_mode: activeGridWork.validatedInsight.insight_source_mode,
              });
            }
          } else {
            errors.push({
              stage: "agent:grid-dropped",
              message: completeGridFailureMessage(activeGridWork),
              document_id: state.document.document_id,
            });
            console.warn("[agent] completing grid without validated insight", {
              document_id: state.document.document_id,
              grid_id: activeGridWork.grid.grid_id,
              validation_errors: activeGridWork.validationErrors ?? [],
              validation_warnings: activeGridWork.validationWarnings ?? [],
            });
          }

          state.pendingGridIds = state.pendingGridIds.filter((gridId) => gridId !== state.activeGridId);
          state.processedGridIds.push(state.activeGridId);
          state.activeGridId = undefined;
          break;
        }

        case "finish_document": {
          state.pendingGridIds = [];
          state.activeGridId = undefined;
          break;
        }

        default:
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      errors.push({
        stage: `agent:${action.action}`,
        message,
        document_id: state.document.document_id,
        cause: error,
      });
      console.warn("[agent] action failed", {
        action: action.action,
        document_id: state.document.document_id,
        message,
      });

      if (state.activeGridId) {
        state.pendingGridIds = state.pendingGridIds.filter((gridId) => gridId !== state.activeGridId);
        state.processedGridIds.push(state.activeGridId);
        state.activeGridId = undefined;
      }
    }

    if (action.action === "finish_document") {
      break;
    }
  }

  if (state.steps >= input.maxSteps) {
    errors.push({
      stage: "agent:max-steps",
      message: `Agent loop reached max steps (${input.maxSteps}) for document ${state.document.document_id}.`,
      document_id: state.document.document_id,
    });
    console.warn("[agent] max steps reached before completion", {
      document_id: state.document.document_id,
      max_steps: input.maxSteps,
      insights: state.insights.length,
      pending_grids: state.pendingGridIds.length,
      processed_grids: state.processedGridIds.length,
      active_grid_id: state.activeGridId,
      last_trace: state.trace.slice(-8),
    });
  }

  console.info("[agent] completed file", {
    document_id: state.document.document_id,
    insights: state.insights.length,
    candidate_grids: state.candidateGrids.length,
    processed_grids: state.processedGridIds.length,
    pending_grids: state.pendingGridIds.length,
    active_grid_id: state.activeGridId,
    errors: errors.length,
  });

  return {
    insights: state.insights,
    errors,
  };
}

async function persistGenerateInsightsV3Output(input: {
  insights: GenerateInsightsV3Insight[];
  documents: V3DocumentBundle["descriptor"][];
  userId?: string;
  projectId?: string;
  organizationId?: string;
  status?: string;
}): Promise<void> {
  if (input.insights.length === 0) {
    console.warn("[generate-insights-v3] persistence skipped: no insights generated", {
      documents: input.documents.length,
      document_ids: input.documents.map((document) => document.document_id),
      has_user_id: Boolean(input.userId),
      has_project_id: Boolean(input.projectId),
    });
    return;
  }

  const documentIds = input.documents.map((document) => document.document_id);
  const sourceTypes = Array.from(
    new Set(input.documents.map((document) => detectBroadFileType(document.source_uri))),
  );
  const primaryDocumentId = input.documents[0]?.document_id ?? "generate-insights-v3";
  const scopeS3Node = ensureScopeS3Node({
    projectId: input.projectId,
    userId: input.userId,
    documentIds,
  });

  const insightFamilyDataScopeS3Node = buildInsightFamilyDataPersistenceScope(scopeS3Node);
  const dimensionMetadataScopeS3Node = buildDimensionMetadataPersistenceScope(scopeS3Node);

  const insightsForPersistence = input.insights.map((insight) => {
    const matchedDocument = input.documents.find((doc) => doc.document_id === insight.document_id);
    const matchedType = matchedDocument
      ? detectBroadFileType(matchedDocument.source_uri)
      : "unknown";

    return {
      ...insight,
      s3_node: scopeS3Node,
      document_ids: insight.document_ids ?? [insight.document_id],
      source_types: insight.source_types ?? [matchedType],
      ...(input.userId ? { user_id: input.userId } : {}),
      ...(input.projectId ? { project_id: input.projectId } : {}),
      ...(input.organizationId ? { organization_id: input.organizationId } : {}),
      status: input.status ?? insight.status ?? "Pending",
      updated_at: new Date().toISOString(),
    };
  });

  await persistInsights(insightsForPersistence);

  for (const insight of insightsForPersistence) {
    try {
      await upsertInsightDocument(toOpenSearchInsightDocument(insight));
    } catch (error) {
      console.warn("[generate-insights-v3] failed indexing insight", {
        insight_id: insight.insight_id,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  await syncInsightFamilyData({
    insightFamilyData: insightsForPersistence.map((insight) => insight.insightfamilydata),
    userId: input.userId,
    projectId: input.projectId,
    organizationId: input.organizationId,
    status: input.status,
    documentIds,
    sourceTypes,
    scopeS3Node: insightFamilyDataScopeS3Node,
    primaryDocumentId,
  });

  await syncDimensionMetadata({
    dimensionMetadata: dedupeDimensionMetadataFromInsights(insightsForPersistence),
    userId: input.userId,
    projectId: input.projectId,
    organizationId: input.organizationId,
    documentIds,
    sourceTypes,
    scopeS3Node: dimensionMetadataScopeS3Node,
    primaryDocumentId,
  });

  if (input.userId && input.projectId) {
    const pendingInsights = await listInsights({
      status: "Pending",
      project_id: input.projectId,
    });

    const pendingInsightIds = Array.from(
      new Set(
        pendingInsights
          .map((insight) => insight.insight_id?.trim())
          .filter((insightId): insightId is string => Boolean(insightId)),
      ),
    );

    await updatePendingProjectInsightIds({
      userId: input.userId,
      projectId: input.projectId,
      insightIds: pendingInsightIds,
    });

    const dimensionIds = Array.from(
      new Set(
        insightsForPersistence
          .flatMap((insight) => insight.dimension_metadata)
          .map((dimension) => dimension.dimension_id?.trim())
          .filter((dimensionId): dimensionId is string => Boolean(dimensionId)),
      ),
    );

    await updatePendingProjectMetadataDimensionIds({
      userId: input.userId,
      projectId: input.projectId,
      dimensionIds,
    });
  }
}

async function parseInputToBundles(input: GenerateInsightsV3Input): Promise<{
  bundles: V3DocumentBundle[];
  projectId?: string;
  errors: PipelineError[];
}> {
  const baseState = emptyGenerateInsightsV2State({
    sourceUris: input.sourceUris,
    outputUrls: input.outputUrls,
    contextUrls: input.contextUrls,
    rawDataUrls: input.rawDataUrls,
    researchContext: input.researchContext,
    uploadMode: input.uploadMode,
    userInfo: input.userInfo,
    userId: input.userId,
    projectId: input.projectId,
    organizationId: input.organizationId,
    status: input.status,
  });

  const intakeUpdate = await documentIntakeNode(baseState);
  const intakeState = {
    ...baseState,
    ...intakeUpdate,
    documents: intakeUpdate.documents ?? baseState.documents,
    projectId: intakeUpdate.projectId ?? baseState.projectId,
  };

  const extractionUpdate = await contentExtractionNode(intakeState);
  const extractionState = {
    ...intakeState,
    ...extractionUpdate,
    extractedDocuments: extractionUpdate.extractedDocuments ?? intakeState.extractedDocuments,
    errors: extractionUpdate.errors ?? intakeState.errors,
    documents: extractionUpdate.documents ?? intakeState.documents,
  };

  const normalizationUpdate = await normalizeContentNode(extractionState);
  const normalizedState = {
    ...extractionState,
    ...normalizationUpdate,
    normalizedDocuments: normalizationUpdate.normalizedDocuments ?? extractionState.normalizedDocuments,
    chunks: normalizationUpdate.chunks ?? extractionState.chunks,
    tables: normalizationUpdate.tables ?? extractionState.tables,
  };

  return {
    bundles: buildDocumentBundles({
      documents: normalizedState.documents,
      extractedDocuments: normalizedState.extractedDocuments,
      chunks: normalizedState.chunks,
      tables: normalizedState.tables,
    }),
    projectId: normalizedState.projectId,
    errors: normalizedState.errors,
  };
}

export async function runGenerateInsightsV3Pipeline(
  input: GenerateInsightsV3Input,
  dependencies?: GenerateInsightsV3AgentDependencies,
): Promise<GenerateInsightsV3RunResult> {
  assertConfig();

  const toolset = mergeToolsetOverrides(dependencies);
  const parseResult = await parseInputToBundles(input);
  const projectId = parseResult.projectId ?? input.projectId;
  const errors: PipelineError[] = [...parseResult.errors];

  const allInsights: GenerateInsightsV3Insight[] = [];

  for (const bundle of parseResult.bundles) {
    const result = await runDocumentAgentOnBundle({
      bundle,
      runtime: {
        userId: input.userId,
        userInfo: input.userInfo,
        projectId,
        organizationId: input.organizationId,
        status: input.status,
      },
      toolset,
      maxSteps: 64,
    });

    allInsights.push(...result.insights);
    errors.push(...result.errors);
  }

  const dimensionMetadata = dedupeDimensionMetadataFromInsights(allInsights);
  const insightFamilyData = allInsights.map((insight) => insight.insightfamilydata);

  await persistGenerateInsightsV3Output({
    insights: allInsights,
    documents: parseResult.bundles.map((bundle) => bundle.descriptor),
    userId: input.userId,
    projectId,
    organizationId: input.organizationId,
    status: input.status,
  });

  console.info("[generate-insights-v3] pipeline result summary", {
    documents: parseResult.bundles.length,
    insights: allInsights.length,
    insightFamilyData: insightFamilyData.length,
    dimensionMetadata: dimensionMetadata.length,
    errors: errors.length,
    project_id: projectId,
  });

  return {
    documents: parseResult.bundles.map((bundle) => ({
      document_id: bundle.descriptor.document_id,
      source_uri: bundle.descriptor.source_uri,
      file_type: detectBroadFileType(bundle.descriptor.source_uri),
    })),
    insights: allInsights,
    insight_family_data: insightFamilyData,
    dimension_metadata: dimensionMetadata,
    errors,
    project_id: projectId,
  };
}
