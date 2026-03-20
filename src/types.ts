type Status = {
  ACCEPTED: string;
  DECLINED: string;
  COMPLETED: string;
  PENDING: string;
}

export type InsightMetadataEntry = {
  tag: string;
  value: string;
  confidence: number;
};

export type Insight = {
  insight_id: string;
  parent_insight_id?: string;
  project_id?: string;
  text: string;
  supporting_chunks?: Array<{
    chunk_id: string;
    paragraph_index?: number;
    line_index?: number;
  }>;
  metadata?: InsightMetadataEntry[];
  additional_refs?: unknown;
  user_id?: string;
  status?: string;
  s3_node: string;
  document_id: string;
};

export type Document = {
  document_id: string;
  url: string;
  text: string;
  blocks?: ContentBlock[];
};

export type TextBlock = {
  block_id: string;
  type: "text";
  content: string;
  page?: number;
};

export type ImageContentBlock = {
  block_id: string;
  type: "image";
  source_image: string;
  page: number;
  extracted_text?: string;
};

export type ContentBlock = TextBlock | ImageContentBlock;

export type Chunk = {
  chunk_id: string;
  document_id: string;
  type: "text" | "image";
  content: string;
  paragraphs?: string[];
  source_image?: string;
  page?: number;
  block_ids: string[];
  s3_node: string;
  observations?: string[];
  source_url?: string;
};

export type ImageBlock = {
  block_id: string;
  image_s3: string;
  page: number;
};

export type ImageChunk = {
  chunk_id: string;
  document_id: string;
  type: "image";
  content: string;
  observations: string[];
  page: number;
  source_image: string;
  s3_node: string;
  block_ids: string[];
};

export type PipelineError = {
  stage: string;
  message: string;
  url?: string;
  document_id?: string;
  cause?: unknown;
};

export type GraphState = {
  outputUrls: string[];
  contextUrls?: string[];
  researchContext?: string;
  userId?: string;
  projectId?: string;
  summary?: string;
  imageDocumentId?: string;
  imageBlocks: ImageBlock[];
  documents: Document[];
  chunks: Chunk[];
  imageChunks: ImageChunk[];
  insights: Insight[];
  sourceTextByS3Node: Record<string, string>;
  errors: PipelineError[];
};
