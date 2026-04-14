import { describe, expect, it, vi } from "vitest";
import type { GenerateInsightsV2State } from "../types";

const mocks = vi.hoisted(() => ({
  syncSearchableInsightFamiliesMock: vi.fn(),
  syncInsightFamilyDataMock: vi.fn(),
  syncDimensionMetadataMock: vi.fn(),
  listInsightsMock: vi.fn(),
  updatePendingProjectInsightIdsMock: vi.fn(),
  updatePendingProjectMetadataDimensionIdsMock: vi.fn(),
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

vi.mock("../services/dimensionMetadataPersistence", async () => {
  const actual = await vi.importActual<typeof import("../services/dimensionMetadataPersistence")>(
    "../services/dimensionMetadataPersistence",
  );

  return {
    ...actual,
    syncDimensionMetadata: mocks.syncDimensionMetadataMock,
  };
});

vi.mock("../../common/services/dynamo", () => ({
  listInsights: mocks.listInsightsMock,
}));

vi.mock("../../common/services/projectsTable", () => ({
  updatePendingProjectInsightIds: mocks.updatePendingProjectInsightIdsMock,
  updatePendingProjectMetadataDimensionIds: mocks.updatePendingProjectMetadataDimensionIdsMock,
}));

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
          { tag: "measure", value: "conversion_rate_change" },
        ],
        confidence: 0.9,
        supporting_refs: [{ chunk_id: "c1" }],
        source_modality: "table",
      },
    ],
    metadataFilters: ["channel", "age_group", "measure"],
    dimensionMetadata: [
      {
        dimension_id: "dim-channel",
        canonical_name: "channel",
        display_name: "Channel",
        dimension_type: "categorical",
        value_type: "string",
        allowed_values: [
          {
            value_id: "val-instagram",
            canonical_value: "instagram",
            display_value: "Instagram",
          },
        ],
        created_at: now,
        updated_at: now,
      },
      {
        dimension_id: "dim-age-group",
        canonical_name: "age_group",
        display_name: "Age Group",
        dimension_type: "ordinal",
        value_type: "string",
        allowed_values: [
          {
            value_id: "val-18-30",
            canonical_value: "18_30",
            display_value: "18-30",
          },
        ],
        created_at: now,
        updated_at: now,
      },
    ],
    insightFamilies: [
      {
        insight_id: "fam-1",
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
          {
            dimension_id: "dim-channel",
            dimension_name: "channel",
            value_id: "val-instagram",
            value: "instagram",
            display_value: "Instagram",
          },
          {
            dimension_id: "dim-age-group",
            dimension_name: "age_group",
            value_id: "val-18-30",
            value: "18_30",
            display_value: "18-30",
          },
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
              {
                dimension_id: "dim-channel",
                dimension_name: "channel",
                value_id: "val-instagram",
                value: "instagram",
                display_value: "Instagram",
              },
              {
                dimension_id: "dim-age-group",
                dimension_name: "age_group",
                value_id: "val-18-30",
                value: "18_30",
                display_value: "18-30",
              },
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
    persistedDimensionMetadataCounts: undefined,
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
    mocks.syncDimensionMetadataMock.mockResolvedValueOnce({
      created: 2,
      updated: 0,
      deleted: 0,
    });
    mocks.listInsightsMock.mockResolvedValueOnce([
      { insight_id: "fam-1" },
      { insight_id: "fam-2" },
    ]);
    mocks.updatePendingProjectInsightIdsMock.mockResolvedValueOnce(undefined);
    mocks.updatePendingProjectMetadataDimensionIdsMock.mockResolvedValueOnce(undefined);

    const state = makeState();
    const result = await persistSearchableFamiliesNode(state);

    expect(mocks.syncSearchableInsightFamiliesMock).toHaveBeenCalledTimes(1);
    expect(mocks.syncInsightFamilyDataMock).toHaveBeenCalledTimes(1);
    expect(mocks.syncDimensionMetadataMock).toHaveBeenCalledTimes(1);
    expect(mocks.listInsightsMock).toHaveBeenCalledWith({
      status: "Pending",
      project_id: "project-1",
    });
    expect(mocks.updatePendingProjectInsightIdsMock).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "project-1",
      insightIds: ["fam-1", "fam-2"],
    });
    expect(mocks.updatePendingProjectMetadataDimensionIdsMock).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "project-1",
      dimensionIds: ["dim-channel", "dim-age-group"],
    });
    expect(mocks.syncInsightFamilyDataMock.mock.calls[0]?.[0]?.insightFamilyData).toHaveLength(1);
    expect(mocks.syncDimensionMetadataMock.mock.calls[0]?.[0]?.dimensionMetadata).toHaveLength(2);
    const persistedMetadata =
      mocks.syncSearchableInsightFamiliesMock.mock.calls[0]?.[0]?.families?.[0]?.insight?.metadata ?? [];
    const persistedMetadataTags = persistedMetadata.map((entry: { tag: string }) => entry.tag);
    expect(persistedMetadataTags).toContain("channel");
    expect(persistedMetadataTags).toContain("age_group");
    expect(persistedMetadataTags).not.toContain("measure");
    expect(result.persistedFamilyCounts).toEqual({ created: 1, updated: 0, deleted: 0 });
    expect(result.persistedInsightFamilyDataCounts).toEqual({ created: 1, updated: 0, deleted: 0 });
    expect(result.persistedDimensionMetadataCounts).toEqual({ created: 2, updated: 0, deleted: 0 });
  });
});
