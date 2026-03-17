import { describe, expect, it } from "vitest";
import type { GraphState } from "../types";
import { chunkingNode } from "../agents/chunkingNode";

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

describe("chunkingNode", () => {
  it("creates separate image chunks and text chunks", async () => {
    const state: GraphState = {
      ...makeState(),
      documents: [
        {
          document_id: "doc-1",
          url: "https://example.com",
          text: "ignored",
          blocks: [
            { block_id: "t1", type: "text", content: "Alpha beta gamma", page: 1 },
            { block_id: "i1", type: "image", source_image: "s3://bucket/img1.png", page: 1, extracted_text: "Image text" },
            { block_id: "t2", type: "text", content: "Delta epsilon zeta", page: 2 },
          ],
        },
      ],
    };

    const result = await chunkingNode(state);
    const chunks = result.chunks ?? [];
    expect(chunks.length).toBe(3);

    const imageChunks = chunks.filter((chunk) => chunk.type === "image");
    const textChunks = chunks.filter((chunk) => chunk.type === "text");

    expect(imageChunks.length).toBe(1);
    expect(textChunks.length).toBe(2);

    expect(imageChunks[0].source_image).toBe("s3://bucket/img1.png");
    expect(imageChunks[0].block_ids).toEqual(["i1"]);

    for (const textChunk of textChunks) {
      expect(textChunk.source_image).toBeUndefined();
      expect(textChunk.block_ids.length).toBe(1);
    }
  });
});
