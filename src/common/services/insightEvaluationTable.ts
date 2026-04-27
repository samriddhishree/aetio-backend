import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { getCachedAwsAssumeRoleProvider } from "./aws";
import { config } from "./config";
import { chunkArray, sleep } from "./utils";
import type { ExtractionTrace, InsightReviewEvent } from "../../evals/generateInsights/types";

const client = new DynamoDBClient({
  credentials: getCachedAwsAssumeRoleProvider(),
});

const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

const MAX_BATCH = 25;
const MAX_RETRIES = 4;
type BatchDeleteRequest = NonNullable<BatchWriteCommandInput["RequestItems"]>[string][number];
type DynamoKey = Record<string, unknown>;

const TRACE_INSIGHT_INDEX = "GSI_InsightIdCreatedAt";
const TRACE_PROJECT_CREATED_AT_INDEX = config.insightEvaluationTraceProjectIdCreatedAtIndexName;
const REVIEW_RUN_INDEX = "GSI_RunIdOccurredAt";

async function batchWrite(tableName: string, items: Record<string, unknown>[]): Promise<void> {
  if (items.length === 0) return;

  const batches = chunkArray(items, MAX_BATCH);

  for (const batch of batches) {
    let unprocessed: Array<{ PutRequest: { Item: Record<string, unknown> } }> = batch.map((item) => ({
      PutRequest: { Item: item },
    }));

    for (let attempt = 0; attempt <= MAX_RETRIES && unprocessed.length > 0; attempt += 1) {
      const response = await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: unprocessed,
          },
        }),
      );

      unprocessed = Array.from(
        (response.UnprocessedItems?.[tableName] ?? []) as Array<{ PutRequest: { Item: Record<string, unknown> } }>,
      );
      if (unprocessed.length > 0) {
        await sleep(Math.min(2000 * Math.pow(2, attempt), 8000));
      }
    }

    if (unprocessed.length > 0) {
      throw new Error(`Failed to persist ${unprocessed.length} records to ${tableName}.`);
    }
  }
}

function normalizedReviewRunId(event: InsightReviewEvent): string {
  const explicitRunId =
    typeof event.run_id === "string" && event.run_id.trim().length > 0
      ? event.run_id.trim()
      : undefined;
  if (explicitRunId) return explicitRunId;
  return `unlinked:${event.project_id}:${event.insight_id}`;
}

function reviewEventKeyOccurredAt(event: InsightReviewEvent): string {
  const occurredAt =
    typeof event.occurred_at === "string" && event.occurred_at.trim().length > 0
      ? event.occurred_at.trim()
      : new Date().toISOString();
  return `${occurredAt}#${event.event_id}`;
}

export async function putExtractionTraces(traces: ExtractionTrace[]): Promise<void> {
  if (traces.length === 0) return;

  const records = traces.map((trace) => ({
    ...trace,
    pk: trace.run_id,
    sk: trace.insight_id,
    created_at: trace.created_at,
    create_at: trace.created_at,
  }));

  await batchWrite(config.insightEvaluationTraceTableName, records);
}

export async function putReviewEvents(events: InsightReviewEvent[]): Promise<void> {
  if (events.length === 0) return;

  const records = events.map((event) => ({
    ...event,
    run_id: normalizedReviewRunId(event),
    pk: event.project_id,
    sk: `${event.occurred_at}#${event.event_id}`,
    created_at: event.occurred_at,
    updated_at: event.occurred_at,
    occured_at: reviewEventKeyOccurredAt(event),
  }));

  try {
    await batchWrite(config.insightReviewEventTableName, records);
  } catch (error) {
    const sample = records[0];
    throw new Error(
      `Failed to persist review events to ${config.insightReviewEventTableName}: ${
        error instanceof Error ? error.message : "Unknown error"
      }. Sample keys: pk=${String(sample?.pk)}, sk=${String(sample?.sk)}, project_id=${String(
        sample?.project_id,
      )}, occurred_at=${String(sample?.occurred_at)}, run_id=${String(sample?.run_id)}`,
    );
  }
}

export async function getLatestTraceForInsight(insightId: string): Promise<ExtractionTrace | undefined> {
  if (!insightId || insightId.trim().length === 0) return undefined;

  try {
    const response = await docClient.send(
      new QueryCommand({
        TableName: config.insightEvaluationTraceTableName,
        IndexName: TRACE_INSIGHT_INDEX,
        KeyConditionExpression: "insight_id = :insightId",
        ExpressionAttributeValues: {
          ":insightId": insightId,
        },
        ScanIndexForward: false,
        Limit: 1,
      }),
    );

    const item = response.Items?.[0];
    if (!item) return undefined;
    return item as ExtractionTrace;
  } catch (error) {
    console.warn("[eval] failed querying latest extraction trace", {
      insightId,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return undefined;
  }
}

export async function listExtractionTracesByRun(runId: string): Promise<ExtractionTrace[]> {
  if (!runId || runId.trim().length === 0) return [];

  const response = await docClient.send(
    new QueryCommand({
      TableName: config.insightEvaluationTraceTableName,
      KeyConditionExpression: "pk = :runId",
      ExpressionAttributeValues: {
        ":runId": runId,
      },
    }),
  );

  return (response.Items ?? []) as ExtractionTrace[];
}

export async function listExtractionTracesByProject(projectId: string): Promise<ExtractionTrace[]> {
  if (!projectId || projectId.trim().length === 0) return [];

  try {
    const rows: ExtractionTrace[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
      const response = await docClient.send(
        new QueryCommand({
          TableName: config.insightEvaluationTraceTableName,
          IndexName: TRACE_PROJECT_CREATED_AT_INDEX,
          KeyConditionExpression: "#project_id = :projectId",
          ExpressionAttributeNames: {
            "#project_id": "project_id",
          },
          ExpressionAttributeValues: {
            ":projectId": projectId,
          },
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );

      rows.push(...((response.Items ?? []) as ExtractionTrace[]));
      lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);

    return rows;
  } catch (error) {
    console.warn("[eval] failed querying extraction traces by project", {
      projectId,
      indexName: TRACE_PROJECT_CREATED_AT_INDEX,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return [];
  }
}

export async function listReviewEventsByProject(projectId: string): Promise<InsightReviewEvent[]> {
  if (!projectId || projectId.trim().length === 0) return [];

  const response = await docClient.send(
    new QueryCommand({
      TableName: config.insightReviewEventTableName,
      KeyConditionExpression: "pk = :projectId",
      ExpressionAttributeValues: {
        ":projectId": projectId,
      },
    }),
  );

  return (response.Items ?? []) as InsightReviewEvent[];
}

export async function listReviewEventsByRun(runId: string): Promise<InsightReviewEvent[]> {
  if (!runId || runId.trim().length === 0) return [];

  try {
    const response = await docClient.send(
      new QueryCommand({
        TableName: config.insightReviewEventTableName,
        IndexName: REVIEW_RUN_INDEX,
        KeyConditionExpression: "run_id = :runId",
        ExpressionAttributeValues: {
          ":runId": runId,
        },
      }),
    );

    return (response.Items ?? []) as InsightReviewEvent[];
  } catch (error) {
    console.warn("[eval] failed querying review events by run", {
      runId,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return [];
  }
}

export async function deleteAllExtractionTraces(): Promise<number> {
  const keys = await scanAllTableKeys(config.insightEvaluationTraceTableName);
  await batchDeleteByKeys(config.insightEvaluationTraceTableName, keys);
  return keys.length;
}

export async function deleteAllReviewEvents(): Promise<number> {
  const keys = await scanAllTableKeys(config.insightReviewEventTableName);
  await batchDeleteByKeys(config.insightReviewEventTableName, keys);
  return keys.length;
}

export async function putExtractionTrace(trace: ExtractionTrace): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: config.insightEvaluationTraceTableName,
      Item: {
        ...trace,
        pk: trace.run_id,
        sk: trace.insight_id,
        create_at: trace.created_at,
      },
    }),
  );
}

export async function putReviewEvent(event: InsightReviewEvent): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: config.insightReviewEventTableName,
      Item: {
        ...event,
        run_id: normalizedReviewRunId(event),
        pk: event.project_id,
        sk: `${event.occurred_at}#${event.event_id}`,
        created_at: event.occurred_at,
        updated_at: event.occurred_at,
        occured_at: reviewEventKeyOccurredAt(event),
      },
    }),
  );
}

async function getTableKeyAttributes(tableName: string): Promise<string[]> {
  const response = await client.send(
    new DescribeTableCommand({
      TableName: tableName,
    }),
  );
  const keyAttributes = (response.Table?.KeySchema ?? [])
    .map((entry) => entry.AttributeName)
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  if (keyAttributes.length === 0) {
    throw new Error(`Unable to determine key schema for ${tableName}`);
  }
  return keyAttributes;
}

async function scanAllTableKeys(tableName: string): Promise<DynamoKey[]> {
  const keyAttributes = await getTableKeyAttributes(tableName);
  const expressionAttributeNames = Object.fromEntries(
    keyAttributes.map((attribute, index) => [`#key${index}`, attribute]),
  );
  const keys = new Map<string, DynamoKey>();
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: Object.keys(expressionAttributeNames).join(", "),
        ExpressionAttributeNames: expressionAttributeNames,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const key = Object.fromEntries(
        keyAttributes
          .map((attribute) => [attribute, item[attribute]])
          .filter(([, value]) => value !== undefined),
      );
      if (Object.keys(key).length !== keyAttributes.length) continue;
      keys.set(JSON.stringify(key), key);
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return Array.from(keys.values());
}

async function batchDeleteByKeys(
  tableName: string,
  keys: DynamoKey[],
): Promise<void> {
  if (keys.length === 0) return;

  const deleteRequests: BatchDeleteRequest[] = keys.map((key) => ({
    DeleteRequest: { Key: key },
  }));

  for (let index = 0; index < deleteRequests.length; index += MAX_BATCH) {
    let unprocessed = deleteRequests.slice(index, index + MAX_BATCH);

    for (let attempt = 0; attempt <= MAX_RETRIES && unprocessed.length > 0; attempt += 1) {
      const response = await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: unprocessed,
          },
        }),
      );

      unprocessed = Array.from(
        (response.UnprocessedItems?.[tableName] ?? []) as BatchDeleteRequest[],
      );
      if (unprocessed.length > 0) {
        await sleep(Math.min(2000 * Math.pow(2, attempt), 8000));
      }
    }

    if (unprocessed.length > 0) {
      throw new Error(`Failed to delete ${unprocessed.length} records from ${tableName}.`);
    }
  }
}
