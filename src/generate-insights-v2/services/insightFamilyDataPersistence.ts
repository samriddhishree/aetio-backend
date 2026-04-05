import {
  deleteInsightFamilyData as deleteInsightFamilyDataRow,
  listInsightFamilyData as listInsightFamilyDataRows,
  putInsightFamilyData as putInsightFamilyDataRow,
  type PersistedInsightFamilyData,
} from "../../common/services/insightFamilyDataTable";
import { deleteInsightById, listInsights } from "../../common/services/dynamo";
import { config } from "../../common/services/config";
import type { InsightFamilyData } from "../types";

export type PersistedInsightFamilyDataRecord = {
  familyData: PersistedInsightFamilyData;
};

export type BuildPersistedInsightFamilyDataInput = {
  table: InsightFamilyData;
  userId?: string;
  projectId?: string;
  organizationId?: string;
  status?: string;
  documentIds: string[];
  sourceTypes: string[];
  scopeS3Node: string;
  primaryDocumentId: string;
};

export type SyncInsightFamilyDataInput = {
  insightFamilyData: InsightFamilyData[];
  userId?: string;
  projectId?: string;
  organizationId?: string;
  status?: string;
  documentIds: string[];
  sourceTypes: string[];
  scopeS3Node: string;
  primaryDocumentId: string;
};

export type SyncInsightFamilyDataResult = {
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

export function buildInsightFamilyDataPersistenceScope(familyScopeS3Node: string): string {
  return `${familyScopeS3Node}:${config.insightFamilyDataScopeSuffix}`;
}

export function buildPersistedInsightFamilyDataRecord(
  input: BuildPersistedInsightFamilyDataInput,
): PersistedInsightFamilyDataRecord {
  const documentIds = uniqueStrings(input.documentIds);
  const sourceTypes = uniqueStrings(input.sourceTypes);

  return {
    familyData: {
      table_id: input.table.table_id,
      family_id: input.table.family_id,
      s3_node: input.scopeS3Node,
      document_id: input.primaryDocumentId,
      document_ids: documentIds,
      source_types: sourceTypes,
      row_count: input.table.row_count,
      dimensions: input.table.dimensions,
      metric_columns: input.table.metric_columns,
      source_modalities: input.table.source_modalities ?? [],
      project_id: input.projectId,
      user_id: input.userId,
      organization_id: input.organizationId,
      status: input.status ?? "Pending",
      rows: input.table.rows,
      created_at: input.table.created_at,
      updated_at: input.table.updated_at,
    },
  };
}

export async function createInsightFamilyData(
  record: PersistedInsightFamilyDataRecord,
): Promise<void> {
  console.info("[insightfamilydata] creating persisted insightfamilydata", {
    table_id: record.familyData.table_id,
    family_id: record.familyData.family_id,
  });
  await putInsightFamilyDataRow(record.familyData);
}

export async function updateInsightFamilyData(
  record: PersistedInsightFamilyDataRecord,
): Promise<void> {
  console.info("[insightfamilydata] updating persisted insightfamilydata", {
    table_id: record.familyData.table_id,
    family_id: record.familyData.family_id,
  });
  await putInsightFamilyDataRow({
    ...record.familyData,
    updated_at: new Date().toISOString(),
  });
}

export async function deleteInsightFamilyData(tableId: string): Promise<void> {
  console.info("[insightfamilydata] deleting persisted insightfamilydata", { table_id: tableId });
  await deleteInsightFamilyDataRow(tableId);
}

async function cleanupLegacyInsightFamilyDataRows(input: {
  scopeS3Node: string;
  userId?: string;
}): Promise<void> {
  try {
    const legacyRows = await listInsights(
      input.userId
        ? {
            s3_node: input.scopeS3Node,
            user_id: input.userId,
            object_type: config.insightFamilyDataType,
          }
        : {
            s3_node: input.scopeS3Node,
            object_type: config.insightFamilyDataType,
          },
    );

    for (const row of legacyRows) {
      await deleteInsightById(row.insight_id);
    }

    if (legacyRows.length > 0) {
      console.info("[insightfamilydata] cleaned up legacy insight rows", {
        count: legacyRows.length,
        scopeS3Node: input.scopeS3Node,
      });
    }
  } catch (error) {
    console.warn("[insightfamilydata] legacy insight-row cleanup failed", {
      scopeS3Node: input.scopeS3Node,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function syncInsightFamilyData(
  input: SyncInsightFamilyDataInput,
): Promise<SyncInsightFamilyDataResult> {
  const existing = await listInsightFamilyDataRows(
    input.userId
      ? {
          s3_node: input.scopeS3Node,
          user_id: input.userId,
        }
      : {
          s3_node: input.scopeS3Node,
        },
  );

  const existingById = new Map(existing.map((record) => [record.table_id, record]));
  const incomingRecords = input.insightFamilyData.map((table) =>
    buildPersistedInsightFamilyDataRecord({
      table,
      userId: input.userId,
      projectId: input.projectId,
      organizationId: input.organizationId,
      status: input.status,
      documentIds: input.documentIds,
      sourceTypes: input.sourceTypes,
      scopeS3Node: input.scopeS3Node,
      primaryDocumentId: input.primaryDocumentId,
    }),
  );
  const incomingById = new Map(
    incomingRecords.map((record) => [record.familyData.table_id, record]),
  );

  let created = 0;
  let updated = 0;
  let deleted = 0;

  for (const [tableId, record] of incomingById.entries()) {
    const existingRecord = existingById.get(tableId);
    if (!existingRecord) {
      await createInsightFamilyData(record);
      created += 1;
      continue;
    }

    await updateInsightFamilyData({
      familyData: {
        ...existingRecord,
        ...record.familyData,
        created_at: existingRecord.created_at ?? record.familyData.created_at,
        updated_at: new Date().toISOString(),
      },
    });
    updated += 1;
  }

  for (const existingRecord of existing) {
    if (incomingById.has(existingRecord.table_id)) continue;
    await deleteInsightFamilyData(existingRecord.table_id);
    deleted += 1;
  }

  await cleanupLegacyInsightFamilyDataRows({
    scopeS3Node: input.scopeS3Node,
    userId: input.userId,
  });

  return { created, updated, deleted };
}
