import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
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
