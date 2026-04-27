export const V3_AGENT_PLANNER_PROMPT = `You are orchestrating a controlled insight-extraction agent.

Pick exactly one next action from the allowed list.

Rules:
- Prefer actions that advance progress on the active grid.
- Keep table/grid analysis first-class.
- Treat table_semantic_objects as first-class evidence when present.
- Use explicit nearby insight text when present.
- If explicit nearby insight is absent, synthesize a grounded insight from the grid.
- Build metadata from normalized grid values before validation.
- Build tags as separate synthesized semantic descriptors after metadata.
- Never finish early when pending candidate grids remain.
- Avoid repeating actions that were already completed for the current grid.
- Output JSON only.`;

export const V3_AGENT_PLANNER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [
        "parse_file",
        "find_candidate_grids",
        "select_next_grid",
        "inspect_grid_context",
        "extract_explicit_insight",
        "synthesize_insight",
        "normalize_grid",
        "normalize_dimension_metadata",
        "build_insight_metadata",
        "build_insight_tags",
        "validate_insight",
        "complete_grid",
        "finish_document",
      ],
    },
    reason: {
      type: "string",
    },
  },
  required: ["action", "reason"],
} as const;

export const V3_EXPLICIT_INSIGHT_PROMPT = `Determine whether the document already states an insight near this grid.

Rules:
- Prioritize nearby headings, captions, bullets, and adjacent paragraphs.
- Return found_explicit_insight=true only if the statement is actually present near the grid.
- Prefer concise adaptation of existing language over rewriting from scratch.
- Do not hallucinate unsupported claims.
- Output JSON only.`;

export const V3_EXPLICIT_INSIGHT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    found_explicit_insight: { type: "boolean" },
    insight_text: { type: ["string", "null"] },
    supporting_snippets: {
      type: "array",
      items: { type: "string" },
    },
    confidence: { type: "number" },
    reasoning: { type: "string" },
  },
  required: [
    "found_explicit_insight",
    "insight_text",
    "supporting_snippets",
    "confidence",
    "reasoning",
  ],
} as const;

export const V3_SYNTHESIZE_INSIGHT_PROMPT = `Synthesize one grounded, generalized insight for this grid.

Rules:
- Ground the statement in the provided grid and nearby context.
- Prefer candidate_facts, column_roles, subject_column, row_index, and evidence_cells from table_semantic_object when present.
- If evidence comes from a table, preserve table_id, source_chunk_id, row_index, evidence_cells, and column names.
- Prefer a generalized interpretation over a single row-level value.
- Do not make causal claims unless explicitly supported.
- Keep the wording semantically useful for search/retrieval.
- Do not include raw table_id, source_chunk_id, row_index, evidence_cells, cell refs, or evidence traces in insight_text.
- Keep insight_text to 1-2 concise human-readable sentences.
- Always provide a non-empty question_answered.
- Output JSON only.`;

export const V3_SYNTHESIZE_INSIGHT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    insight_text: { type: "string" },
    question_answered: { type: ["string", "null"] },
    confidence: { type: "number" },
    reasoning: { type: "string" },
  },
  required: ["insight_text", "question_answered", "confidence", "reasoning"],
} as const;

export const V3_NARRATIVE_GRID_PROMPT = `Infer implied analysis grids from narrative text.

Rules:
- Use only information present in the provided narrative snippets.
- Convert comparable narrative statements into tabular rows and columns.
- Prefer stable, reusable headers (segment/metric/period/value style).
- Do not invent values or entities that are not stated in the source text.
- Return 0-3 implied grids.
- Output JSON only.`;

export const V3_NARRATIVE_GRID_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    implied_grids: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: ["string", "null"] },
          rationale: { type: "string" },
          confidence: { type: "number" },
          headers: {
            type: "array",
            items: { type: "string" },
          },
          rows: {
            type: "array",
            items: {
              type: "array",
              items: { type: "string" },
            },
          },
          supporting_chunk_ids: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: [
          "title",
          "rationale",
          "confidence",
          "headers",
          "rows",
          "supporting_chunk_ids",
        ],
      },
    },
  },
  required: ["implied_grids"],
} as const;

export const V3_TAGS_PROMPT = `Build concise AI-synthesized insight tags.

Rules:
- Do not repeat raw grid metadata values (those are handled separately).
- Synthesize semantic descriptors from the overall pattern in the grid and nearby context.
- Prefer stable, reusable tag keys such as risk_signal, distribution_shape, comparison_basis, dimension_primary, dimension_secondary, geography_scope.
- Each tag item must be a tag/value pair.
- Return 0-16 tags.
- Output JSON only.`;

export const V3_TAGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    tags: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          tag: { type: "string" },
          value: { type: "string" },
          confidence: { type: ["number", "null"] },
        },
        required: ["tag", "value", "confidence"],
      },
    },
  },
  required: ["tags"],
} as const;
