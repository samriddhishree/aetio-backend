import {
  getDimensionMetadata as getDimensionMetadataRow,
  putDimensionMetadata as putDimensionMetadataRow,
  type PersistedDimensionMetadata,
} from "../../common/services/dimensionMetadataTable";
import { config } from "../../common/services/config";
import type { DimensionMetadata } from "../types";
import { mergeDimensionMetadata } from "./metadataService";

export type PersistedDimensionMetadataRecord = {
  dimensionMetadata: PersistedDimensionMetadata;
};

export type BuildPersistedDimensionMetadataInput = {
  dimensionMetadata: DimensionMetadata;
  userId?: string;
  projectId?: string;
  organizationId?: string;
  documentIds: string[];
  sourceTypes: string[];
  scopeS3Node: string;
  primaryDocumentId: string;
};

export type SyncDimensionMetadataInput = {
  dimensionMetadata: DimensionMetadata[];
  userId?: string;
  projectId?: string;
  organizationId?: string;
  documentIds: string[];
  sourceTypes: string[];
  scopeS3Node: string;
  primaryDocumentId: string;
};

export type SyncDimensionMetadataResult = {
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

function toCoreMetadata(input: PersistedDimensionMetadata | DimensionMetadata): DimensionMetadata {
  return {
    dimension_id: input.dimension_id,
    canonical_name: input.canonical_name,
    display_name: input.display_name,
    description: input.description,
    parent_dimension_id: input.parent_dimension_id,
    level: input.level,
    dimension_type: input.dimension_type,
    value_type: input.value_type,
    synonyms: input.synonyms,
    aliases: input.aliases,
    allowed_values: input.allowed_values,
    tags: input.tags,
    status: input.status,
    created_at: input.created_at,
    updated_at: input.updated_at,
  };
}

export function buildDimensionMetadataPersistenceScope(familyScopeS3Node: string): string {
  return `${familyScopeS3Node}:${config.dimensionMetadataScopeSuffix}`;
}

export function buildPersistedDimensionMetadataRecord(
  input: BuildPersistedDimensionMetadataInput,
): PersistedDimensionMetadataRecord {
  const documentIds = uniqueStrings(input.documentIds);
  const sourceTypes = uniqueStrings(input.sourceTypes);

  return {
    dimensionMetadata: {
      ...input.dimensionMetadata,
      s3_node: input.scopeS3Node,
      document_id: input.primaryDocumentId,
      document_ids: documentIds,
      source_types: sourceTypes,
      project_id: input.projectId,
      user_id: input.userId,
      organization_id: input.organizationId,
    },
  };
}

export async function syncDimensionMetadata(
  input: SyncDimensionMetadataInput,
): Promise<SyncDimensionMetadataResult> {
  const incomingRecords = input.dimensionMetadata.map((dimensionMetadata) =>
    buildPersistedDimensionMetadataRecord({
      dimensionMetadata,
      userId: input.userId,
      projectId: input.projectId,
      organizationId: input.organizationId,
      documentIds: input.documentIds,
      sourceTypes: input.sourceTypes,
      scopeS3Node: input.scopeS3Node,
      primaryDocumentId: input.primaryDocumentId,
    }),
  );
  const incomingById = new Map(
    incomingRecords.map((record) => [record.dimensionMetadata.dimension_id, record]),
  );

  const existingPairs = await Promise.all(
    Array.from(incomingById.keys()).map(async (dimensionId) => [
      dimensionId,
      await getDimensionMetadataRow(dimensionId),
    ] as const),
  );
  const existingById = new Map<string, PersistedDimensionMetadata>(
    existingPairs.filter((entry): entry is [string, PersistedDimensionMetadata] => Boolean(entry[1])),
  );

  let created = 0;
  let updated = 0;
  const deleted = 0;

  for (const [dimensionId, record] of incomingById.entries()) {
    const existingRecord = existingById.get(dimensionId);
    if (!existingRecord) {
      await putDimensionMetadataRow(record.dimensionMetadata);
      created += 1;
      continue;
    }

    const mergedCore = mergeDimensionMetadata(
      toCoreMetadata(existingRecord),
      toCoreMetadata({
        ...record.dimensionMetadata,
        created_at: existingRecord.created_at ?? record.dimensionMetadata.created_at,
      }),
    );

    await putDimensionMetadataRow({
      ...existingRecord,
      ...record.dimensionMetadata,
      ...mergedCore,
      created_at: existingRecord.created_at ?? mergedCore.created_at,
      updated_at: new Date().toISOString(),
    });
    updated += 1;
  }

  return { created, updated, deleted };
}
