import { describe, expect, it } from "vitest";
import type { Document, GraphState } from "../types";
import { chunkingNode } from "../agents/chunkingNode";
import { chunkDocument } from "../services/chunking";

const makeText = (words: number) => Array.from({ length: words }, (_, i) => `w${i}`).join(" ");

describe("chunkDocument", () => {
  it("creates text chunks within token bounds", () => {
    const doc: Document = {
      document_id: "doc-1",
      url: "https://example.com",
      text: `${makeText(900)}\n\n${makeText(900)}`,
    };

    const { chunks } = chunkDocument(doc, 500, 1500);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.type).toBe("text");
      expect(chunk.content.length).toBeGreaterThan(0);
      expect(chunk.block_ids.length).toBeGreaterThan(0);
      expect(chunk.s3_node).toContain("source:");
    }
  });
});

describe("chunkingNode", () => {
  it("creates separate image chunk when document has image and text blocks", async () => {
    const state: GraphState = {
      outputUrls: [],
      imageBlocks: [],
      documents: [
        {
          document_id: "doc-2",
          url: "https://example.com/doc-2",
          text: "ignored",
          blocks: [
            { block_id: "t1", type: "text", content: "Alpha beta gamma", page: 1 },
            {
              block_id: "i1",
              type: "image",
              source_image: "s3://bucket/img1.png",
              page: 1,
              extracted_text: "Image text",
            },
            { block_id: "t2", type: "text", content: "Delta epsilon zeta", page: 2 },
          ],
        },
      ],
      chunks: [],
      findings: [],
      finding_batches: [],
      batch_insights: [],
      imageChunks: [],
      insights: [],
      sourceTextByS3Node: {},
      errors: [],
    };

    const result = await chunkingNode(state);
    const chunks = result.chunks ?? [];

    const imageChunks = chunks.filter((chunk) => chunk.type === "image");
    const textChunks = chunks.filter((chunk) => chunk.type === "text");

    expect(imageChunks.length).toBe(1);
    expect(textChunks.length).toBe(2);

    expect(imageChunks[0].source_image).toBe("s3://bucket/img1.png");
    expect(imageChunks[0].block_ids).toEqual(["i1"]);
    expect(imageChunks[0].content).toContain("Image text");

    for (const textChunk of textChunks) {
      expect(textChunk.source_image).toBeUndefined();
      expect(textChunk.block_ids.length).toBe(1);
    }
  });
});
