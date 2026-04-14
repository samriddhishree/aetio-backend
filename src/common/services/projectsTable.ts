import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { WriteRequest } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getCachedAwsAssumeRoleProvider } from "./aws";
import { config } from "./config";
import type { UserInfo } from "../../types";
import { sleep } from "./utils";

const client = new DynamoDBClient({
  credentials: getCachedAwsAssumeRoleProvider(),
});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

export const PENDING_PROJECT_STATUS = "Pending";

type UpsertPendingProjectInput = {
  userId: string;
  projectId: string;
  userInfo?: UserInfo;
  uploadMode?: "document" | "manual";
  researchContext?: string;
  contextUrls?: string[];
  outputUrls?: string[];
  rawDataUrls?: string[];
};

type UpdateProjectInsightIdsInput = {
  userId: string;
  projectId: string;
  insightIds: string[];
};

type UpdateProjectMetadataDimensionIdsInput = {
  userId: string;
  projectId: string;
  dimensionIds: string[];
};

export type ProjectRecord = {
  user_id: string;
  status: string;
  project_id: string;
  insight_ids?: string[];
  countAccepted?: number;
  countDeclined?: number;
  numberChildInsights?: number;
  metadata?: string[];
  user_info?: UserInfo;
  upload_mode?: "document" | "manual";
  research_context?: string;
  context_urls?: string[];
  output_urls?: string[];
  raw_data_urls?: string[];
  created_at?: string;
  updated_at?: string;
};

export async function upsertPendingProject(input: UpsertPendingProjectInput): Promise<void> {
  const now = new Date().toISOString();
  const contextUrls = Array.isArray(input.contextUrls) ? input.contextUrls : [];
  const outputUrls = Array.isArray(input.outputUrls) ? input.outputUrls : [];
  const rawDataUrls = Array.isArray(input.rawDataUrls) ? input.rawDataUrls : [];

  await docClient.send(
    new PutCommand({
      TableName: config.projectsTableName,
      Item: {
        user_id: input.userId,
        status: PENDING_PROJECT_STATUS,
        project_id: input.projectId,
        insight_ids: [],
        countAccepted: 0,
        countDeclined: 0,
        numberChildInsights: 0,
        user_info: input.userInfo,
        upload_mode: input.uploadMode,
        research_context: input.researchContext,
        context_urls: contextUrls,
        output_urls: outputUrls,
        raw_data_urls: rawDataUrls,
        created_at: now,
        updated_at: now,
      },
    }),
  );
}

export async function updatePendingProjectInsightIds(
  input: UpdateProjectInsightIdsInput,
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: config.projectsTableName,
      Key: {
        user_id: input.userId,
        status: PENDING_PROJECT_STATUS,
      },
      UpdateExpression:
        "SET project_id = :projectId, insight_ids = :insightIds, updated_at = :updatedAt",
      ExpressionAttributeValues: {
        ":projectId": input.projectId,
        ":insightIds": input.insightIds,
        ":updatedAt": new Date().toISOString(),
      },
    }),
  );
}

export async function updatePendingProjectMetadataDimensionIds(
  input: UpdateProjectMetadataDimensionIdsInput,
): Promise<void> {
  const dimensionIds = Array.from(
    new Set(
      (input.dimensionIds ?? [])
        .map((dimensionId) => dimensionId.trim())
        .filter((dimensionId) => dimensionId.length > 0),
    ),
  );

  await docClient.send(
    new UpdateCommand({
      TableName: config.projectsTableName,
      Key: {
        user_id: input.userId,
        status: PENDING_PROJECT_STATUS,
      },
      UpdateExpression:
        "SET project_id = :projectId, metadata = :metadata, updated_at = :updatedAt",
      ExpressionAttributeValues: {
        ":projectId": input.projectId,
        ":metadata": dimensionIds,
        ":updatedAt": new Date().toISOString(),
      },
    }),
  );
}

export async function updateProjectCountsByProjectId(input: {
  projectId: string;
  countAccepted: number;
  countDeclined: number;
  numberChildInsights: number;
}): Promise<number> {
  const projectId = input.projectId.trim();
  if (!projectId) return 0;

  const keys = await scanProjectKeysByProjectId(projectId);
  if (keys.length === 0) return 0;

  const updatedAt = new Date().toISOString();
  await Promise.all(
    keys.map((key) =>
      docClient.send(
        new UpdateCommand({
          TableName: config.projectsTableName,
          Key: key,
          UpdateExpression:
            "SET project_id = :projectId, countAccepted = :countAccepted, countDeclined = :countDeclined, numberChildInsights = :numberChildInsights, updated_at = :updatedAt",
          ExpressionAttributeValues: {
            ":projectId": projectId,
            ":countAccepted": input.countAccepted,
            ":countDeclined": input.countDeclined,
            ":numberChildInsights": input.numberChildInsights,
            ":updatedAt": updatedAt,
          },
        }),
      ),
    ),
  );

  return keys.length;
}

export async function listProjectsByUserAndStatus(input: {
  userId: string;
  status: string;
}): Promise<ProjectRecord[]> {
  const userId = input.userId.trim();
  const status = input.status.trim();
  if (!userId || !status) return [];

  const response = await docClient.send(
    new QueryCommand({
      TableName: config.projectsTableName,
      KeyConditionExpression: "#user_id = :userId AND #status = :status",
      ExpressionAttributeNames: {
        "#user_id": "user_id",
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":userId": userId,
        ":status": status,
      },
    }),
  );

  const items = Array.isArray(response.Items) ? response.Items : [];
  return items as ProjectRecord[];
}

const MAX_BATCH = 25;
const MAX_RETRIES = 5;

export async function deleteProjectsByProjectId(projectId: string): Promise<number> {
  if (!projectId || projectId.trim().length === 0) return 0;

  const keys = await scanProjectKeysByProjectId(projectId);
  await batchDeleteByKeys(keys);
  return keys.length;
}

export async function deleteAllProjects(): Promise<number> {
  const keys = await scanAllProjectKeys();
  await batchDeleteByKeys(keys);
  return keys.length;
}

async function scanProjectKeysByProjectId(
  projectId: string,
): Promise<Array<{ user_id: string; status: string }>> {
  const keys = new Map<string, { user_id: string; status: string }>();
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await docClient.send(
      new ScanCommand({
        TableName: config.projectsTableName,
        ProjectionExpression: "#user_id, #status",
        FilterExpression: "#project_id = :projectId",
        ExpressionAttributeNames: {
          "#project_id": "project_id",
          "#user_id": "user_id",
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":projectId": projectId,
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const userId = item.user_id;
      const status = item.status;
      if (
        typeof userId === "string" &&
        userId.trim().length > 0 &&
        typeof status === "string" &&
        status.trim().length > 0
      ) {
        keys.set(`${userId}::${status}`, { user_id: userId, status });
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return Array.from(keys.values());
}

async function scanAllProjectKeys(): Promise<Array<{ user_id: string; status: string }>> {
  const keys = new Map<string, { user_id: string; status: string }>();
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await docClient.send(
      new ScanCommand({
        TableName: config.projectsTableName,
        ProjectionExpression: "#user_id, #status",
        ExpressionAttributeNames: {
          "#user_id": "user_id",
          "#status": "status",
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const userId = item.user_id;
      const status = item.status;
      if (
        typeof userId === "string" &&
        userId.trim().length > 0 &&
        typeof status === "string" &&
        status.trim().length > 0
      ) {
        keys.set(`${userId}::${status}`, { user_id: userId, status });
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return Array.from(keys.values());
}

async function batchDeleteByKeys(keys: Array<{ user_id: string; status: string }>): Promise<void> {
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
            [config.projectsTableName]: unprocessed,
          },
        }),
      );

      const remaining = response.UnprocessedItems?.[config.projectsTableName];
      unprocessed = (remaining ? Array.from(remaining) : []) as WriteRequest[];

      if (unprocessed.length > 0) {
        const backoffMs = Math.min(2000 * Math.pow(2, attempt), 10000);
        await sleep(backoffMs);
      }
    }

    if (unprocessed.length > 0) {
      throw new Error(`Failed to delete ${unprocessed.length} project records after retries.`);
    }
  }
}
