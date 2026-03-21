import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { getAwsAssumeRoleProvider } from "../common/services/aws";
import { config } from "../common/services/config";
import { chunkArray, sleep } from "../common/services/utils";
import type { Insight, SearchFilters, SearchIndexConfig } from "../types";

const DEFAULT_INDEX_CONFIG: SearchIndexConfig = {
  userIdIndexName: "GSI_UserId",
  documentIdIndexName: "GSI_DocumentId",
  parentInsightIdIndexName: "GSI_ParentInsightId",
  statusIndexName: "GSI_Status",
  userStatusIndexName: "GSI_UserStatus",
};

const MAX_BATCH_GET = 100;
const MAX_BATCH_RETRIES = 4;

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

/**
 * DynamoDB-only repository used by the temporary cheap-first search layer.
 *
 * Assumptions:
 * - Table primary key supports direct reads by `insight_id`.
 * - GSIs listed in RECOMMENDED_TEMPORARY_SEARCH_INDEXES exist.
 * - If an index is missing, the service can still run by using a bounded fallback scan.
 */
export class InsightSearchRepository {
  private readonly tableName: string;
  private readonly indexConfig: SearchIndexConfig;
  private readonly docClient: DynamoDBDocumentClient;
  private readonly maxQueryPages: number;
  private readonly queryPageSize: number;

  constructor(options: InsightSearchRepositoryOptions = {}) {
    const ddbClient = new DynamoDBClient({
      credentials: getAwsAssumeRoleProvider(),
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
    const response = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { insight_id: insightId },
      }),
    );

    return response.Item as Insight | undefined;
  }

  async getInsightsByIds(insightIds: string[]): Promise<Insight[]> {
    const uniqueIds = Array.from(new Set(insightIds.filter(Boolean)));
    if (uniqueIds.length === 0) return [];

    const batches = chunkArray(uniqueIds, MAX_BATCH_GET);
    const found = new Map<string, Insight>();

    for (const batch of batches) {
      let requestItems: Record<string, { Keys: Array<{ insight_id: string }> }> = {
        [this.tableName]: {
          Keys: batch.map((insight_id) => ({ insight_id })),
        },
      };

      for (let attempt = 0; attempt <= MAX_BATCH_RETRIES; attempt += 1) {
        const response = await this.docClient.send(
          new BatchGetCommand({ RequestItems: requestItems }),
        );

        for (const item of (response.Responses?.[this.tableName] ?? []) as Insight[]) {
          found.set(item.insight_id, item);
        }

        const unprocessed = (response.UnprocessedKeys?.[this.tableName]?.Keys ??
          []) as Array<{ insight_id: string }>;
        if (unprocessed.length === 0) break;

        requestItems = {
          [this.tableName]: {
            Keys: unprocessed.map((key) => ({ insight_id: key.insight_id })),
          },
        };

        const backoffMs = Math.min(250 * Math.pow(2, attempt), 2000);
        await sleep(backoffMs);
      }
    }

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

  async queryByStatus(status: string, maxItems: number): Promise<Insight[]> {
    if (!this.indexConfig.statusIndexName) return [];
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
    if (!this.indexConfig.userStatusIndexName) return [];

    return this.queryByCompositeIndex({
      indexName: this.indexConfig.userStatusIndexName,
      partitionAttribute: "user_id",
      partitionValue: userId,
      sortAttribute: "status",
      sortValue: status,
      maxItems,
    });
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

  private async queryBySingleKeyIndex(input: {
    indexName: string;
    attribute: string;
    value: string;
    maxItems: number;
  }): Promise<Insight[]> {
    const expressionAttributeNames = {
      "#pk": input.attribute,
    };

    const expressionAttributeValues = {
      ":pk": input.value,
    };

    return this.queryAllPages({
      indexName: input.indexName,
      keyConditionExpression: "#pk = :pk",
      expressionAttributeNames,
      expressionAttributeValues,
      maxItems: input.maxItems,
    });
  }

  private async queryByCompositeIndex(input: {
    indexName: string;
    partitionAttribute: string;
    partitionValue: string;
    sortAttribute: string;
    sortValue: string;
    maxItems: number;
  }): Promise<Insight[]> {
    const expressionAttributeNames = {
      "#pk": input.partitionAttribute,
      "#sk": input.sortAttribute,
    };

    const expressionAttributeValues = {
      ":pk": input.partitionValue,
      ":sk": input.sortValue,
    };

    return this.queryAllPages({
      indexName: input.indexName,
      keyConditionExpression: "#pk = :pk AND #sk = :sk",
      expressionAttributeNames,
      expressionAttributeValues,
      maxItems: input.maxItems,
    });
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
}
