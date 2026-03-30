type Status = {
  ACCEPTED: string;
  DECLINED: string;
  COMPLETED: string;
  PENDING: string;
}

export type InsightMetadataEntry = {
  tag: string;
  value: string;
  confidence?: number;
};

export type InsightConfidence = {
  score: number;
  reasoning: string;
};

export type UserInfo = {
  full_name?: string;
  email_address?: string;
};

export type SupportingChunkRef = {
  chunk_id: string;
  paragraph_index?: number;
  line_index?: number;
};

export type FindingEvidenceType = "quantitative" | "qualitative" | "mixed";

export type Insight = {
  insight_id: string;
  parent_insight_id?: string | null;
  project_id?: string;
  createdAt?: string;
  updatedAt?: string;
  text: string;
  supporting_chunks?: SupportingChunkRef[];
  findings?: FindingRef[];
  metadata?: InsightMetadataEntry[];
  confidence?: InsightConfidence;
  additional_refs?: unknown;
  user_id?: string;
  user_info?: UserInfo;
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

export type Finding = {
  finding_id: string;
  text: string;
  evidence_snipped: string;
  evidence_type: FindingEvidenceType;
  supporting_chunks: SupportingChunkRef[];
  document_id: string;
  s3_node: string;
  metric?: string;
  value?: string;
  comparison?: string;
  segment?: string;
  timeframe?: string;
};

export type FindingBatch = {
  batch_id: string;
  findings: Finding[];
};

export type BatchInsightResult = {
  batch_id: string;
  insights: Insight[];
};

export type FindingRef = {
  finding_id: string;
  text?: string;
  evidence_snipped?: string;
  evidence_type?: string;
  supporting_chunks?: SupportingChunkRef[];
  document_id?: string;
  s3_node?: string;
  metric?: string;
  value?: string;
  comparison?: string;
  segment?: string;
  timeframe?: string;
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
  userInfo?: UserInfo;
  projectId?: string;
  summary?: string;
  imageDocumentId?: string;
  imageBlocks: ImageBlock[];
  documents: Document[];
  chunks: Chunk[];
  findings: Finding[];
  finding_batches: FindingBatch[];
  batch_insights: BatchInsightResult[];
  imageChunks: ImageChunk[];
  insights: Insight[];
  sourceTextByS3Node: Record<string, string>;
  errors: PipelineError[];
};

export type MetadataFilter = {
  tag: string;
  value?: string;
};

export type SearchFilters = {
  user_id?: string;
  document_id?: string;
  status?: string;
  parent_insight_id?: string;
  metadata?: MetadataFilter[];
};

export type SearchPagination = {
  limit?: number;
  cursor?: string;
};

export type SearchQuery = {
  query: string;
  filters?: SearchFilters;
  pagination?: SearchPagination;
  include_ancestors?: boolean;
  include_descendants?: boolean;
  ancestor_depth?: number;
  descendant_depth?: number;
};

export type MatchType = "primary" | "context";

export type SearchResultItem = {
  insight: Insight;
  score: number;
  match_type: MatchType;
  reasons: string[];
  distance_from_primary?: number;
  related_primary_ids: string[];
};

export type SearchResult = {
  query: string;
  total: number;
  count: number;
  next_cursor?: string;
  items: SearchResultItem[];
  candidates_considered: number;
  primary_results: Insight[];
  contextual_results: Insight[];
  explored_paths: SearchExploredPath[];
  reasoning_summary: string;
  relevance_scores?: Record<string, number>;
};

export type SearchExploredPath = {
  step: number;
  action: string;
  insight_ids?: string[];
  rationale?: string;
};

export type RankedInsight = {
  insight: Insight;
  score: number;
  matchType: MatchType;
  reasons: string[];
  directScore: number;
  hierarchyBoost: number;
  distanceFromPrimary?: number;
  relatedPrimaryIds: Set<string>;
};

export type PaginationSlice<T> = {
  items: T[];
  nextCursor?: string;
};

export type SearchIndexConfig = {
  insightIdIndexName?: string;
  userIdIndexName: string;
  documentIdIndexName: string;
  parentInsightIdIndexName: string;
  statusIndexName?: string;
  userStatusIndexName?: string;
};
