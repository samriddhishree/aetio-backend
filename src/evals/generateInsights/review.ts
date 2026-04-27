import { hashId } from "../../common/services/utils";
import type { PersistedInsightFamilyData } from "../../common/services/insightFamilyDataTable";
import type { Insight } from "../../types";
import { computeInsightDelta } from "./delta";
import type {
  InsightEvalState,
  InsightReviewEvent,
  InsightReviewEventType,
  TerminalReviewAction,
} from "./types";

function compact(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeMetadata(metadata: Insight["metadata"]): NonNullable<Insight["metadata"]> {
  return (metadata ?? [])
    .map((entry) => ({
      tag: compact(entry.tag),
      value: compact(entry.value),
      ...(typeof entry.confidence === "number" ? { confidence: entry.confidence } : {}),
    }))
    .filter((entry) => entry.tag.length > 0 && entry.value.length > 0);
}

function metadataKey(entry: { tag: string; value: string }): string {
  return `${entry.tag.toLowerCase()}::${entry.value.toLowerCase()}`;
}

function toSnapshot(insight?: Insight, table?: PersistedInsightFamilyData): InsightEvalState | undefined {
  if (!insight && !table) return undefined;

  return {
    text: insight?.text,
    family_text: insight?.family_text,
    question_answered: insight?.question_answered,
    status: insight?.status,
    metadata: normalizeMetadata(insight?.metadata),
    dimensions: table?.dimensions ?? insight?.table_dimensions,
    rows: table?.rows,
  };
}

function hasTextChanged(before?: Insight, after?: Insight): boolean {
  const left = compact(before?.text ?? before?.family_text);
  const right = compact(after?.text ?? after?.family_text);
  return left !== right;
}

function metadataChanges(before?: Insight, after?: Insight): {
  added: number;
  removed: number;
  edited: number;
} {
  const left = normalizeMetadata(before?.metadata);
  const right = normalizeMetadata(after?.metadata);
  const leftMap = new Map(left.map((entry) => [metadataKey(entry), entry]));
  const rightMap = new Map(right.map((entry) => [metadataKey(entry), entry]));

  const added = Array.from(rightMap.keys()).filter((key) => !leftMap.has(key)).length;
  const removed = Array.from(leftMap.keys()).filter((key) => !rightMap.has(key)).length;
  const confidenceEdits = Array.from(rightMap.entries()).filter(([key, next]) => {
    const prev = leftMap.get(key);
    if (!prev) return false;
    if (typeof prev.confidence !== "number" && typeof next.confidence !== "number") return false;
    return prev.confidence !== next.confidence;
  }).length;

  const toTagValueMap = (entries: NonNullable<Insight["metadata"]>): Map<string, Set<string>> => {
    const byTag = new Map<string, Set<string>>();
    for (const entry of entries) {
      const tag = compact(entry.tag).toLowerCase();
      const value = compact(entry.value).toLowerCase();
      if (!tag || !value) continue;
      const values = byTag.get(tag) ?? new Set<string>();
      values.add(value);
      byTag.set(tag, values);
    }
    return byTag;
  };

  const setEquals = (leftSet: Set<string>, rightSet: Set<string>): boolean => {
    if (leftSet.size !== rightSet.size) return false;
    for (const item of leftSet) {
      if (!rightSet.has(item)) return false;
    }
    return true;
  };

  const leftByTag = toTagValueMap(left);
  const rightByTag = toTagValueMap(right);
  let tagValueMutationCount = 0;
  for (const [tag, leftValues] of leftByTag.entries()) {
    const rightValues = rightByTag.get(tag);
    if (!rightValues) continue;
    if (!setEquals(leftValues, rightValues)) {
      tagValueMutationCount += 1;
    }
  }

  return {
    added,
    removed,
    edited: confidenceEdits + tagValueMutationCount,
  };
}

function rowChangeCounts(
  before?: PersistedInsightFamilyData,
  after?: PersistedInsightFamilyData,
): { added: number; removed: number; edited: number } {
  const left = before?.rows ?? [];
  const right = after?.rows ?? [];
  const leftById = new Map(left.map((row) => [row.row_id, row]));
  const rightById = new Map(right.map((row) => [row.row_id, row]));

  let added = 0;
  let removed = 0;
  let edited = 0;

  for (const rowId of rightById.keys()) {
    if (!leftById.has(rowId)) added += 1;
  }

  for (const rowId of leftById.keys()) {
    if (!rightById.has(rowId)) removed += 1;
  }

  for (const [rowId, leftRow] of leftById.entries()) {
    const rightRow = rightById.get(rowId);
    if (!rightRow) continue;
    if (JSON.stringify(leftRow) !== JSON.stringify(rightRow)) edited += 1;
  }

  return { added, removed, edited };
}

function eventId(input: {
  eventType: InsightReviewEventType;
  projectId: string;
  insightId: string;
  at: string;
}): string {
  return hashId(`${input.projectId}:${input.insightId}:${input.eventType}:${input.at}:${Math.random()}`);
}

function buildEvent(input: {
  eventType: InsightReviewEventType;
  projectId: string;
  insight: Insight;
  at: string;
  userId?: string;
  runId?: string;
  tableId?: string;
  beforeState?: InsightEvalState;
  afterState?: InsightEvalState;
}): InsightReviewEvent {
  return {
    event_id: eventId({
      eventType: input.eventType,
      projectId: input.projectId,
      insightId: input.insight.insight_id,
      at: input.at,
    }),
    event_type: input.eventType,
    occurred_at: input.at,
    project_id: input.projectId,
    insight_id: input.insight.insight_id,
    document_id: input.insight.document_id,
    table_id: input.tableId ?? input.insight.insight_family_data_id,
    run_id: input.runId,
    user_id: input.userId,
    before_state: input.beforeState,
    after_state: input.afterState,
  };
}

export function buildInsightReviewEvents(input: {
  projectId: string;
  beforeInsight?: Insight;
  afterInsight: Insight;
  beforeTable?: PersistedInsightFamilyData;
  afterTable?: PersistedInsightFamilyData;
  userId?: string;
  runId?: string;
  terminalAction?: TerminalReviewAction;
}): InsightReviewEvent[] {
  const at = new Date().toISOString();
  const events: InsightReviewEvent[] = [];

  const beforeState = toSnapshot(input.beforeInsight, input.beforeTable);
  const afterState = toSnapshot(input.afterInsight, input.afterTable);

  if (hasTextChanged(input.beforeInsight, input.afterInsight)) {
    events.push(
      buildEvent({
        eventType: "text_edited",
        projectId: input.projectId,
        insight: input.afterInsight,
        at,
        userId: input.userId,
        runId: input.runId,
        beforeState,
        afterState,
      }),
    );
  }

  const metadata = metadataChanges(input.beforeInsight, input.afterInsight);
  if (metadata.added > 0) {
    events.push(
      buildEvent({
        eventType: "metadata_added",
        projectId: input.projectId,
        insight: input.afterInsight,
        at,
        userId: input.userId,
        runId: input.runId,
        beforeState,
        afterState,
      }),
    );
  }
  if (metadata.removed > 0) {
    events.push(
      buildEvent({
        eventType: "metadata_removed",
        projectId: input.projectId,
        insight: input.afterInsight,
        at,
        userId: input.userId,
        runId: input.runId,
        beforeState,
        afterState,
      }),
    );
  }
  if (metadata.edited > 0) {
    events.push(
      buildEvent({
        eventType: "metadata_edited",
        projectId: input.projectId,
        insight: input.afterInsight,
        at,
        userId: input.userId,
        runId: input.runId,
        beforeState,
        afterState,
      }),
    );
  }

  const rowChanges = rowChangeCounts(input.beforeTable, input.afterTable);
  if (rowChanges.added > 0) {
    events.push(
      buildEvent({
        eventType: "grid_row_added",
        projectId: input.projectId,
        insight: input.afterInsight,
        at,
        userId: input.userId,
        runId: input.runId,
        beforeState,
        afterState,
      }),
    );
  }
  if (rowChanges.removed > 0) {
    events.push(
      buildEvent({
        eventType: "grid_row_deleted",
        projectId: input.projectId,
        insight: input.afterInsight,
        at,
        userId: input.userId,
        runId: input.runId,
        beforeState,
        afterState,
      }),
    );
  }
  if (rowChanges.edited > 0) {
    events.push(
      buildEvent({
        eventType: "grid_row_edited",
        projectId: input.projectId,
        insight: input.afterInsight,
        at,
        userId: input.userId,
        runId: input.runId,
        beforeState,
        afterState,
      }),
    );
  }

  if (input.terminalAction) {
    const terminalEventType = input.terminalAction === "accepted"
      ? "accepted"
      : input.terminalAction === "declined"
        ? "declined"
        : "deleted";

    const delta = computeInsightDelta({
      action: input.terminalAction,
      beforeInsight: input.beforeInsight,
      afterInsight: input.afterInsight,
      beforeTable: input.beforeTable,
      afterTable: input.afterTable,
    });

    events.push({
      ...buildEvent({
        eventType: terminalEventType,
        projectId: input.projectId,
        insight: input.afterInsight,
        at,
        userId: input.userId,
        runId: input.runId,
        beforeState,
        afterState,
      }),
      delta: {
        ...delta,
        insight_id: input.afterInsight.insight_id,
      },
    });

    if (input.terminalAction === "accepted" && delta.outcome !== "accepted_unchanged") {
      events.push({
        ...buildEvent({
          eventType: "accepted_after_edit",
          projectId: input.projectId,
          insight: input.afterInsight,
          at,
          userId: input.userId,
          runId: input.runId,
          beforeState,
          afterState,
        }),
        delta: {
          ...delta,
          insight_id: input.afterInsight.insight_id,
        },
      });
    }
  }

  return events;
}

export function buildDeletedInsightEvent(input: {
  projectId: string;
  insight: Insight;
  table?: PersistedInsightFamilyData;
  userId?: string;
  runId?: string;
}): InsightReviewEvent {
  const at = new Date().toISOString();
  const state = toSnapshot(input.insight, input.table);

  const delta = computeInsightDelta({
    action: "deleted",
    beforeInsight: input.insight,
    afterInsight: input.insight,
    beforeTable: input.table,
    afterTable: input.table,
  });

  return {
    ...buildEvent({
      eventType: "deleted",
      projectId: input.projectId,
      insight: input.insight,
      at,
      userId: input.userId,
      runId: input.runId,
      beforeState: state,
      afterState: undefined,
    }),
    delta: {
      ...delta,
      insight_id: input.insight.insight_id,
    },
  };
}
