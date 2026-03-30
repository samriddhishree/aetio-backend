type Config = {
  openaiApiKey: string;
  openaiModel: string;
  openaiVisionModel: string;
  openaiHelperModel: string;
  findingBatchSize: number;
  maxConcurrency: number;
  requestTimeoutMs: number;
  ddbTableName: string;
  elasticNode: string;
  elasticIndex: string;
  documentsBucket: string;
  unstructuredApiKey: string;
  unstructuredApiUrl: string;
  awsRegion: string;
  cognitoUserPoolId?: string;
};

export const config: Config = {
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  openaiHelperModel: process.env.OPENAI_HELPER_MODEL ?? "gpt-5.2",
  openaiVisionModel: process.env.OPENAI_VISION_MODEL ?? "gpt-4o",
  findingBatchSize: Number(process.env.FINDING_BATCH_SIZE ?? "12"),
  maxConcurrency: Number(process.env.PIPELINE_CONCURRENCY ?? "4"),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? "30000"),
  ddbTableName: process.env.DDB_TABLE_NAME ?? "insights",
  elasticNode: process.env.ELASTIC_NODE ?? "",
  elasticIndex: process.env.ELASTIC_INDEX ?? "user_id",
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
  //if (!config.elasticNode) missing.push("ELASTIC_NODE");
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
