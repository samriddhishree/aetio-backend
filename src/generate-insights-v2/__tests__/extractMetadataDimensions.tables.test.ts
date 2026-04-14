import { describe, expect, it } from "vitest";
import { extractMetadataDimensionsNode } from "../nodes/extractMetadataDimensions";
import type { GenerateInsightsV2State } from "../types";

function makeState(): GenerateInsightsV2State {
  return {
    sourceUris: [],
    contextUrls: [],
    researchContext: undefined,
    userId: "user-1",
    projectId: "project-1",
    organizationId: "org-1",
    status: "Pending",
    documents: [
      {
        document_id: "doc-1",
        source_uri: "s3://bucket/doc.csv",
        file_type: "csv",
        file_name: "doc.csv",
      },
    ],
    extractedDocuments: [],
    normalizedDocuments: [],
    chunks: [],
    tables: [
      {
        table_id: "table-1",
        document_id: "doc-1",
        source_uri: "s3://bucket/doc.csv",
        element_type: "Table",
        raw_text: "Region,Unnamed: 1,Store ID,Measure,Percentage",
        headers: ["Region", "Unnamed: 1", "Store ID", "Measure", "Percentage"],
        rows: [
          {
            row_index: 0,
            cells: ["West", "ignore", "1423", "conversion", "39.1%"],
          },
          {
            row_index: 1,
            cells: ["East", "ignore", "2201", "conversion", "35.4%"],
          },
        ],
      },
    ],
    findings: [],
    validatedFindings: [],
    metadataFilters: [],
    dimensionMetadata: [],
    insightFamilies: [],
    insightRows: [],
    insightFamilyData: [],
    persistedFamilyCounts: undefined,
    persistedInsightFamilyDataCounts: undefined,
    persistedDimensionMetadataCounts: undefined,
    errors: [],
  };
}

describe("extractMetadataDimensionsNode (table-first)", () => {
  it("extracts metadata dimensions from tables before finding extraction and skips placeholder headers", async () => {
    const result = await extractMetadataDimensionsNode(makeState());
    const metadataFilters = result.metadataFilters ?? [];
    const dimensionMetadata = result.dimensionMetadata ?? [];

    expect(metadataFilters.length).toBeGreaterThan(0);
    expect(metadataFilters).toContain("region");
    expect(metadataFilters).toContain("store_id");
    expect(metadataFilters).not.toContain("unnamed_1");

    const canonicalNames = new Set(dimensionMetadata.map((entry) => entry.canonical_name));
    expect(canonicalNames.has("region")).toBe(true);
    expect(canonicalNames.has("store_id")).toBe(true);
    expect(canonicalNames.has("unnamed_1")).toBe(false);
  });
});
