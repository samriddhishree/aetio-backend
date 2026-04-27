import type {
  Insight,
  InsightTagEntry,
  InsightMetadataEntry,
  PipelineError,
  UserInfo,
} from "../types";
import type {
  DimensionMetadata,
  InsightFamilyData,
  InsightFamilyDataRow,
  SupportingRef,
  V2Chunk,
  V2DocumentDescriptor,
  V2ExtractedDocument,
  V2Table,
} from "../generate-insights-v2/types";
import type {
  ImpliedGridResult,
  RawTable,
  TableSemanticObject,
} from "../services/tableUnderstandingClient";

export type ApprovalStatus =
  | "pending"
  | "approved_pr"
  | "approved_legal"
  | "approved_both"
  | "not_required";

export type SharingScope =
  | "internal_restricted"
  | "internal_all"
  | "external_restricted"
  | "public";

export type GenerateInsightsV3Arguments = {
  // v1-compatible inputs
  outputUrls?: string[];
  contextUrls?: string[];
  rawDataUrls?: string[];
  researchContext?: string;
  researchObjective?: string;
  methodology?: string;
  additionalContext?: string;
  analysisStartDate?: string;
  analysisEndDate?: string;
  owner?: string;
  relatedProjects?: string;
  approvalStatus?: ApprovalStatus;
  sharingScope?: SharingScope;
  uploadMode?: "document" | "manual";
  userInfo?: UserInfo;
  user_info?: UserInfo;
  image_blocks?: Array<{ block_id: string; image_s3: string; page: number }>;
  document_id?: string;

  // v3 alias input
  sourceUris?: string[];

  // auth/scoping
  userId?: string;
  projectId?: string;
  organizationId?: string;
  status?: string;
};

export type GenerateInsightsV3Event = {
  arguments: GenerateInsightsV3Arguments;
};

export type GenerateInsightsV3Input = {
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

export type V3DocumentBundle = {
  descriptor: V2DocumentDescriptor;
  extracted?: V2ExtractedDocument;
  chunks: V2Chunk[];
  tables: V2Table[];
};

export type ParsedFileContent = {
  document: V2DocumentDescriptor;
  extracted?: V2ExtractedDocument;
  text_blocks: V2Chunk[];
  tables: V2Table[];
  raw_tables: RawTable[];
  implied_grid_results: ImpliedGridResult[];
  table_semantic_objects: TableSemanticObject[];
  figure_captions: string[];
  headings: string[];
};

export type CandidateGrid = {
  grid_id: string;
  document_id: string;
  source_uri: string;
  table: V2Table;
  raw_table?: RawTable;
  table_semantic_object?: TableSemanticObject;
  source_mode: "table_element" | "text_block" | "narrative_implied";
  confidence: number;
  rationale: string;
};

export type GridContext = {
  grid_id: string;
  page?: number;
  section_title?: string;
  headings: string[];
  captions: string[];
  nearby_paragraphs: string[];
  supporting_refs: SupportingRef[];
  combined_context_text: string;
};

export type ExplicitInsightResult = {
  found_explicit_insight: boolean;
  insight_text?: string;
  supporting_snippets: string[];
  confidence: number;
  reasoning: string;
};

export type SynthesizedInsightResult = {
  insight_text: string;
  question_answered?: string;
  confidence: number;
  reasoning: string;
};

export type GridRowDraft = {
  row_id: string;
  filter_values: Array<{
    dimension_name: string;
    value: string;
    display_value?: string;
  }>;
  metric_name?: string;
  metric_value?: number | string;
  metric_unit?: string;
  value_text: string;
  supporting_refs: SupportingRef[];
};

export type NormalizedGridDraft = {
  table_id: string;
  family_id: string;
  question_answered?: string;
  dimensions: string[];
  metric_columns: string[];
  row_count: number;
  rows: GridRowDraft[];
  raw_table?: RawTable;
  table_semantic_object?: TableSemanticObject;
  table_understanding_summary?: unknown;
  source_modalities?: Array<"text" | "table" | "image">;
  table_markdown?: string;
  table_text_chunk?: string;
};

export type NormalizedGridResult = {
  insightFamilyData: InsightFamilyData;
  dimensionMetadata: DimensionMetadata[];
};

export type InsightSourceMode = "explicit_nearby_text" | "synthesized_from_grid";

export type GenerateInsightsV3Insight = Insight & {
  metadata: InsightMetadataEntry[];
  tags: InsightTagEntry[];
  dimension_metadata: DimensionMetadata[];
  insightfamilydata: InsightFamilyData;
  insight_source_mode?: InsightSourceMode;
};

export type GenerateInsightsV3Response = {
  documents: Array<{
    document_id: string;
    source_uri: string;
    file_type: string;
  }>;
  insights: GenerateInsightsV3Insight[];
  insight_family_data: InsightFamilyData[];
  dimension_metadata: DimensionMetadata[];
  errors: PipelineError[];
};

export type AgentActionName =
  | "parse_file"
  | "find_candidate_grids"
  | "select_next_grid"
  | "inspect_grid_context"
  | "extract_explicit_insight"
  | "synthesize_insight"
  | "normalize_grid"
  | "normalize_dimension_metadata"
  | "build_insight_metadata"
  | "build_insight_tags"
  | "validate_insight"
  | "complete_grid"
  | "finish_document";

export type AgentAction = {
  action: AgentActionName;
  reason: string;
};

export type AgentTraceStep = {
  step: number;
  action: AgentActionName;
  reason: string;
  grid_id?: string;
};

export type GridWorkState = {
  grid: CandidateGrid;
  insightId?: string;
  context?: GridContext;
  explicitInsight?: ExplicitInsightResult;
  synthesizedInsight?: SynthesizedInsightResult;
  normalizedGridDraft?: NormalizedGridDraft;
  normalizedGrid?: NormalizedGridResult;
  metadata?: InsightMetadataEntry[];
  tags?: InsightTagEntry[];
  candidateInsightText?: string;
  candidateQuestionAnswered?: string;
  insightSourceMode?: InsightSourceMode;
  validationErrors?: string[];
  validationWarnings?: string[];
  validatedInsight?: GenerateInsightsV3Insight;
};

export type GenerateInsightsV3AgentState = {
  document: V2DocumentDescriptor;
  parsedContent?: ParsedFileContent;
  candidateGrids: CandidateGrid[];
  candidateGridDiscoveryDone: boolean;
  pendingGridIds: string[];
  processedGridIds: string[];
  activeGridId?: string;
  gridWorkById: Map<string, GridWorkState>;
  insights: GenerateInsightsV3Insight[];
  trace: AgentTraceStep[];
  steps: number;
};

export type GenerateInsightsV3Toolset = {
  parseFile: (bundle: V3DocumentBundle) => Promise<ParsedFileContent>;
  understandTable: (table: RawTable) => Promise<TableSemanticObject>;
  extractImpliedGrid: (input: {
    document_id: string;
    chunk_id: string;
    text: string;
    page?: number;
    context?: string;
  }) => Promise<ImpliedGridResult>;
  findCandidateGrids: (parsed: ParsedFileContent) => Promise<CandidateGrid[]>;
  inspectGridContext: (grid: CandidateGrid, parsed: ParsedFileContent) => Promise<GridContext>;
  extractExplicitInsight: (
    grid: CandidateGrid,
    context: GridContext,
  ) => Promise<ExplicitInsightResult>;
  synthesizeInsightFromGrid: (
    grid: CandidateGrid,
    context: GridContext,
  ) => Promise<SynthesizedInsightResult>;
  normalizeGrid: (
    grid: CandidateGrid,
    familyId: string,
  ) => Promise<NormalizedGridDraft>;
  normalizeDimensionMetadata: (
    draft: NormalizedGridDraft,
  ) => Promise<NormalizedGridResult>;
  buildInsightMetadata: (input: {
    insightText: string;
    context: GridContext;
    grid: NormalizedGridResult;
    sourceMode: InsightSourceMode;
  }) => Promise<InsightMetadataEntry[]>;
  buildInsightTags: (input: {
    insightText: string;
    context: GridContext;
    grid: NormalizedGridResult;
    sourceMode: InsightSourceMode;
    metadata: InsightMetadataEntry[];
  }) => Promise<InsightTagEntry[]>;
  validateInsight: (insight: GenerateInsightsV3Insight) => Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
    insight?: GenerateInsightsV3Insight;
  }>;
  decideNextAction: (state: GenerateInsightsV3AgentState) => Promise<AgentAction>;
};

export type GenerateInsightsV3AgentDependencies = Partial<GenerateInsightsV3Toolset>;

export type GenerateInsightsV3PersistenceInput = {
  insights: GenerateInsightsV3Insight[];
  documents: V2DocumentDescriptor[];
  userId?: string;
  projectId?: string;
  organizationId?: string;
  status?: string;
};

export type GenerateInsightsV3RunResult = GenerateInsightsV3Response & {
  project_id?: string;
};

export type GridRowCompletenessStats = {
  row_count: number;
  rows_with_dimensions: number;
  metric_only_rows: number;
  missing_dimension_rows: number;
};

export type MinimalInsightValidationInput = {
  text: string;
  insightfamilydata: InsightFamilyData;
  dimension_metadata: DimensionMetadata[];
  metadata: InsightMetadataEntry[];
  tags: InsightTagEntry[];
};

export type V3OpenAiChatResponseFormat = {
  type: "json_schema";
  json_schema: {
    name: string;
    schema: Record<string, unknown>;
    strict: true;
  };
};

export type GridRowWithContext = InsightFamilyDataRow;
