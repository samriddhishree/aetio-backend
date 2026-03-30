import type { GraphState, Insight, PipelineError } from "../../types";

export type HierarchyRootStrategy = "null" | "projectId" | "documentId";

export type HierarchyFinalizeConfig = {
  // Backward-compatible flag from the old hierarchy stage behavior.
  attachRootsToProjectId?: boolean;
  projectId?: string | null;
  defaultRootStrategy?: HierarchyRootStrategy;
};

type RootContext = {
  strategy: HierarchyRootStrategy;
  projectId?: string;
};

export class HierarchyFinalizeAgent {
  constructor(private readonly config: HierarchyFinalizeConfig = {}) {}

  // Old HierarchyBuilderAgent mixed semantic grouping + LLM calls with finalization.
  // This agent intentionally removes all semantic/LLM behavior and only keeps
  // deterministic hierarchy integrity cleanup before persistence.
  async process(state: GraphState): Promise<Partial<GraphState>> {
    console.log("HierarchyFinalizeAgent:size", state.insights?.length ?? 0);
    console.debug("HierarchyFinalizeAgent:start", { insights: state.insights.length });

    const errors: PipelineError[] = [];
    const nowIso = new Date().toISOString();
    const rootContext = this.getRootContext(state);

    // Keep deterministic record stamping from the old stage; this is not semantic hierarchy work.
    const finalized = state.insights.map((insight) => ({
      ...insight,
      user_id: state.userId ?? insight.user_id,
      user_info: state.userInfo ?? insight.user_info,
      status: "Pending",
      project_id: rootContext.projectId,
      createdAt: insight.createdAt ?? nowIso,
      updatedAt: nowIso,
    }));

    this.normalizeParents(finalized, errors, rootContext);
    this.breakCycles(finalized, errors, rootContext);
    this.normalizeParents(finalized, errors, rootContext);
    this.normalizeRoots(finalized, rootContext);

    console.debug("HierarchyFinalizeAgent:end", {
      insights: finalized.length,
      errors: errors.length,
      rootStrategy: rootContext.strategy,
    });

    return {
      insights: finalized,
      errors: state.errors.concat(errors),
    };
  }

  private getRootContext(state: GraphState): RootContext {
    const configuredProjectId = this.config.projectId ?? undefined;
    const stateProjectId = state.projectId ?? undefined;
    const projectId = configuredProjectId ?? stateProjectId;

    if (this.config.defaultRootStrategy) {
      return { strategy: this.config.defaultRootStrategy, projectId };
    }
    if (this.config.attachRootsToProjectId === false) {
      return { strategy: "null", projectId };
    }
    return { strategy: "projectId", projectId };
  }

  private normalizeParents(
    insights: Insight[],
    errors: PipelineError[],
    rootContext: RootContext,
  ): void {
    const insightById = new Map(insights.map((insight) => [insight.insight_id, insight]));

    for (const insight of insights) {
      const originalParent = insight.parent_insight_id;
      const normalizedParent = this.normalizeParentId(insight, insightById, rootContext);
      if (originalParent !== normalizedParent) {
        errors.push({
          stage: "HierarchyFinalizeAgent",
          message: `Normalized invalid parent for ${insight.insight_id}.`,
          document_id: insight.document_id,
        });
      }
      insight.parent_insight_id = normalizedParent;
    }
  }

  private normalizeParentId(
    insight: Insight,
    insightById: Map<string, Insight>,
    rootContext: RootContext,
  ): string | undefined {
    const parentId = insight.parent_insight_id;
    if (!parentId) return undefined;
    if (parentId === insight.insight_id) return undefined;

    if (this.isSyntheticRoot(parentId, insight, rootContext)) {
      return parentId;
    }

    const parent = insightById.get(parentId);
    if (!parent) return undefined;
    if (parent.document_id !== insight.document_id) return undefined;
    return parent.insight_id;
  }

  private breakCycles(
    insights: Insight[],
    errors: PipelineError[],
    rootContext: RootContext,
  ): void {
    const insightById = new Map(insights.map((insight) => [insight.insight_id, insight]));
    const orderById = new Map(insights.map((insight, index) => [insight.insight_id, index]));

    while (true) {
      const cycle = this.findCycle(insights, insightById, rootContext);
      if (cycle.length === 0) break;

      const breakId = this.selectCycleBreakId(cycle, insightById, orderById);
      const target = insightById.get(breakId);
      if (!target?.parent_insight_id) break;

      target.parent_insight_id = undefined;
      errors.push({
        stage: "HierarchyFinalizeAgent",
        message: `Cycle detected and broken at ${breakId}.`,
        document_id: target.document_id,
      });
    }
  }

  private findCycle(
    insights: Insight[],
    insightById: Map<string, Insight>,
    rootContext: RootContext,
  ): string[] {
    for (const insight of insights) {
      const seenAt = new Map<string, number>();
      const path: string[] = [];
      let currentId: string | undefined = insight.insight_id;

      while (currentId) {
        const cycleStart = seenAt.get(currentId);
        if (cycleStart !== undefined) {
          return path.slice(cycleStart);
        }

        seenAt.set(currentId, path.length);
        path.push(currentId);

        const current = insightById.get(currentId);
        if (!current?.parent_insight_id) break;
        if (this.isSyntheticRoot(current.parent_insight_id, current, rootContext)) break;
        if (!insightById.has(current.parent_insight_id)) break;

        currentId = current.parent_insight_id;
      }
    }
    return [];
  }

  private selectCycleBreakId(
    cycleIds: string[],
    insightById: Map<string, Insight>,
    orderById: Map<string, number>,
  ): string {
    let selected = cycleIds[0];

    for (const candidate of cycleIds.slice(1)) {
      const selectedSupport = insightById.get(selected)?.supporting_chunks?.length ?? 0;
      const candidateSupport = insightById.get(candidate)?.supporting_chunks?.length ?? 0;
      if (candidateSupport < selectedSupport) {
        selected = candidate;
        continue;
      }
      if (candidateSupport > selectedSupport) continue;

      const selectedOrder = orderById.get(selected) ?? -1;
      const candidateOrder = orderById.get(candidate) ?? -1;
      if (candidateOrder > selectedOrder) {
        selected = candidate;
        continue;
      }
      if (candidateOrder < selectedOrder) continue;

      if (candidate > selected) {
        selected = candidate;
      }
    }

    return selected;
  }

  private normalizeRoots(insights: Insight[], rootContext: RootContext): void {
    for (const insight of insights) {
      if (insight.parent_insight_id) continue;
      insight.parent_insight_id = this.resolveRootParentId(insight, rootContext);
    }
  }

  private resolveRootParentId(insight: Insight, rootContext: RootContext): string | undefined {
    if (rootContext.strategy === "null") return undefined;

    if (rootContext.strategy === "projectId") {
      if (!rootContext.projectId) return undefined;
      if (rootContext.projectId === insight.insight_id) return undefined;
      return rootContext.projectId;
    }

    if (insight.document_id === insight.insight_id) return undefined;
    return insight.document_id;
  }

  private isSyntheticRoot(
    parentId: string,
    insight: Insight,
    rootContext: RootContext,
  ): boolean {
    if (rootContext.strategy === "projectId") {
      return Boolean(rootContext.projectId) && parentId === rootContext.projectId;
    }
    if (rootContext.strategy === "documentId") {
      return parentId === insight.document_id;
    }
    return false;
  }
}

export const hierarchyFinalizeAgent = new HierarchyFinalizeAgent();
