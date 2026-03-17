import { describe, expect, it, vi } from "vitest";
import type { GraphState } from "../types";
import { hierarchyBuilderAgent } from "../agents/hierarchyBuilderAgent";
import * as openaiModule from "../services/openai";

const makeState = (): GraphState => ({
  outputUrls: [],
  imageBlocks: [],
  documents: [],
  chunks: [],
  imageChunks: [],
  insights: [],
  sourceTextByS3Node: {},
  errors: [],
  userId: "user-1",
  projectId: "project-1",
});

describe("hierarchyBuilderAgent", () => {
  it("tags standalone top-level insights with projectId", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ groups: [] }),
          },
        },
      ],
    });

    const openaiSpy = vi.spyOn(openaiModule, "openai", "get").mockReturnValue({
      chat: {
        completions: { create: mockCreate },
      },
    } as any);

    const state: GraphState = {
      ...makeState(),
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

    const result = await hierarchyBuilderAgent(state);
    const updated = result.insights ?? [];
    const insightA = updated.find((item) => item.insight_id === "insight-a");
    const insightB = updated.find((item) => item.insight_id === "insight-b");
    const insightB1 = updated.find((item) => item.insight_id === "insight-b-1");

    expect(insightA?.parent_insight_id).toBe("project-1");
    expect(insightB?.parent_insight_id).toBe(("project-1"));
    expect(insightB1?.parent_insight_id).toBe("insight-b");

    openaiSpy.mockRestore();
  });
});
