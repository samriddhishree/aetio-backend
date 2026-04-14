import {
  buildInsightFamilyDataFromFindings,
} from "../services/insightFamilyDataBuilder";
import type {
  DimensionMetadata,
  GenerateInsightsV2State,
  InsightFamily,
  InsightFamilyData,
  InsightInstanceRow,
} from "../types";

export async function buildInsightFamilyDataNode(
  state: GenerateInsightsV2State,
): Promise<Partial<GenerateInsightsV2State>> {
  console.info("[family-data] build node starting", {
    families: state.insightFamilies.length,
    findings: state.validatedFindings.length,
  });

  const findingById = new Map(state.validatedFindings.map((finding) => [finding.finding_id, finding]));
  const updatedFamilies: InsightFamily[] = [];
  const insightFamilyData: InsightFamilyData[] = [];
  const insightRows: InsightInstanceRow[] = [];
  let dimensionMetadata: DimensionMetadata[] = state.dimensionMetadata;

  let totalDroppedDuplicateRows = 0;
  let tabularFamilies = 0;
  let narrativeFamilies = 0;

  for (const family of state.insightFamilies) {
    const supportingFindings = family.supporting_finding_ids
      .map((findingId) => findingById.get(findingId))
      .filter((finding): finding is NonNullable<typeof finding> => Boolean(finding));

    const result = buildInsightFamilyDataFromFindings({
      family,
      findings: supportingFindings,
      existingDimensionMetadata: dimensionMetadata,
      normalizedChunks: state.chunks,
      normalizedTables: state.tables,
    });

    dimensionMetadata = result.dimensionMetadata;
    updatedFamilies.push(result.family);
    totalDroppedDuplicateRows += result.droppedDuplicateRows;

    if (result.insightFamilyData) {
      tabularFamilies += 1;
      insightFamilyData.push(result.insightFamilyData);
      insightRows.push(...result.insightFamilyData.rows);
      console.info("[family-data] family inferred as tabular", {
        family_id: family.family_id,
        table_id: result.insightFamilyData.table_id,
        dimensions: result.insightFamilyData.dimensions,
        metric_columns: result.insightFamilyData.metric_columns,
        row_count: result.insightFamilyData.row_count,
        tabularity_confidence: result.tabularity_confidence,
      });
    } else {
      narrativeFamilies += 1;
      console.info("[family-data] family marked non-tabular", {
        family_id: family.family_id,
        tabularity_confidence: result.tabularity_confidence,
      });
    }
  }

  console.info("[family-data] build node completed", {
    families: state.insightFamilies.length,
    tabularFamilies,
    narrativeFamilies,
    tables: insightFamilyData.length,
    rows: insightRows.length,
    droppedDuplicateRows: totalDroppedDuplicateRows,
    metadataDimensions: dimensionMetadata.length,
  });

  return {
    insightFamilies: updatedFamilies,
    insightFamilyData,
    insightRows,
    dimensionMetadata,
  };
}
