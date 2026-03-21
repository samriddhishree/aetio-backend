import {
  applyHierarchyBoost,
  dedupeInsights,
  matchesScalarFilters,
  metadataSatisfiesFilters,
  normalizeText,
  paginate,
  rankInsights,
  scoreKeywordMatch,
  scoreMetadataMatch,
  supportingEvidenceBoost,
  tokenize,
  type ContextLink,
} from "./helpers";
import { InsightSearchRepository } from "./repository";
import type {
  Insight,
  MatchType,
  RankedInsight,
  SearchFilters,
  SearchQuery,
  SearchResult,
} from "../types";

export type InsightSearchServiceOptions = {
  stageACandidateLimit?: number;
  expansionSeedLimit?: number;
  maxChildrenPerParent?: number;
  primaryThreshold?: number;
};

const DEFAULT_OPTIONS: Required<InsightSearchServiceOptions> = {
  stageACandidateLimit: 400,
  expansionSeedLimit: 20,
  maxChildrenPerParent: 30,
  primaryThreshold: 5,
};

/**
 * Iterative cheap-first retrieval strategy:
 * A) Narrow candidate set using indexed DynamoDB queries.
 * B) Score direct matches on text + metadata.
 * C) Expand around strong matches through parent/child traversal.
 * D) Rescore with hierarchy proximity boosts.
 * E) Return ranked primary + contextual insights.
 */
export class InsightSearchService {
  private readonly repository: InsightSearchRepository;
  private readonly options: Required<InsightSearchServiceOptions>;

  constructor(
    repository: InsightSearchRepository,
    options: InsightSearchServiceOptions = {},
  ) {
    this.repository = repository;
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
  }

  async searchInsights(input: SearchQuery): Promise<SearchResult> {
    const normalizedQuery = normalizeText(input.query ?? "");
    const queryTokens = tokenize(input.query ?? "");
    const filters = input.filters ?? {};

    // Step A: Candidate narrowing with indexed filters, falling back to a bounded scan when required.
    const stageACandidates = await this.fetchStageACandidates(filters);
    const filteredCandidates = stageACandidates.filter((insight) =>
      this.passesFilters(insight, filters),
    );

    // Step B: Direct lexical + metadata scoring.
    const directScores = new Map<
      string,
      { score: number; reasons: string[] }
    >();

    for (const insight of filteredCandidates) {
      const scored = this.scoreDirectMatch({
        insight,
        normalizedQuery,
        queryTokens,
        filters,
      });
      directScores.set(insight.insight_id, scored);
    }

    const strongPrimary = Array.from(directScores.entries())
      .filter(([, scored]) => scored.score >= this.options.primaryThreshold)
      .sort((left, right) => right[1].score - left[1].score)
      .slice(0, this.options.expansionSeedLimit)
      .map(([insightId]) => insightId);

    const seedInsightIds =
      strongPrimary.length > 0
        ? strongPrimary
        : Array.from(directScores.entries())
            .sort((left, right) => right[1].score - left[1].score)
            .slice(0, Math.min(5, this.options.expansionSeedLimit))
            .map(([insightId]) => insightId);

    // Step C: Expand around strong/seed matches in the hierarchy.
    const seedInsights = filteredCandidates.filter((insight) =>
      seedInsightIds.includes(insight.insight_id),
    );

    const { expandedInsights, contextByInsightId } = await this.expandHierarchyContext(
      seedInsights,
      input,
    );

    // Step D: Re-score with hierarchy context.
    const combinedInsights = dedupeInsights([...filteredCandidates, ...expandedInsights]).filter(
      (insight) => this.passesFilters(insight, filters) || contextByInsightId.has(insight.insight_id),
    );

    const ranked: RankedInsight[] = combinedInsights.map((insight) => {
      const existingDirect = directScores.get(insight.insight_id);
      const direct =
        existingDirect ??
        this.scoreDirectMatch({
          insight,
          normalizedQuery,
          queryTokens,
          filters,
        });

      const hierarchyLinks = contextByInsightId.get(insight.insight_id);
      const hierarchy = applyHierarchyBoost(hierarchyLinks);
      const score = direct.score + hierarchy.score;

      const reasons = [...direct.reasons];
      if (hierarchy.score > 0) {
        reasons.push(
          `Hierarchy proximity boost ${hierarchy.score.toFixed(2)} from ${hierarchy.primaryIds.size} primary matches`,
        );
      }

      const matchType = this.resolveMatchType(direct.score, hierarchy.score);

      return {
        insight,
        score,
        matchType,
        reasons,
        directScore: direct.score,
        hierarchyBoost: hierarchy.score,
        distanceFromPrimary: hierarchy.distance,
        relatedPrimaryIds: hierarchy.primaryIds,
      };
    });

    // Step E: Rank + paginate final primary/context results.
    const rankedFiltered = rankInsights(
      ranked.filter((entry) =>
        entry.score > 0 && (entry.matchType === "primary" || entry.hierarchyBoost > 0),
      ),
    );

    const paged = paginate(
      rankedFiltered,
      input.pagination?.limit ?? 25,
      input.pagination?.cursor,
    );

    return {
      query: input.query,
      total: rankedFiltered.length,
      count: paged.items.length,
      next_cursor: paged.nextCursor,
      candidates_considered: filteredCandidates.length,
      items: paged.items.map((item) => ({
        insight: item.insight,
        score: Number(item.score.toFixed(3)),
        match_type: item.matchType,
        reasons: item.reasons,
        distance_from_primary: item.distanceFromPrimary,
        related_primary_ids: Array.from(item.relatedPrimaryIds).sort(),
      })),
    };
  }

  private async fetchStageACandidates(filters: SearchFilters): Promise<Insight[]> {
    const maxItems = this.options.stageACandidateLimit;
    const tasks: Array<Promise<Insight[]>> = [];

    if (filters.parent_insight_id) {
      tasks.push(this.repository.queryByParentInsightId(filters.parent_insight_id, maxItems));
      tasks.push(
        this.repository
          .getInsightById(filters.parent_insight_id)
          .then((item) => (item ? [item] : [])),
      );
    }

    if (filters.document_id) {
      tasks.push(this.repository.queryByDocumentId(filters.document_id, maxItems));
    }

    if (filters.user_id && filters.status) {
      tasks.push(this.repository.queryByUserAndStatus(filters.user_id, filters.status, maxItems));
    }

    if (filters.user_id) {
      tasks.push(this.repository.queryByUserId(filters.user_id, maxItems));
    }

    if (filters.status) {
      tasks.push(this.repository.queryByStatus(filters.status, maxItems));
    }

    const resultSets = await Promise.all(tasks);
    const nonEmpty = resultSets.filter((items) => items.length > 0);

    if (nonEmpty.length === 0) {
      return this.repository.scanFallback(filters, maxItems);
    }

    if (nonEmpty.length === 1) {
      return dedupeInsights(nonEmpty[0]).slice(0, maxItems);
    }

    const intersected = this.intersectByInsightId(nonEmpty);
    if (intersected.length > 0) {
      return intersected.slice(0, maxItems);
    }

    return dedupeInsights(nonEmpty.flat()).slice(0, maxItems);
  }

  private passesFilters(insight: Insight, filters: SearchFilters): boolean {
    return (
      matchesScalarFilters(insight, {
        user_id: filters.user_id,
        document_id: filters.document_id,
        status: filters.status,
        parent_insight_id: filters.parent_insight_id,
      }) && metadataSatisfiesFilters(insight.metadata, filters.metadata)
    );
  }

  private scoreDirectMatch(input: {
    insight: Insight;
    normalizedQuery: string;
    queryTokens: string[];
    filters: SearchFilters;
  }): { score: number; reasons: string[] } {
    const { insight, normalizedQuery, queryTokens, filters } = input;
    const keyword = scoreKeywordMatch(insight.text, normalizedQuery, queryTokens);
    const metadata = scoreMetadataMatch(insight.metadata, filters.metadata, queryTokens);
    const supportBoost = supportingEvidenceBoost(insight);
    const filterOnlyMode = queryTokens.length === 0 && !(filters.metadata?.length);

    let score = keyword.score + metadata.score + supportBoost;
    const reasons: string[] = [];

    if (keyword.exactPhrase) {
      reasons.push("Exact phrase match in insight text");
    }

    if (keyword.matchedTokens.length > 0) {
      reasons.push(`Matched text tokens: ${keyword.matchedTokens.join(", ")}`);
    }

    if (metadata.matches.length > 0) {
      reasons.push(`Matched metadata: ${metadata.matches.join(", ")}`);
    }

    if (supportBoost > 0) {
      reasons.push(`Supporting evidence boost (${supportBoost.toFixed(2)})`);
    }

    if (filterOnlyMode) {
      score += 0.5;
      reasons.push("Structured filter match");
    }

    return {
      score,
      reasons,
    };
  }

  private async expandHierarchyContext(
    seedInsights: Insight[],
    input: SearchQuery,
  ): Promise<{ expandedInsights: Insight[]; contextByInsightId: Map<string, ContextLink[]> }> {
    const expanded: Insight[] = [];
    const contextByInsightId = new Map<string, ContextLink[]>();

    if (seedInsights.length === 0) {
      return { expandedInsights: expanded, contextByInsightId };
    }

    const includeAncestors = input.include_ancestors ?? true;
    const includeDescendants = input.include_descendants ?? true;
    const ancestorDepth = Math.max(1, input.ancestor_depth ?? 2);
    const descendantDepth = Math.max(1, input.descendant_depth ?? 1);

    if (includeAncestors) {
      let frontier = seedInsights
        .map((seed) => ({
          primaryId: seed.insight_id,
          currentId: seed.parent_insight_id,
          distance: 1,
        }))
        .filter((entry): entry is { primaryId: string; currentId: string; distance: number } =>
          Boolean(entry.currentId),
        );

      for (let depth = 1; depth <= ancestorDepth && frontier.length > 0; depth += 1) {
        const parentIds = Array.from(new Set(frontier.map((entry) => entry.currentId)));
        const parents = await this.repository.getInsightsByIds(parentIds);
        const byId = new Map(parents.map((parent) => [parent.insight_id, parent]));

        const nextFrontier: Array<{ primaryId: string; currentId: string; distance: number }> = [];

        for (const candidate of frontier) {
          const parent = byId.get(candidate.currentId);
          if (!parent) continue;

          expanded.push(parent);
          this.addContextLink(contextByInsightId, parent.insight_id, {
            distance: candidate.distance,
            relation: "ancestor",
            primaryId: candidate.primaryId,
          });

          if (parent.parent_insight_id) {
            nextFrontier.push({
              primaryId: candidate.primaryId,
              currentId: parent.parent_insight_id,
              distance: candidate.distance + 1,
            });
          }
        }

        frontier = this.uniqueAncestorFrontier(nextFrontier);
      }
    }

    if (includeDescendants) {
      let frontier = seedInsights.map((seed) => ({
        primaryId: seed.insight_id,
        parentId: seed.insight_id,
        distance: 1,
      }));

      for (let depth = 1; depth <= descendantDepth && frontier.length > 0; depth += 1) {
        const childQueries = await Promise.all(
          frontier.map((entry) =>
            this.repository
              .queryByParentInsightId(entry.parentId, this.options.maxChildrenPerParent)
              .then((children) => ({ entry, children })),
          ),
        );

        const nextFrontier: Array<{ primaryId: string; parentId: string; distance: number }> = [];

        for (const item of childQueries) {
          for (const child of item.children) {
            expanded.push(child);
            this.addContextLink(contextByInsightId, child.insight_id, {
              distance: item.entry.distance,
              relation: "descendant",
              primaryId: item.entry.primaryId,
            });

            nextFrontier.push({
              primaryId: item.entry.primaryId,
              parentId: child.insight_id,
              distance: item.entry.distance + 1,
            });
          }
        }

        frontier = this.uniqueDescendantFrontier(nextFrontier);
      }
    }

    return {
      expandedInsights: dedupeInsights(expanded),
      contextByInsightId,
    };
  }

  private intersectByInsightId(items: Insight[][]): Insight[] {
    if (items.length === 0) return [];

    const counters = new Map<string, { insight: Insight; hits: number }>();
    for (const bucket of items) {
      const seenInBucket = new Set<string>();
      for (const insight of bucket) {
        if (seenInBucket.has(insight.insight_id)) continue;
        seenInBucket.add(insight.insight_id);

        const existing = counters.get(insight.insight_id);
        if (!existing) {
          counters.set(insight.insight_id, {
            insight,
            hits: 1,
          });
          continue;
        }

        existing.hits += 1;
      }
    }

    return Array.from(counters.values())
      .filter((entry) => entry.hits === items.length)
      .map((entry) => entry.insight);
  }

  private addContextLink(
    contextByInsightId: Map<string, ContextLink[]>,
    insightId: string,
    link: ContextLink,
  ): void {
    const existing = contextByInsightId.get(insightId) ?? [];
    const duplicate = existing.some(
      (entry) =>
        entry.primaryId === link.primaryId &&
        entry.relation === link.relation &&
        entry.distance === link.distance,
    );

    if (!duplicate) {
      existing.push(link);
      contextByInsightId.set(insightId, existing);
    }
  }

  private uniqueAncestorFrontier(
    frontier: Array<{ primaryId: string; currentId: string; distance: number }>,
  ): Array<{ primaryId: string; currentId: string; distance: number }> {
    const map = new Map<string, { primaryId: string; currentId: string; distance: number }>();
    for (const entry of frontier) {
      const signature = `${entry.primaryId}|${entry.currentId}`;
      const existing = map.get(signature);
      if (!existing || entry.distance < existing.distance) {
        map.set(signature, entry);
      }
    }
    return Array.from(map.values());
  }

  private uniqueDescendantFrontier(
    frontier: Array<{ primaryId: string; parentId: string; distance: number }>,
  ): Array<{ primaryId: string; parentId: string; distance: number }> {
    const map = new Map<string, { primaryId: string; parentId: string; distance: number }>();
    for (const entry of frontier) {
      const signature = `${entry.primaryId}|${entry.parentId}`;
      const existing = map.get(signature);
      if (!existing || entry.distance < existing.distance) {
        map.set(signature, entry);
      }
    }
    return Array.from(map.values());
  }

  private resolveMatchType(directScore: number, hierarchyBoost: number): MatchType {
    if (directScore >= this.options.primaryThreshold) return "primary";
    if (hierarchyBoost > 0) return "context";
    return "primary";
  }
}
