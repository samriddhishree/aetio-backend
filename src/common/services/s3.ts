import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Chunk } from "../../types";
import { getCachedAwsAssumeRoleProvider } from "./aws";
import { config } from "./config";

const s3Client = new S3Client({
  credentials: getCachedAwsAssumeRoleProvider(),
});

type ChunkUploadInput = Pick<
  Chunk,
  "chunk_id" | "document_id" | "type" | "content" | "source_url" | "source_image"
>;

function safePathToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "unknown";
  return trimmed.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function sourceToFileName(chunk: ChunkUploadInput): string {
  const source = chunk.source_url ?? chunk.source_image;
  if (!source) {
    return safePathToken(`${chunk.document_id}.txt`);
  }
  const normalized = source.startsWith("source:") ? source.slice("source:".length) : source;
  const withoutFragment = normalized.split("#")[0] ?? normalized;

  try {
    const parsed = new URL(withoutFragment);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();
    return safePathToken(lastSegment ?? `${chunk.document_id}.txt`);
  } catch {
    const fallback = withoutFragment.split("/").filter(Boolean).pop() ?? `${chunk.document_id}.txt`;
    return safePathToken(fallback);
  }
}

export function buildChunkObjectKey(
  chunk: ChunkUploadInput,
  userId?: string,
): string {
  const safeUserId = safePathToken(userId ?? "unknown-user");
  const fileName = sourceToFileName(chunk);
  return [
    "extraction",
    safeUserId,
    `chunks_${fileName}`,
    `${chunk.chunk_id}.txt`,
  ].join("/");
}

export async function uploadChunkToS3(
  chunk: ChunkUploadInput,
  userId?: string,
): Promise<{ bucket: string; key: string; s3Url: string }> {
  const bucket = config.documentsBucket;
  const key = buildChunkObjectKey(chunk, userId);
  const s3Url = `s3://${bucket}/${key}`;

  console.debug("s3:uploadChunk:start", {
    chunkId: chunk.chunk_id,
    documentId: chunk.document_id,
    key,
    bucket,
    bytes: Buffer.byteLength(chunk.content ?? "", "utf8"),
  });

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: chunk.content,
      ContentType: "text/plain; charset=utf-8",
      Metadata: {
        "chunk-id": chunk.chunk_id,
        "document-id": chunk.document_id,
        "chunk-type": chunk.type,
        "source-url": chunk.source_url ?? "",
        "source-image": chunk.source_image ?? "",
        "user-id": userId ?? "",
      },
    }),
  );

  console.debug("s3:uploadChunk:done", {
    chunkId: chunk.chunk_id,
    documentId: chunk.document_id,
    key,
    bucket,
  });

  return { bucket, key, s3Url };
}
