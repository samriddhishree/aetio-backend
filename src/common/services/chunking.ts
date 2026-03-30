import type { Chunk, Document } from "../../types";
import { hashId } from "./utils";

function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function chunkDocument(
  document: Document,
  minTokens = 500,
  maxTokens = 1500,
): { chunks: Chunk[]; sourceTextByS3Node: Record<string, string> } {
  console.debug("chunking:chunkDocument:start", {
    document_id: document.document_id,
    url: document.url,
    textLength: document.text.length,
    minTokens,
    maxTokens,
  });
  const paragraphs = document.text
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean);

  const chunks: Chunk[] = [];
  const sourceTextByS3Node: Record<string, string> = {};

  let current: string[] = [];
  let currentTokens = 0;

  const pushChunk = () => {
    if (current.length === 0) return;
    const content = current.join(" ").trim();
    const chunkIndex = chunks.length;
    const chunkId = hashId(`${document.document_id}:${chunkIndex}`);
    const chunk: Chunk = {
      chunk_id: chunkId,
      document_id: document.document_id,
      type: "text",
      content,
      block_ids: [`text:${chunkIndex}`],
      s3_node: "",
      source_url: document.url,
    };
    chunks.push(chunk);
    current = [];
    currentTokens = 0;
  };

  for (const paragraph of paragraphs) {
    const paraTokens = estimateTokens(paragraph);
    if (paraTokens > maxTokens) {
      const sentences = splitIntoSentences(paragraph);
      for (const sentence of sentences) {
        const sentenceTokens = estimateTokens(sentence);
        if (currentTokens + sentenceTokens > maxTokens) {
          pushChunk();
        }
        current.push(sentence);
        currentTokens += sentenceTokens;
        if (currentTokens >= minTokens) {
          pushChunk();
        }
      }
      continue;
    }

    if (currentTokens + paraTokens > maxTokens) {
      pushChunk();
    }
    current.push(paragraph);
    currentTokens += paraTokens;
    if (currentTokens >= minTokens) {
      pushChunk();
    }
  }

  pushChunk();

  console.debug("chunking:chunkDocument:done", {
    document_id: document.document_id,
    chunks: chunks.length,
  });
  return { chunks, sourceTextByS3Node };
}
