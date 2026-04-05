import { describe, expect, it, vi } from "vitest";
import type { GenerateInsightsV2State } from "../types";

const mocks = vi.hoisted(() => ({
  syncSearchableInsightFamiliesMock: vi.fn(),
  syncInsightFamilyDataMock: vi.fn(),
}));

vi.mock("../services/familyPersistence", async () => {
  const actual = await vi.importActual<typeof import("../services/familyPersistence")>(
    "../services/familyPersistence",
  );

  return {
    ...actual,
    syncSearchableInsightFamilies: mocks.syncSearchableInsightFamiliesMock,
  };
});

vi.mock("../services/insightFamilyDataPersistence", async () => {
  const actual = await vi.importActual<typeof import("../services/insightFamilyDataPersistence")>(
    "../services/insightFamilyDataPersistence",
  );

  return {
    ...actual,
    syncInsightFamilyData: mocks.syncInsightFamilyDataMock,
  };
});

import { persistSearchableFamiliesNode } from "../nodes/persistSearchableFamilies";

function makeState(): GenerateInsightsV2State {
  const now = new Date().toISOString();
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
        source_uri: "s3://bucket/doc.pdf",
        file_type: "pdf",
        file_name: "doc.pdf",
      },
    ],
    extractedDocuments: [],
    normalizedDocuments: [],
    chunks: [],
    tables: [],
    findings: [],
    validatedFindings: [
      {
        finding_id: "f1",
        text: "Instagram | 18-30 | +15%",
        metric_value: 15,
        metric_unit: "%",
        dimensions: [
          { tag: "channel", value: "Instagram" },
          { tag: "age_group", value: "18-30" },
        ],
        confidence: 0.9,
        supporting_refs: [{ chunk_id: "c1" }],
        source_modality: "table",
      },
    ],
    metadataFilters: ["channel", "age_group"],
    insightFamilies: [
      {
        family_id: "fam-1",
        family_text: "Conversion performance differs across channels and age groups",
        question_answered: "How does conversion vary by channel and age group?",
        filters: ["channel", "age_group"],
        supporting_finding_ids: ["f1"],
        has_grid: true,
        insight_family_data_id: "table-1",
        row_count: 1,
        table_dimensions: ["channel", "age_group"],
        metric_columns: ["conversion_rate_change"],
      },
    ],
    insightRows: [
      {
        row_id: "row-1",
        family_id: "fam-1",
        filter_values: [
          { tag: "channel", value: "Instagram" },
          { tag: "age_group", value: "18-30" },
        ],
        metric_name: "conversion_rate_change",
        metric_value: 15,
        metric_unit: "%",
        value_text: "Instagram | 18-30 | +15%",
        supporting_refs: [{ chunk_id: "c1" }],
      },
    ],
    insightFamilyData: [
      {
        table_id: "table-1",
        family_id: "fam-1",
        dimensions: ["channel", "age_group"],
        metric_columns: ["conversion_rate_change"],
        row_count: 1,
        rows: [
          {
            row_id: "row-1",
            family_id: "fam-1",
            filter_values: [
              { tag: "channel", value: "Instagram" },
              { tag: "age_group", value: "18-30" },
            ],
            metric_name: "conversion_rate_change",
            metric_value: 15,
            metric_unit: "%",
            value_text: "Instagram | 18-30 | +15%",
            supporting_refs: [{ chunk_id: "c1" }],
          },
        ],
        source_modalities: ["table"],
        created_at: now,
        updated_at: now,
      },
    ],
    persistedFamilyCounts: undefined,
    persistedInsightFamilyDataCounts: undefined,
    errors: [],
  };
}

describe("persistSearchableFamiliesNode with insight family data", () => {
  it("persists both searchable families and insight family data", async () => {
    mocks.syncSearchableInsightFamiliesMock.mockResolvedValueOnce({
      created: 1,
      updated: 0,
      deleted: 0,
    });
    mocks.syncInsightFamilyDataMock.mockResolvedValueOnce({
      created: 1,
      updated: 0,
      deleted: 0,
    });

    const state = makeState();
    const result = await persistSearchableFamiliesNode(state);

    expect(mocks.syncSearchableInsightFamiliesMock).toHaveBeenCalledTimes(1);
    expect(mocks.syncInsightFamilyDataMock).toHaveBeenCalledTimes(1);
    expect(mocks.syncInsightFamilyDataMock.mock.calls[0]?.[0]?.insightFamilyData).toHaveLength(1);
    expect(result.persistedFamilyCounts).toEqual({ created: 1, updated: 0, deleted: 0 });
    expect(result.persistedInsightFamilyDataCounts).toEqual({ created: 1, updated: 0, deleted: 0 });
  });
});
