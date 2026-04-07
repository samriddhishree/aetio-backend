import type { PipelineError, UserInfo } from "../types";

export type SourceFileType =
  | "pdf"
  | "xlsx"
  | "xls"
  | "csv"
  | "tsv"
  | "txt"
  | "html"
  | "json"
  | "unknown";

export type MetadataDimension = {
  tag: string;
  value: string;
};

export type SupportingRef = {
  chunk_id?: string;
  table_id?: string;
  page?: number;
  section_title?: string;
  row_index?: number;
  cell_refs?: string[];
  source_excerpt?: string;
  source_file?: string;
  element_type?: string;
  sheet_name?: string;
  table_region?: string;
};

export type Finding = {
  finding_id: string;
  text: string;
  metric_value?: string | number;
  metric_unit?: string;
  dimensions?: MetadataDimension[];
  confidence?: number;
  supporting_refs: SupportingRef[];
  source_modality: "text" | "table";
};

export type InsightFamily = {
  family_id: string;
  family_text: string;
  question_answered: string;
  user_info?: UserInfo;
  created_at?: string;
  expires_at?: string;
  filters: string[];
  summary?: string;
  has_grid?: boolean;
  insight_family_data_id?: string;
  row_count?: number;
  table_dimensions?: string[];
  metric_columns?: string[];
  supporting_finding_ids: string[];
};

export type InsightInstanceRow = {
  row_id: string;
  family_id: string;
  filter_values: MetadataDimension[];
  metric_name?: string;
  value_text: string;
  metric_value?: string | number;
  metric_unit?: string;
  supporting_refs: SupportingRef[];
};

export type InsightFamilyDataRow = InsightInstanceRow;

export type InsightFamilyData = {
  table_id: string;
  family_id: string;
  dimensions: string[];
  metric_columns: string[];
  row_count: number;
  rows: InsightFamilyDataRow[];
  source_modalities?: Array<"text" | "table" | "image">;
  created_at: string;
  updated_at: string;
};

export type NormalizedResearchContext = {
  short_summary: string;
  key_topics: string[];
  key_questions: string[];
};

export type GenerateInsightsV2Response = {
  documents: Array<{
    document_id: string;
    source_uri: string;
    file_type: string;
  }>;
  findings: Finding[];
  insight_families: InsightFamily[];
  insight_rows: InsightInstanceRow[];
  insight_family_data: InsightFamilyData[];
};

export type V2DocumentDescriptor = {
  document_id: string;
  source_uri: string;
  file_type: SourceFileType;
  file_name: string;
  content_type?: string;
};

export type V2ExtractedElement = {
  element_id: string;
  type: string;
  text: string;
  metadata: Record<string, unknown>;
};

export type V2ExtractedDocument = {
  document_id: string;
  source_uri: string;
  file_type: SourceFileType;
  content_type?: string;
  elements: V2ExtractedElement[];
};

export type V2NormalizedDocument = {
  document_id: string;
  source_uri: string;
  file_type: SourceFileType;
  content_type?: string;
};

export type V2Chunk = {
  chunk_id: string;
  document_id: string;
  source_uri: string;
  text: string;
  page?: number;
  section_title?: string;
  element_type: string;
  source_modality: "text";
};

export type V2TableRow = {
  row_index: number;
  cells: string[];
};

export type V2Table = {
  table_id: string;
  document_id: string;
  source_uri: string;
  page?: number;
  section_title?: string;
  element_type: string;
  sheet_name?: string;
  table_region?: string;
  raw_text: string;
  headers: string[];
  rows: V2TableRow[];
};

export type GenerateInsightsV2State = {
  sourceUris: string[];
  outputUrls?: string[];
  contextUrls?: string[];
  rawDataUrls?: string[];
  researchContext?: string;
  uploadMode?: "document" | "manual";
  userInfo?: UserInfo;
  normalizedResearchContext?: NormalizedResearchContext;
  userId?: string;
  projectId?: string;
  organizationId?: string;
  status?: string;
  documents: V2DocumentDescriptor[];
  extractedDocuments: V2ExtractedDocument[];
  normalizedDocuments: V2NormalizedDocument[];
  chunks: V2Chunk[];
  tables: V2Table[];
  findings: Finding[];
  validatedFindings: Finding[];
  metadataFilters: string[];
  insightFamilies: InsightFamily[];
  insightRows: InsightInstanceRow[];
  insightFamilyData: InsightFamilyData[];
  persistedFamilyCounts?: {
    created: number;
    updated: number;
    deleted: number;
  };
  persistedInsightFamilyDataCounts?: {
    created: number;
    updated: number;
    deleted: number;
  };
  errors: PipelineError[];
};

export type GenerateInsightsV2Input = {
  sourceUris: string[];
  outputUrls?: string[];
  contextUrls?: string[];
  rawDataUrls?: string[];
  researchContext?: string;
  uploadMode?: "document" | "manual";
  userInfo?: UserInfo;
  userId?: string;
  projectId?: string;
  organizationId?: string;
  status?: string;
};
