import {
  runGenerateInsightsV2MetadataPrepassPipeline,
  runGenerateInsightsV2Pipeline,
  toGenerateInsightsV2MetadataPrepassResponse,
  toGenerateInsightsV2Response,
} from "./graph";
import type {
  GenerateInsightsV2MetadataPrepassResponse,
  GenerateInsightsV2Response,
} from "./types";
import type { UserInfo } from "../types";

export type GenerateInsightsV2Arguments = {
  // v1-compatible inputs
  outputUrls?: string[];
  contextUrls?: string[];
  rawDataUrls?: string[];
  researchContext?: string;
  uploadMode?: "document" | "manual";
  userInfo?: UserInfo;
  user_info?: UserInfo;
  image_blocks?: Array<{ block_id: string; image_s3: string; page: number }>;
  document_id?: string;

  // v2 alias input
  sourceUris?: string[];

  // auth/scoping
  userId?: string;
  projectId?: string;
  organizationId?: string;
  status?: string;
};

export type GenerateInsightsV2Event = {
  arguments: GenerateInsightsV2Arguments;
};

export async function generateInsightsV2Handler(
  event: GenerateInsightsV2Event,
): Promise<GenerateInsightsV2Response> {
  const outputUrls = (event.arguments.outputUrls ?? event.arguments.sourceUris ?? []).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const contextUrls = (event.arguments.contextUrls ?? []).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const researchContext =
    typeof event.arguments.researchContext === "string"
      ? event.arguments.researchContext.trim()
      : undefined;
  const rawDataUrls = (event.arguments.rawDataUrls ?? []).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const uploadMode =
    event.arguments.uploadMode === "document" || event.arguments.uploadMode === "manual"
      ? event.arguments.uploadMode
      : undefined;
  const userInfo = event.arguments.userInfo ?? event.arguments.user_info;

  if (outputUrls.length === 0) {
    throw new Error("outputUrls is required and must be a non-empty array.");
  }

  const sourceUris = Array.from(new Set([...outputUrls, ...contextUrls]));

  const state = await runGenerateInsightsV2Pipeline({
    sourceUris,
    outputUrls,
    contextUrls,
    rawDataUrls,
    researchContext,
    uploadMode,
    userInfo,
    userId: event.arguments.userId,
    projectId: event.arguments.projectId,
    organizationId: event.arguments.organizationId,
    status: event.arguments.status,
  });

  return toGenerateInsightsV2Response(state);
}

export async function generateInsightsV2MetadataPrepassHandler(
  event: GenerateInsightsV2Event,
): Promise<GenerateInsightsV2MetadataPrepassResponse> {
  const outputUrls = (event.arguments.outputUrls ?? event.arguments.sourceUris ?? []).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const contextUrls = (event.arguments.contextUrls ?? []).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const researchContext =
    typeof event.arguments.researchContext === "string"
      ? event.arguments.researchContext.trim()
      : undefined;
  const rawDataUrls = (event.arguments.rawDataUrls ?? []).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const uploadMode =
    event.arguments.uploadMode === "document" || event.arguments.uploadMode === "manual"
      ? event.arguments.uploadMode
      : undefined;
  const userInfo = event.arguments.userInfo ?? event.arguments.user_info;

  if (outputUrls.length === 0) {
    throw new Error("outputUrls is required and must be a non-empty array.");
  }

  const sourceUris = Array.from(new Set([...outputUrls, ...contextUrls]));
  const state = await runGenerateInsightsV2MetadataPrepassPipeline({
    sourceUris,
    outputUrls,
    contextUrls,
    rawDataUrls,
    researchContext,
    uploadMode,
    userInfo,
    userId: event.arguments.userId,
    projectId: event.arguments.projectId,
    organizationId: event.arguments.organizationId,
    status: event.arguments.status,
  });

  return toGenerateInsightsV2MetadataPrepassResponse(state);
}
