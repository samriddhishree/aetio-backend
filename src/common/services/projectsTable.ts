import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getCachedAwsAssumeRoleProvider } from "./aws";
import { config } from "./config";
import type { UserInfo } from "../../types";

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

export type ProjectRecord = {
  user_id: string;
  status: string;
  project_id: string;
  insight_ids?: string[];
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
