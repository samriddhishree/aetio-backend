import type { BatchInsightResult, GraphState, Insight } from "../../types";
import {
  collectInsightRefs,
  isNearDuplicateInsight,
  mergeInsightPair,
  normalizeInsightText,
  selectPreferredInsight,
} from "./insightMergeUtils";

type MergeItem = {
  insight: Insight;
  order: number;
  refs: ReturnType<typeof collectInsightRefs>;
  memberIds: Set<string>;
};

function toMergeItems(batchInsights: BatchInsightResult[], fallbackInsights: Insight[]): MergeItem[] {
  const items: MergeItem[] = [];
  let order = 0;

  if (batchInsights.length > 0) {
    for (const batch of batchInsights) {
      for (const insight of batch.insights) {
        const refs = collectInsightRefs(insight, batch.batch_id);
        items.push({
          insight,
          refs,
          order,
          memberIds: new Set(refs.mergedFromInsightIds),
        });
        order += 1;
      }
    }
    return items;
  }

  for (const insight of fallbackInsights) {
    const refs = collectInsightRefs(insight);
    items.push({
      insight,
      refs,
      order,
      memberIds: new Set(refs.mergedFromInsightIds),
    });
    order += 1;
  }
  return items;
}

function setRemap(map: Map<string, string>, ids: Set<string>, targetId: string) {
  for (const id of ids) {
    map.set(id, targetId);
  }
}

function mergeItems(left: MergeItem, right: MergeItem): MergeItem {
  const { preferred, secondary } = selectPreferredInsight(
    left.insight,
    right.insight,
    left.order,
    right.order,
  );

  const preferredItem = preferred === left.insight ? left : right;
  const secondaryItem = secondary === right.insight ? right : left;
  const { merged, refs } = mergeInsightPair(
    preferredItem.insight,
    secondaryItem.insight,
    preferredItem.refs,
    secondaryItem.refs,
  );

  return {
    insight: merged,
    refs,
    order: Math.min(left.order, right.order),
    memberIds: new Set([...left.memberIds, ...right.memberIds]),
  };
}

function exactDedupe(items: MergeItem[], remap: Map<string, string>): MergeItem[] {
  const grouped = new Map<string, MergeItem[]>();
  for (const item of items) {
    const normalized = normalizeInsightText(item.insight.text);
    const key = `${item.insight.document_id}:${normalized}`;
    const list = grouped.get(key) ?? [];
    list.push(item);
    grouped.set(key, list);
  }

  const deduped: MergeItem[] = [];
  for (const group of grouped.values()) {
    if (group.length === 1) {
      deduped.push(group[0]);
      continue;
    }

    let merged = group[0];
    for (let i = 1; i < group.length; i += 1) {
      merged = mergeItems(merged, group[i]);
    }
    setRemap(remap, merged.memberIds, merged.insight.insight_id);
    deduped.push(merged);
  }

  return deduped.sort((left, right) => left.order - right.order);
}

function nearDedupe(items: MergeItem[], remap: Map<string, string>): MergeItem[] {
  const byDocument = new Map<string, MergeItem[]>();
  for (const item of items) {
    const list = byDocument.get(item.insight.document_id) ?? [];
    list.push(item);
    byDocument.set(item.insight.document_id, list);
  }

  const mergedResults: MergeItem[] = [];
  for (const docItems of byDocument.values()) {
    const working = docItems.sort((left, right) => left.order - right.order);
    const consumed = new Array(working.length).fill(false);

    for (let i = 0; i < working.length; i += 1) {
      if (consumed[i]) continue;
      let current = working[i];

      for (let j = i + 1; j < working.length; j += 1) {
        if (consumed[j]) continue;
        if (!isNearDuplicateInsight(current.insight, working[j].insight)) continue;

        current = mergeItems(current, working[j]);
        consumed[j] = true;
      }

      setRemap(remap, current.memberIds, current.insight.insight_id);
      mergedResults.push(current);
    }
  }

  return mergedResults.sort((left, right) => left.order - right.order);
}

function resolveRemap(remap: Map<string, string>, id: string): string {
  let current = id;
  const seen = new Set<string>();
  while (remap.has(current) && !seen.has(current)) {
    seen.add(current);
    current = remap.get(current)!;
  }
  return current;
}

function regroupParents(insights: Insight[], remap: Map<string, string>): Insight[] {
  const knownIds = new Set(insights.map((insight) => insight.insight_id));
  return insights.map((insight) => {
    if (!insight.parent_insight_id) return insight;
    const resolvedParentId = resolveRemap(remap, insight.parent_insight_id);
    if (resolvedParentId === insight.insight_id) {
      return { ...insight, parent_insight_id: undefined };
    }
    if (!knownIds.has(resolvedParentId)) {
      return { ...insight, parent_insight_id: undefined };
    }
    return { ...insight, parent_insight_id: resolvedParentId };
  });
}

export class CrossBatchMergeAgent {
  // Added to merge/dedupe/regroup insights across finding batches before critique/revision.
  // V1 is deterministic and conservative to preserve provenance and evidence fidelity.
  async process(state: GraphState): Promise<Partial<GraphState>> {
    console.log("CrossBatchMergeAgent:size", state.insights?.length ?? 0);
    console.debug("CrossBatchMergeAgent:start", {
      batchInsights: state.batch_insights.length,
      fallbackInsights: state.insights.length,
    });

    const seedItems = toMergeItems(state.batch_insights, state.insights);
    if (seedItems.length === 0) {
      return { insights: [] };
    }

    const remap = new Map<string, string>();
    const exactMerged = exactDedupe(seedItems, remap);
    const nearMerged = nearDedupe(exactMerged, remap);
    const regrouped = regroupParents(
      nearMerged.map((item) => item.insight),
      remap,
    );

    console.debug("CrossBatchMergeAgent:end", {
      inputInsights: seedItems.length,
      outputInsights: regrouped.length,
    });

    return { insights: regrouped };
  }
}

export const crossBatchMergeAgent = new CrossBatchMergeAgent();
