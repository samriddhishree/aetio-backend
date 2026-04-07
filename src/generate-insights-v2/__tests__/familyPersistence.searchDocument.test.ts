import { describe, expect, it } from "vitest";
import type { Insight } from "../../types";
import {
  buildPersistedInsightFamilyRecord,
  toOpenSearchInsightDocument,
} from "../services/familyPersistence";

describe("toOpenSearchInsightDocument", () => {
  it("persists insight.text, insight.family_text, and insight.question_answered", () => {
    const insight: Insight = {
      insight_id: "insight-1",
      object_type: "insight_family",
      text: "  Canonical insight text  ",
      family_text: "  Family-level insight text  ",
      question_answered: "  Which audience converted best?  ",
      evidence_snippet: "evidence",
      s3_node: "family-v2:project:project-1",
      document_id: "doc-1",
    };

    const doc = toOpenSearchInsightDocument(insight);

    expect(doc.text).toBe("Canonical insight text");
    expect(doc.family_text).toBe("Family-level insight text");
    expect(doc.question_answered).toBe("Which audience converted best?");
  });

  it("defaults expires_at to one year after created_at when persisting insight families", () => {
    const createdAt = "2026-04-07T00:00:00.000Z";

    const record = buildPersistedInsightFamilyRecord({
      family: {
        family_id: "family-1",
        family_text: "Family text",
        question_answered: "Question answered",
        filters: ["segment"],
        supporting_finding_ids: ["finding-1"],
        created_at: createdAt,
      },
      documentIds: ["doc-1"],
      sourceTypes: ["pdf"],
      scopeS3Node: "family-v2:project:project-1",
      primaryDocumentId: "doc-1",
      userId: "user-1",
      status: "Pending",
    });

    expect(record.insight.created_at).toBe(createdAt);
    expect(record.insight.expires_at).toBe("2027-04-07T00:00:00.000Z");
    expect(record.insight.createdAt).toBe(createdAt);
    expect(record.insight.expiresAt).toBe("2027-04-07T00:00:00.000Z");
  });
});
