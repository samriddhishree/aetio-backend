import type { WriteRequest } from "@aws-sdk/client-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { Insight } from "../types";
import { getAwsAssumeRoleProvider } from "./aws";
import { config } from "./config";
import { chunkArray, sleep } from "./utils";

const client = new DynamoDBClient({
  credentials: getAwsAssumeRoleProvider(),
});
const docClient = DynamoDBDocumentClient.from(client);

const MAX_BATCH = 25;
const MAX_RETRIES = 5;

export async function persistInsights(insights: Insight[]): Promise<void> {
  console.debug("dynamo:persist:start", { count: insights.length });
  if (insights.length === 0) return;
  const batches = chunkArray(insights, MAX_BATCH);

  for (const batch of batches) {
    console.debug("dynamo:persist:batch", { size: batch.length });
    let unprocessed = batch.map((item) => ({
      PutRequest: { Item: item },
    })) as unknown as WriteRequest[];

    for (let attempt = 0; attempt <= MAX_RETRIES && unprocessed.length > 0; attempt += 1) {
      const response = await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [config.ddbTableName]: unprocessed,
          },
        }),
      );

      const remaining = response.UnprocessedItems?.[config.ddbTableName];
      unprocessed = (remaining ? Array.from(remaining) : []) as WriteRequest[];

      if (unprocessed.length > 0) {
        const backoffMs = Math.min(2000 * Math.pow(2, attempt), 10000);
        await sleep(backoffMs);
      }
    }

    if (unprocessed.length > 0) {
      throw new Error(
        `Failed to persist ${unprocessed.length} insights after retries.`,
      );
    }
  }
  console.debug("dynamo:persist:done", { count: insights.length });
}
