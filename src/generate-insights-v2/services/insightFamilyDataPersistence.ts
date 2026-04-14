import {
  deleteInsightFamilyData as deleteInsightFamilyDataRow,
  getInsightFamilyData as getInsightFamilyDataRow,
  putInsightFamilyData as putInsightFamilyDataRow,
  type PersistedInsightFamilyData,
} from "../../common/services/insightFamilyDataTable";
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
      table_markdown: input.table.table_markdown,
      table_text_chunk: input.table.table_text_chunk,
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
  console.info(
    `[family-data] persisted table ${record.familyData.table_id} with ${record.familyData.row_count} rows`,
    {
      family_id: record.familyData.family_id,
    },
  );
  await putInsightFamilyDataRow(record.familyData);
}

export async function updateInsightFamilyData(
  record: PersistedInsightFamilyDataRecord,
): Promise<void> {
  console.info(
    `[family-data] persisted table ${record.familyData.table_id} with ${record.familyData.row_count} rows`,
    {
      family_id: record.familyData.family_id,
    },
  );
  await putInsightFamilyDataRow({
    ...record.familyData,
    updated_at: new Date().toISOString(),
  });
}

export async function deleteInsightFamilyData(tableId: string): Promise<void> {
  console.info("[family-data] deleting persisted table", { table_id: tableId });
  await deleteInsightFamilyDataRow(tableId);
}

export async function syncInsightFamilyData(
  input: SyncInsightFamilyDataInput,
): Promise<SyncInsightFamilyDataResult> {
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
  const existingPairs = await Promise.all(
    Array.from(incomingById.keys()).map(async (tableId) => [
      tableId,
      await getInsightFamilyDataRow(tableId),
    ] as const),
  );
  const existingById = new Map<string, PersistedInsightFamilyData>(
    existingPairs.filter((entry): entry is [string, PersistedInsightFamilyData] => Boolean(entry[1])),
  );

  let created = 0;
  let updated = 0;
  const deleted = 0;

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

  return { created, updated, deleted };
}
