import type { GenerateInsightsV2State } from "../types";
import {
  extractNormalizedDimensionMetadataFromTables,
  extractNormalizedDimensionMetadataFromFindings,
} from "../services/metadataService";

export async function extractMetadataDimensionsNode(
  state: GenerateInsightsV2State,
): Promise<Partial<GenerateInsightsV2State>> {
  const fromTables = extractNormalizedDimensionMetadataFromTables({
    tables: state.tables,
    existingMetadata: state.dimensionMetadata,
  });

  const normalized =
    fromTables.canonicalDimensionCount > 0
      ? fromTables
      : extractNormalizedDimensionMetadataFromFindings({
          findings: state.validatedFindings,
          existingMetadata: state.dimensionMetadata,
        });

  console.info(`[metadata] extracted ${normalized.candidateDimensionCount} candidate dimensions`, {
    tables: state.tables.length,
    findings: state.validatedFindings.length,
    source: fromTables.canonicalDimensionCount > 0 ? "tables" : "findings",
  });

  const resolvedFilters = normalized.metadataFilters;

  console.info(
    `[metadata] normalized ${normalized.candidateDimensionCount} dimensions into ${normalized.canonicalDimensionCount} canonical dimensions`,
    {
      filters: resolvedFilters.length,
    },
  );

  return {
    metadataFilters: resolvedFilters,
    dimensionMetadata: normalized.metadata,
  };
}
