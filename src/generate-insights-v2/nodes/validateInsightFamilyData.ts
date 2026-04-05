import { validateInsightFamilyData } from "../services/insightFamilyDataBuilder";
import type {
  GenerateInsightsV2State,
  InsightFamily,
  InsightFamilyData,
} from "../types";

export async function validateInsightFamilyDataNode(
  state: GenerateInsightsV2State,
): Promise<Partial<GenerateInsightsV2State>> {
  console.info("[insightfamilydata] validation node starting", {
    families: state.insightFamilies.length,
    tables: state.insightFamilyData.length,
  });

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
      console.warn("[insightfamilydata] missing table for tabular family; marking non-tabular", {
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

    const result = validateInsightFamilyData(candidateTable, 0.7);
    if (!result.valid || !result.table) {
      invalidTables += 1;
      nonTabularFamilies += 1;
      console.warn("[insightfamilydata] table validation failed; marking family non-tabular", {
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

  console.info("[insightfamilydata] validation node completed", {
    families: validatedFamilies.length,
    validatedTables: validatedTables.length,
    invalidTables,
    repairedTables,
    nonTabularFamilies,
    rows: rows.length,
  });

  return {
    insightFamilies: validatedFamilies,
    insightFamilyData: validatedTables,
    insightRows: rows,
  };
}
