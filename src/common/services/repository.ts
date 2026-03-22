import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { getCachedAwsAssumeRoleProvider } from "./aws";
import { config } from "./config";
import { chunkArray } from "./utils";
import {
  matchesScalarFilters,
  metadataSatisfiesFilters,
  scoreKeywordMatch,
  tokenize,
  normalizeText,
} from "./helpers";
import type { Insight, MetadataFilter, SearchFilters, SearchIndexConfig } from "../../types";

const DEFAULT_INDEX_CONFIG: Partial<SearchIndexConfig> = {
  insightIdIndexName: "GSI_insight_id",
  userIdIndexName: "GSI_UserId",
  documentIdIndexName: "GSI_DocumentId",
  parentInsightIdIndexName: "GSI_ParentInsightId",
  statusIndexName: "GSI_Status",
  userStatusIndexName: "GSI_UserStatus",
};

const MAX_BATCH_GET = 100;

export const RECOMMENDED_TEMPORARY_SEARCH_INDEXES = [
  {
    name: "GSI_UserId",
    partitionKey: "user_id",
    sortKey: "insight_id",
    purpose: "Cheap candidate narrowing for user-scoped searches.",
  },
  {
    name: "GSI_DocumentId",
    partitionKey: "document_id",
    sortKey: "insight_id",
    purpose: "Fast lookup for document-local search and hierarchy traversal seeds.",
  },
  {
    name: "GSI_ParentInsightId",
    partitionKey: "parent_insight_id",
    sortKey: "insight_id",
    purpose: "Child expansion for tree traversal (parent -> children).",
  },
  {
    name: "GSI_Status",
    partitionKey: "status",
    sortKey: "insight_id",
    purpose: "Optional status-scoped candidate retrieval.",
  },
  {
    name: "GSI_UserStatus",
    partitionKey: "user_id",
    sortKey: "status",
    purpose: "Optional combined filter for user + status without set intersections.",
  },
] as const;

export type InsightSearchRepositoryOptions = {
  tableName?: string;
  indexConfig?: Partial<SearchIndexConfig>;
  documentClient?: DynamoDBDocumentClient;
  maxQueryPages?: number;
  queryPageSize?: number;
};

export type TextSearchInput = {
  query: string;
  filters?: SearchFilters;
  limit?: number;
  minScore?: number;
};

export type MetadataSearchInput = {
  metadata: MetadataFilter[];
  filters?: SearchFilters;
  limit?: number;
};

/**
 * DynamoDB-only repository used by the temporary cheap-first search layer.
 *
 * Assumptions:
 * - `insight_id` lookups are served via `GSI_insight_id` (or equivalent configured index).
 * - GSIs listed in RECOMMENDED_TEMPORARY_SEARCH_INDEXES exist.
 * - If an index is missing, the service can still run by using a bounded fallback scan.
 */
export class InsightSearchRepository {
  private readonly tableName: string;
  private readonly indexConfig: Partial<SearchIndexConfig>;
  private readonly docClient: DynamoDBDocumentClient;
  private readonly maxQueryPages: number;
  private readonly queryPageSize: number;

  constructor(options: InsightSearchRepositoryOptions = {}) {
    const ddbClient = new DynamoDBClient({
      credentials: getCachedAwsAssumeRoleProvider(),
    });

    this.tableName = options.tableName ?? config.ddbTableName;
    this.indexConfig = {
      ...DEFAULT_INDEX_CONFIG,
      ...options.indexConfig,
    };
    this.docClient = options.documentClient ?? DynamoDBDocumentClient.from(ddbClient);
    this.maxQueryPages = options.maxQueryPages ?? 5;
    this.queryPageSize = options.queryPageSize ?? 200;
  }

  async getInsightById(insightId: string): Promise<Insight | undefined> {
    const insightIdIndexName = this.indexConfig.insightIdIndexName;
    this.logDebug("getInsightById:start", {
      tableName: this.tableName,
      insightId,
      insightIdIndexName: insightIdIndexName ?? null,
    });

    if (!insightIdIndexName) {
      this.logDebug("getInsightById:no_index_configured_scan_fallback", {
        insightId,
      });
      const scanned = await this.scanByEquality("insight_id", insightId, 1);
      this.logDebug("getInsightById:scan_fallback_result", {
        insightId,
        resultCount: scanned.length,
      });
      return scanned[0];
    }

    try {
      const queryInput = {
        TableName: this.tableName,
        IndexName: insightIdIndexName,
        KeyConditionExpression: "#insight_id = :insight_id",
        ExpressionAttributeNames: {
          "#insight_id": "insight_id",
        },
        ExpressionAttributeValues: {
          ":insight_id": insightId,
        },
        Limit: 1,
      };
      this.logDebug("getInsightById:query_index", {
        insightId,
        queryInput,
      });

      const response = await this.docClient.send(
        new QueryCommand(queryInput),
      );

      const result = (response.Items?.[0] as Insight | undefined) ?? undefined;
      this.logDebug("getInsightById:query_index_result", {
        insightId,
        count: response.Items?.length ?? 0,
        found: Boolean(result),
      });
      return result;
    } catch (error) {
      const isMissingIndex = this.isMissingIndexError(error);
      this.logError("getInsightById:query_index_error", {
        insightId,
        insightIdIndexName,
        isMissingIndex,
        message: error instanceof Error ? error.message : "Unknown repository error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      if (!isMissingIndex) throw error;

      this.logDebug("getInsightById:missing_index_scan_fallback", {
        insightId,
        insightIdIndexName,
      });
      const scanned = await this.scanByEquality("insight_id", insightId, 1);
      this.logDebug("getInsightById:missing_index_scan_fallback_result", {
        insightId,
        resultCount: scanned.length,
      });
      return scanned[0];
    }
  }

  async getParentInsight(insightId: string): Promise<Insight | undefined> {
    const insight = await this.getInsightById(insightId);
    if (!insight?.parent_insight_id) return undefined;
    return this.getInsightById(insight.parent_insight_id);
  }

  async getInsightsByIds(insightIds: string[]): Promise<Insight[]> {
    const uniqueIds = Array.from(new Set(insightIds.filter(Boolean)));
    if (uniqueIds.length === 0) return [];
    const insightIdIndexName = this.indexConfig.insightIdIndexName;

    this.logDebug("getInsightsByIds:start", {
      tableName: this.tableName,
      insightIdIndexName: insightIdIndexName ?? null,
      requestedCount: insightIds.length,
      uniqueCount: uniqueIds.length,
      sampleInsightIds: uniqueIds.slice(0, 10),
    });

    if (!insightIdIndexName) {
      this.logDebug("getInsightsByIds:no_index_configured_scan_fallback", {
        requestedUniqueCount: uniqueIds.length,
      });
      const scanned = await Promise.all(
        uniqueIds.map((insightId) => this.scanByEquality("insight_id", insightId, 1)),
      );
      const deduped = dedupeByInsightId(scanned.flat());
      this.logDebug("getInsightsByIds:no_index_configured_scan_fallback_done", {
        foundCount: deduped.length,
      });
      return deduped;
    }

    const batches = chunkArray(uniqueIds, MAX_BATCH_GET);
    const found = new Map<string, Insight>();

    for (const [batchIndex, batch] of batches.entries()) {
      this.logDebug("getInsightsByIds:batch_query:start", {
        batchIndex,
        batchCount: batches.length,
        batchSize: batch.length,
        sampleInsightIds: batch.slice(0, 5),
      });

      const results = await Promise.all(
        batch.map(async (insightId) => {
          try {
            const response = await this.docClient.send(
              new QueryCommand({
                TableName: this.tableName,
                IndexName: insightIdIndexName,
                KeyConditionExpression: "#insight_id = :insight_id",
                ExpressionAttributeNames: {
                  "#insight_id": "insight_id",
                },
                ExpressionAttributeValues: {
                  ":insight_id": insightId,
                },
                Limit: 1,
              }),
            );
            return response.Items?.[0] as Insight | undefined;
          } catch (error) {
            const isMissingIndex = this.isMissingIndexError(error);
            this.logError("getInsightsByIds:query_error", {
              batchIndex,
              insightId,
              insightIdIndexName,
              isMissingIndex,
              message: error instanceof Error ? error.message : "Unknown repository error",
              stack: error instanceof Error ? error.stack : undefined,
            });
            if (!isMissingIndex) throw error;

            const scanned = await this.scanByEquality("insight_id", insightId, 1);
            return scanned[0];
          }
        }),
      );

      for (const item of results) {
        if (item?.insight_id) found.set(item.insight_id, item);
      }

      this.logDebug("getInsightsByIds:batch_query:done", {
        batchIndex,
        batchCount: batches.length,
        returnedCount: results.filter(Boolean).length,
        foundSoFar: found.size,
      });
    }

    this.logDebug("getInsightsByIds:done", {
      requestedUniqueCount: uniqueIds.length,
      foundCount: found.size,
      missingCount: uniqueIds.length - found.size,
    });

    return Array.from(found.values());
  }

  async queryByUserId(userId: string, maxItems: number): Promise<Insight[]> {
    return this.queryBySingleKeyIndex({
      indexName: this.indexConfig.userIdIndexName,
      attribute: "user_id",
      value: userId,
      maxItems,
    });
  }

  async queryByDocumentId(documentId: string, maxItems: number): Promise<Insight[]> {
    return this.queryBySingleKeyIndex({
      indexName: this.indexConfig.documentIdIndexName,
      attribute: "document_id",
      value: documentId,
      maxItems,
    });
  }

  async queryByParentInsightId(parentId: string, maxItems: number): Promise<Insight[]> {
    return this.queryBySingleKeyIndex({
      indexName: this.indexConfig.parentInsightIdIndexName,
      attribute: "parent_insight_id",
      value: parentId,
      maxItems,
    });
  }

  async getChildInsights(parentInsightId: string, maxItems: number): Promise<Insight[]> {
    return this.queryByParentInsightId(parentInsightId, maxItems);
  }

  async queryByStatus(status: string, maxItems: number): Promise<Insight[]> {
    return this.queryBySingleKeyIndex({
      indexName: this.indexConfig.statusIndexName,
      attribute: "status",
      value: status,
      maxItems,
    });
  }

  async queryByUserAndStatus(
    userId: string,
    status: string,
    maxItems: number,
  ): Promise<Insight[]> {
    return this.queryByCompositeIndex({
      indexName: this.indexConfig.userStatusIndexName,
      partitionAttribute: "user_id",
      partitionValue: userId,
      sortAttribute: "status",
      sortValue: status,
      maxItems,
    });
  }

  async listInsightsByDocument(documentId: string, limit = 200): Promise<Insight[]> {
    return this.queryByDocumentId(documentId, limit);
  }

  async listInsightsByUser(userId: string, limit = 200): Promise<Insight[]> {
    return this.queryByUserId(userId, limit);
  }

  async getSiblingInsights(insightId: string, maxItems = 50): Promise<Insight[]> {
    const insight = await this.getInsightById(insightId);
    if (!insight?.parent_insight_id) return [];

    const siblings = await this.queryByParentInsightId(insight.parent_insight_id, maxItems + 1);
    return siblings.filter((candidate) => candidate.insight_id !== insightId).slice(0, maxItems);
  }

  /**
   * Tool-facing method:
   * Approximate text matching over DynamoDB candidates.
   *
   * This is intentionally cheap-first and may use scanFallback as a temporary strategy.
   * Swap this method with OpenSearch-backed retrieval later.
   */
  async searchInsightsByText(input: TextSearchInput): Promise<Insight[]> {
    const filters = input.filters ?? {};
    const limit = Math.max(1, Math.min(input.limit ?? 30, 200));
    const minScore = input.minScore ?? 1.5;

    const seeds = await this.getSeedCandidates(filters, Math.max(limit * 8, 120));
    const filtered = seeds.filter((insight) => this.matchesFilters(insight, filters));

    const normalizedQuery = normalizeText(input.query);
    const queryTokens = tokenize(input.query);

    return filtered
      .map((insight) => ({
        insight,
        score: scoreKeywordMatch(insight.text, normalizedQuery, queryTokens).score,
      }))
      .filter((entry) => entry.score >= minScore)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((entry) => entry.insight);
  }

  /**
   * Tool-facing metadata matcher for iterative agent retrieval.
   *
   * Swap this method with OpenSearch-backed metadata clauses later.
   */
  async searchInsightsByMetadata(input: MetadataSearchInput): Promise<Insight[]> {
    const filters = {
      ...(input.filters ?? {}),
      metadata: input.metadata,
    } satisfies SearchFilters;

    const limit = Math.max(1, Math.min(input.limit ?? 30, 200));
    const seeds = await this.getSeedCandidates(filters, Math.max(limit * 8, 120));

    return seeds
      .filter((insight) => this.matchesFilters(insight, filters))
      .slice(0, limit);
  }

  async getSeedCandidates(filters: SearchFilters, maxItems: number): Promise<Insight[]> {
    const tasks: Array<Promise<Insight[]>> = [];

    if (filters.parent_insight_id) {
      tasks.push(this.queryByParentInsightId(filters.parent_insight_id, maxItems));
      tasks.push(
        this.getInsightById(filters.parent_insight_id).then((item) => (item ? [item] : [])),
      );
    }

    if (filters.document_id) {
      tasks.push(this.queryByDocumentId(filters.document_id, maxItems));
    }

    if (filters.user_id && filters.status) {
      tasks.push(this.queryByUserAndStatus(filters.user_id, filters.status, maxItems));
    }

    if (filters.user_id) {
      tasks.push(this.queryByUserId(filters.user_id, maxItems));
    }

    if (filters.status) {
      tasks.push(this.queryByStatus(filters.status, maxItems));
    }

    const resultSets = await Promise.all(tasks);
    const nonEmpty = resultSets.filter((items) => items.length > 0);

    if (nonEmpty.length === 0) {
      return this.scanFallback(filters, maxItems);
    }

    if (nonEmpty.length === 1) {
      return dedupeByInsightId(nonEmpty[0]).slice(0, maxItems);
    }

    const intersected = intersectByInsightId(nonEmpty);
    if (intersected.length > 0) {
      return intersected.slice(0, maxItems);
    }

    return dedupeByInsightId(nonEmpty.flat()).slice(0, maxItems);
  }

  /**
   * Temporary cheap-first fallback.
   * This is intentionally bounded and should only be used when indexed filters are absent
   * or missing GSIs block targeted queries.
   */
  async scanFallback(filters: SearchFilters, maxItems: number): Promise<Insight[]> {
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, unknown> = {};
    const conditions: string[] = [];

    if (filters.user_id) {
      expressionAttributeNames["#user_id"] = "user_id";
      expressionAttributeValues[":user_id"] = filters.user_id;
      conditions.push("#user_id = :user_id");
    }

    if (filters.document_id) {
      expressionAttributeNames["#document_id"] = "document_id";
      expressionAttributeValues[":document_id"] = filters.document_id;
      conditions.push("#document_id = :document_id");
    }

    if (filters.status) {
      expressionAttributeNames["#status"] = "status";
      expressionAttributeValues[":status"] = filters.status;
      conditions.push("#status = :status");
    }

    if (filters.parent_insight_id) {
      expressionAttributeNames["#parent_insight_id"] = "parent_insight_id";
      expressionAttributeValues[":parent_insight_id"] = filters.parent_insight_id;
      conditions.push("#parent_insight_id = :parent_insight_id");
    }

    const items: Insight[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    let pages = 0;

    while (items.length < maxItems && pages < this.maxQueryPages) {
      const response = await this.docClient.send(
        new ScanCommand({
          TableName: this.tableName,
          Limit: Math.min(this.queryPageSize, maxItems - items.length),
          ...(conditions.length > 0
            ? {
                FilterExpression: conditions.join(" AND "),
                ExpressionAttributeNames: expressionAttributeNames,
                ExpressionAttributeValues: expressionAttributeValues,
              }
            : {}),
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );

      items.push(...((response.Items ?? []) as Insight[]));
      lastEvaluatedKey = response.LastEvaluatedKey;
      pages += 1;
      if (!lastEvaluatedKey) break;
    }

    return items;
  }

  private matchesFilters(insight: Insight, filters: SearchFilters): boolean {
    return (
      matchesScalarFilters(insight, {
        user_id: filters.user_id,
        document_id: filters.document_id,
        status: filters.status,
        parent_insight_id: filters.parent_insight_id,
      }) && metadataSatisfiesFilters(insight.metadata, filters.metadata)
    );
  }

  private async queryBySingleKeyIndex(input: {
    indexName?: string;
    attribute: string;
    value: string;
    maxItems: number;
  }): Promise<Insight[]> {
    if (!input.indexName) {
      return this.scanByEquality(input.attribute, input.value, input.maxItems);
    }

    const expressionAttributeNames = {
      "#pk": input.attribute,
    };

    const expressionAttributeValues = {
      ":pk": input.value,
    };

    try {
      return await this.queryAllPages({
        indexName: input.indexName,
        keyConditionExpression: "#pk = :pk",
        expressionAttributeNames,
        expressionAttributeValues,
        maxItems: input.maxItems,
      });
    } catch (error) {
      if (!this.isMissingIndexError(error)) throw error;
      return this.scanByEquality(input.attribute, input.value, input.maxItems);
    }
  }

  private async queryByCompositeIndex(input: {
    indexName?: string;
    partitionAttribute: string;
    partitionValue: string;
    sortAttribute: string;
    sortValue: string;
    maxItems: number;
  }): Promise<Insight[]> {
    if (!input.indexName) {
      return this.scanByEqualities(
        [
          [input.partitionAttribute, input.partitionValue],
          [input.sortAttribute, input.sortValue],
        ],
        input.maxItems,
      );
    }

    const expressionAttributeNames = {
      "#pk": input.partitionAttribute,
      "#sk": input.sortAttribute,
    };

    const expressionAttributeValues = {
      ":pk": input.partitionValue,
      ":sk": input.sortValue,
    };

    try {
      return await this.queryAllPages({
        indexName: input.indexName,
        keyConditionExpression: "#pk = :pk AND #sk = :sk",
        expressionAttributeNames,
        expressionAttributeValues,
        maxItems: input.maxItems,
      });
    } catch (error) {
      if (!this.isMissingIndexError(error)) throw error;
      return this.scanByEqualities(
        [
          [input.partitionAttribute, input.partitionValue],
          [input.sortAttribute, input.sortValue],
        ],
        input.maxItems,
      );
    }
  }

  private async queryAllPages(input: {
    indexName: string;
    keyConditionExpression: string;
    expressionAttributeNames: Record<string, string>;
    expressionAttributeValues: Record<string, unknown>;
    maxItems: number;
  }): Promise<Insight[]> {
    const items: Insight[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    let pages = 0;

    while (items.length < input.maxItems && pages < this.maxQueryPages) {
      const response = await this.docClient.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: input.indexName,
          KeyConditionExpression: input.keyConditionExpression,
          ExpressionAttributeNames: input.expressionAttributeNames,
          ExpressionAttributeValues: input.expressionAttributeValues,
          Limit: Math.min(this.queryPageSize, input.maxItems - items.length),
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );

      items.push(...((response.Items ?? []) as Insight[]));
      lastEvaluatedKey = response.LastEvaluatedKey;
      pages += 1;
      if (!lastEvaluatedKey) break;
    }

    return items;
  }

  private async scanByEquality(
    attribute: string,
    value: string,
    maxItems: number,
  ): Promise<Insight[]> {
    return this.scanByEqualities([[attribute, value]], maxItems);
  }

  private async scanByEqualities(
    pairs: Array<[attribute: string, value: string]>,
    maxItems: number,
  ): Promise<Insight[]> {
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, unknown> = {};
    const conditions: string[] = [];

    for (const [attribute, value] of pairs) {
      const safeAttribute = attribute.replace(/[^A-Za-z0-9_]/g, "_");
      const nameKey = `#${safeAttribute}`;
      const valueKey = `:${safeAttribute}`;
      expressionAttributeNames[nameKey] = attribute;
      expressionAttributeValues[valueKey] = value;
      conditions.push(`${nameKey} = ${valueKey}`);
    }

    const items: Insight[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    let pages = 0;
    console.debug("scanByEqualities:start", {
      tableName: this.tableName,
      conditions,
      maxItems,
    });
    while (items.length < maxItems && pages < this.maxQueryPages) {
      const response = await this.docClient.send(
        new ScanCommand({
          TableName: this.tableName,
          Limit: Math.min(this.queryPageSize, maxItems - items.length),
          FilterExpression: conditions.join(" AND "),
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );

      items.push(...((response.Items ?? []) as Insight[]));
      lastEvaluatedKey = response.LastEvaluatedKey;
      pages += 1;
      if (!lastEvaluatedKey) break;
    }

    return items;
  }

  private isMissingIndexError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    return (
      message.includes("index not found") ||
      message.includes("invalid index") ||
      message.includes("does not have the specified index")
    );
  }

  private logDebug(event: string, payload: Record<string, unknown>): void {
    console.debug(`[search:repository] ${event}`, payload);
  }

  private logError(event: string, payload: Record<string, unknown>): void {
    console.error(`[search:repository] ${event}`, payload);
  }
}

const dedupeByInsightId = (insights: Insight[]): Insight[] => {
  const byId = new Map<string, Insight>();
  for (const insight of insights) {
    if (!byId.has(insight.insight_id)) byId.set(insight.insight_id, insight);
  }
  return Array.from(byId.values());
};

const intersectByInsightId = (items: Insight[][]): Insight[] => {
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
};
