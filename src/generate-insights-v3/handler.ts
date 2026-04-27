import { runGenerateInsightsV3Pipeline } from "./agent";
import type {
  GenerateInsightsV3Arguments,
  GenerateInsightsV3Event,
  GenerateInsightsV3Response,
} from "./types";
import type { UserInfo } from "../types";

type ApprovalStatus =
  | "pending"
  | "approved_pr"
  | "approved_legal"
  | "approved_both"
  | "not_required";

type SharingScope =
  | "internal_restricted"
  | "internal_all"
  | "external_restricted"
  | "public";

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeApprovalStatus(value: unknown): ApprovalStatus | undefined {
  if (
    value === "pending"
    || value === "approved_pr"
    || value === "approved_legal"
    || value === "approved_both"
    || value === "not_required"
  ) {
    return value;
  }
  return undefined;
}

function normalizeSharingScope(value: unknown): SharingScope | undefined {
  if (
    value === "internal_restricted"
    || value === "internal_all"
    || value === "external_restricted"
    || value === "public"
  ) {
    return value;
  }
  return undefined;
}

function buildResearchContextFromArguments(args: GenerateInsightsV3Arguments): string | undefined {
  const legacyResearchContext = normalizeOptionalText(args.researchContext);

  const researchObjective = normalizeOptionalText(args.researchObjective);
  const methodology = normalizeOptionalText(args.methodology);
  const additionalContext = normalizeOptionalText(args.additionalContext);
  const analysisStartDate = normalizeOptionalText(args.analysisStartDate);
  const analysisEndDate = normalizeOptionalText(args.analysisEndDate);
  const owner = normalizeOptionalText(args.owner);
  const relatedProjects = normalizeOptionalText(args.relatedProjects);
  const approvalStatus = normalizeApprovalStatus(args.approvalStatus);
  const sharingScope = normalizeSharingScope(args.sharingScope);

  const hasStructuredFields = Boolean(
    researchObjective
      || methodology
      || additionalContext
      || analysisStartDate
      || analysisEndDate
      || owner
      || relatedProjects
      || approvalStatus
      || sharingScope,
  );

  if (!hasStructuredFields) {
    return legacyResearchContext;
  }

  const parts: string[] = [];
  if (researchObjective) parts.push(`Objective: ${researchObjective}`);
  if (methodology) parts.push(`Methodology: ${methodology}`);
  if (analysisStartDate) parts.push(`Analysis start date: ${analysisStartDate}`);
  if (analysisEndDate) parts.push(`Analysis end date: ${analysisEndDate}`);
  if (owner) parts.push(`Owner: ${owner}`);
  if (relatedProjects) parts.push(`Related projects: ${relatedProjects}`);
  if (approvalStatus) parts.push(`Approval status: ${approvalStatus}`);
  if (sharingScope) parts.push(`Sharing scope: ${sharingScope}`);
  if (additionalContext) parts.push(`Additional context: ${additionalContext}`);

  return parts.length > 0 ? parts.join("\n") : legacyResearchContext;
}

function normalizeHandlerInput(args: GenerateInsightsV3Arguments): {
  outputUrls: string[];
  contextUrls: string[];
  rawDataUrls: string[];
  researchContext: string | undefined;
  uploadMode: "document" | "manual" | undefined;
  userInfo: UserInfo | undefined;
  sourceUris: string[];
} {
  const outputUrls = (args.outputUrls ?? args.sourceUris ?? []).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const contextUrls = (args.contextUrls ?? []).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const rawDataUrls = (args.rawDataUrls ?? []).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const uploadMode =
    args.uploadMode === "document" || args.uploadMode === "manual" ? args.uploadMode : undefined;
  const userInfo = args.userInfo ?? args.user_info;
  const researchContext = buildResearchContextFromArguments(args);
  const sourceUris = Array.from(new Set([...outputUrls, ...contextUrls]));

  return {
    outputUrls,
    contextUrls,
    rawDataUrls,
    researchContext,
    uploadMode,
    userInfo,
    sourceUris,
  };
}

export async function generateInsightsV3Handler(
  event: GenerateInsightsV3Event,
): Promise<GenerateInsightsV3Response> {
  const {
    outputUrls,
    contextUrls,
    rawDataUrls,
    researchContext,
    uploadMode,
    userInfo,
    sourceUris,
  } = normalizeHandlerInput(event.arguments);

  if (outputUrls.length === 0) {
    throw new Error("outputUrls is required and must be a non-empty array.");
  }

  const result = await runGenerateInsightsV3Pipeline({
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

  return {
    documents: result.documents,
    insights: result.insights,
    insight_family_data: result.insight_family_data,
    dimension_metadata: result.dimension_metadata,
    errors: result.errors,
  };
}
