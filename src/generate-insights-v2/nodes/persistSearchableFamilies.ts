import type { InsightMetadataEntry } from "../../types";
import { hashId } from "../../common/services/utils";
import {
  buildFamilyPersistenceScope,
  buildPersistedInsightFamilyRecord,
  syncSearchableInsightFamilies,
} from "../services/familyPersistence";
import {
  buildInsightFamilyDataPersistenceScope,
  syncInsightFamilyData,
} from "../services/insightFamilyDataPersistence";
import type { GenerateInsightsV2State, InsightFamily } from "../types";

function normalizeTag(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function buildFamilyMetadata(
  family: InsightFamily,
  state: GenerateInsightsV2State,
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
      const value = dimension.value.trim();
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
  console.info("[persist-family] starting searchable family persistence", {
    families: state.insightFamilies.length,
    insightFamilyData: state.insightFamilyData.length,
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
    };
  }

  const scopeS3Node = buildScopeS3Node(state);
  const documentIds = state.documents.map((document) => document.document_id);
  const sourceTypes = Array.from(new Set(state.documents.map((document) => document.file_type)));
  const primaryDocumentId = state.documents[0]?.document_id ?? "family-v2";
  const insightFamilyDataScopeS3Node = buildInsightFamilyDataPersistenceScope(scopeS3Node);

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
      metadata: buildFamilyMetadata(family, state),
    }),
  );

  try {
    const [counts, tableCounts] = await Promise.all([
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
    ]);

    console.info("[insightfamilydata] persistence completed", {
      tables: state.insightFamilyData.length,
      created: tableCounts.created,
      updated: tableCounts.updated,
      deleted: tableCounts.deleted,
      scopeS3Node: insightFamilyDataScopeS3Node,
    });

    console.info("[persist-family] completed searchable family persistence", {
      families: records.length,
      created: counts.created,
      updated: counts.updated,
      deleted: counts.deleted,
      scopeS3Node,
    });

    return {
      persistedFamilyCounts: counts,
      persistedInsightFamilyDataCounts: tableCounts,
    };
  } catch (error) {
    console.warn("[persist-family] failed searchable family persistence", {
      scopeS3Node,
      insightFamilyDataScopeS3Node,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    throw new Error(
      `PersistSearchableFamilies failed: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }
}
