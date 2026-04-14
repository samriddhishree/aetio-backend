import { validateInsightFamilyData } from "../services/insightFamilyDataBuilder";
import {
  createDimensionMetadataRegistry,
  getOrCreateDimensionMetadata,
  listDimensionMetadata,
  normalizeDimensionName,
} from "../services/metadataService";
import type {
  DimensionMetadata,
  GenerateInsightsV2State,
  InsightFamily,
  InsightFamilyData,
} from "../types";

function alignRowsToMetadata(
  table: InsightFamilyData,
  metadataById: Map<string, DimensionMetadata>,
  metadataByName: Map<string, DimensionMetadata>,
): InsightFamilyData {
  const requiredDimensions = new Set(
    table.dimensions.map((dimension) => normalizeDimensionName(dimension)),
  );

  const alignedRows = table.rows
    .map((row) => {
      const seenDimensions = new Set<string>();
      const alignedFilterValues = row.filter_values
        .map((entry) => {
          const canonicalName = normalizeDimensionName(entry.dimension_name);
          if (!canonicalName || !requiredDimensions.has(canonicalName)) return null;
          if (seenDimensions.has(canonicalName)) return null;
          seenDimensions.add(canonicalName);

          const metadata =
            (entry.dimension_id ? metadataById.get(entry.dimension_id) : undefined) ??
            metadataByName.get(canonicalName);
          if (!metadata) return null;

          const matchedValue = (metadata.allowed_values ?? []).find(
            (value) =>
              (entry.value_id && value.value_id === entry.value_id) ||
              value.canonical_value === entry.value ||
              value.display_value === entry.display_value,
          );

          return {
            dimension_id: metadata.dimension_id,
            dimension_name: metadata.canonical_name,
            value_id: matchedValue?.value_id ?? entry.value_id,
            value: matchedValue?.canonical_value ?? entry.value,
            display_value: matchedValue?.display_value ?? entry.display_value ?? entry.value,
          };
        })
        .filter(
          (
            entry,
          ): entry is InsightFamilyData["rows"][number]["filter_values"][number] => Boolean(entry),
        );

      if (alignedFilterValues.length !== requiredDimensions.size) return null;
      return {
        ...row,
        filter_values: alignedFilterValues,
      };
    })
    .filter((row): row is InsightFamilyData["rows"][number] => Boolean(row));

  return {
    ...table,
    rows: alignedRows,
    row_count: alignedRows.length,
    updated_at: new Date().toISOString(),
  };
}

export async function validateInsightFamilyDataNode(
  state: GenerateInsightsV2State,
): Promise<Partial<GenerateInsightsV2State>> {
  console.info("[family-data] validation node starting", {
    families: state.insightFamilies.length,
    tables: state.insightFamilyData.length,
    dimensionMetadata: state.dimensionMetadata.length,
  });

  const metadataRegistry = createDimensionMetadataRegistry(state.dimensionMetadata);
  for (const table of state.insightFamilyData) {
    for (const dimension of table.dimensions) {
      getOrCreateDimensionMetadata(metadataRegistry, { dimensionName: dimension });
    }
  }

  const dimensionMetadata = listDimensionMetadata(metadataRegistry);
  const metadataById = new Map(dimensionMetadata.map((metadata) => [metadata.dimension_id, metadata]));
  const metadataByName = new Map(
    dimensionMetadata.map((metadata) => [metadata.canonical_name, metadata]),
  );

  const tableById = new Map(state.insightFamilyData.map((table) => [table.table_id, table]));
  const fallbackTableByFamily = new Map<string, InsightFamilyData>();
  for (const table of state.insightFamilyData) {
    if (!fallbackTableByFamily.has(table.family_id)) {
      fallbackTableByFamily.set(table.family_id, table);
    }
  }

  const validatedFamilies: InsightFamily[] = [];
  const validatedTables: InsightFamilyData[] = [];

  let invalidTables = 0;
  let repairedTables = 0;
  let nonTabularFamilies = 0;

  for (const family of state.insightFamilies) {
    if (!family.has_grid) {
      nonTabularFamilies += 1;
      validatedFamilies.push({
        ...family,
        has_grid: false,
        insight_family_data_id: undefined,
        row_count: undefined,
        table_dimensions: undefined,
        metric_columns: undefined,
      });
      continue;
    }

    const candidateTable =
      (family.insight_family_data_id ? tableById.get(family.insight_family_data_id) : undefined) ??
      fallbackTableByFamily.get(family.family_id);

    if (!candidateTable) {
      invalidTables += 1;
      nonTabularFamilies += 1;
      console.warn("[family-data] missing table for tabular family; marking non-tabular", {
        family_id: family.family_id,
        insight_family_data_id: family.insight_family_data_id,
      });
      validatedFamilies.push({
        ...family,
        has_grid: false,
        insight_family_data_id: undefined,
        row_count: undefined,
        table_dimensions: undefined,
        metric_columns: undefined,
      });
      continue;
    }

    const tableWithMetadataAlignedRows = alignRowsToMetadata(
      candidateTable,
      metadataById,
      metadataByName,
    );

    const result = validateInsightFamilyData(tableWithMetadataAlignedRows, 0.7);
    if (!result.valid || !result.table) {
      invalidTables += 1;
      nonTabularFamilies += 1;
      console.warn("[family-data] table validation failed; marking family non-tabular", {
        family_id: family.family_id,
        table_id: candidateTable.table_id,
        errors: result.errors,
        tabularity_confidence: result.tabularity_confidence,
      });
      validatedFamilies.push({
        ...family,
        has_grid: false,
        insight_family_data_id: undefined,
        row_count: undefined,
        table_dimensions: undefined,
        metric_columns: undefined,
      });
      continue;
    }

    if (result.table.row_count !== candidateTable.row_count) {
      repairedTables += 1;
    }

    validatedTables.push(result.table);
    validatedFamilies.push({
      ...family,
      has_grid: true,
      insight_family_data_id: result.table.table_id,
      row_count: result.table.row_count,
      table_dimensions: result.table.dimensions,
      metric_columns: result.table.metric_columns,
    });
  }

  const rows = validatedTables.flatMap((table) => table.rows);

  console.info("[family-data] validation node completed", {
    families: validatedFamilies.length,
    validatedTables: validatedTables.length,
    invalidTables,
    repairedTables,
    nonTabularFamilies,
    rows: rows.length,
    dimensionMetadata: dimensionMetadata.length,
  });

  return {
    insightFamilies: validatedFamilies,
    insightFamilyData: validatedTables,
    insightRows: rows,
    dimensionMetadata,
  };
}
