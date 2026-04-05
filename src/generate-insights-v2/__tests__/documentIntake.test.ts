import { describe, expect, it } from "vitest";
import { hashId } from "../../common/services/utils";
import { documentIntakeNode } from "../nodes/documentIntake";
import type { GenerateInsightsV2State } from "../types";

function makeBaseState(): GenerateInsightsV2State {
  return {
    sourceUris: [],
    contextUrls: [],
    researchContext: undefined,
    userId: "user-1",
    projectId: undefined,
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

describe("documentIntakeNode", () => {
  it("builds document_id from file name instead of source-uri hash", async () => {
    const sourceUri =
      "s3://bucket/uploads/extraction/f12b4500-1041-7018-dc1d-7bf79ae667c9/Mass Incarceration.pdf";
    const state = makeBaseState();
    state.sourceUris = [sourceUri];

    const result = await documentIntakeNode(state);
    const doc = result.documents?.[0];

    expect(doc?.document_id).toBe("mass_incarceration.pdf");
    expect(doc?.document_id).not.toBe(hashId(sourceUri));
  });

  it("adds deterministic suffix when two files share the same name", async () => {
    const uriA = "s3://bucket/a/reports/summary.csv";
    const uriB = "s3://bucket/b/exports/summary.csv";
    const state = makeBaseState();
    state.sourceUris = [uriA, uriB];

    const result = await documentIntakeNode(state);
    const ids = (result.documents ?? []).map((doc) => doc.document_id);

    expect(ids[0]).toBe("summary.csv");
    expect(ids[1]).toBe(`summary.csv-${hashId(uriB).slice(0, 8)}`);
  });

  it("generates a workflow projectId when missing", async () => {
    const state = makeBaseState();
    state.sourceUris = ["s3://bucket/documents/example.pdf"];

    const resultA = await documentIntakeNode(state);
    const resultB = await documentIntakeNode(state);

    expect(resultA.projectId).toMatch(/^project-v2-[a-f0-9]{32}$/);
    expect(resultA.projectId).toBe(resultB.projectId);
  });

  it("keeps explicit projectId when provided", async () => {
    const state = makeBaseState();
    state.sourceUris = ["s3://bucket/documents/example.pdf"];
    state.projectId = "project-manual";

    const result = await documentIntakeNode(state);
    expect(result.projectId).toBe("project-manual");
  });
});
