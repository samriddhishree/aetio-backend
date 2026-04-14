import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateInsightsV2State } from "../types";

const mocks = vi.hoisted(() => ({
  createMock: vi.fn(),
}));

vi.mock("../../common/services/openai", () => ({
  openai: {
    chat: {
      completions: {
        create: mocks.createMock,
      },
    },
  },
  OPENAI_HELPER_MODEL: "test-helper-model",
}));

import { critiqueFindingsNode } from "../nodes/critiqueFindings";

function makeState(): GenerateInsightsV2State {
  return {
    sourceUris: [],
    contextUrls: [],
    researchContext: undefined,
    userId: "user-1",
    projectId: "project-1",
    organizationId: "org-1",
    status: "Pending",
    documents: [],
    extractedDocuments: [],
    normalizedDocuments: [],
    chunks: [
      {
        chunk_id: "chunk-1",
        document_id: "doc-1",
        source_uri: "s3://bucket/doc.txt",
        text: "West region outperformed benchmark.",
        element_type: "NarrativeText",
        source_modality: "text",
      },
    ],
    tables: [],
    findings: [
      {
        finding_id: "f-valid",
        text: "West region outperformed benchmark.",
        dimensions: [{ tag: "Region", value: "West" }],
        supporting_refs: [{ chunk_id: "chunk-1", source_excerpt: "West region outperformed benchmark." }],
        source_modality: "text",
      },
      {
        finding_id: "f-invalid",
        text: "Conversion measure rose by 3 points.",
        dimensions: [{ tag: "Measure", value: "conversion" }],
        supporting_refs: [{ chunk_id: "chunk-1", source_excerpt: "Conversion measure rose by 3 points." }],
        source_modality: "text",
      },
    ],
    validatedFindings: [],
    metadataFilters: ["region", "store_id", "measure"],
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

describe("critiqueFindingsNode metadata policy", () => {
  beforeEach(() => {
    mocks.createMock.mockReset();
  });

  it("does not drop findings solely due to resultant metadata tags", async () => {
    mocks.createMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              drop_finding_ids: [],
            }),
          },
        },
      ],
    });

    const result = await critiqueFindingsNode(makeState());

    expect(result.validatedFindings).toHaveLength(2);
    expect(result.validatedFindings?.map((finding) => finding.finding_id).sort()).toEqual([
      "f-invalid",
      "f-valid",
    ]);

    const requestPayload = mocks.createMock.mock.calls[0]?.[0];
    expect(requestPayload?.messages?.[1]?.content).toContain("\"finding_id\": \"f-invalid\"");
    expect(requestPayload?.messages?.[1]?.content).toContain("\"tag\": \"Measure\"");
  });
});
