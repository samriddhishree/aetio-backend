type Config = {
  openaiApiKey: string;
  openaiModel: string;
  openaiVisionModel: string;
  openaiHelperModel: string;
  maxConcurrency: number;
  requestTimeoutMs: number;
  ddbTableName: string;
  elasticNode: string;
  elasticIndex: string;
  documentsBucket: string;
  unstructuredApiKey: string;
  unstructuredApiUrl: string;
};

export const config: Config = {
  openaiApiKey: process.env.OPENAI_API_KEY ?? "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",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  openaiHelperModel: process.env.OPENAI_HELPER_MODEL ?? "gpt-5.2",
  openaiVisionModel: process.env.OPENAI_VISION_MODEL ?? "gpt-4o",
  maxConcurrency: Number(process.env.PIPELINE_CONCURRENCY ?? "4"),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? "30000"),
  ddbTableName: process.env.DDB_TABLE_NAME ?? "insights",
  elasticNode: process.env.ELASTIC_NODE ?? "",
  elasticIndex: process.env.ELASTIC_INDEX ?? "insights",
  documentsBucket: process.env.DOCUMENTS_BUCKET ?? "documents",
  unstructuredApiKey: process.env.UNSTRUCTURED_API_KEY ?? "7NswlME2XLHasX9Qiebp4ETR4keNqO",
  unstructuredApiUrl: process.env.UNSTRUCTURED_API_URL ?? "",
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
