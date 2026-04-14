import { Annotation } from "@langchain/langgraph";
import type {
  DimensionMetadata,
  Finding,
  GenerateInsightsV2State,
  InsightFamily,
  InsightFamilyData,
  NormalizedResearchContext,
  InsightInstanceRow,
  V2Chunk,
  V2DocumentDescriptor,
  V2ExtractedDocument,
  V2NormalizedDocument,
  V2Table,
} from "./types";
import type { PipelineError, UserInfo } from "../types";

const mergeArray = <T>(left: T[], right: T[]) => left.concat(right);
const overwrite = <T>(left: T, right: T) => right ?? left;

export const GenerateInsightsV2StateAnnotation = Annotation.Root({
  sourceUris: Annotation<string[]>({ value: mergeArray, default: () => [] }),
  outputUrls: Annotation<string[] | undefined>({ value: overwrite, default: () => undefined }),
  contextUrls: Annotation<string[] | undefined>({ value: overwrite, default: () => undefined }),
  rawDataUrls: Annotation<string[] | undefined>({ value: overwrite, default: () => undefined }),
  researchContext: Annotation<string | undefined>({ value: overwrite, default: () => undefined }),
  uploadMode: Annotation<"document" | "manual" | undefined>({
    value: overwrite,
    default: () => undefined,
  }),
  userInfo: Annotation<UserInfo | undefined>({ value: overwrite, default: () => undefined }),
  normalizedResearchContext: Annotation<NormalizedResearchContext | undefined>({
    value: overwrite,
    default: () => undefined,
  }),
  userId: Annotation<string | undefined>({ value: overwrite, default: () => undefined }),
  projectId: Annotation<string | undefined>({ value: overwrite, default: () => undefined }),
  organizationId: Annotation<string | undefined>({ value: overwrite, default: () => undefined }),
  status: Annotation<string | undefined>({ value: overwrite, default: () => undefined }),
  documents: Annotation<V2DocumentDescriptor[]>({ value: overwrite, default: () => [] }),
  extractedDocuments: Annotation<V2ExtractedDocument[]>({ value: overwrite, default: () => [] }),
  normalizedDocuments: Annotation<V2NormalizedDocument[]>({ value: overwrite, default: () => [] }),
  chunks: Annotation<V2Chunk[]>({ value: overwrite, default: () => [] }),
  tables: Annotation<V2Table[]>({ value: overwrite, default: () => [] }),
  findings: Annotation<Finding[]>({ value: overwrite, default: () => [] }),
  validatedFindings: Annotation<Finding[]>({ value: overwrite, default: () => [] }),
  metadataFilters: Annotation<string[]>({ value: overwrite, default: () => [] }),
  dimensionMetadata: Annotation<DimensionMetadata[]>({ value: overwrite, default: () => [] }),
  insightFamilies: Annotation<InsightFamily[]>({ value: overwrite, default: () => [] }),
  insightRows: Annotation<InsightInstanceRow[]>({ value: overwrite, default: () => [] }),
  insightFamilyData: Annotation<InsightFamilyData[]>({ value: overwrite, default: () => [] }),
  persistedFamilyCounts: Annotation<
    { created: number; updated: number; deleted: number } | undefined
  >({ value: overwrite, default: () => undefined }),
  persistedInsightFamilyDataCounts: Annotation<
    { created: number; updated: number; deleted: number } | undefined
  >({ value: overwrite, default: () => undefined }),
  persistedDimensionMetadataCounts: Annotation<
    { created: number; updated: number; deleted: number } | undefined
  >({ value: overwrite, default: () => undefined }),
  errors: Annotation<PipelineError[]>({ value: mergeArray, default: () => [] }),
});

export const emptyGenerateInsightsV2State = (
  input: {
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
  },
): GenerateInsightsV2State => ({
  sourceUris: input.sourceUris,
  outputUrls: input.outputUrls,
  contextUrls: input.contextUrls,
  rawDataUrls: input.rawDataUrls,
  researchContext: input.researchContext,
  uploadMode: input.uploadMode,
  userInfo: input.userInfo,
  normalizedResearchContext: undefined,
  userId: input.userId,
  projectId: input.projectId,
  organizationId: input.organizationId,
  status: input.status,
  documents: [],
  extractedDocuments: [],
  normalizedDocuments: [],
  chunks: [],
  tables: [],
  findings: [],
  validatedFindings: [],
  metadataFilters: [],
  dimensionMetadata: [],
  insightFamilies: [],
  insightRows: [],
  insightFamilyData: [],
  persistedFamilyCounts: undefined,
  persistedInsightFamilyDataCounts: undefined,
  persistedDimensionMetadataCounts: undefined,
  errors: [],
});
