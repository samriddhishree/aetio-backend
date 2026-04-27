import type { ExtractionTrace, V2TraceBuildInput, V3TraceBuildInput } from "./types";

type TableSnapshot = {
  table_id: string;
  row_count: number;
  dimensions: string[];
};

function compact(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function documentFileTypeById(documents: Array<{ document_id: string; file_type?: string }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const doc of documents) {
    if (!doc.document_id) continue;
    if (!doc.file_type) continue;
    map.set(doc.document_id, doc.file_type);
  }
  return map;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function buildV2ExtractionTraces(input: V2TraceBuildInput): ExtractionTrace[] {
  const at = nowIso();
  const docsById = documentFileTypeById(input.documents);
  const tableById = new Map<string, TableSnapshot>(
    input.insight_family_data.map((table) => [
      table.table_id,
      {
        table_id: table.table_id,
        row_count: table.row_count,
        dimensions: table.dimensions,
      },
    ]),
  );

  return input.insight_families
    .filter((family) => typeof family.insight_id === "string" && family.insight_id.trim().length > 0)
    .map((family) => {
      const tableId = family.insight_family_data_id?.trim();
      const table = tableId ? tableById.get(tableId) : undefined;

      return {
        run_id: input.run_id,
        project_id: family.project_id,
        document_id: family.document_id ?? input.documents[0]?.document_id ?? "unknown-document",
        insight_id: family.insight_id!,
        table_id: table?.table_id ?? tableId,
        pipeline_version: input.pipeline_version,
        extraction_mode: "deterministic_completion",
        model_name: input.model_name,
        prompt_version: input.prompt_version,
        file_type: docsById.get(family.document_id ?? ""),
        chosen_grid_id: table?.table_id ?? tableId,
        family_text: compact(family.family_text),
        question_answered: compact(family.question_answered),
        dimensions_detected: family.table_dimensions ?? table?.dimensions ?? [],
        row_count: family.row_count ?? table?.row_count,
        validation_flags: [],
        created_at: at,
        updated_at: at,
      };
    });
}

export function buildV3ExtractionTraces(input: V3TraceBuildInput): ExtractionTrace[] {
  const at = nowIso();
  const docsById = documentFileTypeById(input.documents);

  return input.insights.map((insight) => {
    const tableId = insight.insight_family_data_id?.trim();
    const sourceMode = (insight as { insight_source_mode?: "explicit_nearby_text" | "synthesized_from_grid" })
      .insight_source_mode;

    return {
      run_id: input.run_id,
      project_id: insight.project_id,
      document_id: insight.document_id,
      insight_id: insight.insight_id,
      table_id: tableId,
      pipeline_version: input.pipeline_version,
      extraction_mode: "agentic",
      model_name: input.model_name,
      prompt_version: input.prompt_version,
      source_mode: sourceMode,
      file_type: docsById.get(insight.document_id),
      chosen_grid_id: tableId,
      family_text: compact(insight.family_text),
      question_answered: compact(insight.question_answered),
      dimensions_detected: insight.table_dimensions ?? [],
      row_count: insight.row_count,
      validation_flags: [],
      created_at: at,
      updated_at: at,
    };
  });
}
