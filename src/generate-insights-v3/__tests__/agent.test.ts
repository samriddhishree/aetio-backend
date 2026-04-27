import { describe, expect, it } from "vitest";
import type { V2Chunk, V2Table } from "../../generate-insights-v2/types";
import { runDocumentAgentOnBundle } from "../agent";
import { mergeToolsetOverrides } from "../tools";
import type { GenerateInsightsV3AgentState, V3DocumentBundle } from "../types";

function makeChunk(input: {
  id: string;
  documentId: string;
  sourceUri: string;
  text: string;
  page?: number;
  section?: string;
  elementType?: string;
}): V2Chunk {
  return {
    chunk_id: input.id,
    document_id: input.documentId,
    source_uri: input.sourceUri,
    text: input.text,
    page: input.page,
    section_title: input.section,
    element_type: input.elementType ?? "NarrativeText",
    source_modality: "text",
  };
}

function makeTable(input: {
  id: string;
  documentId: string;
  sourceUri: string;
  headers: string[];
  rows: string[][];
  rawText?: string;
  page?: number;
  section?: string;
  sheetName?: string;
}): V2Table {
  return {
    table_id: input.id,
    document_id: input.documentId,
    source_uri: input.sourceUri,
    page: input.page,
    section_title: input.section,
    element_type: "Table",
    sheet_name: input.sheetName,
    raw_text:
      input.rawText
      ?? [input.headers.join(" | "), ...input.rows.map((row) => row.join(" | "))].join("\n"),
    headers: input.headers,
    rows: input.rows.map((cells, index) => ({
      row_index: index,
      cells,
    })),
  };
}

function makeBundle(input: {
  documentId: string;
  sourceUri: string;
  fileType: "pdf" | "xlsx";
  chunks: V2Chunk[];
  tables: V2Table[];
}): V3DocumentBundle {
  return {
    descriptor: {
      document_id: input.documentId,
      source_uri: input.sourceUri,
      file_type: input.fileType,
      file_name: input.sourceUri.split("/").pop() ?? `${input.documentId}.${input.fileType}`,
    },
    extracted: {
      document_id: input.documentId,
      source_uri: input.sourceUri,
      file_type: input.fileType,
      elements: [],
    },
    chunks: input.chunks,
    tables: input.tables,
  };
}

async function runWithDeterministicPlanner(
  bundle: V3DocumentBundle,
  overrides: Parameters<typeof mergeToolsetOverrides>[0],
) {
  const toolset = mergeToolsetOverrides({
    decideNextAction: async (state: GenerateInsightsV3AgentState) => {
      if (!state.parsedContent) return { action: "parse_file", reason: "parse" };
      if (!state.candidateGridDiscoveryDone) return { action: "find_candidate_grids", reason: "find" };

      if (!state.activeGridId) {
        if (state.pendingGridIds.length === 0) {
          return { action: "finish_document", reason: "done" };
        }
        return { action: "select_next_grid", reason: "next" };
      }

      const work = state.gridWorkById.get(state.activeGridId);
      if (!work?.context) return { action: "inspect_grid_context", reason: "context" };
      if (!work.explicitInsight) return { action: "extract_explicit_insight", reason: "explicit" };
      if (!work.explicitInsight.found_explicit_insight && !work.synthesizedInsight) {
        return { action: "synthesize_insight", reason: "synthesize" };
      }
      if (!work.normalizedGridDraft) return { action: "normalize_grid", reason: "normalize-grid" };
      if (work.normalizedGridDraft.row_count <= 0) return { action: "complete_grid", reason: "drop-empty" };
      if (work.validationErrors && work.validationErrors.length > 0) {
        return { action: "complete_grid", reason: "drop-invalid" };
      }
      if (!work.normalizedGrid) return { action: "normalize_dimension_metadata", reason: "normalize-metadata" };
      if (!work.metadata) return { action: "build_insight_metadata", reason: "metadata" };
      if (!work.tags) return { action: "build_insight_tags", reason: "tags" };
      if (!work.validatedInsight && !work.validationErrors) {
        return { action: "validate_insight", reason: "validate" };
      }
      return { action: "complete_grid", reason: "complete" };
    },
    buildInsightMetadata: async ({ sourceMode }) => [
      {
        tag: "insight_source",
        value: sourceMode,
        confidence: 1,
      },
    ],
    buildInsightTags: async ({ sourceMode }) => [
      {
        insight_source_mode: sourceMode,
      },
    ],
    ...overrides,
  });

  return runDocumentAgentOnBundle({
    bundle,
    runtime: {
      userId: "user-1",
      projectId: "project-1",
      status: "Pending",
    },
    toolset,
    maxSteps: 48,
  });
}

describe("generate-insights-v3 agent", () => {
  it("reuses explicit nearby insight text for a PDF table", async () => {
    const bundle = makeBundle({
      documentId: "report-explicit",
      sourceUri: "s3://bucket/report-explicit.pdf",
      fileType: "pdf",
      tables: [
        makeTable({
          id: "tbl-explicit",
          documentId: "report-explicit",
          sourceUri: "s3://bucket/report-explicit.pdf",
          page: 4,
          section: "Performance",
          headers: ["Region", "Store Id", "Measure", "Percentage"],
          rows: [
            ["West", "1423", "conversion", "39.1%"],
            ["West", "2107", "conversion", "41.0%"],
          ],
        }),
      ],
      chunks: [
        makeChunk({
          id: "c1",
          documentId: "report-explicit",
          sourceUri: "s3://bucket/report-explicit.pdf",
          page: 4,
          section: "Performance",
          elementType: "Title",
          text: "Performance summary",
        }),
        makeChunk({
          id: "c2",
          documentId: "report-explicit",
          sourceUri: "s3://bucket/report-explicit.pdf",
          page: 4,
          section: "Performance",
          text: "Insight: West conversion performance remains stronger across store cohorts.",
        }),
      ],
    });

    const result = await runWithDeterministicPlanner(bundle, {
      extractExplicitInsight: async () => ({
        found_explicit_insight: true,
        insight_text: "West conversion performance remains stronger across store cohorts.",
        supporting_snippets: ["Insight: West conversion performance remains stronger across store cohorts."],
        confidence: 0.92,
        reasoning: "Nearby paragraph explicitly states the pattern.",
      }),
      synthesizeInsightFromGrid: async () => ({
        insight_text: "fallback synthesis should not be used",
        confidence: 0.5,
        reasoning: "n/a",
      }),
    });

    expect(result.errors).toEqual([]);
    const explicit = result.insights.find(
      (insight) =>
        insight.text === "West conversion performance remains stronger across store cohorts.",
    );
    expect(explicit).toBeDefined();
    expect(explicit?.insight_source_mode).toBe("explicit_nearby_text");
    expect(explicit?.insightfamilydata.row_count).toBeGreaterThan(0);
    expect(explicit?.dimension_metadata.length).toBeGreaterThan(0);
    expect(explicit?.metadata.length).toBeGreaterThan(0);
  });

  it("synthesizes insight from grid when nearby explicit statement is absent", async () => {
    const bundle = makeBundle({
      documentId: "report-synth",
      sourceUri: "s3://bucket/report-synth.pdf",
      fileType: "pdf",
      tables: [
        makeTable({
          id: "tbl-synth",
          documentId: "report-synth",
          sourceUri: "s3://bucket/report-synth.pdf",
          page: 2,
          section: "Quarterly mix",
          headers: ["Channel", "Quarter", "Revenue"],
          rows: [
            ["Online", "Q1", "120"],
            ["Retail", "Q1", "83"],
            ["Online", "Q2", "138"],
          ],
        }),
      ],
      chunks: [
        makeChunk({
          id: "c1",
          documentId: "report-synth",
          sourceUri: "s3://bucket/report-synth.pdf",
          page: 2,
          section: "Quarterly mix",
          text: "Table 3 presents quarterly revenue by channel.",
        }),
      ],
    });

    const result = await runWithDeterministicPlanner(bundle, {
      extractExplicitInsight: async () => ({
        found_explicit_insight: false,
        supporting_snippets: [],
        confidence: 0.2,
        reasoning: "No explicit claim appears near the table.",
      }),
      synthesizeInsightFromGrid: async () => ({
        insight_text: "Online channel revenue consistently outperforms retail across the observed quarters.",
        question_answered: "How does revenue vary by channel over time?",
        confidence: 0.84,
        reasoning: "Higher values are repeatedly associated with Online rows.",
      }),
    });

    expect(result.errors).toEqual([]);
    expect(result.insights).toHaveLength(1);
    expect(result.insights[0]?.insight_source_mode).toBe("synthesized_from_grid");
    expect(result.insights[0]?.text).toContain("Online channel revenue");
    expect(result.insights[0]?.insightfamilydata.rows.length).toBeGreaterThan(0);
  });

  it("preserves full row-identifying context for spreadsheet-style grids", async () => {
    const bundle = makeBundle({
      documentId: "sheet-1",
      sourceUri: "s3://bucket/sheet-1.xlsx",
      fileType: "xlsx",
      tables: [
        makeTable({
          id: "tbl-xlsx",
          documentId: "sheet-1",
          sourceUri: "s3://bucket/sheet-1.xlsx",
          sheetName: "Data",
          headers: ["Region", "Store Id", "Measure", "Percentage"],
          rows: [
            ["West", "1423", "conversion", "39.1%"],
            ["West", "2107", "conversion", "41.0%"],
          ],
        }),
      ],
      chunks: [
        makeChunk({
          id: "sheet-c1",
          documentId: "sheet-1",
          sourceUri: "s3://bucket/sheet-1.xlsx",
          text: "Sheet Data",
          elementType: "Title",
        }),
      ],
    });

    const result = await runWithDeterministicPlanner(bundle, {
      extractExplicitInsight: async () => ({
        found_explicit_insight: false,
        supporting_snippets: [],
        confidence: 0.2,
        reasoning: "No explicit statement",
      }),
      synthesizeInsightFromGrid: async () => ({
        insight_text: "Conversion percentages differ across store IDs within the same region.",
        confidence: 0.78,
        reasoning: "Rows vary by Store Id and percentage.",
      }),
    });

    const insight = result.insights[0];
    expect(insight).toBeDefined();
    expect(insight?.insightfamilydata.rows).toHaveLength(2);

    for (const row of insight?.insightfamilydata.rows ?? []) {
      const names = new Set(row.filter_values.map((value) => value.dimension_name));
      expect(names.has("Region")).toBe(true);
      expect(names.has("Store Id")).toBe(true);
      expect(names.has("Measure")).toBe(true);
      expect(row.metric_value).toBeDefined();
    }
  });

  it("uses nearby captions/summary context in mixed report inputs", async () => {
    const bundle = makeBundle({
      documentId: "mixed-report",
      sourceUri: "s3://bucket/mixed-report.pdf",
      fileType: "pdf",
      tables: [
        makeTable({
          id: "tbl-mixed",
          documentId: "mixed-report",
          sourceUri: "s3://bucket/mixed-report.pdf",
          page: 6,
          section: "Executive Summary",
          headers: ["Channel", "Sales"],
          rows: [
            ["Online", "190"],
            ["Retail", "132"],
          ],
        }),
      ],
      chunks: [
        makeChunk({
          id: "m1",
          documentId: "mixed-report",
          sourceUri: "s3://bucket/mixed-report.pdf",
          page: 6,
          section: "Executive Summary",
          text: "Figure 2: Quarterly sales by channel.",
        }),
        makeChunk({
          id: "m2",
          documentId: "mixed-report",
          sourceUri: "s3://bucket/mixed-report.pdf",
          page: 6,
          section: "Executive Summary",
          text: "Summary: Online sales lead the total mix across the compared channels.",
        }),
      ],
    });

    const result = await runWithDeterministicPlanner(bundle, {
      extractExplicitInsight: async () => ({
        found_explicit_insight: true,
        insight_text: "Online sales lead the total mix across the compared channels.",
        supporting_snippets: ["Summary: Online sales lead the total mix across the compared channels."],
        confidence: 0.89,
        reasoning: "Summary paragraph states the insight explicitly.",
      }),
      synthesizeInsightFromGrid: async () => ({
        insight_text: "fallback synthesis",
        confidence: 0.4,
        reasoning: "n/a",
      }),
      buildInsightMetadata: async ({ context, sourceMode }) => [
        {
          tag: "section",
          value: context.section_title ?? "unknown",
          confidence: 0.9,
        },
        {
          tag: "insight_source",
          value: sourceMode,
          confidence: 1,
        },
      ],
    });

    expect(result.errors).toEqual([]);
    const explicit = result.insights.find((insight) =>
      insight.text.includes("Online sales lead the total mix"),
    );
    expect(explicit).toBeDefined();
    expect(explicit?.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: "section", value: "Executive Summary" }),
      ]),
    );
  });

  it("builds implied grids from narrative-only documents", async () => {
    const priorOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "";

    try {
      const bundle = makeBundle({
        documentId: "narrative-only",
        sourceUri: "s3://bucket/narrative-only.pdf",
        fileType: "pdf",
        tables: [],
        chunks: [
          makeChunk({
            id: "n1",
            documentId: "narrative-only",
            sourceUri: "s3://bucket/narrative-only.pdf",
            page: 1,
            section: "Channel Performance",
            text: "In Q1, Online reached 190 while Retail reached 132.",
          }),
          makeChunk({
            id: "n2",
            documentId: "narrative-only",
            sourceUri: "s3://bucket/narrative-only.pdf",
            page: 1,
            section: "Channel Performance",
            text: "In Q2, Online reached 205 while Retail reached 141.",
          }),
        ],
      });

      const result = await runWithDeterministicPlanner(bundle, {
        extractExplicitInsight: async () => ({
          found_explicit_insight: false,
          supporting_snippets: [],
          confidence: 0.2,
          reasoning: "No explicit insight sentence.",
        }),
        synthesizeInsightFromGrid: async (grid) => ({
          insight_text: `Narrative grid insight from ${grid.table.headers.join(", ")}.`,
          confidence: 0.78,
          reasoning: "Uses implied grid rows synthesized from narrative.",
        }),
      });

      expect(result.errors).toEqual([]);
      expect(result.insights.length).toBeGreaterThan(0);
      expect(
        result.insights.some((insight) =>
          insight.insightfamilydata.source_modalities?.includes("text"),
        ),
      ).toBe(true);
    } finally {
      process.env.OPENAI_API_KEY = priorOpenAiKey;
    }
  });

  it("prefers actual grids over narrative-implied duplicates", async () => {
    const priorOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "";

    try {
      const bundle = makeBundle({
        documentId: "actual-vs-narrative",
        sourceUri: "s3://bucket/actual-vs-narrative.pdf",
        fileType: "pdf",
        tables: [
          makeTable({
            id: "tbl-actual",
            documentId: "actual-vs-narrative",
            sourceUri: "s3://bucket/actual-vs-narrative.pdf",
            page: 2,
            section: "Channel Performance",
            headers: ["Channel", "Sales"],
            rows: [
              ["Online", "190"],
              ["Retail", "132"],
            ],
          }),
        ],
        chunks: [
          makeChunk({
            id: "d1",
            documentId: "actual-vs-narrative",
            sourceUri: "s3://bucket/actual-vs-narrative.pdf",
            page: 2,
            section: "Channel Performance",
            text: "Narrative summary: Online reached 190 while Retail reached 132.",
          }),
        ],
      });

      const result = await runWithDeterministicPlanner(bundle, {
        extractExplicitInsight: async () => ({
          found_explicit_insight: false,
          supporting_snippets: [],
          confidence: 0.2,
          reasoning: "No explicit insight sentence.",
        }),
        synthesizeInsightFromGrid: async () => ({
          insight_text: "Online outperforms retail in the compared channel totals.",
          confidence: 0.81,
          reasoning: "Based on channel-level comparison.",
        }),
      });

      expect(result.errors).toEqual([]);
      expect(result.insights).toHaveLength(1);
      expect(result.insights[0]?.insightfamilydata.source_modalities).toEqual(["table"]);
    } finally {
      process.env.OPENAI_API_KEY = priorOpenAiKey;
    }
  });

  it("extracts multi-value dimension metadata for farm-sector and soil-factor style grids", async () => {
    const priorOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "";

    try {
      const bundle = makeBundle({
        documentId: "farm-soil-metadata",
        sourceUri: "s3://bucket/farm-soil-metadata.csv",
        fileType: "xlsx",
        tables: [
          makeTable({
            id: "tbl-farm-soil",
            documentId: "farm-soil-metadata",
            sourceUri: "s3://bucket/farm-soil-metadata.csv",
            headers: ["Farm_Sector", "Soil_Factor", "Actual_Yield_Bushels"],
            rows: [
              ["Sector 5", "Nitrogen level", "151"],
              ["Sector 6", "PH level", "147"],
              ["Sector 7", "Moisture", "154"],
            ],
          }),
        ],
        chunks: [
          makeChunk({
            id: "fs1",
            documentId: "farm-soil-metadata",
            sourceUri: "s3://bucket/farm-soil-metadata.csv",
            text: "Yield observations by farm sector and soil factors.",
          }),
        ],
      });

      const result = await runWithDeterministicPlanner(bundle, {
        extractExplicitInsight: async () => ({
          found_explicit_insight: false,
          supporting_snippets: [],
          confidence: 0.25,
          reasoning: "No explicit nearby insight statement.",
        }),
        synthesizeInsightFromGrid: async () => ({
          insight_text: "Yield varies across farm sectors and soil factors.",
          confidence: 0.8,
          reasoning: "Grounded in structured rows.",
        }),
        buildInsightMetadata: async () => [
          { tag: "farm_sector", value: "Sector 5", confidence: 1 },
          { tag: "farm_sector", value: "Sector 6", confidence: 1 },
          { tag: "farm_sector", value: "Sector 7", confidence: 1 },
          { tag: "soil_factor", value: "Nitrogen level", confidence: 1 },
          { tag: "soil_factor", value: "PH level", confidence: 1 },
          { tag: "soil_factor", value: "Moisture", confidence: 1 },
          { tag: "insight_source", value: "synthesized_from_grid", confidence: 1 },
        ],
      });

      expect(result.errors).toEqual([]);
      expect(result.insights.length).toBeGreaterThan(0);

      const metadata = result.insights.flatMap((insight) => insight.metadata ?? []);
      const farmSectorValues = metadata
        .filter((entry) => entry.tag === "farm_sector")
        .map((entry) => entry.value);
      const soilFactorValues = metadata
        .filter((entry) => entry.tag === "soil_factor")
        .map((entry) => entry.value);

      expect(new Set(farmSectorValues)).toEqual(new Set(["Sector 5", "Sector 6", "Sector 7"]));
      expect(new Set(soilFactorValues)).toEqual(new Set(["Nitrogen level", "PH level", "Moisture"]));
    } finally {
      process.env.OPENAI_API_KEY = priorOpenAiKey;
    }
  });

  it("surfaces an error and skips downstream stages when normalized grid has zero rows", async () => {
    const bundle = makeBundle({
      documentId: "zero-row-grid",
      sourceUri: "s3://bucket/zero-row-grid.pdf",
      fileType: "pdf",
      tables: [
        makeTable({
          id: "tbl-zero-row",
          documentId: "zero-row-grid",
          sourceUri: "s3://bucket/zero-row-grid.pdf",
          page: 1,
          section: "Data",
          headers: ["Segment", "Value"],
          rows: [["A", "100"]],
        }),
      ],
      chunks: [
        makeChunk({
          id: "zr-c1",
          documentId: "zero-row-grid",
          sourceUri: "s3://bucket/zero-row-grid.pdf",
          page: 1,
          section: "Data",
          text: "Table with sparse usable data.",
        }),
      ],
    });

    let normalizeDimensionMetadataCalls = 0;
    let buildMetadataCalls = 0;
    let validateCalls = 0;

    const result = await runWithDeterministicPlanner(bundle, {
      extractExplicitInsight: async () => ({
        found_explicit_insight: false,
        supporting_snippets: [],
        confidence: 0.2,
        reasoning: "No explicit statement",
      }),
      synthesizeInsightFromGrid: async () => ({
        insight_text: "Fallback synthesis text.",
        confidence: 0.5,
        reasoning: "n/a",
      }),
      normalizeGrid: async () => ({
        table_id: "tbl-zero-row",
        family_id: "fam-zero-row",
        dimensions: ["Segment"],
        metric_columns: ["Value"],
        row_count: 0,
        rows: [],
        source_modalities: ["table"],
      }),
      normalizeDimensionMetadata: async (draft) => {
        normalizeDimensionMetadataCalls += 1;
        const now = new Date().toISOString();
        return {
          insightFamilyData: {
            family_id: draft.family_id,
            table_id: draft.table_id,
            dimensions: draft.dimensions,
            metric_columns: draft.metric_columns,
            row_count: draft.row_count,
            rows: [],
            source_modalities: ["table"],
            created_at: now,
            updated_at: now,
          },
          dimensionMetadata: [],
        };
      },
      buildInsightMetadata: async () => {
        buildMetadataCalls += 1;
        return [];
      },
      validateInsight: async () => {
        validateCalls += 1;
        return {
          valid: false,
          errors: ["should not run"],
          warnings: [],
        };
      },
    });

    expect(result.insights).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((error) => error.stage === "agent:grid-dropped")).toBe(true);
    expect(normalizeDimensionMetadataCalls).toBe(0);
    expect(buildMetadataCalls).toBe(0);
    expect(validateCalls).toBe(0);
  });

  it("skips explicit insight extraction when no narrative chunks exist", async () => {
    const bundle = makeBundle({
      documentId: "no-chunks",
      sourceUri: "s3://bucket/no-chunks.pdf",
      fileType: "pdf",
      tables: [
        makeTable({
          id: "tbl-no-chunks",
          documentId: "no-chunks",
          sourceUri: "s3://bucket/no-chunks.pdf",
          headers: ["Region", "Revenue"],
          rows: [
            ["West", "100"],
            ["East", "90"],
          ],
        }),
      ],
      chunks: [],
    });

    let explicitCalls = 0;

    const result = await runWithDeterministicPlanner(bundle, {
      extractExplicitInsight: async () => {
        explicitCalls += 1;
        return {
          found_explicit_insight: false,
          supporting_snippets: [],
          confidence: 0.2,
          reasoning: "No explicit statement",
        };
      },
      synthesizeInsightFromGrid: async () => ({
        insight_text: "Revenue differs by region.",
        confidence: 0.7,
        reasoning: "Grid comparison.",
      }),
    });

    expect(result.errors).toEqual([]);
    expect(result.insights).toHaveLength(1);
    expect(explicitCalls).toBe(0);
    expect(result.insights[0]?.insight_source_mode).toBe("synthesized_from_grid");
  });
});
