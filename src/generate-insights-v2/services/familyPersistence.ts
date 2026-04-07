import type { Insight, InsightMetadataEntry } from "../../types";
import {
  deleteInsightById,
  listInsights,
  persistInsights,
  updateInsight,
} from "../../common/services/dynamo";
import {
  deleteInsightDocument,
  upsertInsightDocument,
} from "../../common/services/elasticsearch";
import { hashId } from "../../common/services/utils";
import type { InsightFamily } from "../types";

export type SearchInsightDocument = {
  insight_id: string;
  text: string;
  family_text: string;
  question_answered: string;
  summary?: string;
  filters?: string[];
  has_grid?: boolean;
  insight_family_data_id?: string;
  row_count?: number;
  table_dimensions?: string[];
  metric_columns?: string[];
  metadata?: Array<{ tag: string; value: string; confidence?: number }>;
  project_id?: string;
  user_id?: string;
  organization_id?: string;
  document_ids?: string[];
  source_types?: string[];
  status?: string;
  created_at?: string;
  updated_at?: string;
  expires_at?: string;
  searchable_text: string;
};

export type PersistedInsightFamilyRecord = {
  insight: Insight;
  searchDocument: SearchInsightDocument;
};

export type BuildPersistedInsightFamilyInput = {
  family: InsightFamily;
  userId?: string;
  projectId?: string;
  organizationId?: string;
  status?: string;
  documentIds: string[];
  sourceTypes: string[];
  scopeS3Node: string;
  primaryDocumentId: string;
  metadata?: InsightMetadataEntry[];
};

export type SyncSearchableInsightFamiliesInput = {
  families: PersistedInsightFamilyRecord[];
  scopeS3Node: string;
  userId?: string;
};

export type SyncSearchableInsightFamiliesResult = {
  created: number;
  updated: number;
  deleted: number;
};

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items.map((item) => compact(item)).filter(Boolean)));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toIsoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function addOneYearIso(baseIso: string): string {
  const next = new Date(baseIso);
  next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next.toISOString();
}

function buildSearchableText(input: {
  familyText: string;
  questionAnswered: string;
  summary?: string;
  filters: string[];
  dimensions: string[];
  metricColumns: string[];
}): string {
  return [
    input.familyText,
    input.questionAnswered,
    input.summary ?? "",
    input.filters.join(" "),
    input.dimensions.join(" "),
    input.metricColumns.join(" "),
  ]
    .map((value) => compact(value))
    .filter(Boolean)
    .join(" ");
}

function normalizeMetadata(metadata: InsightMetadataEntry[] | undefined): InsightMetadataEntry[] {
  return (metadata ?? [])
    .map((entry) => ({
      tag: compact(entry.tag),
      value: compact(entry.value),
      ...(typeof entry.confidence === "number" ? { confidence: entry.confidence } : {}),
    }))
    .filter((entry) => entry.tag.length > 0 && entry.value.length > 0);
}

export function buildFamilyPersistenceScope(input: {
  projectId?: string;
  userId?: string;
  documentIds: string[];
}): string {
  if (input.projectId && input.projectId.trim().length > 0) {
    return `family-v2:project:${input.projectId.trim()}`;
  }

  const scopeBasis = [
    input.userId ?? "anonymous",
    ...uniqueStrings(input.documentIds).sort(),
  ].join("|");
  return `family-v2:scope:${hashId(scopeBasis)}`;
}

export function toOpenSearchInsightDocument(insight: Insight): SearchInsightDocument {
  const refs = asRecord(insight.additional_refs);
  const createdAt = toIsoOrUndefined(insight.created_at) ?? toIsoOrUndefined(insight.createdAt);
  const updatedAt = toIsoOrUndefined(insight.updated_at) ?? toIsoOrUndefined(insight.updatedAt);
  const expiresAt = toIsoOrUndefined(insight.expires_at) ?? toIsoOrUndefined(insight.expiresAt);
  const familyText =
    typeof insight.family_text === "string" && insight.family_text.trim().length > 0
      ? compact(insight.family_text)
      : compact(insight.text);
  const questionAnswered =
    typeof insight.question_answered === "string" && insight.question_answered.trim().length > 0
      ? compact(insight.question_answered)
      : typeof refs.question_answered === "string"
        ? compact(refs.question_answered)
        : "";

  const summary =
    typeof insight.summary === "string"
      ? compact(insight.summary)
      : typeof refs.family_summary === "string"
        ? compact(refs.family_summary)
        : undefined;

  const filters = Array.isArray(insight.filters)
    ? uniqueStrings(insight.filters)
    : Array.isArray(refs.filters)
      ? uniqueStrings(refs.filters.filter((value): value is string => typeof value === "string"))
      : [];

  const documentIds = Array.isArray(insight.document_ids)
    ? uniqueStrings(insight.document_ids)
    : Array.isArray(refs.document_ids)
      ? uniqueStrings(refs.document_ids.filter((value): value is string => typeof value === "string"))
      : [];

  const sourceTypes = Array.isArray(insight.source_types)
    ? uniqueStrings(insight.source_types)
    : Array.isArray(refs.source_types)
      ? uniqueStrings(refs.source_types.filter((value): value is string => typeof value === "string"))
      : [];

  const hasGrid = typeof insight.has_grid === "boolean"
    ? insight.has_grid
    : typeof refs.has_grid === "boolean"
      ? refs.has_grid
      : undefined;

  const insightFamilyDataId = typeof insight.insight_family_data_id === "string"
    ? compact(insight.insight_family_data_id)
    : typeof refs.insight_family_data_id === "string"
      ? compact(refs.insight_family_data_id)
      : undefined;

  const rowCount = typeof insight.row_count === "number"
    ? insight.row_count
    : typeof refs.row_count === "number"
      ? refs.row_count
      : undefined;

  const tableDimensions = Array.isArray(insight.table_dimensions)
    ? uniqueStrings(insight.table_dimensions)
    : Array.isArray(refs.table_dimensions)
      ? uniqueStrings(
          refs.table_dimensions.filter((value): value is string => typeof value === "string"),
        )
      : [];

  const metricColumns = Array.isArray(insight.metric_columns)
    ? uniqueStrings(insight.metric_columns)
    : Array.isArray(refs.metric_columns)
      ? uniqueStrings(
          refs.metric_columns.filter((value): value is string => typeof value === "string"),
        )
      : [];

  const searchableText = buildSearchableText({
    familyText,
    questionAnswered,
    summary,
    filters,
    dimensions: tableDimensions,
    metricColumns,
  });

  return {
    insight_id: insight.insight_id,
    text: compact(insight.text),
    family_text: familyText,
    question_answered: questionAnswered,
    summary,
    filters,
    has_grid: hasGrid,
    insight_family_data_id: insightFamilyDataId,
    row_count: rowCount,
    table_dimensions: tableDimensions,
    metric_columns: metricColumns,
    metadata: normalizeMetadata(insight.metadata),
    project_id: insight.project_id,
    user_id: insight.user_id,
    organization_id: insight.organization_id,
    document_ids: documentIds,
    source_types: sourceTypes,
    status: insight.status,
    created_at: createdAt,
    updated_at: updatedAt,
    expires_at: expiresAt,
    searchable_text: searchableText,
  };
}

export function buildPersistedInsightFamilyRecord(
  input: BuildPersistedInsightFamilyInput,
): PersistedInsightFamilyRecord {
  const now = new Date().toISOString();
  const createdAt = toIsoOrUndefined(input.family.created_at) ?? now;
  const expiresAt = toIsoOrUndefined(input.family.expires_at) ?? addOneYearIso(createdAt);
  const documentIds = uniqueStrings(input.documentIds);
  const sourceTypes = uniqueStrings(input.sourceTypes);
  const filters = uniqueStrings(input.family.filters);
  const tableDimensions = uniqueStrings(input.family.table_dimensions ?? []);
  const metricColumns = uniqueStrings(input.family.metric_columns ?? []);

  const insight: Insight = {
    insight_id: input.family.family_id,
    object_type: "insight_family",
    text: input.family.family_text,
    family_text: input.family.family_text,
    question_answered: input.family.question_answered,
    summary: input.family.summary,
    has_grid: input.family.has_grid ?? false,
    insight_family_data_id: input.family.insight_family_data_id,
    row_count: input.family.row_count,
    table_dimensions: tableDimensions,
    metric_columns: metricColumns,
    evidence_snippet: input.family.summary ?? input.family.question_answered,
    s3_node: input.scopeS3Node,
    document_id: input.primaryDocumentId,
    document_ids: documentIds,
    source_types: sourceTypes,
    filters,
    metadata: normalizeMetadata(input.metadata),
    project_id: input.projectId,
    user_id: input.userId,
    user_info: input.family.user_info,
    organization_id: input.organizationId,
    status: input.status ?? "Pending",
    created_at: createdAt,
    updated_at: now,
    createdAt: createdAt,
    updatedAt: now,
    expires_at: expiresAt,
    expiresAt: expiresAt,
    additional_refs: {
      object_type: "insight_family",
      question_answered: input.family.question_answered,
      family_summary: input.family.summary,
      filters,
      has_grid: input.family.has_grid ?? false,
      insight_family_data_id: input.family.insight_family_data_id,
      row_count: input.family.row_count,
      table_dimensions: tableDimensions,
      metric_columns: metricColumns,
      supporting_finding_ids: input.family.supporting_finding_ids,
      document_ids: documentIds,
      source_types: sourceTypes,
      scope_s3_node: input.scopeS3Node,
      created_at: createdAt,
      expires_at: expiresAt,
    },
  };

  return {
    insight,
    searchDocument: toOpenSearchInsightDocument(insight),
  };
}

export async function createSearchableInsightFamily(
  record: PersistedInsightFamilyRecord,
): Promise<void> {
  console.info("[persist-family] creating family", {
    insight_id: record.insight.insight_id,
    project_id: record.insight.project_id,
    user_id: record.insight.user_id,
  });

  await persistInsights([record.insight]);

  try {
    await upsertInsightDocument(record.searchDocument);
    console.info("[opensearch-sync] indexed family", {
      insight_id: record.insight.insight_id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.warn("[opensearch-sync] failed indexing family", {
      insight_id: record.insight.insight_id,
      message,
    });
    throw new Error(
      `DB write succeeded but OpenSearch create/upsert failed for ${record.insight.insight_id}: ${message}`,
    );
  }
}

export async function updateSearchableInsightFamily(
  record: PersistedInsightFamilyRecord,
): Promise<void> {
  console.info("[persist-family] updating family", {
    insight_id: record.insight.insight_id,
    project_id: record.insight.project_id,
    user_id: record.insight.user_id,
  });

  const updatePayload: Insight = {
    ...record.insight,
    updated_at: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await updateInsight(updatePayload);

  try {
    await upsertInsightDocument(toOpenSearchInsightDocument(updatePayload));
    console.info("[opensearch-sync] updated family", {
      insight_id: record.insight.insight_id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.warn("[opensearch-sync] failed updating family", {
      insight_id: record.insight.insight_id,
      message,
    });
    throw new Error(
      `DB update succeeded but OpenSearch update/upsert failed for ${record.insight.insight_id}: ${message}`,
    );
  }
}

export async function deleteSearchableInsightFamily(insightId: string): Promise<void> {
  console.info("[persist-family] deleting family", { insight_id: insightId });
  await deleteInsightById(insightId);

  try {
    await deleteInsightDocument(insightId);
    console.info("[opensearch-sync] deleted family", { insight_id: insightId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.warn("[opensearch-sync] failed deleting family", {
      insight_id: insightId,
      message,
    });
    throw new Error(
      `DB delete succeeded but OpenSearch delete failed for ${insightId}: ${message}`,
    );
  }
}

export async function syncSearchableInsightFamilies(
  input: SyncSearchableInsightFamiliesInput,
): Promise<SyncSearchableInsightFamiliesResult> {
  if (!input.userId) {
    throw new Error(
      "syncSearchableInsightFamilies requires userId. Current fixed query path uses user_id index GSI_UserId.",
    );
  }

  const filters = { s3_node: input.scopeS3Node, user_id: input.userId };

  const existing = await listInsights(filters);
  const existingById = new Map(existing.map((insight) => [insight.insight_id, insight]));
  const incomingById = new Map(input.families.map((record) => [record.insight.insight_id, record]));

  let created = 0;
  let updated = 0;
  let deleted = 0;

  for (const [insightId, record] of incomingById.entries()) {
    const existingInsight = existingById.get(insightId);
    if (!existingInsight) {
      await createSearchableInsightFamily(record);
      created += 1;
      continue;
    }

    const mergedInsight: Insight = {
      ...existingInsight,
      ...record.insight,
      created_at: existingInsight.created_at ?? existingInsight.createdAt ?? record.insight.created_at ?? record.insight.createdAt,
      expires_at:
        existingInsight.expires_at ??
        existingInsight.expiresAt ??
        record.insight.expires_at ??
        record.insight.expiresAt,
      createdAt: existingInsight.createdAt ?? record.insight.createdAt,
      expiresAt: existingInsight.expiresAt ?? record.insight.expiresAt,
      updated_at: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await updateSearchableInsightFamily({
      insight: mergedInsight,
      searchDocument: toOpenSearchInsightDocument(mergedInsight),
    });
    updated += 1;
  }

  for (const existingInsight of existing) {
    if (incomingById.has(existingInsight.insight_id)) continue;
    await deleteSearchableInsightFamily(existingInsight.insight_id);
    deleted += 1;
  }

  return { created, updated, deleted };
}
