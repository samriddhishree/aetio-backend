import { describe, expect, it } from "vitest";
import { buildPersistedInsightFamilyDataRecord } from "../services/insightFamilyDataPersistence";
import type { InsightFamilyData } from "../types";

describe("insightFamilyDataPersistence", () => {
  it("builds a dedicated family-data record linked by family_id", () => {
    const table: InsightFamilyData = {
      table_id: "table-1",
      family_id: "family-1",
      dimensions: ["channel"],
      metric_columns: ["conversion_rate_change"],
      row_count: 1,
      rows: [
        {
          row_id: "row-1",
          family_id: "family-1",
          filter_values: [
            {
              dimension_id: "dim-channel",
              dimension_name: "channel",
              value_id: "val-email",
              value: "email",
              display_value: "Email",
            },
          ],
          metric_name: "conversion_rate_change",
          value_text: "Email conversion +4%",
          metric_value: 4,
          metric_unit: "%",
          supporting_refs: [{ chunk_id: "chunk-1" }],
        },
      ],
      source_modalities: ["table"],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };

    const record = buildPersistedInsightFamilyDataRecord({
      table,
      userId: "user-1",
      projectId: "project-1",
      organizationId: "org-1",
      status: "Pending",
      documentIds: ["doc-1"],
      sourceTypes: ["csv"],
      scopeS3Node: "family-v2:project:project-1:insightfamilydata",
      primaryDocumentId: "doc-1",
    });

    expect(record.familyData.table_id).toBe("table-1");
    expect(record.familyData.family_id).toBe("family-1");
    expect(record.familyData.s3_node).toBe("family-v2:project:project-1:insightfamilydata");
    expect(record.familyData.rows).toHaveLength(1);
    expect((record.familyData as { text?: string }).text).toBeUndefined();
  });
});
