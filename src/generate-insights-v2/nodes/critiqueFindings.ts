import { openai, OPENAI_HELPER_MODEL } from "../../common/services/openai";
import type { PipelineError } from "../../types";
import {
  FINDING_CRITIQUE_PROMPT,
  FINDING_CRITIQUE_SCHEMA,
} from "../prompts";
import type { Finding, GenerateInsightsV2State } from "../types";

type CritiqueResponse = {
  drop_finding_ids: string[];
};

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function isVagueFinding(value: string): boolean {
  const compact = normalizeText(value);
  if (compact.length < 18) return true;
  const vaguePatterns = [
    "is important",
    "suggests that",
    "indicates that",
    "in general",
    "various factors",
    "many aspects",
  ];
  return vaguePatterns.some((pattern) => compact.includes(pattern));
}

function isSupportedFinding(
  finding: Finding,
  chunkIds: Set<string>,
  tableIds: Set<string>,
): boolean {
  if (finding.supporting_refs.length === 0) return false;
  return finding.supporting_refs.some((ref) => {
    if (ref.chunk_id && chunkIds.has(ref.chunk_id)) return true;
    if (ref.table_id && tableIds.has(ref.table_id)) return true;
    return false;
  });
}

function hasNumericMismatch(finding: Finding): boolean {
  if (finding.metric_value === undefined || finding.metric_value === null) return false;
  const metricToken = String(finding.metric_value).trim();
  if (!metricToken) return false;

  const text = [finding.text, ...finding.supporting_refs.map((ref) => ref.source_excerpt ?? "")]
    .join(" ")
    .toLowerCase();

  return !text.includes(metricToken.toLowerCase());
}

function dedupeRefs(finding: Finding): Finding {
  return {
    ...finding,
    supporting_refs: finding.supporting_refs.filter(
      (ref, index, refs) =>
        refs.findIndex(
          (candidate) =>
            candidate.chunk_id === ref.chunk_id &&
            candidate.table_id === ref.table_id &&
            candidate.row_index === ref.row_index,
        ) === index,
    ),
  };
}

export async function critiqueFindingsNode(
  state: GenerateInsightsV2State,
): Promise<Partial<GenerateInsightsV2State>> {
  console.info("[finding-critique] starting", {
    findings: state.findings.length,
  });

  const chunkIds = new Set(state.chunks.map((chunk) => chunk.chunk_id));
  const tableIds = new Set(state.tables.map((table) => table.table_id));

  const seenByText = new Set<string>();
  const deterministicKept: Finding[] = [];

  let unsupportedCount = 0;
  let duplicateCount = 0;
  let vagueCount = 0;
  let numericMismatchCount = 0;

  for (const finding of state.findings) {
    const withDedupedRefs = dedupeRefs(finding);
    const normalizedText = normalizeText(withDedupedRefs.text);

    if (!isSupportedFinding(withDedupedRefs, chunkIds, tableIds)) {
      unsupportedCount += 1;
      continue;
    }

    if (seenByText.has(normalizedText)) {
      duplicateCount += 1;
      continue;
    }

    if (isVagueFinding(withDedupedRefs.text)) {
      vagueCount += 1;
      continue;
    }

    if (hasNumericMismatch(withDedupedRefs)) {
      numericMismatchCount += 1;
      continue;
    }

    seenByText.add(normalizedText);
    deterministicKept.push(withDedupedRefs);
  }

  if (deterministicKept.length === 0) {
    console.warn("[finding-critique] all findings removed by deterministic checks", {
      unsupportedCount,
      duplicateCount,
      vagueCount,
      numericMismatchCount,
    });

    return {
      validatedFindings: [],
    };
  }

  const critiqueErrors: PipelineError[] = [];
  let llmDropSet = new Set<string>();

  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_HELPER_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: FINDING_CRITIQUE_PROMPT,
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              findings: deterministicKept.map((finding) => ({
                finding_id: finding.finding_id,
                text: finding.text,
                metric_value: finding.metric_value,
                metric_unit: finding.metric_unit,
                dimensions: finding.dimensions ?? [],
                supporting_refs: finding.supporting_refs.map((ref) => ({
                  chunk_id: ref.chunk_id,
                  table_id: ref.table_id,
                  row_index: ref.row_index,
                  source_excerpt: ref.source_excerpt,
                })),
              })),
            },
            null,
            2,
          ),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "finding_critique_v2",
          schema: FINDING_CRITIQUE_SCHEMA,
          strict: true,
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("Empty OpenAI response.");

    const parsed = JSON.parse(content) as CritiqueResponse;
    llmDropSet = new Set((parsed.drop_finding_ids ?? []).filter(Boolean));
  } catch (error) {
    critiqueErrors.push({
      stage: "finding-critique",
      message: error instanceof Error ? error.message : "Unknown error",
      cause: error,
    });
    console.warn("[finding-critique] semantic critique failed, using deterministic output only", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }

  const validatedFindings = deterministicKept.filter(
    (finding) => !llmDropSet.has(finding.finding_id),
  );

  console.info("[finding-critique] completed", {
    inputFindings: state.findings.length,
    keptAfterDeterministic: deterministicKept.length,
    droppedUnsupported: unsupportedCount,
    droppedDuplicate: duplicateCount,
    droppedVague: vagueCount,
    droppedNumericMismatch: numericMismatchCount,
    droppedBySemanticCritique: deterministicKept.length - validatedFindings.length,
    validatedFindings: validatedFindings.length,
  });

  return {
    validatedFindings,
    errors: state.errors.concat(critiqueErrors),
  };
}
