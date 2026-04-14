import { describe, expect, it } from "vitest";
import type { GenerateInsightsV2State } from "../types";
import { normalizeContentNode } from "../nodes/normalizeContent";

function makeStateWithMultiGridText(): GenerateInsightsV2State {
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
              "OmniMart Loyalty Fraud Analysis:,,,,,,",
              "Region,Expected Redemption %,Actual Redemption %,Variance (bps)",
              "West,83.50%,96.00%,1250",
              ",,,,,,",
              "Region West,,,,,,",
              "Store ID,Location,Total Redemptions ($),Manual Adjustments (Pts)",
              "#402,San Francisco,112000,4500000",
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

describe("normalizeContentNode sub-grid parsing", () => {
  it("splits delimited text blocks into separate tables and selects structural header rows", async () => {
    const result = await normalizeContentNode(makeStateWithMultiGridText());

    expect(result.tables).toHaveLength(2);
    expect(result.tables?.[0]?.headers).toEqual([
      "Region",
      "Expected Redemption %",
      "Actual Redemption %",
      "Variance (bps)",
    ]);
    expect(result.tables?.[0]?.rows).toHaveLength(1);
    expect(result.tables?.[1]?.headers).toEqual([
      "Store ID",
      "Location",
      "Total Redemptions ($)",
      "Manual Adjustments (Pts)",
    ]);
    expect(result.tables?.[1]?.rows).toHaveLength(1);
  });

  it("splits html table blocks into separate tables when blank rows separate logical grids", async () => {
    const state = makeStateWithMultiGridText();
    const element = state.extractedDocuments[0]?.elements[0];
    if (!element) throw new Error("Missing fixture element");

    element.metadata = {
      text_as_html: [
        "<table>",
        "<tr><th>Region</th><th>Expected Redemption %</th></tr>",
        "<tr><td>West</td><td>83.5%</td></tr>",
        "<tr><td></td><td></td></tr>",
        "<tr><td></td><td></td></tr>",
        "<tr><th>Store ID</th><th>Total Redemptions ($)</th></tr>",
        "<tr><td>#402</td><td>112000</td></tr>",
        "</table>",
      ].join(""),
    };

    const result = await normalizeContentNode(state);

    expect(result.tables).toHaveLength(2);
    expect(result.tables?.[0]?.headers).toEqual(["Region", "Expected Redemption %"]);
    expect(result.tables?.[0]?.rows).toEqual([{ row_index: 0, cells: ["West", "83.5%"] }]);
    expect(result.tables?.[1]?.headers).toEqual(["Store ID", "Total Redemptions ($)"]);
    expect(result.tables?.[1]?.rows).toEqual([{ row_index: 0, cells: ["#402", "112000"] }]);
  });
});
