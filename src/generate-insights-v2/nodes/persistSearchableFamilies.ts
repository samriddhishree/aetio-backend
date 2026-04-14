import type { InsightMetadataEntry, InsightSubInsight } from "../../types";
import { hashId } from "../../common/services/utils";
import { listInsights } from "../../common/services/dynamo";
import {
  updatePendingProjectInsightIds,
  updatePendingProjectMetadataDimensionIds,
} from "../../common/services/projectsTable";
import {
  normalizeDimensionName,
  normalizeDimensionValue,
} from "../services/metadataService";
import {
  isResultantMetadataField,
  resolveValidMetadataFields,
} from "../services/metadataFieldPolicy";
import {
  buildFamilyPersistenceScope,
  buildPersistedInsightFamilyRecord,
  syncSearchableInsightFamilies,
} from "../services/familyPersistence";
import {
  buildInsightFamilyDataPersistenceScope,
  syncInsightFamilyData,
} from "../services/insightFamilyDataPersistence";
import {
  buildDimensionMetadataPersistenceScope,
  syncDimensionMetadata,
} from "../services/dimensionMetadataPersistence";
import type { GenerateInsightsV2State, InsightFamily } from "../types";

function normalizeTag(value: string): string {
  return normalizeDimensionName(value);
}

function buildFamilyMetadata(
  family: InsightFamily,
  state: GenerateInsightsV2State,
  validMetadataFields: Set<string>,
): InsightMetadataEntry[] {
  const findingById = new Map(
    state.validatedFindings.map((finding) => [finding.finding_id, finding]),
  );

  const entries = new Map<string, { value: string; count: number }>();
  const supportingFindings = family.supporting_finding_ids
    .map((findingId) => findingById.get(findingId))
    .filter((finding): finding is NonNullable<typeof finding> => Boolean(finding));

  for (const finding of supportingFindings) {
    for (const dimension of finding.dimensions ?? []) {
      const tag = normalizeTag(dimension.tag);
      if (!tag) continue;
      if (isResultantMetadataField(tag)) continue;
      if (validMetadataFields.size > 0 && !validMetadataFields.has(tag)) continue;
      const value = normalizeDimensionValue({
        dimensionName: tag,
        value: dimension.value,
      }).display_value;
      if (!tag || !value) continue;
      const key = `${tag}::${value}`;
      const existing = entries.get(key) ?? { value, count: 0 };
      existing.count += 1;
      entries.set(key, existing);
    }
  }

  const denominator = Math.max(supportingFindings.length, 1);
  return Array.from(entries.entries())
    .sort((left, right) => right[1].count - left[1].count)
    .slice(0, 20)
    .map(([key, info]) => {
      const [tag] = key.split("::");
      const confidence = Number((info.count / denominator).toFixed(3));
      return {
        tag,
        value: info.value,
        confidence,
      };
    });
}

function buildFamilySubInsights(
  family: InsightFamily,
  state: GenerateInsightsV2State,
): InsightSubInsight[] {
  const findingById = new Map(
    state.validatedFindings.map((finding) => [finding.finding_id, finding]),
  );

  return family.supporting_finding_ids
    .map((findingId) => findingById.get(findingId))
    .filter((finding): finding is NonNullable<typeof finding> => Boolean(finding))
    .map((finding) => ({
      finding_id: finding.finding_id,
      text: finding.text,
      ...(finding.metric_value !== undefined ? { metric_value: finding.metric_value } : {}),
      ...(finding.metric_unit ? { metric_unit: finding.metric_unit } : {}),
      ...(Array.isArray(finding.dimensions) && finding.dimensions.length > 0
        ? {
            dimensions: finding.dimensions.map((dimension) => ({
              tag: dimension.tag,
              value: dimension.value,
            })),
          }
        : {}),
      ...(typeof finding.confidence === "number" ? { confidence: finding.confidence } : {}),
      source_modality: finding.source_modality,
      ...(finding.top_level_group_id ? { top_level_group_id: finding.top_level_group_id } : {}),
    }));
}

function buildScopeS3Node(state: GenerateInsightsV2State): string {
  const documentIds = state.documents.map((document) => document.document_id);
  const baseScope = buildFamilyPersistenceScope({
    projectId: state.projectId,
    userId: state.userId,
    documentIds,
  });

  if (state.projectId && state.projectId.trim().length > 0) {
    return baseScope;
  }

  // No project boundary provided: include document-set hash to avoid deleting unrelated families.
  return `${baseScope}:docs:${hashId(documentIds.sort().join("|"))}`;
}

export async function persistSearchableFamiliesNode(
  state: GenerateInsightsV2State,
): Promise<Partial<GenerateInsightsV2State>> {
  console.info("[family] starting persistence", {
    families: state.insightFamilies.length,
    insightFamilyData: state.insightFamilyData.length,
    dimensionMetadata: state.dimensionMetadata.length,
  });

  if (state.insightFamilies.length === 0) {
    return {
      persistedFamilyCounts: {
        created: 0,
        updated: 0,
        deleted: 0,
      },
      persistedInsightFamilyDataCounts: {
        created: 0,
        updated: 0,
        deleted: 0,
      },
      persistedDimensionMetadataCounts: {
        created: 0,
        updated: 0,
        deleted: 0,
      },
    };
  }

  const scopeS3Node = buildScopeS3Node(state);
  const documentIds = state.documents.map((document) => document.document_id);
  const sourceTypes = Array.from(new Set(state.documents.map((document) => document.file_type)));
  const primaryDocumentId = state.documents[0]?.document_id ?? "family-v2";
  const insightFamilyDataScopeS3Node = buildInsightFamilyDataPersistenceScope(scopeS3Node);
  const dimensionMetadataScopeS3Node = buildDimensionMetadataPersistenceScope(scopeS3Node);
  const validMetadataFields = resolveValidMetadataFields({
    metadataFilters: state.metadataFilters,
    dimensionMetadata: state.dimensionMetadata,
  });

  const records = state.insightFamilies.map((family) =>
    buildPersistedInsightFamilyRecord({
      family,
      userId: state.userId,
      projectId: state.projectId,
      organizationId: state.organizationId,
      status: state.status,
      documentIds,
      sourceTypes,
      scopeS3Node,
      primaryDocumentId,
      metadata: buildFamilyMetadata(family, state, validMetadataFields),
      subInsights: buildFamilySubInsights(family, state),
    }),
  );

  try {
    const [counts, tableCounts, metadataCounts] = await Promise.all([
      syncSearchableInsightFamilies({
        families: records,
        scopeS3Node,
        userId: state.userId,
      }),
      syncInsightFamilyData({
        insightFamilyData: state.insightFamilyData,
        userId: state.userId,
        projectId: state.projectId,
        organizationId: state.organizationId,
        status: state.status,
        documentIds,
        sourceTypes,
        scopeS3Node: insightFamilyDataScopeS3Node,
        primaryDocumentId,
      }),
      syncDimensionMetadata({
        dimensionMetadata: state.dimensionMetadata,
        userId: state.userId,
        projectId: state.projectId,
        organizationId: state.organizationId,
        documentIds,
        sourceTypes,
        scopeS3Node: dimensionMetadataScopeS3Node,
        primaryDocumentId,
      }),
    ]);

    console.info("[family-data] persistence completed", {
      tables: state.insightFamilyData.length,
      created: tableCounts.created,
      updated: tableCounts.updated,
      deleted: tableCounts.deleted,
      scopeS3Node: insightFamilyDataScopeS3Node,
    });

    for (const table of state.insightFamilyData) {
      console.info("[family-data] persisted table", {
        table_id: table.table_id,
        family_id: table.family_id,
        row_count: table.row_count,
      });
    }

    const upsertedMetadataCount = metadataCounts.created + metadataCounts.updated;
    console.info(`[metadata] upserted ${upsertedMetadataCount} dimension metadata records`, {
      created: metadataCounts.created,
      updated: metadataCounts.updated,
      deleted: metadataCounts.deleted,
      scopeS3Node: dimensionMetadataScopeS3Node,
    });

    console.info("[family] completed persistence", {
      families: records.length,
      created: counts.created,
      updated: counts.updated,
      deleted: counts.deleted,
      scopeS3Node,
    });

    for (const record of records) {
      console.info("[family] persisted family", {
        family_id: record.insight.insight_id,
        has_grid: record.insight.has_grid,
        row_count: record.insight.row_count,
      });
    }

    if (state.userId && state.projectId) {
      const pendingInsights = await listInsights({
        status: "Pending",
        project_id: state.projectId,
      });
      const pendingInsightIds = Array.from(
        new Set(
          pendingInsights
            .map((insight) => insight.insight_id?.trim())
            .filter((insightId): insightId is string => Boolean(insightId)),
        ),
      );

      await updatePendingProjectInsightIds({
        userId: state.userId,
        projectId: state.projectId,
        insightIds: pendingInsightIds,
      });

      const projectDimensionIds = Array.from(
        new Set(
          state.dimensionMetadata
            .map((dimension) => dimension.dimension_id?.trim())
            .filter((dimensionId): dimensionId is string => Boolean(dimensionId)),
        ),
      );

      await updatePendingProjectMetadataDimensionIds({
        userId: state.userId,
        projectId: state.projectId,
        dimensionIds: projectDimensionIds,
      });

      console.info("[family] updated project insight ids", {
        projectId: state.projectId,
        pendingInsightIds: pendingInsightIds.length,
      });
      console.info("[metadata] updated project metadata dimension ids", {
        projectId: state.projectId,
        dimensionIds: projectDimensionIds.length,
      });
    }

    return {
      persistedFamilyCounts: counts,
      persistedInsightFamilyDataCounts: tableCounts,
      persistedDimensionMetadataCounts: metadataCounts,
    };
  } catch (error) {
    console.warn("[family] failed persistence", {
      scopeS3Node,
      insightFamilyDataScopeS3Node,
      dimensionMetadataScopeS3Node,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    throw new Error(
      `PersistSearchableFamilies failed: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }
}
