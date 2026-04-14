import { describe, expect, it } from "vitest";
import type { GenerateInsightsV2State } from "../types";
import { normalizeContentNode } from "../nodes/normalizeContent";

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
    extractedDocuments: [
      {
        document_id: "doc-1",
        source_uri: "s3://bucket/doc.csv",
        file_type: "csv",
        elements: [
          {
            element_id: "element-1",
            type: "Table",
            text: [
              "Region,Store Id,Measure,Percentage",
              "West,1423,conversion,39.1%",
              "West,,conversion,41.0%",
            ].join("\n"),
            metadata: {},
          },
        ],
      },
    ],
    normalizedDocuments: [],
    chunks: [],
    tables: [],
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

describe("normalizeContentNode table parsing", () => {
  it("keeps empty cells to preserve column alignment", async () => {
    const result = await normalizeContentNode(makeState());
    const table = result.tables?.[0];

    expect(table).toBeDefined();
    expect(table?.headers).toEqual(["Region", "Store Id", "Measure", "Percentage"]);
    expect(table?.rows).toHaveLength(2);
    expect(table?.rows[1]?.cells).toEqual(["West", "", "conversion", "41.0%"]);
  });
});
