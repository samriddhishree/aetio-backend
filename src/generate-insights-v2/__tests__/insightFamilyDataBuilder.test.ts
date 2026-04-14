import { describe, expect, it } from "vitest";
import {
  buildInsightFamilyDataFromFindings,
  validateInsightFamilyData,
} from "../services/insightFamilyDataBuilder";
import { validateInsightFamilyDataNode } from "../nodes/validateInsightFamilyData";
import type { Finding, GenerateInsightsV2State, InsightFamily } from "../types";

function makeFinding(input: {
  id: string;
  text: string;
  metricValue?: string | number;
  metricUnit?: string;
  dimensions?: Array<{ tag: string; value: string }>;
  refs?: Array<{ chunk_id?: string; table_id?: string; row_index?: number }>;
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
    insight_id: input.id,
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

describe("insightFamilyDataBuilder", () => {
  it("builds a multi-dimension table and persists all normalized rows", () => {
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
        text: "Instagram | 18-24 | +15%",
        metricValue: 15,
        metricUnit: "%",
        dimensions: [
          { tag: "channel", value: "Instagram" },
          { tag: "age bucket", value: "18 to 24" },
        ],
      }),
      makeFinding({
        id: "f2",
        text: "Instagram | 30+ | +7%",
        metricValue: 7,
        metricUnit: "%",
        dimensions: [
          { tag: "channel", value: "Instagram" },
          { tag: "age_band", value: "30+" },
        ],
      }),
      makeFinding({
        id: "f3",
        text: "Facebook | 18-24 | +4%",
        metricValue: 4,
        metricUnit: "%",
        dimensions: [
          { tag: "channel", value: "Facebook" },
          { tag: "age", value: "Age 18-24" },
        ],
      }),
    ];

    const result = buildInsightFamilyDataFromFindings({ family, findings });

    expect(result.family.has_grid).toBe(true);
    expect(result.insightFamilyData).toBeDefined();
    expect(result.family.insight_family_data_id).toBe(result.insightFamilyData?.table_id);
    expect(result.family.row_count).toBe(3);
    expect(result.insightFamilyData?.row_count).toBe(3);
    expect(result.insightFamilyData?.rows).toHaveLength(3);
    expect(result.insightFamilyData?.rows.every((row) => row.supporting_refs.length > 0)).toBe(true);

    const ageDimension = result.dimensionMetadata.find(
      (dimension) => dimension.canonical_name === "age_group",
    );
    expect(ageDimension).toBeDefined();
    expect(ageDimension?.allowed_values?.some((value) => value.canonical_value === "18_24")).toBe(
      true,
    );
    expect(ageDimension?.allowed_values?.some((value) => value.canonical_value === "30_plus")).toBe(
      true,
    );
    expect(
      result.insightFamilyData?.rows.every((row) =>
        row.filter_values.every((filter) => Boolean(filter.dimension_id) && Boolean(filter.value_id)),
      ),
    ).toBe(true);
  });

  it("builds a one-dimensional measure table and persists all normalized rows", () => {
    const family = makeFamily({
      id: "fam-b",
      text: "Justice-system supervision spans probation, incarceration, and criminal-record burden",
      question: "How large are the major justice-system controlled populations by measure?",
      filters: [],
      findingIds: ["f1", "f2", "f3", "f4"],
    });

    const findings = [
      makeFinding({
        id: "f1",
        text: "The U.S. justice system controls over 5.6 million people.",
        metricValue: 5.6,
        metricUnit: "million",
      }),
      makeFinding({
        id: "f2",
        text: "There are 3.1 million people on probation.",
        metricValue: 3.1,
        metricUnit: "million",
      }),
      makeFinding({
        id: "f3",
        text: "The document lists 1.9 million people as incarcerated today in prison or jail.",
        metricValue: 1.9,
        metricUnit: "million",
      }),
      makeFinding({
        id: "f4",
        text: "The document lists 79 million or more people as having a criminal record.",
        metricValue: 79,
        metricUnit: "million",
      }),
    ];

    const result = buildInsightFamilyDataFromFindings({ family, findings });

    expect(result.family.has_grid).toBe(true);
    expect(result.insightFamilyData?.dimensions).toEqual(["measure"]);
    expect(result.insightFamilyData?.row_count).toBe(4);
    expect(result.insightFamilyData?.rows).toHaveLength(4);
    expect(
      result.insightFamilyData?.rows.every(
        (row) => row.filter_values[0]?.dimension_name === "measure" && row.supporting_refs.length > 0,
      ),
    ).toBe(true);
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
        dimensions: [],
      }),
      makeFinding({
        id: "f2",
        text: "Local detention policy differs widely across jurisdictions.",
        dimensions: [],
      }),
    ];

    const result = buildInsightFamilyDataFromFindings({ family, findings });
    expect(result.insightFamilyData).toBeUndefined();
    expect(result.family.has_grid).toBe(false);
    expect(result.family.insight_family_data_id).toBeUndefined();
  });

  it("deduplicates duplicate findings into unique rows without losing evidence refs", () => {
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
      refs: [{ table_id: "table-a" }],
    });

    const findings = [
      duplicatedFinding,
      { ...duplicatedFinding, finding_id: "f1-dup", supporting_refs: [{ table_id: "table-b" }] },
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

    const dedupedRow = result.insightFamilyData?.rows.find((row) => row.metric_value === 15);
    expect(dedupedRow?.supporting_refs.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves full row-identifying dimensions for tabular rows (Region/Store Id/Measure)", () => {
    const family = makeFamily({
      id: "fam-tabular-context",
      text: "Conversion differs by region and store",
      question: "How does conversion percentage vary by region, store, and measure?",
      filters: ["region", "store_id", "measure"],
      findingIds: ["r1", "r2"],
    });

    const findings = [
      makeFinding({
        id: "r1",
        text: "West | 1423 | conversion | 39.1%",
        metricValue: 39.1,
        metricUnit: "%",
        dimensions: [
          { tag: "Region", value: "West" },
          { tag: "Store Id", value: "1423" },
          { tag: "Measure", value: "conversion" },
        ],
      }),
      makeFinding({
        id: "r2",
        text: "West | 2107 | conversion | 41.0%",
        metricValue: 41,
        metricUnit: "%",
        dimensions: [
          { tag: "Region", value: "West" },
          { tag: "Store Id", value: "2107" },
          { tag: "Measure", value: "conversion" },
        ],
      }),
    ];

    const result = buildInsightFamilyDataFromFindings({ family, findings });
    const table = result.insightFamilyData;

    expect(table).toBeDefined();
    expect(table?.dimensions).toEqual(expect.arrayContaining(["Region", "Store Id", "Measure"]));
    expect(table?.rows).toHaveLength(2);

    for (const row of table?.rows ?? []) {
      const names = new Set(row.filter_values.map((value) => value.dimension_name));
      expect(names.has("Region")).toBe(true);
      expect(names.has("Store Id")).toBe(true);
      expect(names.has("Measure")).toBe(true);
      expect(
        row.filter_values.every((value) => value.value !== "unknown" && value.display_value !== "Unknown"),
      ).toBe(true);
      expect(row.metric_name).toBeDefined();
      expect(row.metric_value).toBeDefined();
      expect(row.metric_unit).toBe("%");
    }
  });

  it("sources persisted row values from normalized table rows when supporting refs point to table rows", () => {
    const family = makeFamily({
      id: "fam-source-table",
      text: "Conversion differs by region and store",
      question: "How does conversion vary by region and store?",
      filters: ["region", "store_id", "measure"],
      findingIds: ["s1", "s2"],
    });

    const findings = [
      makeFinding({
        id: "s1",
        text: "North | 9999 | conversion | 55.0%",
        metricValue: 39.1,
        metricUnit: "%",
        dimensions: [
          { tag: "Region", value: "North" },
          { tag: "Store Id", value: "9999" },
          { tag: "Measure", value: "conversion" },
        ],
        refs: [{ table_id: "table-source", row_index: 0 }],
      }),
      makeFinding({
        id: "s2",
        text: "South | 8888 | conversion | 55.0%",
        metricValue: 41.0,
        metricUnit: "%",
        dimensions: [
          { tag: "Region", value: "South" },
          { tag: "Store Id", value: "8888" },
          { tag: "Measure", value: "conversion" },
        ],
        refs: [{ table_id: "table-source", row_index: 1 }],
      }),
    ];

    const normalizedTables = [
      {
        table_id: "table-source",
        document_id: "doc-1",
        source_uri: "s3://bucket/source.csv",
        element_type: "Table",
        raw_text: "Region,Store Id,Measure,Percentage",
        headers: ["Region", "Store Id", "Measure", "Percentage"],
        rows: [
          { row_index: 0, cells: ["West", "1423", "conversion", "39.1%"] },
          { row_index: 1, cells: ["East", "2107", "conversion", "41.0%"] },
        ],
      },
    ];

    const result = buildInsightFamilyDataFromFindings({
      family,
      findings,
      normalizedTables,
    });
    const table = result.insightFamilyData;

    expect(table).toBeDefined();
    expect(table?.rows).toHaveLength(2);

    const regionValues = table?.rows.map((row) =>
      row.filter_values.find((value) => value.dimension_name === "Region")?.display_value,
    );
    const storeValues = table?.rows.map((row) =>
      row.filter_values.find((value) => value.dimension_name === "Store Id")?.display_value,
    );

    expect(regionValues).toEqual(expect.arrayContaining(["West", "East"]));
    expect(storeValues).toEqual(expect.arrayContaining(["1423", "2107"]));
    expect(table?.rows.some((row) => row.value_text.includes("Region: West"))).toBe(true);
    expect(table?.rows.some((row) => row.value_text.includes("Region: East"))).toBe(true);
    expect(table?.table_markdown).toContain("### table-source");
    expect(table?.table_markdown).toContain("| Region | Store Id | Measure | Percentage |");
    expect(table?.table_markdown).toContain("| West | 1423 | conversion | 39.1% |");
    expect(table?.table_markdown).toContain("| East | 2107 | conversion | 41.0% |");
    expect(table?.table_text_chunk).toContain("Table ID: table-source");
    expect(table?.table_text_chunk).toContain("Row 0: West | 1423 | conversion | 39.1%");
    expect(table?.table_text_chunk).toContain("Row 1: East | 2107 | conversion | 41.0%");
  });

  it("keeps linking multiple findings to the same normalized chunk origin", () => {
    const family = makeFamily({
      id: "fam-shared-chunk",
      text: "Channel conversion differs by segment",
      question: "How does conversion vary by channel?",
      filters: ["channel"],
      findingIds: ["c1", "c2"],
    });

    const findings = [
      makeFinding({
        id: "c1",
        text: "Instagram conversion change is +15%",
        metricValue: 15,
        metricUnit: "%",
        dimensions: [{ tag: "channel", value: "Instagram" }],
        refs: [{ chunk_id: "chunk-shared" }],
      }),
      makeFinding({
        id: "c2",
        text: "Facebook conversion change is +4%",
        metricValue: 4,
        metricUnit: "%",
        dimensions: [{ tag: "channel", value: "Facebook" }],
        refs: [{ chunk_id: "chunk-shared" }],
      }),
    ];

    const normalizedChunks = [
      {
        chunk_id: "chunk-shared",
        document_id: "doc-1",
        source_uri: "s3://bucket/source.txt",
        text: "Normalized source chunk content for shared-origin insights.",
        element_type: "NarrativeText",
        source_modality: "text" as const,
      },
    ];

    const result = buildInsightFamilyDataFromFindings({
      family,
      findings,
      normalizedChunks,
    });
    const table = result.insightFamilyData;

    expect(table).toBeDefined();
    expect(table?.rows).toHaveLength(2);
    expect(table?.rows.every((row) => row.supporting_refs.some((ref) => ref.chunk_id === "chunk-shared"))).toBe(
      true,
    );
    expect(table?.rows.every((row) => row.value_text === normalizedChunks[0]?.text)).toBe(true);
  });

  it("links each finding to exactly one persisted row when a finding has multiple supporting refs", () => {
    const family = makeFamily({
      id: "fam-single-row-per-finding",
      text: "Conversion differs by region and store",
      question: "How does conversion vary by region and store?",
      filters: ["region", "store_id", "measure"],
      findingIds: ["m1"],
    });

    const findings = [
      makeFinding({
        id: "m1",
        text: "Source finding text should be replaced by normalized row context",
        metricValue: 39.1,
        metricUnit: "%",
        dimensions: [
          { tag: "Region", value: "North" },
          { tag: "Store Id", value: "9999" },
          { tag: "Measure", value: "conversion" },
        ],
        refs: [
          { table_id: "table-multi", row_index: 0 },
          { table_id: "table-multi", row_index: 1 },
        ],
      }),
    ];

    const normalizedTables = [
      {
        table_id: "table-multi",
        document_id: "doc-1",
        source_uri: "s3://bucket/source.csv",
        element_type: "Table",
        raw_text: "Region,Store Id,Measure,Percentage",
        headers: ["Region", "Store Id", "Measure", "Percentage"],
        rows: [
          { row_index: 0, cells: ["West", "1423", "conversion", "39.1%"] },
          { row_index: 1, cells: ["East", "2107", "conversion", "41.0%"] },
        ],
      },
    ];

    const result = buildInsightFamilyDataFromFindings({
      family,
      findings,
      normalizedTables,
    });
    const table = result.insightFamilyData;

    expect(table).toBeDefined();
    expect(table?.rows).toHaveLength(1);
    expect(table?.row_count).toBe(1);
    expect(table?.rows[0]?.supporting_refs).toHaveLength(1);
    expect(table?.rows[0]?.supporting_refs[0]?.row_index).toBe(0);
    expect(table?.rows[0]?.value_text).toContain("Region: West");
    expect(table?.table_markdown).toContain("| East | 2107 | conversion | 41.0% |");
  });

  it("drops incomplete metric-only rows when source row context exists", () => {
    const family = makeFamily({
      id: "fam-incomplete-context",
      text: "Conversion differs by region and store",
      question: "How does conversion percentage vary by region, store, and measure?",
      filters: ["region", "store_id", "measure"],
      findingIds: ["i1", "i2"],
    });

    const findings = [
      makeFinding({
        id: "i1",
        text: "West | 1423 | conversion | 39.1%",
        metricValue: 39.1,
        metricUnit: "%",
        dimensions: [
          { tag: "Region", value: "West" },
          { tag: "Store Id", value: "1423" },
          { tag: "Measure", value: "conversion" },
        ],
      }),
      makeFinding({
        id: "i2",
        text: "West | conversion | 41.0%",
        metricValue: 41,
        metricUnit: "%",
        dimensions: [
          { tag: "Region", value: "West" },
          { tag: "Measure", value: "conversion" },
        ],
      }),
    ];

    const result = buildInsightFamilyDataFromFindings({ family, findings });
    expect(result.insightFamilyData?.rows).toHaveLength(1);
    expect(result.insightFamilyData?.row_count).toBe(1);
  });

  it("excludes placeholder dimensions from table dimensions while preserving source labels", () => {
    const family = makeFamily({
      id: "fam-placeholder-dim",
      text: "Conversion differs by region and store",
      question: "How does conversion vary by region and store?",
      filters: ["region", "unnamed_1", "store_id"],
      findingIds: ["p1", "p2"],
    });

    const findings = [
      makeFinding({
        id: "p1",
        text: "West | ignore me | 1423 | 39.1%",
        metricValue: 39.1,
        metricUnit: "%",
        dimensions: [
          { tag: "Region", value: "West" },
          { tag: "Unnamed: 1", value: "ignore me" },
          { tag: "Store ID", value: "1423" },
        ],
      }),
      makeFinding({
        id: "p2",
        text: "East | ignore me too | 2201 | 35.4%",
        metricValue: 35.4,
        metricUnit: "%",
        dimensions: [
          { tag: "Region", value: "East" },
          { tag: "Unnamed: 1", value: "ignore me too" },
          { tag: "Store ID", value: "2201" },
        ],
      }),
    ];

    const result = buildInsightFamilyDataFromFindings({ family, findings });
    const table = result.insightFamilyData;

    expect(table).toBeDefined();
    expect(table?.dimensions).toEqual(expect.arrayContaining(["Region", "Store ID"]));
    expect(table?.dimensions).not.toContain("Unnamed: 1");
    expect(table?.dimensions).not.toContain("unnamed_1");
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
        insight_id: "fam-invalid",
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
            filter_values: [
              {
                dimension_id: "dim-channel",
                dimension_name: "channel",
                value_id: "val-instagram",
                value: "instagram",
                display_value: "Instagram",
              },
            ],
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
    state.dimensionMetadata = [
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
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const result = await validateInsightFamilyDataNode(state);
    expect(result.insightFamilies?.[0]?.has_grid).toBe(false);
    expect(result.insightFamilyData).toEqual([]);
  });
});
