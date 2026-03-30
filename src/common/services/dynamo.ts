import type { WriteRequest } from "@aws-sdk/client-dynamodb";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
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

export type InsightFilterKey =
  | "insight_id"
  | "project_id"
  | "parent_insight_id"
  | "text"
  | "user_id"
  | "status"
  | "s3_node"
  | "document_id";

export type InsightFilters = Partial<Record<InsightFilterKey, string | string[] | null>>;

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
      throw new Error(
        `Failed to persist ${unprocessed.length} insights after retries.`,
      );
    }
  }
  console.debug("dynamo:persist:done", { count: insights.length });
}

export async function updateInsight(insight: Insight): Promise<void> {
  if (!insight.insight_id) {
    throw new Error("updateInsight requires insight.insight_id");
  }

  const { insight_id: insightId, ...rest } = insight;
  const updatableEntries = Object.entries(rest).filter(([, value]) => value !== undefined);

  if (updatableEntries.length === 0) {
    console.warn("dynamo:update:skip", {
      insightId,
      reason: "no_updatable_fields",
    });
    return;
  }

  const expressionAttributeNames: Record<string, string> = {
    "#insight_id": "insight_id",
  };
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
        Key: { insight_id: insightId },
        UpdateExpression: `SET ${setExpressions.join(", ")}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ConditionExpression: "attribute_exists(insight_id)",
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
// TODO: Get rid of Scan
export async function listInsights(filters: InsightFilters = {}): Promise<Insight[]> {
  const filterEntries = Object.entries(filters).filter(([, value]) => value !== undefined);
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const conditions: string[] = [];

  for (const [key, value] of filterEntries) {
    const nameKey = `#${key}`;
    names[nameKey] = key;

    if (value === null) {
      conditions.push(`attribute_not_exists(${nameKey})`);
      continue;
    }

    if (Array.isArray(value)) {
      const orParts: string[] = [];
      value.forEach((entry, index) => {
        const valueKey = `:${key}_${index}`;
        values[valueKey] = entry;
        orParts.push(`${nameKey} = ${valueKey}`);
      });
      if (orParts.length > 0) {
        conditions.push(`(${orParts.join(" OR ")})`);
      }
      continue;
    }

    const valueKey = `:${key}`;
    values[valueKey] = value;
    conditions.push(`${nameKey} = ${valueKey}`);
  }

  let lastEvaluatedKey: Record<string, unknown> | undefined;

  const items: Insight[] = [];
  console.log("constraints", conditions);
  do {
    const response = await docClient.send(
      new ScanCommand({
        TableName: config.ddbTableName,
        ...(conditions.length > 0
          ? {
              FilterExpression: conditions.join(" AND "),
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            }
          : {}),
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );

    items.push(...((response.Items ?? []) as Insight[]));
    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log("listInsights:done", items, items.length);
  return items;
}

export async function getInsightById(insightId: string): Promise<Insight | undefined> {
  if (!insightId) return undefined;

  const response = await docClient.send(
    new QueryCommand({
      TableName: config.ddbTableName,
      IndexName: "GSI_insight_id",
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
  console.log("getInsightById", { response});
  return (response.Items?.[0] as Insight | undefined) ?? undefined;
}

export async function deleteAllInsights(): Promise<number> {
  const describe = await client.send(
    new DescribeTableCommand({ TableName: config.ddbTableName }),
  );
  const keyAttributes =
    describe.Table?.KeySchema?.map((entry) => entry.AttributeName).filter(
      (value): value is string => Boolean(value),
    ) ?? [];

  if (keyAttributes.length === 0) {
    throw new Error("Could not resolve table key schema.");
  }

  const expressionAttributeNames = keyAttributes.reduce<Record<string, string>>(
    (acc, key, index) => {
      acc[`#k${index}`] = key;
      return acc;
    },
    {},
  );
  const projectionExpression = Object.keys(expressionAttributeNames).join(", ");

  let deletedCount = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const response = await docClient.send(
      new ScanCommand({
        TableName: config.ddbTableName,
        ProjectionExpression: projectionExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExclusiveStartKey,
      }),
    );

    const keys = (response.Items ?? [])
      .map((item) => {
        const keyObject = keyAttributes.reduce<Record<string, unknown>>((acc, key) => {
          if (item[key] !== undefined) {
            acc[key] = item[key];
          }
          return acc;
        }, {});
        return Object.keys(keyObject).length === keyAttributes.length ? keyObject : null;
      })
      .filter((item): item is Record<string, unknown> => item !== null);

    if (keys.length > 0) {
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
          throw new Error(
            `Failed to delete ${unprocessed.length} records after retries.`,
          );
        }
      }

      deletedCount += deleteRequests.length;
    }

    ExclusiveStartKey = response.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return deletedCount;
}

export async function deleteInsightsByProjectId(projectId: string): Promise<number> {
  if (!projectId) return 0;

  const describe = await client.send(
    new DescribeTableCommand({ TableName: config.ddbTableName }),
  );
  const keyAttributes =
    describe.Table?.KeySchema?.map((entry) => entry.AttributeName).filter(
      (value): value is string => Boolean(value),
    ) ?? [];

  if (keyAttributes.length === 0) {
    throw new Error("Could not resolve table key schema.");
  }

  const expressionAttributeNames = keyAttributes.reduce<Record<string, string>>(
    (acc, key, index) => {
      acc[`#k${index}`] = key;
      return acc;
    },
    {
      "#project_id": "project_id",
      "#insight_id": "insight_id",
    },
  );
  const projectionExpression = keyAttributes.map((_, index) => `#k${index}`).join(", ");

  let deletedCount = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const response = await docClient.send(
      new ScanCommand({
        TableName: config.ddbTableName,
        ProjectionExpression: projectionExpression,
        FilterExpression: "#project_id = :projectId OR #insight_id = :projectId",
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: {
          ":projectId": projectId,
        },
        ExclusiveStartKey,
      }),
    );

    const keys = (response.Items ?? [])
      .map((item) => {
        const keyObject = keyAttributes.reduce<Record<string, unknown>>((acc, key) => {
          if (item[key] !== undefined) {
            acc[key] = item[key];
          }
          return acc;
        }, {});
        return Object.keys(keyObject).length === keyAttributes.length ? keyObject : null;
      })
      .filter((item): item is Record<string, unknown> => item !== null);

    if (keys.length > 0) {
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
          throw new Error(
            `Failed to delete ${unprocessed.length} project records after retries.`,
          );
        }
      }

      deletedCount += deleteRequests.length;
    }

    ExclusiveStartKey = response.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return deletedCount;
}
