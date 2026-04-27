import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { getCachedAwsAssumeRoleProvider } from "./aws";
import { config } from "./config";
import { sleep } from "./utils";

export type PersistedInsightFamilyData = {
  table_id: string;
  family_id: string;
  question_answered?: string;
  project_id?: string;
  organization_id?: string;
  user_id?: string;
  status?: string;
  s3_node: string;
  document_id: string;
  document_ids: string[];
  source_types: string[];
  row_count: number;
  dimensions: string[];
  metric_columns: string[];
  table_markdown?: string;
  table_text_chunk?: string;
  raw_table?: unknown;
  table_semantic_object?: unknown;
  table_understanding_summary?: unknown;
  source_modalities: Array<"text" | "table" | "image">;
  rows: Array<{
    row_id: string;
    family_id: string;
    filter_values: Array<{
      dimension_id: string;
      dimension_name: string;
      value_id?: string;
      value: string;
      display_value?: string;
    }>;
    metric_name?: string;
    value_text: string;
    metric_value?: string | number;
    metric_unit?: string;
    supporting_refs: Array<{
      chunk_id?: string;
      table_id?: string;
      page?: number;
      section_title?: string;
      row_index?: number;
      row_indices?: number[];
      evidence_cells?: Array<{ row: number; col: number }>;
      cell_refs?: string[];
      source_excerpt?: string;
      source_file?: string;
      element_type?: string;
      sheet_name?: string;
      table_region?: string;
    }>;
  }>;
  created_at: string;
  updated_at: string;
};

export type InsightFamilyDataFilterKey =
  | "table_id"
  | "family_id"
  | "project_id"
  | "user_id"
  | "status"
  | "s3_node";

export type InsightFamilyDataFilters = Partial<
  Record<InsightFamilyDataFilterKey, string | string[] | null>
>;

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
type BatchDeleteRequest = NonNullable<BatchWriteCommandInput["RequestItems"]>[string][number];
type DynamoKey = Record<string, unknown>;

export async function putInsightFamilyData(record: PersistedInsightFamilyData): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: config.insightFamilyDataTableName,
      Item: record,
    }),
  );
}

export async function getInsightFamilyData(
  tableId: string,
): Promise<PersistedInsightFamilyData | undefined> {
  if (!tableId || tableId.trim().length === 0) return undefined;

  const response = await docClient.send(
    new GetCommand({
      TableName: config.insightFamilyDataTableName,
      Key: { table_id: tableId },
    }),
  );

  return response.Item as PersistedInsightFamilyData | undefined;
}

export async function deleteInsightFamilyData(tableId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: config.insightFamilyDataTableName,
      Key: { table_id: tableId },
    }),
  );
}

export async function deleteAllInsightFamilyData(): Promise<number> {
  const keys = await scanAllInsightFamilyDataKeys();
  await batchDeleteByKeys(keys);
  return keys.length;
}

export async function listInsightFamilyData(
  filters: InsightFamilyDataFilters = {},
): Promise<PersistedInsightFamilyData[]> {
  const filterEntries = Object.entries(filters).filter(([, value]) => value !== undefined) as Array<
    [InsightFamilyDataFilterKey, string | string[] | null]
  >;

  if (filterEntries.length === 0) {
    throw new Error(
      "listInsightFamilyData requires at least one filter. Without a fixed secondary index, only table_id lookups are supported.",
    );
  }

  if (filters.table_id === undefined) {
    throw new Error(
      "listInsightFamilyData currently supports table_id lookups only. Add a fixed GSI if you need family_id/project_id/user_id/status/s3_node queries.",
    );
  }

  const tableIds = normalizeFilterValues(filters.table_id);
  const items = await Promise.all(tableIds.map((tableId) => getInsightFamilyData(tableId)));

  return items
    .filter((item): item is PersistedInsightFamilyData => Boolean(item))
    .filter((item) => matchesFilters(item, filters));
}

function normalizeFilterValues(value: string | string[] | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return Array.from(new Set(value));
  return [value];
}

function matchesFilters(
  item: PersistedInsightFamilyData,
  filters: InsightFamilyDataFilters,
): boolean {
  for (const [rawKey, rawValue] of Object.entries(filters) as Array<
    [InsightFamilyDataFilterKey, string | string[] | null | undefined]
  >) {
    if (rawValue === undefined) continue;

    const itemValue = item[rawKey];

    if (rawValue === null) {
      if (itemValue !== undefined) return false;
      continue;
    }

    if (Array.isArray(rawValue)) {
      if (typeof itemValue !== "string") return false;
      if (!rawValue.includes(itemValue)) return false;
      continue;
    }

    if (itemValue !== rawValue) return false;
  }

  return true;
}

async function getInsightFamilyDataKeyAttributes(): Promise<string[]> {
  const response = await client.send(
    new DescribeTableCommand({
      TableName: config.insightFamilyDataTableName,
    }),
  );
  const keyAttributes = (response.Table?.KeySchema ?? [])
    .map((entry) => entry.AttributeName)
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  if (keyAttributes.length === 0) {
    throw new Error(`Unable to determine key schema for ${config.insightFamilyDataTableName}`);
  }
  return keyAttributes;
}

async function scanAllInsightFamilyDataKeys(): Promise<DynamoKey[]> {
  const keyAttributes = await getInsightFamilyDataKeyAttributes();
  const expressionAttributeNames = Object.fromEntries(
    keyAttributes.map((attribute, index) => [`#key${index}`, attribute]),
  );
  const keys = new Map<string, DynamoKey>();
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await docClient.send(
      new ScanCommand({
        TableName: config.insightFamilyDataTableName,
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

async function batchDeleteByKeys(keys: DynamoKey[]): Promise<void> {
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
            [config.insightFamilyDataTableName]: unprocessed,
          },
        }),
      );

      const remaining = response.UnprocessedItems?.[config.insightFamilyDataTableName];
      unprocessed = remaining ? Array.from(remaining) : [];

      if (unprocessed.length > 0) {
        const backoffMs = Math.min(2000 * Math.pow(2, attempt), 10000);
        await sleep(backoffMs);
      }
    }

    if (unprocessed.length > 0) {
      throw new Error(`Failed to delete ${unprocessed.length} insight family data records after retries.`);
    }
  }
}
