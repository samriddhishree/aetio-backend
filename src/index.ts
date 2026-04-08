import express, { Request, Response } from "express";
import cors from 'cors';
import crypto from "crypto";
import {
  generateInsightsV2Handler,
  type GenerateInsightsV2Arguments,
} from "./generate-insights-v2/handler";
import { runIngestionPipelineFromChunks, summarizeProject } from "./generate-insights/graph";
import { getAwsAssumeRoleProvider, getCachedAwsAssumeRoleProvider } from "./common/services/aws";
import {
  deleteAllInsightsWithInsightIds,
  deleteInsightsByProjectIdWithInsightIds,
  getInsightById,
  listInsights,
  persistInsights,
  updateInsight,
  type InsightFilters,
  type InsightFilterKey,
} from "./common/services/dynamo";
import {
  getInsightFamilyData,
  putInsightFamilyData,
  type PersistedInsightFamilyData,
} from "./common/services/insightFamilyDataTable";
import {
  deleteAllInsightDocuments,
  deleteInsightDocuments,
  upsertInsightDocument,
} from "./common/services/elasticsearch";
import { listProjectsByUserAndStatus } from "./common/services/projectsTable";
import { toOpenSearchInsightDocument } from "./generate-insights-v2/services/familyPersistence";

import type { Chunk, FindingRef, Insight } from "./types";
import { config  } from "./common/services/config";

type FormattedInsight = Insight & {
  sub_insights?: Insight[];
};

const app = express();
const port = Number(process.env.PORT ?? 8000);
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

app.use(express.json({ limit: "25mb" }));
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

type AcceptStreamEvent =
  | {
      type: "insight_persisted";
      index: number;
      insight_id: string;
      status?: string;
    }
  | {
      type: "project_counts_updated";
      project_id: string;
      countAccepted: number;
      countDeclined: number;
    }
  | {
      type: "complete";
      updated: number;
      countAccepted: number;
      countDeclined: number;
    }
  | {
      type: "error";
      message: string;
    };

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

app.get("/projects", async (req: Request, res: Response) => {
  const jwtUserId = getJwtUserId(req);
  if (!jwtUserId) {
    return res.status(401).json({ error: "Authorization bearer token with sub is required" });
  }

  const status =
    typeof req.query.status === "string" && req.query.status.trim().length > 0
      ? req.query.status.trim()
      : "Pending";

  try {
    const projects = await listProjectsByUserAndStatus({
      userId: jwtUserId,
      status,
    });
    return res.status(200).json({ items: projects });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.get("/projects/:projectId", async (req: Request, res: Response) => {
  const jwtUserId = getJwtUserId(req);
  if (!jwtUserId) {
    return res.status(401).json({ error: "Authorization bearer token with sub is required" });
  }

  const projectId = req.params.projectId?.trim();
  if (!projectId) {
    return res.status(400).json({ error: "projectId is required in path" });
  }

  try {
    const pendingProjects = await listProjectsByUserAndStatus({
      userId: jwtUserId,
      status: "Pending",
    });
    const project = pendingProjects.find((entry) => entry.project_id === projectId);
    if (!project) {
      return res.status(404).json({ error: `Project not found: ${projectId}` });
    }

    const pendingInsights = await listInsights({
      status: "Pending",
      project_id: projectId,
    });
    const tableIds = Array.from(
      new Set(
        pendingInsights
          .map((insight) => insight.insight_family_data_id?.trim())
          .filter((tableId): tableId is string => Boolean(tableId)),
      ),
    );
    const insightFamilyData = (
      await Promise.all(tableIds.map((tableId) => getInsightFamilyData(tableId)))
    ).filter((value): value is PersistedInsightFamilyData => Boolean(value));
    const insightFamilyDataById = new Map(
      insightFamilyData.map((table) => [table.table_id, table]),
    );
    const insightsWithFamilyData = pendingInsights.map((pendingInsight) => {
      const tableId = pendingInsight.insight_family_data_id?.trim();
      const linkedFamilyData = tableId ? insightFamilyDataById.get(tableId) : undefined;
      const existingRefs =
        pendingInsight.additional_refs &&
        typeof pendingInsight.additional_refs === "object" &&
        !Array.isArray(pendingInsight.additional_refs)
          ? (pendingInsight.additional_refs as Record<string, unknown>)
          : {};

      return {
        ...pendingInsight,
        additional_refs: linkedFamilyData
          ? {
              ...existingRefs,
              insight_family_data: linkedFamilyData,
            }
          : existingRefs,
      };
    });

    return res.status(200).json({
      project,
      insights: insightsWithFamilyData,
      insightfamilydata: insightFamilyData,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

const toObjectRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const normalizeInsightStatus = (insight: Insight): Insight => ({
  ...insight,
  evidence_snippet: insight.evidence_snippet?.trim() || insight.text,
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

const incrementStatusCounts = (counts: AcceptStatusCounts, insight: Insight): void => {
  const normalizedStatus = insight.status?.toLowerCase();
  if (normalizedStatus === "accepted") counts.countAccepted += 1;
  if (normalizedStatus === "declined") counts.countDeclined += 1;
};

const isNdjsonRequest = (req: Request): boolean =>
  (req.header("content-type") ?? "").toLowerCase().includes("application/x-ndjson");

const writeAcceptStreamEvent = (res: Response, event: AcceptStreamEvent): void => {
  res.write(`${JSON.stringify(event)}\n`);
};

const upsertInsightToOpenSearch = async (insight: Insight): Promise<void> => {
  await upsertInsightDocument(toOpenSearchInsightDocument(insight));
};

const upsertInsightsToOpenSearch = async (insights: Insight[]): Promise<void> => {
  for (const insight of insights) {
    await upsertInsightToOpenSearch(insight);
  }
};

const toInsightFromStreamLine = (line: string): Insight => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("Received invalid JSON line while streaming insights.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Each streamed line must be a JSON object.");
  }

  const insight = parsed as Insight;
  if (!insight.insight_id || typeof insight.insight_id !== "string") {
    throw new Error("Each streamed insight must include insight_id.");
  }

  return insight;
};

const extractInsightUpdatePatch = (body: unknown): Partial<Insight> => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  const payload = body as Partial<Insight>;
  const patch: Partial<Insight> = {};

  if (typeof payload.text === "string") patch.text = payload.text;
  if (typeof payload.created_at === "string") patch.created_at = payload.created_at;
  if (typeof payload.createdAt === "string") patch.createdAt = payload.createdAt;
  if (typeof payload.expires_at === "string") patch.expires_at = payload.expires_at;
  if (typeof payload.expiresAt === "string") patch.expiresAt = payload.expiresAt;
  if (typeof payload.summary === "string") patch.summary = payload.summary;
  if (Array.isArray(payload.metadata)) patch.metadata = payload.metadata;
  if (typeof payload.status === "string") patch.status = payload.status;
  if ("additional_refs" in payload) patch.additional_refs = payload.additional_refs;
  if ("user_info" in payload && payload.user_info && typeof payload.user_info === "object" && !Array.isArray(payload.user_info)) {
    patch.user_info = payload.user_info;
  }
  if (typeof payload.family_text === "string") patch.family_text = payload.family_text;
  if (typeof payload.question_answered === "string") patch.question_answered = payload.question_answered;
  if (typeof payload.evidence_snippet === "string") patch.evidence_snippet = payload.evidence_snippet;

  return patch;
};

const extractInsightFamilyDataPatch = (
  body: unknown,
): Partial<Pick<PersistedInsightFamilyData, "dimensions" | "metric_columns" | "rows">> => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  const payload = body as Partial<PersistedInsightFamilyData>;
  const patch: Partial<Pick<PersistedInsightFamilyData, "dimensions" | "metric_columns" | "rows">> = {};

  if (Array.isArray(payload.dimensions)) {
    patch.dimensions = payload.dimensions.filter((value): value is string => typeof value === "string");
  }

  if (Array.isArray(payload.metric_columns)) {
    patch.metric_columns = payload.metric_columns.filter((value): value is string => typeof value === "string");
  }

  if (Array.isArray(payload.rows)) {
    patch.rows = payload.rows;
  }

  return patch;
};

const addProjectAcceptCountsOnCompleted = (
  insights: Insight[],
  projectId: string,
  counts: AcceptStatusCounts,
): Insight[] =>
  insights.map((insight) => {
    if (insight.insight_id !== projectId) return insight;
    const normalizedStatus = insight.status?.toLowerCase();
    const projectStatus = normalizedStatus === "declined" ? "Declined" : "Accepted";
    const existingRefs = toObjectRecord(insight.additional_refs);
    return {
      ...insight,
      status: projectStatus,
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

app.get("/insights/all", async (req: Request, res: Response) => {
  const jwtUserId = getJwtUserId(req);
  if (!jwtUserId) {
    return res.status(401).json({ error: "Authorization bearer token with sub is required" });
  }

  try {
    const items = await listInsights();
    return res.json({ count: items.length, items });
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

app.patch(["/insight/:insightId", "/insights/:insightId"], async (req: Request, res: Response) => {
  const insightId = req.params.insightId?.trim();
  if (!insightId) {
    return res.status(400).json({ error: "insightId is required in path" });
  }

  const jwtUserId = getJwtUserId(req);
  if (!jwtUserId) {
    return res.status(401).json({ error: "Authorization bearer token with sub is required" });
  }

  const patch = extractInsightUpdatePatch(req.body);
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: "No editable insight fields provided in request body" });
  }

  try {
    const existingInsight = await getInsightById(insightId);
    if (!existingInsight) {
      return res.status(404).json({ error: `Insight not found: ${insightId}` });
    }

    if (existingInsight.user_id && existingInsight.user_id !== jwtUserId) {
      return res.status(403).json({ error: "Forbidden for requested insightId" });
    }

    const nextInsight: Insight = {
      ...existingInsight,
      ...patch,
      insight_id: insightId,
      user_id: existingInsight.user_id ?? jwtUserId,
      updatedAt: new Date().toISOString(),
    };

    await updateInsight(nextInsight);
    await upsertInsightDocument(toOpenSearchInsightDocument(nextInsight));
    return res.status(200).json({ insight: nextInsight });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.patch("/insight-family-data/:tableId", async (req: Request, res: Response) => {
  const tableId = req.params.tableId?.trim();
  if (!tableId) {
    return res.status(400).json({ error: "tableId is required in path" });
  }

  const jwtUserId = getJwtUserId(req);
  if (!jwtUserId) {
    return res.status(401).json({ error: "Authorization bearer token with sub is required" });
  }

  const patch = extractInsightFamilyDataPatch(req.body);
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: "No editable insight family data fields provided in request body" });
  }

  try {
    const existingData = await getInsightFamilyData(tableId);
    if (!existingData) {
      return res.status(404).json({ error: `Insight family data not found: ${tableId}` });
    }

    if (existingData.user_id && existingData.user_id !== jwtUserId) {
      return res.status(403).json({ error: "Forbidden for requested tableId" });
    }

    const nextRows = patch.rows ?? existingData.rows;
    const nextData: PersistedInsightFamilyData = {
      ...existingData,
      ...patch,
      table_id: tableId,
      family_id: existingData.family_id,
      user_id: existingData.user_id ?? jwtUserId,
      row_count: nextRows.length,
      updated_at: new Date().toISOString(),
    };

    await putInsightFamilyData(nextData);
    return res.status(200).json({ data: nextData });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.delete("/insights/deleteAll", async (_req: Request, res: Response) => {
  try {
    const { deletedCount } = await deleteAllInsightsWithInsightIds();

    try {
      const deletedFromOpenSearch = await deleteAllInsightDocuments();
      return res.json({
        deleted: deletedCount,
        deletedFromOpenSearch,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({
        error: `Dynamo delete succeeded but OpenSearch index wipe failed: ${message}`,
        deleted: deletedCount,
      });
    }
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
    const { deletedCount, insightIds } = await deleteInsightsByProjectIdWithInsightIds(projectId);

    try {
      await deleteInsightDocuments(insightIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({
        error: `Dynamo delete succeeded but OpenSearch delete failed: ${message}`,
        deleted: deletedCount,
        attemptedOpenSearchDeletes: insightIds.length,
        projectId,
      });
    }

    return res.json({
      deleted: deletedCount,
      deletedFromOpenSearch: insightIds.length,
      projectId,
    });
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

  if (isNdjsonRequest(req)) {
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const counts: AcceptStatusCounts = { countAccepted: 0, countDeclined: 0 };
    let persistedCount = 0;
    let projectInsightFromPayload: Insight | undefined;
    let buffer = "";

    try {
      for await (const chunk of req) {
        buffer += chunk.toString("utf8");

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (!line) {
            newlineIndex = buffer.indexOf("\n");
            continue;
          }

          const parsedInsight = toInsightFromStreamLine(line);
          const normalizedInsight = normalizeInsightStatus(parsedInsight);
          incrementStatusCounts(counts, normalizedInsight);

          if (normalizedInsight.insight_id === projectId) {
            projectInsightFromPayload = normalizedInsight;
          } else {
            await persistInsights([normalizedInsight]);
            await upsertInsightToOpenSearch(normalizedInsight);
            persistedCount += 1;
            writeAcceptStreamEvent(res, {
              type: "insight_persisted",
              index: persistedCount,
              insight_id: normalizedInsight.insight_id,
              status: normalizedInsight.status,
            });
          }

          newlineIndex = buffer.indexOf("\n");
        }
      }

      const trailingLine = buffer.trim();
      if (trailingLine.length > 0) {
        const parsedInsight = toInsightFromStreamLine(trailingLine);
        const normalizedInsight = normalizeInsightStatus(parsedInsight);
        incrementStatusCounts(counts, normalizedInsight);
        if (normalizedInsight.insight_id === projectId) {
          projectInsightFromPayload = normalizedInsight;
        } else {
          await persistInsights([normalizedInsight]);
          await upsertInsightToOpenSearch(normalizedInsight);
          persistedCount += 1;
          writeAcceptStreamEvent(res, {
            type: "insight_persisted",
            index: persistedCount,
            insight_id: normalizedInsight.insight_id,
            status: normalizedInsight.status,
          });
        }
      }

      if (projectInsightFromPayload) {
        const [projectInsight] = addProjectAcceptCountsOnCompleted(
          [projectInsightFromPayload],
          projectId,
          counts,
        );
        await persistInsights([projectInsight]);
        await upsertInsightToOpenSearch(projectInsight);
        persistedCount += 1;
        writeAcceptStreamEvent(res, {
          type: "project_counts_updated",
          project_id: projectId,
          countAccepted: counts.countAccepted,
          countDeclined: counts.countDeclined,
        });
      }

      writeAcceptStreamEvent(res, {
        type: "complete",
        updated: persistedCount,
        countAccepted: counts.countAccepted,
        countDeclined: counts.countDeclined,
      });
      res.end();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      writeAcceptStreamEvent(res, {
        type: "error",
        message,
      });
      res.end();
      return;
    }
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
    await upsertInsightsToOpenSearch(updatedInsights);
    return res.json({ updated: updatedInsights.length, items: updatedInsights });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.post("/insights/:insightId/opensearch", async (req: Request, res: Response) => {
  const insightId = req.params.insightId?.trim();
  if (!insightId) {
    return res.status(400).json({ error: "insightId is required in path" });
  }

  try {
    const insight = await getInsightById(insightId);
    if (!insight) {
      return res.status(404).json({ error: `Insight not found: ${insightId}` });
    }

    const jwtUserId = getJwtUserId(req);
    if (jwtUserId && insight.user_id && insight.user_id !== jwtUserId) {
      return res.status(403).json({ error: "Forbidden for requested insightId" });
    }

    const searchDocument = toOpenSearchInsightDocument(insight);
    await upsertInsightDocument(searchDocument);
    return res.status(200).json({
      insight_id: insightId,
      indexed: true,
      index: config.openSearchIndex,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.post("/generate-insights-v2", async (req: Request, res: Response) => {
  const jwtUserId = getJwtUserId(req);
  if (!jwtUserId) {
    return res.status(401).json({ error: "Authorization bearer token with sub is required" });
  }

  const payload = {
    ...toObjectRecord(req.body),
    userId: jwtUserId,
  } as GenerateInsightsV2Arguments;

  const outputUrlsRaw = payload.outputUrls ?? payload.sourceUris;
  if (!Array.isArray(outputUrlsRaw) || outputUrlsRaw.length === 0) {
    return res.status(400).json({
      error: "outputUrls is required and must be a non-empty array (or use sourceUris alias).",
    });
  }
  const contextUrlsRaw = Array.isArray(payload.contextUrls) ? payload.contextUrls : [];
  const researchContext =
    typeof payload.researchContext === "string" ? payload.researchContext : undefined;

  const requestId = req.header("x-request-id") ?? crypto.randomUUID();
  console.info("[generate-insights-v2] starting request", {
    requestId,
    userId: jwtUserId,
    outputUrls: outputUrlsRaw.length,
    contextUrls: contextUrlsRaw.length,
    hasResearchContext: Boolean(researchContext?.trim()),
  });

  try {
    const result = await generateInsightsV2Handler({ arguments: payload });
    console.info("[generate-insights-v2] completed request", {
      requestId,
      documents: result.documents.length,
      findings: result.findings.length,
      families: result.insight_families.length,
      rows: result.insight_rows.length,
      insightFamilyData: result.insight_family_data.length,
    });
    return res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.warn("[generate-insights-v2] failed request", {
      requestId,
      message,
    });
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
