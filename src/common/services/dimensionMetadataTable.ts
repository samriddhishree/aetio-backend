import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { WriteRequest } from "@aws-sdk/client-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { getCachedAwsAssumeRoleProvider } from "./aws";
import { config } from "./config";
import { sleep } from "./utils";

export type PersistedDimensionValueMetadata = {
  value_id: string;
  canonical_value: string;
  display_value: string;
  description?: string;
  synonyms?: string[];
  parent_value_id?: string | null;
  sort_order?: number;
  is_other?: boolean;
  is_unknown?: boolean;
  raw_source_values?: string[];
};

export type PersistedDimensionMetadata = {
  dimension_id: string;
  canonical_name: string;
  display_name: string;
  description?: string;
  parent_dimension_id?: string | null;
  level?: number;
  dimension_type:
    | "categorical"
    | "temporal"
    | "geographic"
    | "ordinal"
    | "numeric_bucket"
    | "boolean"
    | "entity";
  value_type:
    | "string"
    | "number"
    | "date"
    | "datetime"
    | "boolean";
  synonyms?: string[];
  aliases?: string[];
  allowed_values?: PersistedDimensionValueMetadata[];
  tags?: string[];
  status?: "active" | "deprecated" | "Declined";
  s3_node: string;
  document_id: string;
  document_ids: string[];
  source_types: string[];
  project_id?: string;
  organization_id?: string;
  user_id?: string;
  created_at: string;
  updated_at: string;
};

const client = new DynamoDBClient({
  credentials: getCachedAwsAssumeRoleProvider(),
});

const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

export async function putDimensionMetadata(record: PersistedDimensionMetadata): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: config.dimensionMetadataTableName,
      Item: record,
    }),
  );
}

export async function getDimensionMetadata(
  dimensionId: string,
): Promise<PersistedDimensionMetadata | undefined> {
  if (!dimensionId || dimensionId.trim().length === 0) return undefined;

  const response = await docClient.send(
    new GetCommand({
      TableName: config.dimensionMetadataTableName,
      Key: { dimension_id: dimensionId },
    }),
  );

  return response.Item as PersistedDimensionMetadata | undefined;
}

export async function deleteDimensionMetadata(dimensionId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: config.dimensionMetadataTableName,
      Key: { dimension_id: dimensionId },
    }),
  );
}

const MAX_BATCH = 25;
const MAX_RETRIES = 5;

export async function deleteDimensionMetadataByProjectId(projectId: string): Promise<number> {
  if (!projectId || projectId.trim().length === 0) return 0;

  const keys = await scanDimensionMetadataKeysForProject(projectId);
  await batchDeleteByKeys(keys);
  return keys.length;
}

export async function deleteAllDimensionMetadata(): Promise<number> {
  const keys = await scanAllDimensionMetadataKeys();
  await batchDeleteByKeys(keys);
  return keys.length;
}

export async function setDimensionMetadataStatusByProjectAndCanonicalNames(input: {
  projectId: string;
  canonicalNames: string[];
  status: PersistedDimensionMetadata["status"];
}): Promise<number> {
  const projectId = input.projectId.trim();
  if (!projectId) return 0;

  const canonicalNameSet = new Set(
    (input.canonicalNames ?? [])
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
  if (canonicalNameSet.size === 0) return 0;

  const dimensionIds: string[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await docClient.send(
      new ScanCommand({
        TableName: config.dimensionMetadataTableName,
        ProjectionExpression: "#dimension_id, #canonical_name",
        FilterExpression: "#project_id = :projectId",
        ExpressionAttributeNames: {
          "#dimension_id": "dimension_id",
          "#canonical_name": "canonical_name",
          "#project_id": "project_id",
        },
        ExpressionAttributeValues: {
          ":projectId": projectId,
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const dimensionId = typeof item.dimension_id === "string" ? item.dimension_id.trim() : "";
      const canonicalName =
        typeof item.canonical_name === "string" ? item.canonical_name.trim().toLowerCase() : "";
      if (!dimensionId || !canonicalName) continue;
      if (!canonicalNameSet.has(canonicalName)) continue;
      dimensionIds.push(dimensionId);
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  if (dimensionIds.length === 0) return 0;

  let updated = 0;
  for (const dimensionId of dimensionIds) {
    await docClient.send(
      new UpdateCommand({
        TableName: config.dimensionMetadataTableName,
        Key: { dimension_id: dimensionId },
        UpdateExpression: "SET #status = :status, #updated_at = :updatedAt",
        ExpressionAttributeNames: {
          "#status": "status",
          "#updated_at": "updated_at",
        },
        ExpressionAttributeValues: {
          ":status": input.status,
          ":updatedAt": new Date().toISOString(),
        },
      }),
    );
    updated += 1;
  }

  return updated;
}

async function scanDimensionMetadataKeysForProject(
  projectId: string,
): Promise<Array<{ dimension_id: string }>> {
  const keys = new Map<string, { dimension_id: string }>();
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await docClient.send(
      new ScanCommand({
        TableName: config.dimensionMetadataTableName,
        ProjectionExpression: "#dimension_id",
        FilterExpression: "#project_id = :projectId",
        ExpressionAttributeNames: {
          "#dimension_id": "dimension_id",
          "#project_id": "project_id",
        },
        ExpressionAttributeValues: {
          ":projectId": projectId,
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const dimensionId = item.dimension_id;
      if (typeof dimensionId === "string" && dimensionId.trim().length > 0) {
        keys.set(dimensionId, { dimension_id: dimensionId });
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return Array.from(keys.values());
}

async function scanAllDimensionMetadataKeys(): Promise<Array<{ dimension_id: string }>> {
  const keys = new Map<string, { dimension_id: string }>();
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await docClient.send(
      new ScanCommand({
        TableName: config.dimensionMetadataTableName,
        ProjectionExpression: "#dimension_id",
        ExpressionAttributeNames: {
          "#dimension_id": "dimension_id",
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const dimensionId = item.dimension_id;
      if (typeof dimensionId === "string" && dimensionId.trim().length > 0) {
        keys.set(dimensionId, { dimension_id: dimensionId });
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return Array.from(keys.values());
}

async function batchDeleteByKeys(keys: Array<{ dimension_id: string }>): Promise<void> {
  if (keys.length === 0) return;

  const deleteRequests = keys.map(
    (key) =>
      ({
        DeleteRequest: { Key: key },
      }) as WriteRequest,
  );

  for (let index = 0; index < deleteRequests.length; index += MAX_BATCH) {
    let unprocessed = deleteRequests.slice(index, index + MAX_BATCH);

    for (let attempt = 0; attempt <= MAX_RETRIES && unprocessed.length > 0; attempt += 1) {
      const response = await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [config.dimensionMetadataTableName]: unprocessed,
          },
        }),
      );

      const remaining = response.UnprocessedItems?.[config.dimensionMetadataTableName];
      unprocessed = (remaining ? Array.from(remaining) : []) as WriteRequest[];

      if (unprocessed.length > 0) {
        const backoffMs = Math.min(2000 * Math.pow(2, attempt), 10000);
        await sleep(backoffMs);
      }
    }

    if (unprocessed.length > 0) {
      throw new Error(
        `Failed to delete ${unprocessed.length} dimension_metadata records after retries.`,
      );
    }
  }
}
