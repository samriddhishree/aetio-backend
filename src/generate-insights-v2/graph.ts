import { StateGraph } from "@langchain/langgraph";
import { assertConfig } from "../common/services/config";
import { documentIntakeNode } from "./nodes/documentIntake";
import { contentExtractionNode } from "./nodes/contentExtraction";
import { normalizeContentNode } from "./nodes/normalizeContent";
import { extractFindingsNode } from "./nodes/extractFindings";
import { critiqueFindingsNode } from "./nodes/critiqueFindings";
import { extractMetadataDimensionsNode } from "./nodes/extractMetadataDimensions";
import { preprocessResearchContextNode } from "./nodes/preprocessResearchContext";
import { groupInsightFamiliesNode } from "./nodes/groupInsightFamilies";
import { buildInsightFamilyDataNode } from "./nodes/buildInsightFamilyData";
import { validateInsightFamilyDataNode } from "./nodes/validateInsightFamilyData";
import { finalValidationNode } from "./nodes/finalValidation";
import { persistSearchableFamiliesNode } from "./nodes/persistSearchableFamilies";
import { emptyGenerateInsightsV2State, GenerateInsightsV2StateAnnotation } from "./state";
import type {
  GenerateInsightsV2MetadataPrepassResponse,
  GenerateInsightsV2Input,
  GenerateInsightsV2Response,
  GenerateInsightsV2State,
} from "./types";

const START = "__start__";
const END = "__end__";

/**
 * generate-insights-v2 node responsibilities:
 *
 * 1) DocumentIntake
 * - Accepts incoming S3/source URIs.
 * - Detects file type and builds canonical document descriptors.
 * - Produces routing metadata for downstream extraction.
 *
 * 2) ContentExtraction
 * - Loads source files (S3/http) and parses content via Unstructured.
 * - Preserves element-level provenance (page/section/type/sheet metadata when available).
 * - Emits raw extracted elements per document.
 *
 * 3) Normalization
 * - Converts extracted elements into canonical internal objects:
 *   - text chunks
 *   - tables (headers/rows/raw text)
 * - Keeps text and tables as first-class separate objects.
 *
 * 4) MetadataDimensionExtraction
 * - Extracts candidate dimensions from normalized tables.
 * - Normalizes/merges candidates into canonical reusable dimension metadata.
 * - Produces family filter candidates from canonical metadata dimensions.
 *
 * 5) FindingExtraction
 * - Generates atomic, evidence-grounded findings from normalized chunks/tables.
 * - Preserves quantitative detail and dimensions where present.
 * - Attaches supporting refs to every finding.
 *
 * 6) FindingCritique
 * - Applies deterministic quality checks (support, duplicates, vagueness, numeric mismatch).
 * - Applies optional semantic critique for additional pruning.
 * - Produces validated findings.
 *
 * 7) ResearchContextPreprocess
 * - Normalizes optional researchContext into a short guidance lens:
 *   - short_summary
 *   - key_topics
 *   - key_questions
 * - Empty context is skipped.
 *
 * 8) FamilyGrouping
 * - Groups related findings into insight families.
 * - Ensures each family is grounded in supporting finding IDs.
 * - Produces searchable family descriptions:
 *   - family_text (generalized reusable insight statement)
 *   - question_answered (user-meaningful analytical question)
 * - Carries family-level filter tags and optional summary text.
 *
 * 9) InsightFamilyDataBuilder
 * - Determines if each family implies a renderable grid.
 * - Infers dimensions + metric columns and builds normalized rows.
 * - Persists all normalized evidence-grounded rows per family.
 * - Rows reference reusable dimension/value metadata IDs when possible.
 *
 * 10) InsightFamilyDataValidation
 * - Deterministically validates insight family data:
 *   - row evidence
 *   - dimension alignment
 *   - duplicate key handling
 *   - family/table linkage consistency
 * - Marks families non-tabular when table validation fails.
 *
 * 11) FinalValidation
 * - Enforces final grounding constraints:
 *   - families must reference existing validated findings
 *   - family_text and question_answered must be non-empty and strong
 *   - filters must be supported by finding dimensions
 *   - each family must be complete: has_grid=false OR linked persisted-ready table
 * - Drops unsupported families before response formatting.
 *
 * 12) PersistSearchableFamilies
 * - Persists only the search-relevant family semantic layer to DynamoDB.
 * - Persists normalized insight family data to DynamoDB via separate scope.
 * - Persists/upserts reusable dimension metadata records.
 * - Synchronizes corresponding OpenSearch docs with explicit CRUD behavior:
 *   - create -> index
 *   - update -> upsert
 *   - delete -> delete
 * - Intentionally avoids indexing full row payloads in OpenSearch.
 */
export function buildGenerateInsightsV2Graph() {
  return new StateGraph(GenerateInsightsV2StateAnnotation)
    .addNode("DocumentIntake", documentIntakeNode)
    .addNode("ContentExtraction", contentExtractionNode)
    .addNode("Normalization", normalizeContentNode)
    .addNode("MetadataDimensionExtraction", extractMetadataDimensionsNode)
    .addNode("FindingExtraction", extractFindingsNode)
    .addNode("FindingCritique", critiqueFindingsNode)
    .addNode("ResearchContextPreprocess", preprocessResearchContextNode)
    .addNode("FamilyGrouping", groupInsightFamiliesNode)
    .addNode("InsightFamilyDataBuilder", buildInsightFamilyDataNode)
    .addNode("InsightFamilyDataValidation", validateInsightFamilyDataNode)
    .addNode("FinalValidation", finalValidationNode)
    .addNode("PersistSearchableFamilies", persistSearchableFamiliesNode)
    .addEdge(START, "DocumentIntake")
    .addEdge("DocumentIntake", "ContentExtraction")
    .addEdge("ContentExtraction", "Normalization")
    .addEdge("Normalization", "MetadataDimensionExtraction")
    .addEdge("MetadataDimensionExtraction", "FindingExtraction")
    .addEdge("FindingExtraction", "FindingCritique")
    .addEdge("FindingCritique", "ResearchContextPreprocess")
    .addEdge("ResearchContextPreprocess", "FamilyGrouping")
    .addEdge("FamilyGrouping", "InsightFamilyDataBuilder")
    .addEdge("InsightFamilyDataBuilder", "InsightFamilyDataValidation")
    .addEdge("InsightFamilyDataValidation", "FinalValidation")
    .addEdge("FinalValidation", "PersistSearchableFamilies")
    .addEdge("PersistSearchableFamilies", END)
    .compile();
}

export function buildGenerateInsightsV2MetadataPrepassGraph() {
  return new StateGraph(GenerateInsightsV2StateAnnotation)
    .addNode("DocumentIntake", documentIntakeNode)
    .addNode("ContentExtraction", contentExtractionNode)
    .addNode("Normalization", normalizeContentNode)
    .addNode("MetadataDimensionExtraction", extractMetadataDimensionsNode)
    .addEdge(START, "DocumentIntake")
    .addEdge("DocumentIntake", "ContentExtraction")
    .addEdge("ContentExtraction", "Normalization")
    .addEdge("Normalization", "MetadataDimensionExtraction")
    .addEdge("MetadataDimensionExtraction", END)
    .compile();
}

export function toGenerateInsightsV2Response(
  state: GenerateInsightsV2State,
): GenerateInsightsV2Response {
  return {
    documents: state.documents.map((document) => ({
      document_id: document.document_id,
      source_uri: document.source_uri,
      file_type: document.file_type,
    })),
    findings: state.validatedFindings,
    insight_families: state.insightFamilies,
    insight_rows: state.insightRows,
    insight_family_data: state.insightFamilyData,
    dimension_metadata: state.dimensionMetadata,
  };
}

export function toGenerateInsightsV2MetadataPrepassResponse(
  state: GenerateInsightsV2State,
): GenerateInsightsV2MetadataPrepassResponse {
  return {
    documents: state.documents.map((document) => ({
      document_id: document.document_id,
      source_uri: document.source_uri,
      file_type: document.file_type,
    })),
    tables: state.tables,
    metadata_filters: state.metadataFilters,
    dimension_metadata: state.dimensionMetadata,
  };
}

export async function runGenerateInsightsV2Pipeline(
  input: GenerateInsightsV2Input,
): Promise<GenerateInsightsV2State> {
  assertConfig();
  const graph = buildGenerateInsightsV2Graph();

  console.info("[generate-insights-v2] graph invoke start", {
    sourceUris: input.sourceUris.length,
    contextUrls: input.contextUrls?.length ?? 0,
    hasResearchContext: Boolean(input.researchContext?.trim()),
  });

  const result = await graph.invoke(emptyGenerateInsightsV2State(input));

  console.info("[generate-insights-v2] graph invoke completed", {
    documents: result.documents.length,
    findings: result.validatedFindings.length,
    families: result.insightFamilies.length,
    rows: result.insightRows.length,
    insightFamilyData: result.insightFamilyData.length,
    dimensionMetadata: result.dimensionMetadata.length,
    persistedFamilyCounts: result.persistedFamilyCounts,
    persistedInsightFamilyDataCounts: result.persistedInsightFamilyDataCounts,
    persistedDimensionMetadataCounts: result.persistedDimensionMetadataCounts,
    errors: result.errors.length,
  });

  return result;
}

export async function runGenerateInsightsV2MetadataPrepassPipeline(
  input: GenerateInsightsV2Input,
): Promise<GenerateInsightsV2State> {
  assertConfig();
  const graph = buildGenerateInsightsV2MetadataPrepassGraph();

  console.info("[generate-insights-v2-prepass] graph invoke start", {
    sourceUris: input.sourceUris.length,
    contextUrls: input.contextUrls?.length ?? 0,
    hasResearchContext: Boolean(input.researchContext?.trim()),
  });

  const result = await graph.invoke(emptyGenerateInsightsV2State(input));

  console.info("[generate-insights-v2-prepass] graph invoke completed", {
    documents: result.documents.length,
    tables: result.tables.length,
    metadataFilters: result.metadataFilters.length,
    dimensionMetadata: result.dimensionMetadata.length,
    errors: result.errors.length,
  });

  return result;
}
