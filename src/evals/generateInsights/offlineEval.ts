import type { Insight } from "../../types";
import type { GenerateInsightsV2Response } from "../../generate-insights-v2/types";
import type { GenerateInsightsV3Response } from "../../generate-insights-v3/types";

export type OfflineEvalFixture = {
  fixture_id: string;
  mode: "v2" | "v3";
  payload: Record<string, unknown>;
  expected: {
    expected_insight_count?: number;
    expected_family_text_contains?: string[];
    expected_semantic_labels?: string[];
    expected_dimensions?: string[];
    expected_row_count?: number;
    expected_metadata_tags?: string[];
  };
};

export type OfflineEvalCheck = {
  check: string;
  passed: boolean;
  details?: string;
};

export type OfflineEvalResult = {
  fixture_id: string;
  mode: "v2" | "v3";
  passed: boolean;
  checks: OfflineEvalCheck[];
};

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function collectInsights(output: GenerateInsightsV2Response | GenerateInsightsV3Response): Insight[] {
  if ("insights" in output) return output.insights;
  return output.insight_families.map((family) => ({
    insight_id: family.insight_id ?? family.family_id,
    text: family.family_text,
    family_text: family.family_text,
    question_answered: family.question_answered,
    metadata: [],
    evidence_snippet: family.summary ?? family.family_text,
    s3_node: "offline-eval",
    document_id: family.document_ids?.[0] ?? output.documents[0]?.document_id ?? "offline",
    row_count: family.row_count,
    table_dimensions: family.table_dimensions,
  }));
}

function collectDimensions(output: GenerateInsightsV2Response | GenerateInsightsV3Response): string[] {
  if ("insights" in output) {
    return Array.from(
      new Set(
        output.insights.flatMap((insight) => insight.table_dimensions ?? []),
      ),
    );
  }

  return Array.from(
    new Set(
      output.insight_family_data.flatMap((table) => table.dimensions ?? []),
    ),
  );
}

function collectMetadataTags(output: GenerateInsightsV2Response | GenerateInsightsV3Response): string[] {
  if ("insights" in output) {
    return Array.from(
      new Set(
        output.insights.flatMap((insight) => (insight.metadata ?? []).map((entry) => entry.tag)),
      ),
    );
  }

  return [];
}

function collectRowCount(output: GenerateInsightsV2Response | GenerateInsightsV3Response): number {
  if ("insights" in output) {
    return output.insight_family_data.reduce((sum, table) => sum + table.row_count, 0);
  }

  return output.insight_family_data.reduce((sum, table) => sum + table.row_count, 0);
}

export function evaluateOfflineFixtureResult(input: {
  fixture: OfflineEvalFixture;
  output: GenerateInsightsV2Response | GenerateInsightsV3Response;
}): OfflineEvalResult {
  const checks: OfflineEvalCheck[] = [];
  const insights = collectInsights(input.output);
  const dimensions = collectDimensions(input.output).map(compact);
  const metadataTags = collectMetadataTags(input.output).map(compact);
  const totalRowCount = collectRowCount(input.output);

  if (typeof input.fixture.expected.expected_insight_count === "number") {
    checks.push({
      check: "expected_insight_count",
      passed: insights.length === input.fixture.expected.expected_insight_count,
      details: `expected=${input.fixture.expected.expected_insight_count}, actual=${insights.length}`,
    });
  }

  if (Array.isArray(input.fixture.expected.expected_family_text_contains)) {
    const corpus = insights
      .map((insight) => compact(insight.family_text ?? insight.text))
      .join("\n");

    for (const expectedFragment of input.fixture.expected.expected_family_text_contains) {
      const normalized = compact(expectedFragment);
      checks.push({
        check: `expected_family_text_contains:${expectedFragment}`,
        passed: corpus.includes(normalized),
      });
    }
  }

  if (Array.isArray(input.fixture.expected.expected_semantic_labels)) {
    const corpus = insights
      .map((insight) => compact(insight.question_answered ?? ""))
      .join("\n");

    for (const expectedLabel of input.fixture.expected.expected_semantic_labels) {
      const normalized = compact(expectedLabel);
      checks.push({
        check: `expected_semantic_labels:${expectedLabel}`,
        passed: corpus.includes(normalized),
      });
    }
  }

  if (Array.isArray(input.fixture.expected.expected_dimensions)) {
    for (const expectedDimension of input.fixture.expected.expected_dimensions) {
      checks.push({
        check: `expected_dimensions:${expectedDimension}`,
        passed: dimensions.includes(compact(expectedDimension)),
      });
    }
  }

  if (typeof input.fixture.expected.expected_row_count === "number") {
    checks.push({
      check: "expected_row_count",
      passed: totalRowCount === input.fixture.expected.expected_row_count,
      details: `expected=${input.fixture.expected.expected_row_count}, actual=${totalRowCount}`,
    });
  }

  if (Array.isArray(input.fixture.expected.expected_metadata_tags)) {
    for (const expectedTag of input.fixture.expected.expected_metadata_tags) {
      checks.push({
        check: `expected_metadata_tags:${expectedTag}`,
        passed: metadataTags.includes(compact(expectedTag)),
      });
    }
  }

  return {
    fixture_id: input.fixture.fixture_id,
    mode: input.fixture.mode,
    passed: checks.every((check) => check.passed),
    checks,
  };
}
