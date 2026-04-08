type Config = {
  openaiApiKey: string;
  openaiModel: string;
  openaiVisionModel: string;
  openaiHelperModel: string;
  findingBatchSize: number;
  maxConcurrency: number;
  requestTimeoutMs: number;
  ddbTableName: string;
  projectsTableName: string;
  insightFamilyDataTableName: string;
  insightFamilyDataType: string;
  insightFamilyDataScopeSuffix: string;
  openSearchNode: string;
  openSearchIndex: string;
  documentsBucket: string;
  unstructuredApiKey: string;
  unstructuredApiUrl: string;
  awsRegion: string;
  cognitoUserPoolId?: string;
};

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
  projectsTableName: process.env.PROJECTS_TABLE_NAME ?? "projects",
  insightFamilyDataTableName:
    process.env.INSIGHT_FAMILY_DATA_TABLE_NAME ?? "insightfamilydata",
  insightFamilyDataType: process.env.INSIGHT_FAMILY_DATA_TYPE ?? "insightfamilydata",
  insightFamilyDataScopeSuffix:
    process.env.INSIGHT_FAMILY_DATA_SCOPE_SUFFIX ?? "insightfamilydata",
  openSearchNode:
    process.env.OPENSEARCH_NODE ??
    "https://search-aetio-insights-itr47ew4zvtmse7drfwehqxcne.us-east-2.es.amazonaws.com",
  openSearchIndex: process.env.OPENSEARCH_INDEX ?? "insights",
  documentsBucket: process.env.DOCUMENTS_BUCKET ?? "amplify-amplifyvitereactt-aetioinsightstoragebucke-jzbc7y9yml35",
  unstructuredApiKey: process.env.UNSTRUCTURED_API_KEY ?? "",
  unstructuredApiUrl: process.env.UNSTRUCTURED_API_URL ?? "",
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
