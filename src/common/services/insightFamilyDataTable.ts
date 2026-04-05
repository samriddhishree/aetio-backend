import { DeleteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { getCachedAwsAssumeRoleProvider } from "./aws";
import { config } from "./config";

export type PersistedInsightFamilyData = {
  table_id: string;
  family_id: string;
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
  source_modalities: Array<"text" | "table" | "image">;
  rows: Array<{
    row_id: string;
    family_id: string;
    filter_values: Array<{ tag: string; value: string }>;
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

export async function putInsightFamilyData(record: PersistedInsightFamilyData): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: config.insightFamilyDataTableName,
      Item: record,
    }),
  );
}

export async function deleteInsightFamilyData(tableId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: config.insightFamilyDataTableName,
      Key: { table_id: tableId },
    }),
  );
}

export async function listInsightFamilyData(
  filters: InsightFamilyDataFilters = {},
): Promise<PersistedInsightFamilyData[]> {
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
  const items: PersistedInsightFamilyData[] = [];

  do {
    const response = await docClient.send(
      new ScanCommand({
        TableName: config.insightFamilyDataTableName,
        ...(conditions.length > 0
          ? {
              FilterExpression: conditions.join(" AND "),
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            }
          : {}),
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    items.push(...((response.Items ?? []) as PersistedInsightFamilyData[]));
    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return items;
}
