import express, { Request, Response } from "express";
import cors from 'cors';
import crypto from "crypto";
import { handler, type GenerateInsightsArguments } from "./generate-insights/handler";
import { getAwsAssumeRoleProvider, getCachedAwsAssumeRoleProvider } from "./common/services/aws";
import {
  deleteAllInsights,
  getInsightById,
  listInsights,
  persistInsights,
  type InsightFilters,
  type InsightFilterKey,
} from "./common/services/dynamo";

import type { Insight } from "./types";

type GenerateInsightsResponse = {
  status: "accepted";
  requestId: string;
};

type FormattedInsight = Insight & {
  sub_insights?: Insight[];
};

const app = express();
const port = Number(process.env.PORT ?? 8000);
const allowedOrigins = ['http://localhost:5001']; // Replace with your frontend origins
// CORS middleware
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
  credentials: true, // if you need cookies
}));

app.use(express.json());
const allowedInsightFilters: InsightFilterKey[] = [
  "insight_id",
  "project_id",
  "parent_insight_id",
  "text",
  "user_id",
  "status",
  "s3_node",
  "document_id",
];

type AcceptStatusCounts = {
  countAccepted: number;
  countDeclined: number;
};

const toObjectRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const normalizeInsightStatus = (insight: Insight): Insight => ({
  ...insight,
  status: insight.status?.toLowerCase() === "declined" ? insight.status : "Accepted",
});

const countInsightStatuses = (insights: Insight[]): AcceptStatusCounts =>
  insights.reduce<AcceptStatusCounts>(
    (acc, insight) => {
      const normalizedStatus = insight.status?.toLowerCase();
      if (normalizedStatus === "declined") acc.countDeclined += 1;
      if (normalizedStatus === "accepted") acc.countAccepted += 1;
      return acc;
    },
    { countAccepted: 0, countDeclined: 0 },
  );

const addProjectAcceptCountsOnCompleted = (
  insights: Insight[],
  projectId: string,
  counts: AcceptStatusCounts,
): Insight[] =>
  insights.map((insight) => {
    if (insight.insight_id !== projectId) return insight;
    //TODO get this fixed at a point 
    insight.status = "Pending";
    const existingRefs = toObjectRecord(insight.additional_refs);
    return {
      ...insight,
      additional_refs: {
        ...existingRefs,
        ...counts,
      }
    } as Insight;
  });

const extractInsightFilters = (query: Request["query"]): InsightFilters | { error: string } => {
  const filters: InsightFilters = {};

  for (const [key, rawValue] of Object.entries(query)) {
    if (!allowedInsightFilters.includes(key as InsightFilterKey)) {
      return { error: `Unsupported filter: ${key}` };
    }

    if (rawValue === undefined) continue;

    if (Array.isArray(rawValue)) {
      filters[key as InsightFilterKey] = rawValue.map((value) => String(value));
      continue;
    }

    const value = String(rawValue);
    if (value.toLowerCase() === "null") {
      filters[key as InsightFilterKey] = null;
      continue;
    }

    if (value.includes(",")) {
      const parts = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      filters[key as InsightFilterKey] = parts;
      continue;
    }

    filters[key as InsightFilterKey] = value;
  }

  return filters;
};

const formatInsights = (items: Insight[]): FormattedInsight[] => {
  const childrenByParentId = new Map<string, Insight[]>();

  for (const item of items) {
    if (!item.parent_insight_id) continue;
    const children = childrenByParentId.get(item.parent_insight_id) ?? [];
    children.push(item);
    childrenByParentId.set(item.parent_insight_id, children);
  }

  return items.map((item) => {
    const subInsights = childrenByParentId.get(item.insight_id);
    if (!subInsights || subInsights.length === 0) return item;

    return {
      ...item,
      sub_insights: subInsights,
    };
  });
};

app.get("/insights", async (req: Request, res: Response) => {
  const parsedFilters = extractInsightFilters(req.query);
  if ("error" in parsedFilters) {
    return res.status(400).json({ error: parsedFilters.error });
  }

  try {
    const items = await listInsights(parsedFilters);
    return res.json({ count: items.length, items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.get("/insight/:insightId", async (req: Request, res: Response) => {
  const insightId = req.params.insightId;
  if (!insightId) {
    return res.status(400).json({ error: "insightId is required in path" });
  }

  try {
    console.log("getInsightById:start", { insightId });
    const insight = await getInsightById(insightId);
    if (!insight) {
      return res.status(404).json({ error: `Insight not found: ${insightId}` });
    }
    return res.json(insight);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.get("/formatted-insights", async (req: Request, res: Response) => {
  const parsedFilters = extractInsightFilters(req.query);
  if ("error" in parsedFilters) {
    return res.status(400).json({ error: parsedFilters.error });
  }

  try {
    const items = await listInsights(parsedFilters);
    const formattedItems = formatInsights(items);
    return res.json({ count: formattedItems.length, items: formattedItems });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.delete("/insights/deleteAll", async (_req: Request, res: Response) => {
  try {
    const deleted = await deleteAllInsights();
    return res.json({ deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.patch("/insights/accept/:projectId", async (req: Request, res: Response) => {
  const projectId = req.params.projectId;
  if (!projectId) {
    return res.status(400).json({ error: "projectId is required in path" });
  }

  const body = req.body as Insight[] | { insights?: Insight[] };
  const insights = Array.isArray(body) ? body : body?.insights;
  console.log("Received insights for acceptance", insights);
  if (!Array.isArray(insights)) {
    return res.status(400).json({ error: "Body must be an array of insights or { insights: Insight[] }" });
  }

  const normalizedInsights = insights.map(normalizeInsightStatus);
  const statusCounts = countInsightStatuses(normalizedInsights);
  const updatedInsights = addProjectAcceptCountsOnCompleted(
    normalizedInsights,
    projectId,
    statusCounts,
  );

  try {
    await persistInsights(updatedInsights);
    return res.json({ updated: updatedInsights.length, items: updatedInsights });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.post("/generateInsights", async (req: Request, res: Response) => {
  const payload = req.body as GenerateInsightsArguments;
  console.log("payload", payload)
  if (!payload?.userId) {
    return res.status(400).json({ error: "userId is required" });
  }
  if (!payload?.outputUrls || payload.outputUrls.length === 0) {
    return res.status(400).json({ error: "outputUrls is required" });
  }

  const requestId = req.header("x-request-id") ?? crypto.randomUUID();

  try {
    const result = await handler({ arguments: payload });
    const parsed = JSON.parse(result) as Record<string, unknown>;
    return res.status(202).json({
      status: "accepted",
      requestId,
      ...parsed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message, requestId });
  }
});

if (process.env.NODE_ENV !== "test") {
  void (async () => {
    await getAwsAssumeRoleProvider();
    console.log(getCachedAwsAssumeRoleProvider());
    app.listen(port, () => {
      console.log(`Aetio backend listening on port ${port}`);
    });
  })();
}

export { app };
