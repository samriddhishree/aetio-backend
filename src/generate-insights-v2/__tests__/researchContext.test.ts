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

import { groupInsightFamiliesNode } from "../nodes/groupInsightFamilies";
import { preprocessResearchContextNode } from "../nodes/preprocessResearchContext";

function makeState(): GenerateInsightsV2State {
  return {
    sourceUris: [],
    contextUrls: [],
    researchContext: undefined,
    normalizedResearchContext: undefined,
    userId: "user-1",
    projectId: "project-1",
    organizationId: "org-1",
    status: "Pending",
    documents: [],
    extractedDocuments: [],
    normalizedDocuments: [],
    chunks: [],
    tables: [],
    findings: [],
    validatedFindings: [
      {
        finding_id: "f1",
        text: "Instagram conversion rate increased for ages 18-30.",
        metric_value: 15,
        metric_unit: "%",
        dimensions: [
          { tag: "channel", value: "Instagram" },
          { tag: "age_group", value: "18-30" },
        ],
        supporting_refs: [{ chunk_id: "chunk-1" }],
        source_modality: "table",
      },
      {
        finding_id: "f2",
        text: "Facebook conversion rate increased for ages 18-30.",
        metric_value: 4,
        metric_unit: "%",
        dimensions: [
          { tag: "channel", value: "Facebook" },
          { tag: "age_group", value: "18-30" },
        ],
        supporting_refs: [{ chunk_id: "chunk-2" }],
        source_modality: "table",
      },
    ],
    metadataFilters: ["channel", "age_group"],
    insightFamilies: [],
    insightRows: [],
    insightFamilyData: [],
    persistedFamilyCounts: undefined,
    persistedInsightFamilyDataCounts: undefined,
    errors: [],
  };
}

describe("research context handling in grouping", () => {
  beforeEach(() => {
    mocks.createMock.mockReset();
  });

  it("no context: works normally", async () => {
    mocks.createMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              families: [
                {
                  family_text: "Conversion performance varies across channels and age groups.",
                  question_answered:
                    "How does conversion performance vary across channels and age groups?",
                  filters: ["channel", "age_group"],
                  summary: null,
                  supporting_finding_ids: ["f1", "f2"],
                },
              ],
            }),
          },
        },
      ],
    });

    const result = await groupInsightFamiliesNode(makeState());

    expect(result.insightFamilies).toHaveLength(1);
    expect(result.insightFamilies?.[0]?.family_text).toContain("Conversion performance");

    const request = mocks.createMock.mock.calls[0]?.[0];
    const userContent = String(request?.messages?.[1]?.content ?? "");
    expect(userContent).toContain(
      "Research context is for guidance only. Do NOT introduce unsupported facts.",
    );
    expect(userContent).not.toContain("research_context");
  });

  it("context present: improves family phrasing", async () => {
    const state = makeState();
    state.researchContext = [
      "Focus on conversion outcomes by channel and age group.",
      "How does conversion performance vary across channels and age groups?",
    ].join(" ");

    const preprocessed = await preprocessResearchContextNode(state);
    state.normalizedResearchContext = preprocessed.normalizedResearchContext;

    mocks.createMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              families: [
                {
                  family_text: "Conversion performance varies across channels and age groups.",
                  question_answered: "What does the data show?",
                  filters: ["channel", "age_group"],
                  summary: null,
                  supporting_finding_ids: ["f1", "f2"],
                },
              ],
            }),
          },
        },
      ],
    });

    const result = await groupInsightFamiliesNode(state);

    expect(result.insightFamilies).toHaveLength(1);
    expect(result.insightFamilies?.[0]?.question_answered).toBe(
      "How does conversion performance vary across channels and age groups?",
    );

    const request = mocks.createMock.mock.calls[0]?.[0];
    const userContent = String(request?.messages?.[1]?.content ?? "");
    expect(userContent).toContain("\"research_context\"");
  });

  it("context broader than data: avoids hallucinated family phrasing", async () => {
    const state = makeState();
    state.normalizedResearchContext = {
      short_summary: "Pretrial detention and jail incarceration policy landscape.",
      key_topics: ["Pretrial detention in local jails"],
      key_questions: ["How does pretrial detention shape incarceration levels?"],
    };

    mocks.createMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              families: [
                {
                  family_text:
                    "Pretrial detention dominates incarceration growth in local jails.",
                  question_answered:
                    "How does pretrial detention drive incarceration in county jails?",
                  filters: ["channel", "age_group"],
                  summary: null,
                  supporting_finding_ids: ["f1", "f2"],
                },
              ],
            }),
          },
        },
      ],
    });

    const result = await groupInsightFamiliesNode(state);
    const family = result.insightFamilies?.[0];

    expect(family).toBeDefined();
    expect(family?.family_text.toLowerCase()).not.toContain("detention");
    expect(family?.family_text.toLowerCase()).not.toContain("incarceration");
    expect(family?.family_text.toLowerCase()).not.toContain("jail");
    expect(family?.question_answered.toLowerCase()).not.toContain("detention");
    expect(family?.question_answered.toLowerCase()).not.toContain("incarceration");
    expect(family?.supporting_finding_ids).toEqual(["f1", "f2"]);
  });
});
