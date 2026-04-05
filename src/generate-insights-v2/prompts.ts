export const FINDING_EXTRACTION_PROMPT = `You extract atomic, evidence-grounded findings from mixed-source research documents.

Rules:
- Return ONLY findings directly supported by the provided evidence units.
- Keep each finding atomic and concrete.
- Preserve quantitative specificity: values, units, dimensions, timeframe, denominator if present.
- Prefer explicit claims over vague summaries.
- Include supporting_unit_ids for every finding.
- Do not invent rows, dimensions, or metrics not present in evidence.
- For table-derived findings, keep row-level fidelity when relevant.
- Output JSON only.`;

export const FINDING_EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          metric_value: { type: ["string", "number", "null"] },
          metric_unit: { type: ["string", "null"] },
          dimensions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                tag: { type: "string" },
                value: { type: "string" },
              },
              required: ["tag", "value"],
            },
          },
          confidence: { type: ["number", "null"] },
          source_modality: { type: "string", enum: ["text", "table"] },
          supporting_unit_ids: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: [
          "text",
          "metric_value",
          "metric_unit",
          "dimensions",
          "confidence",
          "source_modality",
          "supporting_unit_ids",
        ],
      },
    },
  },
  required: ["findings"],
} as const;

export const FINDING_CRITIQUE_PROMPT = `You validate findings for support quality and precision.

Drop findings that are unsupported, duplicate, vague, or quantitatively inconsistent with provided refs.
Be conservative: only drop when confidence is high.
Output JSON only.`;

export const FINDING_CRITIQUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    drop_finding_ids: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["drop_finding_ids"],
} as const;

export const FILTER_EXTRACTION_PROMPT = `You identify reusable metadata filter dimensions across findings.

Rules:
- Return reusable dimension tags only.
- Prefer tags that appear across multiple findings.
- Avoid one-off or overly specific tags.
- Output JSON only.`;

export const FILTER_EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    filters: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["filters"],
} as const;

export const RESEARCH_CONTEXT_NORMALIZATION_PROMPT = `You normalize research context into a concise guidance lens.

Rules:
- Preserve intent and key analytical scope from the input context.
- Keep output concise and reusable.
- key_topics should be short topical phrases.
- key_questions should be explicit analytical questions when available.
- Do not introduce unsupported facts.
- Research context is for guidance only. Do NOT introduce unsupported facts.
- Output JSON only.`;

export const RESEARCH_CONTEXT_NORMALIZATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    short_summary: { type: "string" },
    key_topics: {
      type: "array",
      items: { type: "string" },
    },
    key_questions: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["short_summary", "key_topics", "key_questions"],
} as const;

export const FAMILY_GROUPING_PROMPT = `You group related findings into insight families.

Rules:
- Families must be grounded in supporting finding IDs.
- family_text must be a generalized, reusable insight statement that acts as the semantic anchor for search.
- family_text should usually avoid hard-coding row-level numeric values unless required for correctness.
- family_text must be an insight statement, not a bland topic label.
- question_answered must be a specific, user-meaningful analytical question aligned to the supporting findings.
- question_answered must not be generic boilerplate (for example: "What does the data show?").
- Quantitative specifics belong primarily in findings and instance rows.
- Filters must be grounded in the supporting findings.
- summary is optional (1-3 sentences), and should remain general rather than row-level.
- Research context is for guidance only. Do NOT introduce unsupported facts.
- Output JSON only.`;

export const FAMILY_GROUPING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    families: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          family_text: { type: "string" },
          question_answered: { type: "string" },
          filters: {
            type: "array",
            items: { type: "string" },
          },
          summary: { type: ["string", "null"] },
          supporting_finding_ids: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: [
          "family_text",
          "question_answered",
          "filters",
          "summary",
          "supporting_finding_ids",
        ],
      },
    },
  },
  required: ["families"],
} as const;
