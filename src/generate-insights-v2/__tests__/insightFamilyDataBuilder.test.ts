import { describe, expect, it } from "vitest";
import { buildInsightFamilyDataFromFindings, validateInsightFamilyData } from "../services/insightFamilyDataBuilder";
import { validateInsightFamilyDataNode } from "../nodes/validateInsightFamilyData";
import type { Finding, GenerateInsightsV2State, InsightFamily } from "../types";

function makeFinding(input: {
  id: string;
  text: string;
  metricValue?: string | number;
  metricUnit?: string;
  dimensions?: Array<{ tag: string; value: string }>;
  refs?: Array<{ chunk_id?: string; table_id?: string }>;
}): Finding {
  return {
    finding_id: input.id,
    text: input.text,
    metric_value: input.metricValue,
    metric_unit: input.metricUnit,
    dimensions: input.dimensions ?? [],
    supporting_refs: (input.refs ?? [{ chunk_id: `chunk-${input.id}` }]).map((ref) => ({
      ...ref,
      source_excerpt: input.text.slice(0, 120),
    })),
    source_modality: "table",
  };
}

function makeFamily(input: {
  id: string;
  text: string;
  question: string;
  filters: string[];
  findingIds: string[];
}): InsightFamily {
  return {
    family_id: input.id,
    family_text: input.text,
    question_answered: input.question,
    filters: input.filters,
    supporting_finding_ids: input.findingIds,
  };
}

function makeBaseState(): GenerateInsightsV2State {
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
    chunks: [],
    tables: [],
    findings: [],
    validatedFindings: [],
    metadataFilters: [],
    insightFamilies: [],
    insightRows: [],
    insightFamilyData: [],
    persistedFamilyCounts: undefined,
    persistedInsightFamilyDataCounts: undefined,
    errors: [],
  };
}

describe("insightFamilyDataBuilder", () => {
  it("builds a multi-dimension table for tabular families", () => {
    const family = makeFamily({
      id: "fam-a",
      text: "Conversion performance differs across channels and age groups",
      question: "How does conversion performance vary across channels and age groups?",
      filters: ["channel", "age_group"],
      findingIds: ["f1", "f2", "f3"],
    });
    const findings = [
      makeFinding({
        id: "f1",
        text: "Instagram | 18-30 | +15%",
        metricValue: 15,
        metricUnit: "%",
        dimensions: [
          { tag: "channel", value: "Instagram" },
          { tag: "age_group", value: "18-30" },
        ],
      }),
      makeFinding({
        id: "f2",
        text: "Instagram | 30+ | +7%",
        metricValue: 7,
        metricUnit: "%",
        dimensions: [
          { tag: "channel", value: "Instagram" },
          { tag: "age_group", value: "30+" },
        ],
      }),
      makeFinding({
        id: "f3",
        text: "Facebook | 18-30 | +4%",
        metricValue: 4,
        metricUnit: "%",
        dimensions: [
          { tag: "channel", value: "Facebook" },
          { tag: "age_group", value: "18-30" },
        ],
      }),
    ];

    const result = buildInsightFamilyDataFromFindings({ family, findings });

    expect(result.family.has_grid).toBe(true);
    expect(result.insightFamilyData).toBeDefined();
    expect(result.insightFamilyData?.dimensions).toEqual(["channel", "age_group"]);
    expect(result.insightFamilyData?.metric_columns).toEqual(["conversion_rate_change"]);
    expect(result.insightFamilyData?.row_count).toBe(3);
    expect(result.insightFamilyData?.rows).toHaveLength(3);
    expect(result.family.insight_family_data_id).toBe(result.insightFamilyData?.table_id);
    expect(result.family.row_count).toBe(result.insightFamilyData?.row_count);
  });

  it("builds a one-dimensional measure table when structure is a metric list", () => {
    const family = makeFamily({
      id: "fam-b",
      text: "Justice-system supervision spans probation, incarceration, and criminal-record burden",
      question: "How large are the major justice-system controlled populations by measure?",
      filters: [],
      findingIds: ["f1", "f2", "f3", "f4"],
    });

    const findings = [
      makeFinding({ id: "f1", text: "The U.S. justice system controls over 5.6 million people.", metricValue: 5.6, metricUnit: "million" }),
      makeFinding({ id: "f2", text: "There are 3.1 million people on probation.", metricValue: 3.1, metricUnit: "million" }),
      makeFinding({ id: "f3", text: "The document lists 1.9 million people as incarcerated today in prison or jail.", metricValue: 1.9, metricUnit: "million" }),
      makeFinding({ id: "f4", text: "The document lists 79 million or more people as having a criminal record.", metricValue: 79, metricUnit: "million" }),
    ];

    const result = buildInsightFamilyDataFromFindings({ family, findings });

    expect(result.family.has_grid).toBe(true);
    expect(result.insightFamilyData).toBeDefined();
    expect(result.insightFamilyData?.dimensions).toEqual(["measure"]);
    expect(result.insightFamilyData?.metric_columns).toEqual(["count"]);
    expect(result.insightFamilyData?.row_count).toBe(4);
    expect(result.insightFamilyData?.rows.every((row) => row.supporting_refs.length > 0)).toBe(true);
    expect(result.insightFamilyData?.rows.every((row) => row.filter_values[0]?.tag === "measure")).toBe(true);
  });

  it("marks conceptual narrative families as non-tabular", () => {
    const family = makeFamily({
      id: "fam-c",
      text: "Jail administration is fragmented and policy practices vary by locality",
      question: "How does detention policy fragmentation shape local jail administration?",
      filters: [],
      findingIds: ["f1", "f2"],
    });

    const findings = [
      makeFinding({
        id: "f1",
        text: "Several states rely on fragmented jail administration with inconsistent practices.",
        metricValue: undefined,
        metricUnit: undefined,
        dimensions: [],
      }),
      makeFinding({
        id: "f2",
        text: "Local detention policy differs widely across jurisdictions.",
        metricValue: undefined,
        metricUnit: undefined,
        dimensions: [],
      }),
    ];

    const result = buildInsightFamilyDataFromFindings({ family, findings });
    expect(result.insightFamilyData).toBeUndefined();
    expect(result.family.has_grid).toBe(false);
    expect(result.family.insight_family_data_id).toBeUndefined();
  });

  it("deduplicates duplicate findings into unique rows", () => {
    const family = makeFamily({
      id: "fam-d",
      text: "Conversion rates vary by channel and age group",
      question: "How do conversion rates vary by segment?",
      filters: ["channel", "age_group"],
      findingIds: ["f1", "f2", "f3", "f4"],
    });

    const duplicatedFinding = makeFinding({
      id: "f1",
      text: "Instagram | 18-30 | +15%",
      metricValue: 15,
      metricUnit: "%",
      dimensions: [
        { tag: "channel", value: "Instagram" },
        { tag: "age_group", value: "18-30" },
      ],
    });

    const findings = [
      duplicatedFinding,
      { ...duplicatedFinding, finding_id: "f1-dup" },
      makeFinding({
        id: "f2",
        text: "Instagram | 30+ | +7%",
        metricValue: 7,
        metricUnit: "%",
        dimensions: [
          { tag: "channel", value: "Instagram" },
          { tag: "age_group", value: "30+" },
        ],
      }),
      makeFinding({
        id: "f3",
        text: "Facebook | 18-30 | +4%",
        metricValue: 4,
        metricUnit: "%",
        dimensions: [
          { tag: "channel", value: "Facebook" },
          { tag: "age_group", value: "18-30" },
        ],
      }),
    ];

    const result = buildInsightFamilyDataFromFindings({ family, findings });
    expect(result.insightFamilyData?.row_count).toBe(3);
    expect(result.droppedDuplicateRows).toBe(1);
  });

  it("fails validation when a row has no evidence refs", () => {
    const family = makeFamily({
      id: "fam-e",
      text: "Conversion rates vary by channel",
      question: "How do conversion rates vary by channel?",
      filters: ["channel"],
      findingIds: ["f1", "f2"],
    });
    const findings = [
      makeFinding({
        id: "f1",
        text: "Instagram | +15%",
        metricValue: 15,
        metricUnit: "%",
        dimensions: [{ tag: "channel", value: "Instagram" }],
      }),
      makeFinding({
        id: "f2",
        text: "Facebook | +4%",
        metricValue: 4,
        metricUnit: "%",
        dimensions: [{ tag: "channel", value: "Facebook" }],
      }),
    ];

    const built = buildInsightFamilyDataFromFindings({ family, findings });
    const table = built.insightFamilyData!;
    table.rows = table.rows.map((row) => ({
      ...row,
      supporting_refs: [],
    }));

    const validation = validateInsightFamilyData(table, 0.8);
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  it("marks a tabular family non-tabular when linked table is invalid", async () => {
    const state = makeBaseState();
    state.insightFamilies = [
      {
        family_id: "fam-invalid",
        family_text: "Rates vary by channel",
        question_answered: "How do rates vary by channel?",
        filters: ["channel"],
        supporting_finding_ids: ["f1"],
        has_grid: true,
        insight_family_data_id: "table-invalid",
        row_count: 1,
      },
    ];
    state.insightFamilyData = [
      {
        table_id: "table-invalid",
        family_id: "fam-invalid",
        dimensions: ["channel"],
        metric_columns: ["rate"],
        row_count: 1,
        rows: [
          {
            row_id: "row-1",
            family_id: "fam-invalid",
            filter_values: [{ tag: "channel", value: "Instagram" }],
            metric_name: "rate",
            metric_value: 15,
            metric_unit: "%",
            value_text: "Instagram | +15%",
            supporting_refs: [],
          },
        ],
        source_modalities: ["table"],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const result = await validateInsightFamilyDataNode(state);
    expect(result.insightFamilies?.[0]?.has_grid).toBe(false);
    expect(result.insightFamilyData).toEqual([]);
  });
});
