import { describe, expect, it } from "vitest";
import { finalValidationNode } from "../nodes/finalValidation";
import type { GenerateInsightsV2State } from "../types";

describe("finalValidationNode timestamps", () => {
  it("adds created_at and expires_at (1 year later) to validated families", async () => {
    const state: GenerateInsightsV2State = {
      sourceUris: ["s3://bucket/doc.pdf"],
      documents: [],
      extractedDocuments: [],
      normalizedDocuments: [],
      chunks: [],
      tables: [],
      findings: [],
      validatedFindings: [
        {
          finding_id: "f-1",
          text: "Enterprise accounts had higher conversion rates across regions.",
          dimensions: [{ tag: "segment", value: "enterprise" }],
          supporting_refs: [{ chunk_id: "c-1" }],
          source_modality: "text",
        },
      ],
      metadataFilters: ["segment"],
      insightFamilies: [
        {
          family_id: "family-1",
          family_text: "Enterprise accounts convert better in this dataset.",
          question_answered: "How does conversion vary by segment?",
          filters: ["segment"],
          supporting_finding_ids: ["f-1"],
          has_grid: false,
        },
      ],
      insightRows: [],
      insightFamilyData: [],
      errors: [],
      outputUrls: [],
      contextUrls: [],
      rawDataUrls: [],
      researchContext: undefined,
      uploadMode: "document",
      userInfo: undefined,
      normalizedResearchContext: undefined,
      userId: "user-1",
      projectId: "project-1",
      organizationId: undefined,
      status: "Pending",
      persistedFamilyCounts: undefined,
      persistedInsightFamilyDataCounts: undefined,
    };

    const result = await finalValidationNode(state);
    const family = result.insightFamilies?.[0];

    expect(family).toBeDefined();
    expect(typeof family?.created_at).toBe("string");
    expect(typeof family?.expires_at).toBe("string");

    const created = new Date(family!.created_at!);
    const expires = new Date(family!.expires_at!);
    const expected = new Date(family!.created_at!);
    expected.setUTCFullYear(expected.getUTCFullYear() + 1);
    expect(expires.toISOString()).toBe(expected.toISOString());
    expect(created.getTime()).toBeLessThan(expires.getTime());
  });
});
