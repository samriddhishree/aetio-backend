import { describe, expect, it, vi } from "vitest";
import type { GraphState } from "../types";
import { insightExtractionAgent } from "../agents/insightExtractionAgent";
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
});

describe("insightExtractionAgent", () => {
  it("extracts insights from chunk content", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              insights: [
                { text: "Insight A", sub_insights: [{ text: "Sub A1" }] },
              ],
            }),
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
      chunks: [
        {
          chunk_id: "c1",
          document_id: "d1",
          type: "text",
          content: "Some content",
          block_ids: ["b1"],
          s3_node: "source:s3://bucket/doc#chunk:0",
        },
      ],
    };

    const result = await insightExtractionAgent(state);
    expect(result.insights?.length).toBe(2);
    expect(result.insights?.[0].text).toBe("Insight A");
    expect(result.insights?.[1].parent_insight_id).toBe(result.insights?.[0].insight_id);

    openaiSpy.mockRestore();
  });

  it("skips empty chunk content", async () => {
    const openaiSpy = vi.spyOn(openaiModule, "openai", "get").mockReturnValue({
      chat: {
        completions: { create: vi.fn() },
      },
    } as any);

    const state: GraphState = {
      ...makeState(),
      chunks: [
        {
          chunk_id: "c1",
          document_id: "d1",
          type: "text",
          content: "",
          block_ids: ["b1"],
          s3_node: "source:s3://bucket/doc#chunk:0",
        },
      ],
    };

    const result = await insightExtractionAgent(state);
    expect(result.insights?.length).toBe(0);

    openaiSpy.mockRestore();
  });
});
