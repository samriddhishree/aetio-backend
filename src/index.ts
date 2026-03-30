import express, { Request, Response } from "express";
import cors from 'cors';
import crypto from "crypto";
import { handler, type GenerateInsightsArguments } from "./generate-insights/handler";
import { runIngestionPipelineFromChunks, summarizeProject } from "./generate-insights/graph";
import { getAwsAssumeRoleProvider, getCachedAwsAssumeRoleProvider } from "./common/services/aws";
import {
  deleteAllInsights,
  deleteInsightsByProjectId,
  getInsightById,
  listInsights,
  persistInsights,
  type InsightFilters,
  type InsightFilterKey,
} from "./common/services/dynamo";
import { InsightSearchRepository } from "./common/services/repository";

import type { Chunk, FindingRef, Insight } from "./types";
import { config  } from "./common/services/config";

type GenerateInsightsResponse = {
  status: "accepted";
  requestId: string;
};

type FormattedInsight = Insight & {
  sub_insights?: Insight[];
};

type InsightTreeResponse = {
  insight: Insight[];
  children: Insight[];
  parents: Insight[];
  siblings: Insight[];
};

const app = express();
const port = Number(process.env.PORT ?? 8000);
const insightSearchRepository = new InsightSearchRepository();
const allowedOrigins = ['http://localhost:5001','https://main.d27ng47b6pfw44.amplifyapp.com']; // Replace with your frontend origins
// CORS middleware
app.use(cors({
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) => {
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
  "status",
  "s3_node",
  "document_id",
];

type AcceptStatusCounts = {
  countAccepted: number;
  countDeclined: number;
};

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

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

const toFindingRefMap = (items: Insight[]): Map<string, FindingRef> => {
  const findingById = new Map<string, FindingRef>();
  for (const item of items) {
    const refs = toObjectRecord(item.additional_refs);
    const findings = Array.isArray(refs.findings) ? refs.findings : [];
    for (const finding of findings) {
      if (!finding || typeof finding !== "object" || Array.isArray(finding)) continue;
      const findingObj = finding as FindingRef;
      if (typeof findingObj.finding_id !== "string" || findingObj.finding_id.trim().length === 0) {
        continue;
      }
      findingById.set(findingObj.finding_id, findingObj);
    }
  }
  return findingById;
};

const enrichInsightFindingRefs = (
  insight: Insight,
  findingById: Map<string, FindingRef>,
): Insight => {
  const refs = toObjectRecord(insight.additional_refs);
  const findingIds = Array.isArray(refs.finding_ids)
    ? refs.finding_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];

  if (findingIds.length === 0) {
    return insight;
  }

  const expandedFindings: FindingRef[] = findingIds.map((findingId) => {
    const existing = findingById.get(findingId);
    if (existing) return existing;
    // Fallback for older records that only persisted finding_ids.
    return {
      finding_id: findingId,
      text: insight.text,
      supporting_chunks: insight.supporting_chunks,
      document_id: insight.document_id,
      s3_node: insight.s3_node,
    };
  });

  const deduped = new Map<string, FindingRef>();
  for (const finding of expandedFindings) {
    deduped.set(finding.finding_id, finding);
  }
  const { finding_ids: _findingIds, ...rest } = refs;

  return {
    ...insight,
    additional_refs: {
      ...rest,
      findings: Array.from(deduped.values()),
    },
  };
};

const isChunk = (value: unknown): value is Chunk => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const chunk = value as Partial<Chunk>;
  return (
    typeof chunk.chunk_id === "string" &&
    typeof chunk.document_id === "string" &&
    (chunk.type === "text" || chunk.type === "image") &&
    typeof chunk.content === "string" &&
    Array.isArray(chunk.block_ids) &&
    typeof chunk.s3_node === "string"
  );
};

app.get("/insights", async (req: Request, res: Response) => {
  const parsedFilters = extractInsightFilters(req.query);
  if ("error" in parsedFilters) {
    return res.status(400).json({ error: parsedFilters.error });
  }

  try {
    const effectiveFilters = applyJwtUserIdFilter(req, parsedFilters);
    const items = await listInsights(effectiveFilters);
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

app.get("/insight/tree/:insightId", async (req: Request, res: Response) => {
  const insightId = req.params.insightId;
  if (!insightId) {
    return res.status(400).json({ error: "insightId is required in path" });
  }

  try {
    const insight = await insightSearchRepository.getInsightById(insightId);
    if (!insight) {
      return res.status(404).json({ error: `Insight not found: ${insightId}` });
    }

    const [children, parent, siblings] = await Promise.all([
      insightSearchRepository.getChildInsights(insightId, 200),
      insightSearchRepository.getParentInsight(insightId),
      insightSearchRepository.getSiblingInsights(insightId, 200),
    ]);

    const response: InsightTreeResponse = {
      insight: [insight],
      children,
      parents: parent ? [parent] : [],
      siblings,
    };

    return res.json(response);
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
    const effectiveFilters = applyJwtUserIdFilter(req, parsedFilters);
    const items = await listInsights(effectiveFilters);
    const findingById = toFindingRefMap(items);
    const enrichedItems = items.map((item) => enrichInsightFindingRefs(item, findingById));
    const formattedItems = formatInsights(enrichedItems);
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

app.delete("/project/:projectId", async (req: Request, res: Response) => {
  const projectId = req.params.projectId;
  if (!projectId) {
    return res.status(400).json({ error: "projectId is required in path" });
  }

  try {
    const deleted = await deleteInsightsByProjectId(projectId);
    return res.json({ deleted, projectId });
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
  const jwtUserId = getJwtUserId(req);
  if (!jwtUserId) {
    return res.status(401).json({ error: "Authorization bearer token with sub is required" });
  }
  const payload = {
    ...toObjectRecord(req.body),
    userId: jwtUserId,
  } as GenerateInsightsArguments;
  console.log("payload", payload);
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

app.post("/generateInsightsFromChunks", async (req: Request, res: Response) => {
  const jwtUserId = getJwtUserId(req);
  if (!jwtUserId) {
    return res.status(401).json({ error: "Authorization bearer token with sub is required" });
  }

  const body = toObjectRecord(req.body);
  const rawChunks = body.chunks;
  if (!Array.isArray(rawChunks) || rawChunks.length === 0) {
    return res.status(400).json({ error: "chunks is required and must be a non-empty array" });
  }

  if (!rawChunks.every(isChunk)) {
    return res.status(400).json({
      error:
        "Each chunk must include chunk_id, document_id, type, content, block_ids, and s3_node.",
    });
  }

  const chunks = rawChunks as Chunk[];
  const contextUrls = Array.isArray(body.contextUrls)
    ? body.contextUrls.filter((url): url is string => typeof url === "string")
    : [];
  const researchContext =
    typeof body.researchContext === "string" ? body.researchContext : "";
  const userInfo = toObjectRecord(body.userInfo ?? body.user_info) as {
    full_name?: string;
    email_address?: string;
  };
  const requestId = req.header("x-request-id") ?? crypto.randomUUID();

  try {
    const summaryResult = await summarizeProject(contextUrls, researchContext, {
      userId: jwtUserId,
      userInfo,
    });
    const result = await runIngestionPipelineFromChunks(
      chunks,
      jwtUserId,
      userInfo,
      summaryResult.insight_id,
    );

    return res.status(202).json({
      status: "accepted",
      requestId,
      ok: result.errors.length === 0,
      insights: result.insights.length,
      documents: result.documents.length,
      chunks: result.chunks.length,
      summary: summaryResult.summary,
      errors: result.errors.map((error) => ({
        stage: error.stage,
        message: error.message,
        url: error.url,
        document_id: error.document_id,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message, requestId });
  }
});

export { app };

const applyJwtUserIdFilter = (req: Request, filters: InsightFilters): InsightFilters => {
  const output: InsightFilters = { ...filters };
  delete output.user_id;

  const userId = getJwtUserId(req);
  if (userId) {
    output.user_id = userId;
  }

  return output;
};

const getJwtUserId = (req: Request): string | undefined => {
  const token = parseBearerToken(req);
  if (!token) return undefined;

  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;

  const sub = payload.sub;
  return typeof sub === "string" && sub.trim().length > 0 ? sub.trim() : undefined;
};

const parseBearerToken = (req: Request): string | undefined => {
  const rawAuthorization = req.header("authorization");
  if (!rawAuthorization) return undefined;
  const match = rawAuthorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
};

const decodeJwtPayload = (token: string): Record<string, unknown> | undefined => {
  const segments = token.split(".");
  if (segments.length < 2) return undefined;

  try {
    const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
    const decoded = Buffer.from(base64 + padding, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

if (process.env.NODE_ENV !== "test") {
  void (async () => {
    await getAwsAssumeRoleProvider();
    console.log(getCachedAwsAssumeRoleProvider());
    console.log(
      process.env.OPENAI_API_KEY
        ? "OpenAI API key is set"
        : "OpenAI API key is NOT set",
    );
    console.log(
      process.env.UNSTRUCTURED_API_KEY
        ? "Unstructured API key is set"
        : "Unstructured API key is NOT set",
    );
    console.log(`Documents bucket: ${config.documentsBucket}`);
    app.listen(port, () => {
      console.log(`Aetio backend listening on port ${port}`);
    });
  })();
}
