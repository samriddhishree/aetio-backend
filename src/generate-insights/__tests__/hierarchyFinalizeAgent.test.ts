import { describe, expect, it } from "vitest";
import type { GraphState } from "../../types";
import { HierarchyFinalizeAgent } from "../agents/hierarchyFinalizeAgent";

const makeState = (): GraphState => ({
  outputUrls: [],
  imageBlocks: [],
  documents: [],
  chunks: [],
  findings: [],
  finding_batches: [],
  batch_insights: [],
  imageChunks: [],
  insights: [],
  sourceTextByS3Node: {},
  errors: [],
  userId: "user-1",
});

describe("HierarchyFinalizeAgent", () => {
  it("attaches top-level insights to project root when configured by state", async () => {
    const agent = new HierarchyFinalizeAgent();
    const state: GraphState = {
      ...makeState(),
      projectId: "project-1",
      insights: [
        {
          insight_id: "insight-a",
          text: "Top-level A",
          s3_node: "doc:d1",
          document_id: "d1",
        },
        {
          insight_id: "insight-b",
          text: "Top-level B",
          s3_node: "doc:d1",
          document_id: "d1",
        },
        {
          insight_id: "insight-b-1",
          parent_insight_id: "insight-b",
          text: "Child of B",
          s3_node: "doc:d1",
          document_id: "d1",
        },
      ],
    };

    const result = await agent.process(state);
    const updated = result.insights ?? [];
    const insightA = updated.find((item) => item.insight_id === "insight-a");
    const insightB = updated.find((item) => item.insight_id === "insight-b");
    const insightB1 = updated.find((item) => item.insight_id === "insight-b-1");

    expect(insightA?.parent_insight_id).toBe("project-1");
    expect(insightB?.parent_insight_id).toBe("project-1");
    expect(insightB1?.parent_insight_id).toBe("insight-b");
    expect(insightA?.status).toBe("Pending");
    expect(insightA?.project_id).toBe("project-1");
  });

  it("detaches self-parent and missing-parent links deterministically", async () => {
    const agent = new HierarchyFinalizeAgent({
      defaultRootStrategy: "null",
    });
    const state: GraphState = {
      ...makeState(),
      insights: [
        {
          insight_id: "a",
          parent_insight_id: "a",
          text: "Self-parented",
          s3_node: "doc:d1",
          document_id: "d1",
        },
        {
          insight_id: "b",
          parent_insight_id: "missing",
          text: "Dangling parent",
          s3_node: "doc:d1",
          document_id: "d1",
        },
      ],
    };

    const result = await agent.process(state);
    const updated = result.insights ?? [];
    expect(updated[0]?.parent_insight_id).toBeUndefined();
    expect(updated[1]?.parent_insight_id).toBeUndefined();
  });

  it("breaks cycles by detaching the least-supported then latest link", async () => {
    const agent = new HierarchyFinalizeAgent({
      defaultRootStrategy: "null",
    });
    const state: GraphState = {
      ...makeState(),
      insights: [
        {
          insight_id: "a",
          parent_insight_id: "b",
          text: "A",
          supporting_chunks: [{ chunk_id: "c1" }, { chunk_id: "c2" }],
          s3_node: "doc:d1",
          document_id: "d1",
        },
        {
          insight_id: "b",
          parent_insight_id: "c",
          text: "B",
          supporting_chunks: [{ chunk_id: "c3" }],
          s3_node: "doc:d1",
          document_id: "d1",
        },
        {
          insight_id: "c",
          parent_insight_id: "a",
          text: "C",
          supporting_chunks: [{ chunk_id: "c4" }],
          s3_node: "doc:d1",
          document_id: "d1",
        },
      ],
    };

    const result = await agent.process(state);
    const updated = result.insights ?? [];
    const a = updated.find((item) => item.insight_id === "a");
    const b = updated.find((item) => item.insight_id === "b");
    const c = updated.find((item) => item.insight_id === "c");

    expect(a?.parent_insight_id).toBe("b");
    expect(b?.parent_insight_id).toBe("c");
    expect(c?.parent_insight_id).toBeUndefined();
  });

  it("removes cross-document parent references", async () => {
    const agent = new HierarchyFinalizeAgent({
      defaultRootStrategy: "null",
    });
    const state: GraphState = {
      ...makeState(),
      insights: [
        {
          insight_id: "parent-d1",
          text: "Doc 1 parent",
          s3_node: "doc:d1",
          document_id: "d1",
        },
        {
          insight_id: "child-d2",
          parent_insight_id: "parent-d1",
          text: "Doc 2 child",
          s3_node: "doc:d2",
          document_id: "d2",
        },
      ],
    };

    const result = await agent.process(state);
    const updated = result.insights ?? [];
    const child = updated.find((item) => item.insight_id === "child-d2");
    expect(child?.parent_insight_id).toBeUndefined();
  });
});
