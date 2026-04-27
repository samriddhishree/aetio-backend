import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
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
type BatchDeleteRequest = NonNullable<BatchWriteCommandInput["RequestItems"]>[string][number];
type ProjectDynamoKey = Record<string, string>;

export const PENDING_PROJECT_STATUS = "Pending";

type ProjectsKeyMode = "project_id" | "user_status";

const LEGACY_PENDING_STATUS_DELIMITER = "#";

let keyModePromise: Promise<ProjectsKeyMode> | null = null;

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
  createdAt?: string;
  updatedAt?: string;
};

function legacyPendingStatus(projectId: string): string {
  return `${PENDING_PROJECT_STATUS}${LEGACY_PENDING_STATUS_DELIMITER}${projectId}`;
}

function normalizeStatusForResponse(status: string): string {
  const trimmed = status.trim();
  const legacyPrefix = `${PENDING_PROJECT_STATUS}${LEGACY_PENDING_STATUS_DELIMITER}`;
  if (trimmed === PENDING_PROJECT_STATUS || trimmed.startsWith(legacyPrefix)) {
    return PENDING_PROJECT_STATUS;
  }
  return trimmed;
}

function normalizeProjectRecordTimestamps(record: ProjectRecord): ProjectRecord {
  const createdAt =
    typeof record.createdAt === "string"
      ? record.createdAt
      : typeof record.created_at === "string"
        ? record.created_at
        : undefined;
  const updatedAt =
    typeof record.updatedAt === "string"
      ? record.updatedAt
      : typeof record.updated_at === "string"
        ? record.updated_at
        : undefined;

  return {
    ...record,
    status: normalizeStatusForResponse(record.status),
    ...(createdAt
      ? {
          created_at: record.created_at ?? createdAt,
          createdAt,
        }
      : {}),
    ...(updatedAt
      ? {
          updated_at: record.updated_at ?? updatedAt,
          updatedAt,
        }
      : {}),
  };
}

async function getProjectsKeyMode(): Promise<ProjectsKeyMode> {
  if (keyModePromise) return keyModePromise;

  keyModePromise = (async () => {
    try {
      const response = await client.send(
        new DescribeTableCommand({
          TableName: config.projectsTableName,
        }),
      );
      const keySchema = response.Table?.KeySchema ?? [];
      const hashKey = keySchema.find((entry) => entry.KeyType === "HASH")?.AttributeName;
      return hashKey === "project_id" ? "project_id" : "user_status";
    } catch (error) {
      console.warn("[projects] failed to describe table schema; defaulting to legacy key mode", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
      return "user_status";
    }
  })();

  return keyModePromise;
}

export async function upsertPendingProject(input: UpsertPendingProjectInput): Promise<void> {
  const mode = await getProjectsKeyMode();
  const now = new Date().toISOString();
  const contextUrls = Array.isArray(input.contextUrls) ? input.contextUrls : [];
  const outputUrls = Array.isArray(input.outputUrls) ? input.outputUrls : [];
  const rawDataUrls = Array.isArray(input.rawDataUrls) ? input.rawDataUrls : [];

  await docClient.send(
    new PutCommand({
      TableName: config.projectsTableName,
      Item: {
        user_id: input.userId,
        status:
          mode === "project_id" ? PENDING_PROJECT_STATUS : legacyPendingStatus(input.projectId),
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
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

export async function updatePendingProjectInsightIds(
  input: UpdateProjectInsightIdsInput,
): Promise<void> {
  const mode = await getProjectsKeyMode();

  if (mode === "project_id") {
    await docClient.send(
      new UpdateCommand({
        TableName: config.projectsTableName,
        Key: {
          project_id: input.projectId,
        },
        UpdateExpression:
          "SET user_id = :userId, #status = :status, insight_ids = :insightIds, updated_at = :updatedAt, updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":userId": input.userId,
          ":status": PENDING_PROJECT_STATUS,
          ":insightIds": input.insightIds,
          ":updatedAt": new Date().toISOString(),
        },
        ConditionExpression: "attribute_exists(project_id)",
      }),
    );
    return;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: config.projectsTableName,
      Key: {
        user_id: input.userId,
        status: legacyPendingStatus(input.projectId),
      },
      UpdateExpression:
        "SET project_id = :projectId, insight_ids = :insightIds, updated_at = :updatedAt, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":projectId": input.projectId,
        ":insightIds": input.insightIds,
        ":updatedAt": new Date().toISOString(),
      },
      ConditionExpression: "attribute_exists(user_id) AND attribute_exists(#status)",
      ExpressionAttributeNames: {
        "#status": "status",
      },
    }),
  );
}

export async function updatePendingProjectMetadataDimensionIds(
  input: UpdateProjectMetadataDimensionIdsInput,
): Promise<void> {
  const mode = await getProjectsKeyMode();
  const dimensionIds = Array.from(
    new Set(
      (input.dimensionIds ?? [])
        .map((dimensionId) => dimensionId.trim())
        .filter((dimensionId) => dimensionId.length > 0),
    ),
  );

  if (mode === "project_id") {
    await docClient.send(
      new UpdateCommand({
        TableName: config.projectsTableName,
        Key: {
          project_id: input.projectId,
        },
        UpdateExpression:
          "SET user_id = :userId, #status = :status, metadata = :metadata, updated_at = :updatedAt, updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":userId": input.userId,
          ":status": PENDING_PROJECT_STATUS,
          ":metadata": dimensionIds,
          ":updatedAt": new Date().toISOString(),
        },
        ConditionExpression: "attribute_exists(project_id)",
      }),
    );
    return;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: config.projectsTableName,
      Key: {
        user_id: input.userId,
        status: legacyPendingStatus(input.projectId),
      },
      UpdateExpression:
        "SET project_id = :projectId, metadata = :metadata, updated_at = :updatedAt, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":projectId": input.projectId,
        ":metadata": dimensionIds,
        ":updatedAt": new Date().toISOString(),
      },
      ConditionExpression: "attribute_exists(user_id) AND attribute_exists(#status)",
      ExpressionAttributeNames: {
        "#status": "status",
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

  const mode = await getProjectsKeyMode();
  const updatedAt = new Date().toISOString();

  if (mode === "project_id") {
    const existing = await getProjectById(projectId);
    if (!existing) return 0;

    await docClient.send(
      new UpdateCommand({
        TableName: config.projectsTableName,
        Key: {
          project_id: projectId,
        },
        UpdateExpression:
          "SET countAccepted = :countAccepted, countDeclined = :countDeclined, numberChildInsights = :numberChildInsights, updated_at = :updatedAt, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":countAccepted": input.countAccepted,
          ":countDeclined": input.countDeclined,
          ":numberChildInsights": input.numberChildInsights,
          ":updatedAt": updatedAt,
        },
        ConditionExpression: "attribute_exists(project_id)",
      }),
    );
    return 1;
  }

  const keys = await scanLegacyProjectKeysByProjectId(projectId);
  if (keys.length === 0) return 0;

  await Promise.all(
    keys.map((key) =>
      docClient.send(
        new UpdateCommand({
          TableName: config.projectsTableName,
          Key: key,
          UpdateExpression:
            "SET project_id = :projectId, countAccepted = :countAccepted, countDeclined = :countDeclined, numberChildInsights = :numberChildInsights, updated_at = :updatedAt, updatedAt = :updatedAt",
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

  const mode = await getProjectsKeyMode();
  let projects: ProjectRecord[] = [];

  if (mode === "project_id") {
    projects = await queryProjectsByUserAndStatusIndex({
      userId,
      status,
    });
  } else if (status === PENDING_PROJECT_STATUS) {
    const prefixed = await queryLegacyProjectsByStatusPrefix({
      userId,
      statusPrefix: `${PENDING_PROJECT_STATUS}${LEGACY_PENDING_STATUS_DELIMITER}`,
    });
    const exact = await queryLegacyProjectsByExactStatus({
      userId,
      status,
    });
    const byProjectId = new Map<string, ProjectRecord>();
    for (const record of [...prefixed, ...exact]) {
      const key = `${record.project_id}::${record.user_id}::${record.status}`;
      byProjectId.set(key, record);
    }
    projects = Array.from(byProjectId.values());
  } else {
    projects = await queryLegacyProjectsByExactStatus({
      userId,
      status,
    });
  }

  return projects
    .map((project) => normalizeProjectRecordTimestamps(project))
    .sort((left, right) =>
      (right.updated_at ?? right.updatedAt ?? "").localeCompare(left.updated_at ?? left.updatedAt ?? ""),
    );
}

async function queryProjectsByUserAndStatusIndex(input: {
  userId: string;
  status: string;
}): Promise<ProjectRecord[]> {
  try {
    const response = await docClient.send(
      new QueryCommand({
        TableName: config.projectsTableName,
        IndexName: config.projectsUserStatusIndexName,
        KeyConditionExpression: "#user_id = :userId AND #status = :status",
        ExpressionAttributeNames: {
          "#user_id": "user_id",
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":userId": input.userId,
          ":status": input.status,
        },
      }),
    );
    return (response.Items ?? []) as ProjectRecord[];
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const normalized = message.toLowerCase();
    const missingIndex =
      normalized.includes("index not found")
      || normalized.includes("invalid index")
      || normalized.includes("does not have the specified index");
    if (!missingIndex) throw error;

    console.warn("[projects] user/status index missing, falling back to scan", {
      indexName: config.projectsUserStatusIndexName,
      message,
    });
    return scanProjects({
      FilterExpression: "#user_id = :userId AND #status = :status",
      ExpressionAttributeNames: {
        "#user_id": "user_id",
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":userId": input.userId,
        ":status": input.status,
      },
    });
  }
}

const MAX_BATCH = 25;
const MAX_RETRIES = 5;

export async function deleteProjectsByProjectId(projectId: string): Promise<number> {
  const trimmed = projectId?.trim();
  if (!trimmed) return 0;

  const mode = await getProjectsKeyMode();
  if (mode === "project_id") {
    const existing = await getProjectById(trimmed);
    if (!existing) return 0;
    await docClient.send(
      new DeleteCommand({
        TableName: config.projectsTableName,
        Key: {
          project_id: trimmed,
        },
      }),
    );
    return 1;
  }

  const keys = await scanLegacyProjectKeysByProjectId(trimmed);
  await batchDeleteByKeys(keys);
  return keys.length;
}

export async function deleteAllProjects(): Promise<number> {
  const mode = await getProjectsKeyMode();
  const keys =
    mode === "project_id"
      ? await scanAllProjectKeysByProjectId()
      : await scanAllProjectKeysByUserStatus();
  await batchDeleteByKeys(keys);
  return keys.length;
}

async function getProjectById(projectId: string): Promise<ProjectRecord | null> {
  const response = await docClient.send(
    new GetCommand({
      TableName: config.projectsTableName,
      Key: {
        project_id: projectId,
      },
    }),
  );
  if (!response.Item) return null;
  return normalizeProjectRecordTimestamps(response.Item as ProjectRecord);
}

export async function findProjectByProjectId(projectId: string): Promise<ProjectRecord | null> {
  const trimmed = projectId.trim();
  if (!trimmed) return null;

  const mode = await getProjectsKeyMode();
  if (mode === "project_id") {
    return getProjectById(trimmed);
  }

  const projects = await scanProjects({
    FilterExpression: "#project_id = :projectId",
    ExpressionAttributeNames: {
      "#project_id": "project_id",
    },
    ExpressionAttributeValues: {
      ":projectId": trimmed,
    },
  });

  return projects[0] ? normalizeProjectRecordTimestamps(projects[0]) : null;
}

async function scanProjects(input?: {
  FilterExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
  ProjectionExpression?: string;
}): Promise<ProjectRecord[]> {
  const items: ProjectRecord[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await docClient.send(
      new ScanCommand({
        TableName: config.projectsTableName,
        ...(input?.ProjectionExpression ? { ProjectionExpression: input.ProjectionExpression } : {}),
        ...(input?.FilterExpression ? { FilterExpression: input.FilterExpression } : {}),
        ...(input?.ExpressionAttributeNames
          ? { ExpressionAttributeNames: input.ExpressionAttributeNames }
          : {}),
        ...(input?.ExpressionAttributeValues
          ? { ExpressionAttributeValues: input.ExpressionAttributeValues }
          : {}),
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    items.push(...((response.Items ?? []) as ProjectRecord[]));
    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return items;
}

async function queryLegacyProjectsByExactStatus(input: {
  userId: string;
  status: string;
}): Promise<ProjectRecord[]> {
  const response = await docClient.send(
    new QueryCommand({
      TableName: config.projectsTableName,
      KeyConditionExpression: "#user_id = :userId AND #status = :status",
      ExpressionAttributeNames: {
        "#user_id": "user_id",
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":userId": input.userId,
        ":status": input.status,
      },
    }),
  );
  return (response.Items ?? []) as ProjectRecord[];
}

async function queryLegacyProjectsByStatusPrefix(input: {
  userId: string;
  statusPrefix: string;
}): Promise<ProjectRecord[]> {
  const response = await docClient.send(
    new QueryCommand({
      TableName: config.projectsTableName,
      KeyConditionExpression: "#user_id = :userId AND begins_with(#status, :statusPrefix)",
      ExpressionAttributeNames: {
        "#user_id": "user_id",
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":userId": input.userId,
        ":statusPrefix": input.statusPrefix,
      },
    }),
  );
  return (response.Items ?? []) as ProjectRecord[];
}

async function scanLegacyProjectKeysByProjectId(projectId: string): Promise<ProjectDynamoKey[]> {
  const keys = new Map<string, ProjectDynamoKey>();
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
        typeof userId === "string"
        && userId.trim().length > 0
        && typeof status === "string"
        && status.trim().length > 0
      ) {
        keys.set(`${userId}::${status}`, { user_id: userId, status });
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return Array.from(keys.values());
}

async function scanAllProjectKeysByProjectId(): Promise<ProjectDynamoKey[]> {
  const keys = await scanProjects({
    ProjectionExpression: "#project_id",
    ExpressionAttributeNames: {
      "#project_id": "project_id",
    },
  });

  return Array.from(
    new Set(
      keys
        .map((item) => item.project_id)
        .filter((projectId): projectId is string => typeof projectId === "string" && projectId.trim().length > 0),
    ),
  ).map((project_id) => ({ project_id }));
}

async function scanAllProjectKeysByUserStatus(): Promise<ProjectDynamoKey[]> {
  const keys = new Map<string, ProjectDynamoKey>();
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
        typeof userId === "string"
        && userId.trim().length > 0
        && typeof status === "string"
        && status.trim().length > 0
      ) {
        keys.set(`${userId}::${status}`, { user_id: userId, status });
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return Array.from(keys.values());
}

async function batchDeleteByKeys(keys: ProjectDynamoKey[]): Promise<void> {
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
            [config.projectsTableName]: unprocessed,
          },
        }),
      );

      const remaining = response.UnprocessedItems?.[config.projectsTableName];
      unprocessed = remaining ? Array.from(remaining) : [];

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
