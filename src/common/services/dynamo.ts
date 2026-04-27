import type { WriteRequest } from "@aws-sdk/client-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Insight } from "../../types";
import { getCachedAwsAssumeRoleProvider } from "./aws";
import { config } from "./config";
import { chunkArray, sleep } from "./utils";

const client = new DynamoDBClient({
  credentials: getCachedAwsAssumeRoleProvider(),
});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

const MAX_BATCH = 25;
const MAX_RETRIES = 5;
const INSIGHTS_BY_USER_ID_INDEX = "GSI_UserId";
const INSIGHTS_BY_DOCUMENT_ID_INDEX = "GSI_DocumentId";
const INSIGHTS_BY_PARENT_INSIGHT_ID_INDEX = "GSI_ParentInsightId";
const INSIGHTS_BY_STATUS_INDEX = "GSI_Status";
const INSIGHTS_BY_PROJECT_ID_INDEX = config.ddbProjectIdIndexName;
const ENABLE_UNSAFE_DELETE_ALL_INSIGHTS =
  process.env.ENABLE_UNSAFE_DELETE_ALL_INSIGHTS?.trim().toLowerCase() === "true";

export type InsightFilterKey =
  | "insight_id"
  | "object_type"
  | "project_id"
  | "parent_insight_id"
  | "text"
  | "user_id"
  | "status"
  | "s3_node"
  | "document_id";

export type InsightFilters = Partial<Record<InsightFilterKey, string | string[] | null>>;

type QueryTarget = {
  partitionKey:
    | "insight_id"
    | "project_id"
    | "user_id"
    | "document_id"
    | "parent_insight_id"
    | "status";
  indexName?: string;
};

const QUERY_PRIORITY: QueryTarget["partitionKey"][] = [
  "insight_id",
  "project_id",
  "user_id",
  "document_id",
  "parent_insight_id",
  "status",
];

const QUERY_TARGETS: Record<QueryTarget["partitionKey"], QueryTarget> = {
  insight_id: { partitionKey: "insight_id" },
  project_id: { partitionKey: "project_id", indexName: INSIGHTS_BY_PROJECT_ID_INDEX },
  user_id: { partitionKey: "user_id", indexName: INSIGHTS_BY_USER_ID_INDEX },
  document_id: { partitionKey: "document_id", indexName: INSIGHTS_BY_DOCUMENT_ID_INDEX },
  parent_insight_id: {
    partitionKey: "parent_insight_id",
    indexName: INSIGHTS_BY_PARENT_INSIGHT_ID_INDEX,
  },
  status: { partitionKey: "status", indexName: INSIGHTS_BY_STATUS_INDEX },
};

export async function persistInsights(insights: Insight[]): Promise<void> {
  console.debug("dynamo:persist:start", { count: insights.length });
  if (insights.length === 0) return;
  const batches = chunkArray(insights, MAX_BATCH);

  for (const batch of batches) {
    console.debug("dynamo:persist:batch", { size: batch.length });
    let unprocessed = batch.map((item) => ({
      PutRequest: { Item: item },
    })) as unknown as WriteRequest[];

    for (let attempt = 0; attempt <= MAX_RETRIES && unprocessed.length > 0; attempt += 1) {
      const response = await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [config.ddbTableName]: unprocessed,
          },
        }),
      );

      const remaining = response.UnprocessedItems?.[config.ddbTableName];
      unprocessed = (remaining ? Array.from(remaining) : []) as WriteRequest[];

      if (unprocessed.length > 0) {
        const backoffMs = Math.min(2000 * Math.pow(2, attempt), 10000);
        await sleep(backoffMs);
      }
    }

    if (unprocessed.length > 0) {
      throw new Error(`Failed to persist ${unprocessed.length} insights after retries.`);
    }
  }

  console.debug("dynamo:persist:done", { count: insights.length });
}

export async function updateInsight(insight: Insight): Promise<void> {
  if (!insight.insight_id) {
    throw new Error("updateInsight requires insight.insight_id");
  }
  if (!insight.user_id) {
    throw new Error("updateInsight requires insight.user_id for composite key updates");
  }

  const { insight_id: insightId, user_id: userId, ...rest } = insight;
  const updatableEntries = Object.entries(rest).filter(([, value]) => value !== undefined);

  if (updatableEntries.length === 0) {
    console.warn("dynamo:update:skip", {
      insightId,
      reason: "no_updatable_fields",
    });
    return;
  }

  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, unknown> = {};
  const setExpressions: string[] = [];

  updatableEntries.forEach(([key, value], index) => {
    const nameKey = `#f${index}`;
    const valueKey = `:v${index}`;
    expressionAttributeNames[nameKey] = key;
    expressionAttributeValues[valueKey] = value;
    setExpressions.push(`${nameKey} = ${valueKey}`);
  });

  console.debug("dynamo:update:start", {
    insightId,
    fieldCount: updatableEntries.length,
  });

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: config.ddbTableName,
        Key: { insight_id: insightId, user_id: userId },
        UpdateExpression: `SET ${setExpressions.join(", ")}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ConditionExpression: "attribute_exists(insight_id) AND attribute_exists(user_id)",
      }),
    );

    console.debug("dynamo:update:done", {
      insightId,
      fieldCount: updatableEntries.length,
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      console.warn("dynamo:update:not_found", { insightId, error });
      throw new Error(`Insight not found for update: ${insightId}`);
    }

    console.error("dynamo:update:failed", { insightId, error });
    throw error;
  }
}

export async function getInsightById(insightId: string): Promise<Insight | undefined> {
  if (!insightId || insightId.trim().length === 0) return undefined;
  const items = await listInsights({ insight_id: insightId });
  return items[0];
}

export async function deleteInsightById(insightId: string): Promise<void> {
  if (!insightId || insightId.trim().length === 0) {
    throw new Error("deleteInsightById requires a non-empty insightId");
  }

  console.debug("dynamo:deleteInsightById:start", { insightId });
  const keys = await queryInsightKeysByInsightId(insightId);
  await batchDeleteByKeys(keys);
  console.debug("dynamo:deleteInsightById:done", { insightId });
}

export async function listInsights(filters: InsightFilters = {}): Promise<Insight[]> {
  const filterEntries = Object.entries(filters).filter(([, value]) => value !== undefined) as Array<
    [InsightFilterKey, string | string[] | null]
  >;

  if (filterEntries.length === 0) {
    return scanAllInsights();
  }

  const selectedKey = chooseBestQueryKey(filters);
  if (!selectedKey) {
    throw new Error(
      `No indexed partition key in requested filters [${filterEntries
        .map(([key]) => key)
        .join(", ")}]. Supported partition keys: insight_id (table PK), project_id (${INSIGHTS_BY_PROJECT_ID_INDEX}), user_id (GSI_UserId), document_id (GSI_DocumentId), parent_insight_id (GSI_ParentInsightId), status (GSI_Status).`,
    );
  }

  const keyValues = normalizeFilterValues(filters[selectedKey]);
  if (keyValues.length === 0) {
    return [];
  }

  const queryTarget = QUERY_TARGETS[selectedKey];

  const dedupedById = new Map<string, Insight>();

  for (const keyValue of keyValues) {
    const pageItems = await queryItemsByPartitionKey({
      tableName: config.ddbTableName,
      target: queryTarget,
      partitionValue: keyValue,
      filters,
    });

    for (const item of pageItems) {
      if (!item.insight_id) continue;
      dedupedById.set(`${item.insight_id}::${item.user_id ?? ""}`, item);
    }
  }

  return Array.from(dedupedById.values());
}

async function scanAllInsights(): Promise<Insight[]> {
  const dedupedById = new Map<string, Insight>();
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await docClient.send(
      new ScanCommand({
        TableName: config.ddbTableName,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const insight = item as Insight;
      if (typeof insight.insight_id !== "string" || insight.insight_id.trim().length === 0) {
        continue;
      }
      dedupedById.set(`${insight.insight_id}::${insight.user_id ?? ""}`, insight);
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return Array.from(dedupedById.values());
}

export async function deleteAllInsights(): Promise<number> {
  const { deletedCount } = await deleteAllInsightsWithInsightIds();
  return deletedCount;
}

export async function deleteAllInsightsWithInsightIds(): Promise<{
  deletedCount: number;
  insightIds: string[];
}> {
  if (!ENABLE_UNSAFE_DELETE_ALL_INSIGHTS) {
    throw new Error(
      "deleteAllInsightsWithInsightIds is disabled. Set ENABLE_UNSAFE_DELETE_ALL_INSIGHTS=true to allow a full-table scan delete.",
    );
  }

  const keys = await scanAllInsightKeys();
  await batchDeleteByKeys(keys);
  const insightIds = Array.from(
    new Set(keys.map((key) => key.insight_id).filter((insightId) => insightId.trim().length > 0)),
  );
  return {
    deletedCount: keys.length,
    insightIds,
  };
}

export async function deleteInsightsByProjectId(projectId: string): Promise<number> {
  const { deletedCount } = await deleteInsightsByProjectIdWithInsightIds(projectId);
  return deletedCount;
}

export async function deleteInsightsByProjectIdWithInsightIds(projectId: string): Promise<{
  deletedCount: number;
  insightIds: string[];
}> {
  if (!projectId) {
    return {
      deletedCount: 0,
      insightIds: [],
    };
  }

  const keys = await queryInsightKeysForProject(projectId);
  await batchDeleteByKeys(keys);
  const insightIds = Array.from(
    new Set(keys.map((key) => key.insight_id).filter((insightId) => insightId.trim().length > 0)),
  );
  return {
    deletedCount: keys.length,
    insightIds,
  };
}

function chooseBestQueryKey(
  filters: InsightFilters,
): QueryTarget["partitionKey"] | undefined {
  for (const key of QUERY_PRIORITY) {
    const rawValue = filters[key];
    if (rawValue === undefined || rawValue === null) continue;
    if (normalizeFilterValues(rawValue).length === 0) continue;
    return key;
  }
  return undefined;
}

function normalizeFilterValues(value: string | string[] | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return Array.from(new Set(value));
  return [value];
}

function buildFilterExpression(
  filters: InsightFilters,
  keyAttribute: QueryTarget["partitionKey"],
): {
  conditions: string[];
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, unknown>;
} {
  const conditions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, unknown> = {};
  let fieldIndex = 0;

  for (const [rawKey, rawValue] of Object.entries(filters) as Array<
    [InsightFilterKey, string | string[] | null | undefined]
  >) {
    if (rawValue === undefined || rawKey === keyAttribute) continue;

    const nameKey = `#f${fieldIndex}`;
    fieldIndex += 1;
    expressionAttributeNames[nameKey] = rawKey;

    if (rawValue === null) {
      conditions.push(`attribute_not_exists(${nameKey})`);
      continue;
    }

    if (Array.isArray(rawValue)) {
      if (rawValue.length === 0) continue;

      const orParts: string[] = [];
      rawValue.forEach((entry, valueIndex) => {
        const valueKey = `:f${fieldIndex}_${valueIndex}`;
        expressionAttributeValues[valueKey] = entry;
        orParts.push(`${nameKey} = ${valueKey}`);
      });

      if (orParts.length > 0) {
        conditions.push(`(${orParts.join(" OR ")})`);
      }
      continue;
    }

    const valueKey = `:f${fieldIndex}`;
    expressionAttributeValues[valueKey] = rawValue;
    conditions.push(`${nameKey} = ${valueKey}`);
  }

  return {
    conditions,
    expressionAttributeNames,
    expressionAttributeValues,
  };
}

async function queryItemsByPartitionKey(params: {
  tableName: string;
  target: QueryTarget;
  partitionValue: string;
  filters?: InsightFilters;
}): Promise<Insight[]> {
  const filterResult = params.filters
    ? buildFilterExpression(params.filters, params.target.partitionKey)
    : {
        conditions: [],
        expressionAttributeNames: {},
        expressionAttributeValues: {},
      };

  const expressionAttributeNames: Record<string, string> = {
    "#pk": params.target.partitionKey,
    ...filterResult.expressionAttributeNames,
  };
  const expressionAttributeValues: Record<string, unknown> = {
    ":pk": params.partitionValue,
    ...filterResult.expressionAttributeValues,
  };

  const items: Insight[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await docClient.send(
      new QueryCommand({
        TableName: params.tableName,
        ...(params.target.indexName ? { IndexName: params.target.indexName } : {}),
        KeyConditionExpression: "#pk = :pk",
        ...(filterResult.conditions.length > 0
          ? {
              FilterExpression: filterResult.conditions.join(" AND "),
            }
          : {}),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    items.push(...((response.Items ?? []) as Insight[]));
    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return items;
}

async function queryInsightKeysByInsightId(
  insightId: string,
): Promise<Array<{ insight_id: string; user_id: string }>> {
  const items = await queryItemsByPartitionKey({
    tableName: config.ddbTableName,
    target: { partitionKey: "insight_id" },
    partitionValue: insightId,
  });

  const keys = new Map<string, { insight_id: string; user_id: string }>();
  for (const item of items) {
    if (typeof item.insight_id !== "string" || typeof item.user_id !== "string") continue;
    keys.set(`${item.insight_id}::${item.user_id}`, {
      insight_id: item.insight_id,
      user_id: item.user_id,
    });
  }

  return Array.from(keys.values());
}

async function queryInsightKeysForProject(
  projectId: string,
): Promise<Array<{ insight_id: string; user_id: string }>> {
  const projectItems = await queryItemsByPartitionKey({
    tableName: config.ddbTableName,
    target: { partitionKey: "project_id", indexName: INSIGHTS_BY_PROJECT_ID_INDEX },
    partitionValue: projectId,
  });
  const rootCandidates = await queryItemsByPartitionKey({
    tableName: config.ddbTableName,
    target: { partitionKey: "insight_id" },
    partitionValue: projectId,
  });

  const keys = new Map<string, { insight_id: string; user_id: string }>();
  for (const item of [...projectItems, ...rootCandidates]) {
    const insightId = item.insight_id;
    const userId = item.user_id;
    if (
      typeof insightId === "string"
      && insightId.trim().length > 0
      && typeof userId === "string"
      && userId.trim().length > 0
    ) {
      keys.set(`${insightId}::${userId}`, {
        insight_id: insightId,
        user_id: userId,
      });
    }
  }

  return Array.from(keys.values());
}

async function scanAllInsightKeys(): Promise<Array<{ insight_id: string; user_id: string }>> {
  const keys = new Map<string, { insight_id: string; user_id: string }>();
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await docClient.send(
      new ScanCommand({
        TableName: config.ddbTableName,
        ProjectionExpression: "#insight_id, #user_id",
        ExpressionAttributeNames: {
          "#insight_id": "insight_id",
          "#user_id": "user_id",
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const insightId = item.insight_id;
      const userId = item.user_id;
      if (
        typeof insightId === "string" &&
        insightId.trim().length > 0 &&
        typeof userId === "string" &&
        userId.trim().length > 0
      ) {
        keys.set(`${insightId}::${userId}`, {
          insight_id: insightId,
          user_id: userId,
        });
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return Array.from(keys.values());
}

async function batchDeleteByKeys(keys: Array<{ insight_id: string; user_id: string }>): Promise<void> {
  if (keys.length === 0) return;

  const deleteRequests = keys.map((key) => ({
    DeleteRequest: { Key: key },
  })) as unknown as WriteRequest[];

  const batches = chunkArray(deleteRequests, MAX_BATCH);
  for (const batch of batches) {
    let unprocessed = batch;

    for (let attempt = 0; attempt <= MAX_RETRIES && unprocessed.length > 0; attempt += 1) {
      const writeResponse = await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [config.ddbTableName]: unprocessed,
          },
        }),
      );

      const remaining = writeResponse.UnprocessedItems?.[config.ddbTableName];
      unprocessed = (remaining ? Array.from(remaining) : []) as WriteRequest[];

      if (unprocessed.length > 0) {
        const backoffMs = Math.min(2000 * Math.pow(2, attempt), 10000);
        await sleep(backoffMs);
      }
    }

    if (unprocessed.length > 0) {
      throw new Error(`Failed to delete ${unprocessed.length} records after retries.`);
    }
  }
}
