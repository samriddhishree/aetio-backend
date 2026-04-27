type Config = {
  openaiApiKey: string;
  openaiModel: string;
  openaiVisionModel: string;
  openaiHelperModel: string;
  findingBatchSize: number;
  maxConcurrency: number;
  requestTimeoutMs: number;
  ddbTableName: string;
  ddbProjectIdIndexName: string;
  projectsTableName: string;
  projectsUserStatusIndexName: string;
  insightFamilyDataTableName: string;
  insightFamilyDataType: string;
  insightFamilyDataScopeSuffix: string;
  dimensionMetadataTableName: string;
  dimensionMetadataProjectIdIndexName: string;
  dimensionMetadataType: string;
  dimensionMetadataScopeSuffix: string;
  insightEvaluationTraceTableName: string;
  insightEvaluationTraceProjectIdCreatedAtIndexName: string;
  insightReviewEventTableName: string;
  generateInsightsV2PromptVersion: string;
  generateInsightsV3PromptVersion: string;
  openSearchNode: string;
  openSearchIndex: string;
  documentsBucket: string;
  unstructuredApiKey: string;
  unstructuredApiUrl: string;
  unstructuredRequestTimeoutMs: number;
  unstructuredUseLegacySplitMode: boolean;
  unstructuredLegacySplitConcurrency: number;
  unstructuredLegacySplitAllowFailed: boolean;
  unstructuredPdfSplitEnabled: boolean;
  unstructuredPdfSplitStrictMode: boolean;
  unstructuredPdfSplitConcurrency: number;
  unstructuredPdfSplitChunkSizePages: number;
  unstructuredPdfSplitMaxRetries: number;
  unstructuredPdfMinCoverageRatio: number;
  awsRegion: string;
  cognitoUserPoolId?: string;
};

function envInt(name: string, fallback: number): number {
  const raw = envValue(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = envValue(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = envValue(name);
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return fallback;
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const config: Config = {
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-5.2",
  openaiHelperModel: process.env.OPENAI_HELPER_MODEL ?? "gpt-5.2",
  openaiVisionModel: process.env.OPENAI_VISION_MODEL ?? "gpt-4o",
  findingBatchSize: Number(process.env.FINDING_BATCH_SIZE ?? "12"),
  maxConcurrency: Number(process.env.PIPELINE_CONCURRENCY ?? "4"),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? "30000"),
  ddbTableName: process.env.DDB_TABLE_NAME ?? "insights",
  ddbProjectIdIndexName: process.env.DDB_PROJECT_ID_INDEX_NAME ?? "GSI_ProjectId",
  projectsTableName: process.env.PROJECTS_TABLE_NAME ?? "projects",
  projectsUserStatusIndexName:
    process.env.PROJECTS_USER_STATUS_INDEX_NAME ?? "GSI_UserStatusId",
  insightFamilyDataTableName:
    process.env.INSIGHT_FAMILY_DATA_TABLE_NAME ?? "insightfamilydata",
  insightFamilyDataType: process.env.INSIGHT_FAMILY_DATA_TYPE ?? "insightfamilydata",
  insightFamilyDataScopeSuffix:
    process.env.INSIGHT_FAMILY_DATA_SCOPE_SUFFIX ?? "insightfamilydata",
  dimensionMetadataTableName:
    process.env.DIMENSION_METADATA_TABLE_NAME ?? "dimensionmetadata",
  dimensionMetadataProjectIdIndexName:
    process.env.DIMENSION_METADATA_PROJECT_ID_INDEX_NAME ?? "GSI_ProjectId",
  dimensionMetadataType: process.env.DIMENSION_METADATA_TYPE ?? "dimensionmetadata",
  dimensionMetadataScopeSuffix:
    process.env.DIMENSION_METADATA_SCOPE_SUFFIX ?? "dimensionmetadata",
  insightEvaluationTraceTableName:
    process.env.INSIGHT_EVALUATION_TRACE_TABLE_NAME ?? "insight_evaluation_traces",
  insightEvaluationTraceProjectIdCreatedAtIndexName:
    process.env.INSIGHT_EVALUATION_TRACE_PROJECT_ID_CREATED_AT_INDEX_NAME
    ?? "GSI_ProjectIdCreatedAt",
  insightReviewEventTableName:
    process.env.INSIGHT_REVIEW_EVENT_TABLE_NAME ?? "insight_review_events",
  generateInsightsV2PromptVersion:
    process.env.GENERATE_INSIGHTS_V2_PROMPT_VERSION ?? "v2-default",
  generateInsightsV3PromptVersion:
    process.env.GENERATE_INSIGHTS_V3_PROMPT_VERSION ?? "v3-default",
  openSearchNode:
    process.env.OPENSEARCH_NODE ??
    "https://search-aetio-insights-itr47ew4zvtmse7drfwehqxcne.us-east-2.es.amazonaws.com",
  openSearchIndex: process.env.OPENSEARCH_INDEX ?? "insights",
  documentsBucket: process.env.DOCUMENTS_BUCKET ?? "amplify-amplifyvitereactt-aetioinsightstoragebucke-jzbc7y9yml35",
  unstructuredApiKey: process.env.UNSTRUCTURED_API_KEY ?? "",
  unstructuredApiUrl: process.env.UNSTRUCTURED_API_URL ?? "",
  unstructuredRequestTimeoutMs: Math.max(1000, envInt("UNSTRUCTURED_REQUEST_TIMEOUT_MS", 90000)),
  unstructuredUseLegacySplitMode: envBool("UNSTRUCTURED_USE_LEGACY_SPLIT_MODE", false),
  unstructuredLegacySplitConcurrency: Math.max(1, envInt("UNSTRUCTURED_LEGACY_SPLIT_CONCURRENCY", 8)),
  unstructuredLegacySplitAllowFailed: envBool("UNSTRUCTURED_LEGACY_SPLIT_ALLOW_FAILED", true),
  unstructuredPdfSplitEnabled: envBool("UNSTRUCTURED_PDF_SPLIT_ENABLED", true),
  unstructuredPdfSplitStrictMode: envBool("UNSTRUCTURED_PDF_SPLIT_STRICT_MODE", false),
  unstructuredPdfSplitConcurrency: Math.max(1, envInt("UNSTRUCTURED_PDF_SPLIT_CONCURRENCY", 2)),
  unstructuredPdfSplitChunkSizePages: Math.max(1, envInt("UNSTRUCTURED_PDF_SPLIT_CHUNK_SIZE_PAGES", 3)),
  unstructuredPdfSplitMaxRetries: Math.max(0, envInt("UNSTRUCTURED_PDF_SPLIT_MAX_RETRIES", 1)),
  unstructuredPdfMinCoverageRatio: Math.min(
    1,
    Math.max(0, envFloat("UNSTRUCTURED_PDF_MIN_COVERAGE_RATIO", 0.9)),
  ),
  awsRegion: process.env.AWS_REGION ?? "us-east-2",
  cognitoUserPoolId: process.env.COGNITO_USER_POOL_ID?.trim(),
};

export function assertConfig() {
  const missing: string[] = [];
  //if (!config.openaiApiKey) missing.push("OPENAI_API_KEY");
  //if (!config.ddbTableName) missing.push("DDB_TABLE_NAME");
  //if (!config.openSearchNode) missing.push("OPENSEARCH_NODE");
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
