import express, { Request, Response } from "express";
import cors from 'cors';
import crypto from "crypto";
import {
  generateInsightsV2MetadataPrepassHandler,
  generateInsightsV2Handler,
  type GenerateInsightsV2Arguments,
} from "./generate-insights-v2/handler";
// NOTE: generate-insights-v1 is intentionally disabled and unused.
// Do not re-enable or modify v1 paths; use generate-insights-v2 endpoints only.
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
import {
  deleteAllDimensionMetadata,
  deleteDimensionMetadataByProjectId,
  setDimensionMetadataStatusByProjectAndCanonicalNames,
} from "./common/services/dimensionMetadataTable";
import {
  deleteAllProjects,
  deleteProjectsByProjectId,
  listProjectsByUserAndStatus,
  updateProjectCountsByProjectId,
} from "./common/services/projectsTable";
import { toOpenSearchInsightDocument } from "./generate-insights-v2/services/familyPersistence";
import { normalizeDimensionName } from "./generate-insights-v2/services/metadataService";

import type { FindingRef, Insight, InsightMetadataEntry } from "./types";
import { config  } from "./common/services/config";

type FormattedInsight = Omit<Insight, "sub_insights"> & {
  sub_insights?: Insight["sub_insights"] | Insight[];
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
    const projectStatusCandidates = ["Pending", "Accepted", "Declined", "Completed"];
    const projectBuckets = await Promise.all(
      projectStatusCandidates.map((status) =>
        listProjectsByUserAndStatus({
          userId: jwtUserId,
          status,
        }),
      ),
    );
    const project = projectBuckets
      .flat()
      .find((entry) => entry.project_id === projectId);
    if (!project) {
      return res.status(404).json({ error: `Project not found: ${projectId}` });
    }

    const insightStatusCandidates = [
      "Pending",
      "Accepted",
      "Declined",
      "pending",
      "accepted",
      "declined",
    ];
    let linkedInsights = await listInsights({
      status: insightStatusCandidates,
      project_id: projectId,
    });
    const projectInsightIds = Array.isArray(project.insight_ids)
      ? project.insight_ids
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : [];

    if (linkedInsights.length === 0 && projectInsightIds.length > 0) {
      const insightsByIds = await listInsights({ insight_id: projectInsightIds });
      linkedInsights = insightsByIds;
    }

    const linkedInsightsByKey = new Map<string, Insight>();
    for (const linkedInsight of linkedInsights) {
      const key = `${linkedInsight.insight_id}::${linkedInsight.user_id ?? ""}`;
      linkedInsightsByKey.set(key, linkedInsight);
    }
    const dedupedLinkedInsights = Array.from(linkedInsightsByKey.values());

    const tableIds = Array.from(
      new Set(
        dedupedLinkedInsights
          .map((insight) => insight.insight_family_data_id?.trim())
          .filter((tableId): tableId is string => Boolean(tableId)),
      ),
    );
    const insightFamilyData = (
      await Promise.all(tableIds.map((tableId) => getInsightFamilyData(tableId)))
    ).filter((value): value is PersistedInsightFamilyData => Boolean(value));
    const insightsWithFamilyData = dedupedLinkedInsights;

    const fallbackCounts = countInsightStatuses(insightsWithFamilyData, projectId);
    const fallbackNumberChildInsights = new Set(
      insightsWithFamilyData
        .filter((entry) => entry.insight_id !== projectId)
        .map((entry) => entry.insight_id),
    ).size;
    const projectWithCounts = {
      ...project,
      countAccepted:
        typeof project.countAccepted === "number"
          ? project.countAccepted
          : fallbackCounts.countAccepted,
      countDeclined:
        typeof project.countDeclined === "number"
          ? project.countDeclined
          : fallbackCounts.countDeclined,
      numberChildInsights:
        typeof project.numberChildInsights === "number"
          ? project.numberChildInsights
          : fallbackNumberChildInsights,
    };

    return res.status(200).json({
      project: projectWithCounts,
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

const compactText = (value: string): string => value.replace(/\s+/g, " ").trim();

const migrateLegacyAdditionalRefs = (insight: Insight): Insight => {
  const refs = toObjectRecord(insight.additional_refs);
  const next: Insight = {
    ...insight,
    ...(typeof insight.footnote === "string"
      ? {}
      : typeof refs.footnote === "string"
        ? { footnote: refs.footnote }
        : {}),
    ...(typeof insight.createdAt === "string"
      ? {}
      : typeof refs.createdAt === "string"
        ? { createdAt: refs.createdAt }
        : {}),
    ...(Array.isArray(insight.preloaded_project_insights)
      ? {}
      : Array.isArray(refs.preloaded_project_insights)
        ? { preloaded_project_insights: refs.preloaded_project_insights as Insight[] }
        : {}),
  };

  const withoutLegacyFields = { ...next } as Record<string, unknown>;
  delete withoutLegacyFields.additional_refs;
  delete withoutLegacyFields.insightfamilydata;
  delete withoutLegacyFields.insight_family_data;
  return withoutLegacyFields as Insight;
};

const normalizeInsightMetadata = (metadata: unknown): InsightMetadataEntry[] | undefined => {
  if (!Array.isArray(metadata)) return undefined;

  const normalized: InsightMetadataEntry[] = [];
  const seen = new Set<string>();

  for (const item of metadata) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;

    const entry = item as Partial<InsightMetadataEntry>;
    const tag = typeof entry.tag === "string" ? compactText(entry.tag) : "";
    const value = typeof entry.value === "string" ? compactText(entry.value) : "";
    if (!tag || !value) continue;

    const key = `${tag.toLowerCase()}::${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    normalized.push({
      tag,
      value,
      ...(typeof entry.confidence === "number" ? { confidence: entry.confidence } : {}),
    });
  }

  return normalized;
};

const normalizeInsightStatus = (insight: Insight): Insight => {
  const migratedInsight = migrateLegacyAdditionalRefs(insight);
  const normalizedMetadata = normalizeInsightMetadata(migratedInsight.metadata);
  return {
    ...migratedInsight,
    evidence_snippet: migratedInsight.evidence_snippet?.trim() || migratedInsight.text,
    status: migratedInsight.status?.toLowerCase() === "declined" ? migratedInsight.status : "Accepted",
    ...(normalizedMetadata ? { metadata: normalizedMetadata } : {}),
  };
};

const isPartialInsightsAcceptRequest = (req: Request): boolean => {
  if ((req.header("x-insights-partial-update") ?? "").toLowerCase() === "true") {
    return true;
  }
  if (typeof req.query.partial === "string" && req.query.partial.toLowerCase() === "true") {
    return true;
  }
  return false;
};

const normalizeMetadataTagForDimension = (value: unknown): string => {
  const compacted = compactText(typeof value === "string" ? value : "");
  if (!compacted) return "";
  return normalizeDimensionName(compacted) || compacted.toLowerCase();
};

const collectMetadataTagsFromInsight = (insight: Insight, target: Set<string>): void => {
  for (const metadataEntry of insight.metadata ?? []) {
    const normalizedTag = normalizeMetadataTagForDimension(metadataEntry.tag);
    if (!normalizedTag) continue;
    target.add(normalizedTag);
  }
};

const collectMetadataTagsFromInsights = (insights: Insight[]): Set<string> => {
  const tags = new Set<string>();
  for (const insight of insights) {
    collectMetadataTagsFromInsight(insight, tags);
  }
  return tags;
};

const listCurrentProjectInsightsForAccept = async (projectId: string): Promise<Insight[]> => {
  const insightStatusCandidates = [
    "Pending",
    "Accepted",
    "Declined",
    "Completed",
    "pending",
    "accepted",
    "declined",
    "completed",
  ];
  const [projectInsights, projectRootCandidates] = await Promise.all([
    listInsights({ status: insightStatusCandidates, project_id: projectId }),
    listInsights({ insight_id: projectId }),
  ]);

  const deduped = new Map<string, Insight>();
  for (const insight of [...projectInsights, ...projectRootCandidates]) {
    const key = `${insight.insight_id}::${insight.user_id ?? ""}`;
    deduped.set(key, insight);
  }
  return Array.from(deduped.values());
};

const getRemovedMetadataDimensions = (existing: Set<string>, incoming: Set<string>): string[] =>
  Array.from(existing).filter((tag) => !incoming.has(tag));

const declineRemovedMetadataDimensions = async (input: {
  projectId: string;
  existingMetadataTags: Set<string>;
  incomingMetadataTags: Set<string>;
}): Promise<number> => {
  const removedTags = getRemovedMetadataDimensions(
    input.existingMetadataTags,
    input.incomingMetadataTags,
  );
  if (removedTags.length === 0) return 0;

  const updatedCount = await setDimensionMetadataStatusByProjectAndCanonicalNames({
    projectId: input.projectId,
    canonicalNames: removedTags,
    status: "Declined",
  });

  console.info("[insights-accept] metadata dimensions marked Declined", {
    projectId: input.projectId,
    removedTags: removedTags.length,
    updatedCount,
    removedTagNames: removedTags,
  });

  return updatedCount;
};

const countInsightStatuses = (insights: Insight[], projectId?: string): AcceptStatusCounts =>
  insights.reduce<AcceptStatusCounts>(
    (acc, insight) => {
      if (projectId && insight.insight_id === projectId) return acc;
      const normalizedStatus = insight.status?.toLowerCase();
      if (normalizedStatus === "declined") acc.countDeclined += 1;
      if (normalizedStatus === "accepted") acc.countAccepted += 1;
      return acc;
    },
    { countAccepted: 0, countDeclined: 0 },
  );

const incrementStatusCounts = (
  counts: AcceptStatusCounts,
  insight: Insight,
  projectId?: string,
): void => {
  if (projectId && insight.insight_id === projectId) return;
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
  if (Array.isArray(payload.metadata)) patch.metadata = normalizeInsightMetadata(payload.metadata) ?? [];
  if (typeof payload.status === "string") patch.status = payload.status;
  if (typeof payload.footnote === "string") patch.footnote = payload.footnote;
  if (Array.isArray(payload.preloaded_project_insights)) {
    patch.preloaded_project_insights = payload.preloaded_project_insights;
  }
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

const setProjectInsightStatusOnCompleted = (
  insights: Insight[],
  projectId: string,
): Insight[] =>
  insights.map((insight) => {
    if (insight.insight_id !== projectId) return insight;
    const normalizedStatus = insight.status?.toLowerCase();
    const projectStatus = normalizedStatus === "declined" ? "Declined" : "Accepted";
    return {
      ...insight,
      status: projectStatus,
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
    if (Array.isArray(item.sub_insights) && item.sub_insights.length > 0) return item;

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

/*
 * -----------------------------------------------------------------------------
 * DEPRECATED / UNUSED: generate-insights-v1 surface area
 * Disabled on 2026-04-11.
 * Do not modify this block in the future; keep as historical reference only.
 * Use generate-insights-v2 endpoints exclusively.
 * -----------------------------------------------------------------------------
 *
 * const isChunk = (value: unknown): value is Chunk => {
 *   if (!value || typeof value !== "object" || Array.isArray(value)) return false;
 *   const chunk = value as Partial<Chunk>;
 *   return (
 *     typeof chunk.chunk_id === "string" &&
 *     typeof chunk.document_id === "string" &&
 *     (chunk.type === "text" || chunk.type === "image") &&
 *     typeof chunk.content === "string" &&
 *     Array.isArray(chunk.block_ids) &&
 *     typeof chunk.s3_node === "string"
 *   );
 * };
 */

app.get("/insights", async (req: Request, res: Response) => {
  const parsedFilters = extractInsightFilters(req.query);
  if ("error" in parsedFilters) {
    return res.status(400).json({ error: parsedFilters.error });
  }

  try {
    // TODO: Support user_id filtering from JWT (sub) for /insights once auth scoping is re-enabled.
    const items = await listInsights(parsedFilters);
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

    const nextInsight = migrateLegacyAdditionalRefs({
      ...existingInsight,
      ...patch,
      insight_id: insightId,
      user_id: existingInsight.user_id ?? jwtUserId,
      updatedAt: new Date().toISOString(),
    });

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
      const deletedFromDimensionMetadata = await deleteAllDimensionMetadata();
      const deletedFromProjects = await deleteAllProjects();
      const deletedFromOpenSearch = await deleteAllInsightDocuments();
      return res.json({
        deleted: deletedCount,
        deletedFromDimensionMetadata,
        deletedFromProjects,
        deletedFromOpenSearch,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({
        error: `Insights delete succeeded but related-table cleanup or OpenSearch index wipe failed: ${message}`,
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
      const deletedFromDimensionMetadata = await deleteDimensionMetadataByProjectId(projectId);
      const deletedFromProjects = await deleteProjectsByProjectId(projectId);
      await deleteInsightDocuments(insightIds);
      return res.json({
        deleted: deletedCount,
        deletedFromDimensionMetadata,
        deletedFromProjects,
        deletedFromOpenSearch: insightIds.length,
        projectId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({
        error: `Insights delete succeeded but related-table cleanup or OpenSearch delete failed: ${message}`,
        deleted: deletedCount,
        attemptedOpenSearchDeletes: insightIds.length,
        projectId,
      });
    }
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

  const isPartialUpdate = isPartialInsightsAcceptRequest(req);

  if (isNdjsonRequest(req)) {
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const counts: AcceptStatusCounts = { countAccepted: 0, countDeclined: 0 };
    const childInsightIds = new Set<string>();
    let persistedCount = 0;
    let projectInsightFromPayload: Insight | undefined;
    let buffer = "";
    let existingMetadataTags = new Set<string>();
    const incomingMetadataTags = new Set<string>();

    try {
      if (!isPartialUpdate) {
        const existingProjectInsights = await listCurrentProjectInsightsForAccept(projectId);
        existingMetadataTags = collectMetadataTagsFromInsights(existingProjectInsights);
      }

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
          collectMetadataTagsFromInsight(normalizedInsight, incomingMetadataTags);
          incrementStatusCounts(counts, normalizedInsight, projectId);

          if (normalizedInsight.insight_id === projectId) {
            projectInsightFromPayload = normalizedInsight;
          } else {
            childInsightIds.add(normalizedInsight.insight_id);
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
        collectMetadataTagsFromInsight(normalizedInsight, incomingMetadataTags);
        incrementStatusCounts(counts, normalizedInsight, projectId);
        if (normalizedInsight.insight_id === projectId) {
          projectInsightFromPayload = normalizedInsight;
        } else {
          childInsightIds.add(normalizedInsight.insight_id);
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
        const [projectInsight] = setProjectInsightStatusOnCompleted(
          [projectInsightFromPayload],
          projectId,
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

      if (projectInsightFromPayload && !isPartialUpdate) {
        await declineRemovedMetadataDimensions({
          projectId,
          existingMetadataTags,
          incomingMetadataTags,
        });

        await updateProjectCountsByProjectId({
          projectId,
          countAccepted: counts.countAccepted,
          countDeclined: counts.countDeclined,
          numberChildInsights: childInsightIds.size,
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
  const statusCounts = countInsightStatuses(normalizedInsights, projectId);
  const numberChildInsights = new Set(
    normalizedInsights
      .filter((entry) => entry.insight_id !== projectId)
      .map((entry) => entry.insight_id),
  ).size;
  const updatedInsights = setProjectInsightStatusOnCompleted(
    normalizedInsights,
    projectId,
  );
  const shouldReconcileMetadataDimensions =
    !isPartialUpdate && updatedInsights.some((entry) => entry.insight_id === projectId);

  try {
    const existingMetadataTags = shouldReconcileMetadataDimensions
      ? collectMetadataTagsFromInsights(await listCurrentProjectInsightsForAccept(projectId))
      : new Set<string>();

    await persistInsights(updatedInsights);
    await upsertInsightsToOpenSearch(updatedInsights);
    const metadataDimensionsDeclined = shouldReconcileMetadataDimensions
      ? await declineRemovedMetadataDimensions({
          projectId,
          existingMetadataTags,
          incomingMetadataTags: collectMetadataTagsFromInsights(updatedInsights),
        })
      : 0;

    if (!isPartialUpdate) {
      await updateProjectCountsByProjectId({
        projectId,
        countAccepted: statusCounts.countAccepted,
        countDeclined: statusCounts.countDeclined,
        numberChildInsights,
      });
    }

    return res.json({
      updated: updatedInsights.length,
      items: updatedInsights,
      metadataDimensionsDeclined,
    });
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
      dimensionMetadata: result.dimension_metadata.length,
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

app.post("/generate-insights-v2-metadata-prepass", async (req: Request, res: Response) => {
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

  const requestId = req.header("x-request-id") ?? crypto.randomUUID();
  console.info("[generate-insights-v2-prepass] starting request", {
    requestId,
    userId: jwtUserId,
    outputUrls: outputUrlsRaw.length,
  });

  try {
    const result = await generateInsightsV2MetadataPrepassHandler({ arguments: payload });
    console.info("[generate-insights-v2-prepass] completed request", {
      requestId,
      documents: result.documents.length,
      tables: result.tables.length,
      metadataFilters: result.metadata_filters.length,
      dimensionMetadata: result.dimension_metadata.length,
    });
    return res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.warn("[generate-insights-v2-prepass] failed request", {
      requestId,
      message,
    });
    return res.status(500).json({ error: message, requestId });
  }
});

/*
 * -----------------------------------------------------------------------------
 * DEPRECATED / UNUSED: generate-insights-v1 endpoint
 * Disabled on 2026-04-11.
 * Do not modify this block in the future; keep as historical reference only.
 * Use /generate-insights-v2 and /generate-insights-v2-metadata-prepass.
 * -----------------------------------------------------------------------------
 *
 * app.post("/generateInsightsFromChunks", async (req: Request, res: Response) => {
 *   const jwtUserId = getJwtUserId(req);
 *   if (!jwtUserId) {
 *     return res.status(401).json({ error: "Authorization bearer token with sub is required" });
 *   }
 *
 *   const body = toObjectRecord(req.body);
 *   const rawChunks = body.chunks;
 *   if (!Array.isArray(rawChunks) || rawChunks.length === 0) {
 *     return res.status(400).json({ error: "chunks is required and must be a non-empty array" });
 *   }
 *
 *   if (!rawChunks.every(isChunk)) {
 *     return res.status(400).json({
 *       error:
 *         "Each chunk must include chunk_id, document_id, type, content, block_ids, and s3_node.",
 *     });
 *   }
 *
 *   const chunks = rawChunks as Chunk[];
 *   const contextUrls = Array.isArray(body.contextUrls)
 *     ? body.contextUrls.filter((url): url is string => typeof url === "string")
 *     : [];
 *   const researchContext =
 *     typeof body.researchContext === "string" ? body.researchContext : "";
 *   const userInfo = toObjectRecord(body.userInfo ?? body.user_info) as {
 *     full_name?: string;
 *     email_address?: string;
 *   };
 *   const requestId = req.header("x-request-id") ?? crypto.randomUUID();
 *
 *   try {
 *     const summaryResult = await summarizeProject(contextUrls, researchContext, {
 *       userId: jwtUserId,
 *       userInfo,
 *     });
 *     const result = await runIngestionPipelineFromChunks(
 *       chunks,
 *       jwtUserId,
 *       userInfo,
 *       summaryResult.insight_id,
 *     );
 *
 *     return res.status(202).json({
 *       status: "accepted",
 *       requestId,
 *       ok: result.errors.length === 0,
 *       insights: result.insights.length,
 *       documents: result.documents.length,
 *       chunks: result.chunks.length,
 *       summary: summaryResult.summary,
 *       errors: result.errors.map((error) => ({
 *         stage: error.stage,
 *         message: error.message,
 *         url: error.url,
 *         document_id: error.document_id,
 *       })),
 *     });
 *   } catch (error) {
 *     const message = error instanceof Error ? error.message : "Unknown error";
 *     return res.status(500).json({ error: message, requestId });
 *   }
 * });
 */

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
