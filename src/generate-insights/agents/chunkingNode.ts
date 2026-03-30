import type {
  ContentBlock,
  GraphState,
  ImageContentBlock,
  PipelineError,
  TextBlock,
} from "../../types";
import { config } from "../../common/services/config";
import { chunkDocument } from "../../common/services/chunking";
import { hashId, mapWithConcurrency } from "../../common/services/utils";
import { uploadChunkToS3 } from "../../common/services/s3";

const MIN_TOKENS = 500;
const MAX_TOKENS = 1500;

function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

function buildTextChunk(
  documentId: string,
  sourceUrl: string,
  index: number,
  blocks: TextBlock[],
  content: string,
) {
  const chunkId = hashId(`${documentId}:text:${index}`);
  return {
    chunk_id: chunkId,
    document_id: documentId,
    type: "text" as const,
    content: content.trim(),
    block_ids: blocks.map((block) => block.block_id),
    s3_node: "",
    source_url: sourceUrl,
    page: blocks[0]?.page,
  };
}

function buildImageChunk(
  documentId: string,
  block: ImageContentBlock,
) {
  const chunkId = hashId(`${documentId}:image:${block.block_id}`);
  return {
    chunk_id: chunkId,
    document_id: documentId,
    type: "image" as const,
    content: (block.extracted_text ?? "").trim(),
    source_image: block.source_image,
    page: block.page,
    block_ids: [block.block_id],
    s3_node: "",
  };
}

function isImageBlock(block: ContentBlock): block is ImageContentBlock {
  return block.type === "image";
}

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === "text";
}

export async function chunkingNode(
  state: GraphState,
): Promise<Partial<GraphState>> {
  console.log("ChunkingNode:size", state.insights?.length ?? 0);
  console.debug("ChunkingNode:start", {
    documents: state.documents.length,
    blocks: state.documents.reduce((sum, doc) => sum + (doc.blocks?.length ?? 0), 0),
  });
  const errors: PipelineError[] = [];
  const allChunks = [];
  const sourceTextByS3Node: Record<string, string> = {};

  for (const document of state.documents) {
    try {
      if (document.blocks && document.blocks.length > 0) {
        let currentBlocks: TextBlock[] = [];
        let currentContent: string[] = [];
        let currentTokens = 0;
        let textChunkIndex = 0;

        const flushTextChunk = () => {
          if (currentBlocks.length === 0) return;
          const content = currentContent.join(" ").trim();
          const chunk = buildTextChunk(
            document.document_id,
            document.url,
            textChunkIndex,
            currentBlocks,
            content,
          );
          allChunks.push(chunk);
          textChunkIndex += 1;
          currentBlocks = [];
          currentContent = [];
          currentTokens = 0;
        };

        for (const block of document.blocks) {
          if (isImageBlock(block)) {
            flushTextChunk();
            const chunk = buildImageChunk(document.document_id, block);
            allChunks.push(chunk);
            continue;
          }

          if (!isTextBlock(block)) continue;
          const blockContent = block.content.trim();
          if (!blockContent) continue;

          const blockTokens = estimateTokens(blockContent);
          if (currentTokens + blockTokens > MAX_TOKENS) {
            flushTextChunk();
          }
          currentBlocks.push(block);
          currentContent.push(blockContent);
          currentTokens += blockTokens;

          if (currentTokens >= MIN_TOKENS) {
            flushTextChunk();
          }
        }

        flushTextChunk();
      } else {
        const { chunks } = chunkDocument(document);
        allChunks.push(...chunks);
      }
    } catch (error) {
      errors.push({
        stage: "ChunkingNode",
        message: error instanceof Error ? error.message : "Unknown error",
        document_id: document.document_id,
        cause: error,
      });
    }
  }

  if (process.env.NODE_ENV === "test") {
    console.debug("ChunkingNode:upload:skipped", {
      reason: "test-environment",
      chunks: allChunks.length,
    });
  } else {
    console.debug("ChunkingNode:upload:start", {
      chunks: allChunks.length,
      bucket: config.documentsBucket,
    });

    await mapWithConcurrency(allChunks, config.maxConcurrency, async (chunk) => {
      try {
        const uploadResult = await uploadChunkToS3(chunk, state.userId);
        chunk.s3_node = uploadResult.s3Url;
        sourceTextByS3Node[uploadResult.s3Url] = chunk.content;
      } catch (error) {
        errors.push({
          stage: "ChunkingNode",
          message: `Failed to upload chunk ${chunk.chunk_id} to S3: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
          document_id: chunk.document_id,
          cause: error,
        });
      }
    });

    console.debug("ChunkingNode:upload:end", {
      chunks: allChunks.length,
      uploadErrors: errors.length,
    });
  }

  return {
    chunks: allChunks,
    sourceTextByS3Node,
    errors: state.errors.concat(errors),
  };
}
