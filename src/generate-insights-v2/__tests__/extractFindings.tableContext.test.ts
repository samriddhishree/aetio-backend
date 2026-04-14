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

import { extractFindingsNode } from "../nodes/extractFindings";

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
        raw_text: "Region | Store Id | Measure | Percentage",
        headers: ["Region", "Store Id", "Measure", "Percentage"],
        rows: [
          {
            row_index: 0,
            cells: ["West", "1423", "conversion", "39.1%"],
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

describe("extractFindingsNode table context preservation", () => {
  beforeEach(() => {
    mocks.createMock.mockReset();
  });

  it("preserves source row dimensions even when model dimensions are partial or conflicting", async () => {
    mocks.createMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                {
                  text: "West | 1423 | conversion | 39.1%",
                  metric_value: "39.1%",
                  metric_unit: "%",
                  dimensions: [
                    { tag: "Region", value: "East" },
                    { tag: "Measure", value: "conversion" },
                  ],
                  confidence: 0.92,
                  source_modality: "table",
                  supporting_unit_ids: ["table:table-1:row:0"],
                },
              ],
            }),
          },
        },
      ],
    });

    const result = await extractFindingsNode(makeState());
    expect(result.findings).toHaveLength(1);

    const finding = result.findings?.[0];
    const byTag = new Map((finding?.dimensions ?? []).map((dimension) => [dimension.tag, dimension.value]));

    expect(byTag.get("Region")).toBe("West");
    expect(byTag.get("Store Id")).toBe("1423");
    expect(byTag.get("Measure")).toBe("conversion");
    expect(byTag.get("Percentage")).toBeUndefined();
  });

  it("drops placeholder unnamed columns from extracted row dimensions", async () => {
    mocks.createMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                {
                  text: "West | helper | 1423 | conversion | 39.1%",
                  metric_value: "39.1%",
                  metric_unit: "%",
                  dimensions: [],
                  confidence: 0.91,
                  source_modality: "table",
                  supporting_unit_ids: ["table:table-1:row:0"],
                },
              ],
            }),
          },
        },
      ],
    });

    const state = makeState();
    state.tables = [
      {
        ...state.tables[0]!,
        headers: ["Region", "Unnamed: 1", "Store Id", "Measure", "Percentage"],
        rows: [{ row_index: 0, cells: ["West", "helper", "1423", "conversion", "39.1%"] }],
      },
    ];

    const result = await extractFindingsNode(state);
    const finding = result.findings?.[0];
    const tags = new Set((finding?.dimensions ?? []).map((dimension) => dimension.tag));

    expect(tags.has("Region")).toBe(true);
    expect(tags.has("Store Id")).toBe(true);
    expect(tags.has("Measure")).toBe(true);
    expect(tags.has("Unnamed: 1")).toBe(false);
    expect(tags.has("unnamed_1")).toBe(false);
  });

  it("runs extraction once per chunk or table target without batching payloads", async () => {
    mocks.createMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ findings: [] }),
          },
        },
      ],
    });

    const longChunkText = "A".repeat(1300);
    const state = makeState();
    state.chunks = [
      {
        chunk_id: "chunk-1",
        document_id: "doc-1",
        source_uri: "s3://bucket/doc.csv",
        text: longChunkText,
        element_type: "NarrativeText",
        source_modality: "text",
      },
    ];
    state.tables = [
      state.tables[0]!,
      {
        ...state.tables[0]!,
        table_id: "table-2",
        rows: [{ row_index: 0, cells: ["East", "1424", "conversion", "38.5%"] }],
      },
    ];

    const result = await extractFindingsNode(state);

    expect(result.findings).toEqual([]);
    expect(mocks.createMock).toHaveBeenCalledTimes(3);

    const firstPayload = mocks.createMock.mock.calls[0]?.[0];
    const secondPayload = mocks.createMock.mock.calls[1]?.[0];
    const thirdPayload = mocks.createMock.mock.calls[2]?.[0];

    expect(firstPayload?.messages?.[1]?.content).toContain(longChunkText);
    expect(secondPayload?.messages?.[1]?.content).toContain("\"table_id\": \"table-1\"");
    expect(thirdPayload?.messages?.[1]?.content).toContain("\"table_id\": \"table-2\"");
  });

  it("assigns fallback supporting refs when model returns invalid supporting ids", async () => {
    mocks.createMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                {
                  text: "West conversion is 39.1%",
                  metric_value: "39.1%",
                  metric_unit: "%",
                  dimensions: [],
                  confidence: 0.92,
                  source_modality: "table",
                  supporting_unit_ids: ["table:other-table:row:99"],
                },
              ],
            }),
          },
        },
      ],
    });

    const result = await extractFindingsNode(makeState());
    const finding = result.findings?.[0];

    expect(finding).toBeDefined();
    expect(finding?.supporting_refs).toHaveLength(1);
    expect(finding?.supporting_refs[0]?.table_id).toBe("table-1");
    expect(finding?.supporting_refs[0]?.row_index).toBe(0);
  });

  it("adds chunk metadata dimensions in-code and assigns default top_level_group_id", async () => {
    mocks.createMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                {
                  text: "Customer sentiment is improving in the executive summary section.",
                  metric_value: null,
                  metric_unit: null,
                  dimensions: [{ tag: "Topic", value: "Sentiment" }],
                  confidence: 0.88,
                  source_modality: "text",
                  top_level_group_id: null,
                  supporting_unit_ids: ["chunk:chunk-1"],
                },
              ],
            }),
          },
        },
      ],
    });

    const state = makeState();
    state.chunks = [
      {
        chunk_id: "chunk-1",
        document_id: "doc-1",
        source_uri: "s3://bucket/doc.csv",
        text: "Executive summary shows improving customer sentiment in Q4.",
        page: 3,
        section_title: "Executive Summary",
        element_type: "NarrativeText",
        source_modality: "text",
      },
    ];
    state.tables = [];

    const result = await extractFindingsNode(state);
    const finding = result.findings?.[0];
    const byTag = new Map((finding?.dimensions ?? []).map((dimension) => [dimension.tag, dimension.value]));

    expect(finding).toBeDefined();
    expect(finding?.top_level_group_id).toBe("chunk:chunk-1");
    expect(byTag.get("Page")).toBe("3");
    expect(byTag.get("Section")).toBe("Executive Summary");
    expect(byTag.get("Element Type")).toBe("NarrativeText");
    expect(byTag.get("Topic")).toBe("Sentiment");
  });

  it("passes valid metadata fields to extraction while preserving row-identity dimensions", async () => {
    mocks.createMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                {
                  text: "West | 1423 | conversion | 39.1%",
                  metric_value: "39.1%",
                  metric_unit: "%",
                  dimensions: [
                    { tag: "Region", value: "West" },
                    { tag: "Measure", value: "conversion" },
                  ],
                  confidence: 0.92,
                  source_modality: "table",
                  supporting_unit_ids: ["table:table-1:row:0"],
                },
              ],
            }),
          },
        },
      ],
    });

    const state = makeState();
    state.metadataFilters = ["region", "store_id", "measure"];

    const result = await extractFindingsNode(state);
    const finding = result.findings?.[0];
    const tags = new Set((finding?.dimensions ?? []).map((dimension) => dimension.tag));

    expect(tags.has("Region")).toBe(true);
    expect(tags.has("Store Id")).toBe(true);
    // Keep row identity dimensions in findings; filtering is applied when propagating metadata to insight metadata.
    expect(tags.has("Measure")).toBe(true);

    const requestPayload = mocks.createMock.mock.calls[0]?.[0];
    expect(requestPayload?.messages?.[1]?.content).toContain("\"valid_metadata_fields\"");
    expect(requestPayload?.messages?.[1]?.content).toContain("\"metadata_tag_value_options\"");
    expect(requestPayload?.messages?.[1]?.content).toContain("\"region\"");
    expect(requestPayload?.messages?.[1]?.content).toContain("\"store_id\"");
    expect(requestPayload?.messages?.[1]?.content).toContain("\"Region\"");
    expect(requestPayload?.messages?.[1]?.content).toContain("\"West\"");
    expect(requestPayload?.messages?.[1]?.content).not.toContain("\"measure\"");
  });
});
