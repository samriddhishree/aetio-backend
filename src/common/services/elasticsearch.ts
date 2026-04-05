import { fromIni } from "@aws-sdk/credential-providers";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws-v3";
import type { Insight } from "../../types";
import { config } from "./config";

let elasticClient: Client | null = null;

function getElasticClient(): Client {
  if (!config.openSearchNode || config.openSearchNode.trim().length === 0) {
    throw new Error("OPENSEARCH_NODE is required for OpenSearch indexing.");
  }
  if (!elasticClient) {
    const credentialsProvider = fromIni({ profile: "default" });
    elasticClient = new Client({
      ...AwsSigv4Signer({
        region: config.awsRegion,
        service: "es",
        getCredentials: () => credentialsProvider(),
      }),
      node: config.openSearchNode,
    });
  }
  return elasticClient;
}

export async function indexInsights(insights: Insight[]): Promise<void> {
  console.debug("elasticsearch:index:start", { count: insights.length });
  if (insights.length === 0) return;
  const ops: Record<string, unknown>[] = [];

  for (const insight of insights) {
    ops.push({ index: { _index: config.openSearchIndex, _id: insight.insight_id } });
    ops.push(insight);
  }

  const response = await getElasticClient().bulk({
    refresh: false,
    body: ops,
  });

  if (response.body.errors) {
    const failed = response.body.items
      .map((item) => item.index)
      .filter((item) => item && item.error);
    throw new Error(
      `Elasticsearch bulk index had ${failed.length} failures.`,
    );
  }
  console.debug("elasticsearch:index:done", { count: insights.length });
}

export async function upsertInsightDocument(
  insightDocument: Record<string, unknown> & { insight_id: string },
): Promise<void> {
  console.debug("elasticsearch:upsert:start", { insightId: insightDocument.insight_id });
  await getElasticClient().index({
    index: config.openSearchIndex,
    id: insightDocument.insight_id,
    body: insightDocument,
    refresh: false,
  });
  console.debug("elasticsearch:upsert:done", { insightId: insightDocument.insight_id });
}

export async function deleteInsightDocument(insightId: string): Promise<void> {
  console.debug("elasticsearch:delete:start", { insightId });
  try {
    await getElasticClient().delete({
      index: config.openSearchIndex,
      id: insightId,
      refresh: false,
    });
  } catch (error) {
    const statusCode =
      error && typeof error === "object" && "statusCode" in error
        ? (error as { statusCode?: number }).statusCode
        : undefined;
    if (statusCode !== 404) {
      throw error;
    }
  }
  console.debug("elasticsearch:delete:done", { insightId });
}

export async function deleteInsightDocuments(insightIds: string[]): Promise<void> {
  const normalizedIds = Array.from(
    new Set(
      insightIds
        .map((insightId) => insightId?.trim())
        .filter((insightId): insightId is string => Boolean(insightId)),
    ),
  );
  console.debug("elasticsearch:bulk-delete:start", { count: normalizedIds.length });
  if (normalizedIds.length === 0) return;

  const operations = normalizedIds.map((insightId) => ({
    delete: { _index: config.openSearchIndex, _id: insightId },
  }));

  const response = await getElasticClient().bulk({
    refresh: false,
    body: operations,
  });

  if (response.body.errors) {
    const failed = response.body.items
      .map((item) => item.delete)
      .filter((item) => item && item.error && item.status !== 404);
    if (failed.length > 0) {
      throw new Error(`Elasticsearch bulk delete had ${failed.length} failures.`);
    }
  }
  console.debug("elasticsearch:bulk-delete:done", { count: normalizedIds.length });
}
