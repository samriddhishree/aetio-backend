import { Client } from "@elastic/elasticsearch";
import type { Insight } from "../types";
import { config } from "./config";

const client = new Client({ node: config.elasticNode });

export async function indexInsights(insights: Insight[]): Promise<void> {
  console.debug("elasticsearch:index:start", { count: insights.length });
  if (insights.length === 0) return;
  const ops: Record<string, unknown>[] = [];

  for (const insight of insights) {
    ops.push({ index: { _index: config.elasticIndex, _id: insight.insight_id } });
    ops.push(insight);
  }

  const response = await client.bulk({
    refresh: false,
    operations: ops,
  });

  if (response.errors) {
    const failed = response.items
      .map((item) => item.index)
      .filter((item) => item && item.error);
    throw new Error(
      `Elasticsearch bulk index had ${failed.length} failures.`,
    );
  }
  console.debug("elasticsearch:index:done", { count: insights.length });
}
