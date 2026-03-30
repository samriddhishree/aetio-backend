import { config } from "../../common/services/config";
import { hashId } from "../../common/services/utils";
import type { Finding, FindingBatch, GraphState } from "../../types";

const DEFAULT_BATCH_SIZE = 12;
const MAX_BATCH_SIZE = 20;
const MIN_BATCH_SIZE = 5;
const LOCALITY_GAP_THRESHOLD = 8;

type FindingWithOrder = {
  finding: Finding;
  originalIndex: number;
  localityIndex: number;
};

function sanitizeBatchSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_BATCH_SIZE;
  return Math.max(MIN_BATCH_SIZE, Math.min(MAX_BATCH_SIZE, Math.floor(size)));
}

function getFindingLocalityIndex(
  finding: Finding,
  chunkOrderById: Map<string, number>,
): number {
  const indexes = finding.supporting_chunks
    .map((ref) => chunkOrderById.get(ref.chunk_id))
    .filter((index): index is number => typeof index === "number");
  if (indexes.length === 0) return Number.MAX_SAFE_INTEGER;
  return Math.min(...indexes);
}

function buildBatchesForDocument(
  documentId: string,
  orderedFindings: FindingWithOrder[],
  batchSize: number,
): FindingBatch[] {
  const batches: FindingBatch[] = [];
  let current: FindingWithOrder[] = [];
  let batchIndex = 0;

  const flush = () => {
    if (current.length === 0) return;
    const findings = current.map((item) => item.finding);
    batches.push({
      batch_id: hashId(`${documentId}:finding-batch:${batchIndex}`),
      findings,
    });
    batchIndex += 1;
    current = [];
  };

  for (const item of orderedFindings) {
    const previous = current[current.length - 1];
    const localityGap =
      previous && item.localityIndex !== Number.MAX_SAFE_INTEGER
      && previous.localityIndex !== Number.MAX_SAFE_INTEGER
        ? item.localityIndex - previous.localityIndex
        : 0;

    // Keep V1 deterministic and practical:
    // - cap by configured batch size
    // - split on large locality jumps to preserve source adjacency when possible
    if (current.length >= batchSize || localityGap > LOCALITY_GAP_THRESHOLD) {
      flush();
    }
    current.push(item);
  }

  flush();
  return batches;
}

export class FindingBatchingAgent {
  constructor(private readonly defaultBatchSize = sanitizeBatchSize(config.findingBatchSize)) {}

  // Reuses existing finding ordering signals (document + chunk references) and keeps batching
  // deterministic so downstream extraction can run in bounded LLM calls.
  async process(state: GraphState): Promise<Partial<GraphState>> {
    console.log("FindingBatchingAgent:size", state.insights?.length ?? 0);
    const batchSize = sanitizeBatchSize(this.defaultBatchSize);
    console.debug("FindingBatchingAgent:start", {
      findings: state.findings.length,
      batchSize,
    });

    if (state.findings.length === 0) {
      return { finding_batches: [] };
    }

    const chunkOrderById = new Map(state.chunks.map((chunk, index) => [chunk.chunk_id, index]));
    const findingsByDocument = new Map<string, FindingWithOrder[]>();

    for (const [index, finding] of state.findings.entries()) {
      const list = findingsByDocument.get(finding.document_id) ?? [];
      list.push({
        finding,
        originalIndex: index,
        localityIndex: getFindingLocalityIndex(finding, chunkOrderById),
      });
      findingsByDocument.set(finding.document_id, list);
    }

    const batches: FindingBatch[] = [];
    for (const [documentId, findings] of findingsByDocument.entries()) {
      const ordered = findings.sort((left, right) => {
        if (left.localityIndex !== right.localityIndex) {
          return left.localityIndex - right.localityIndex;
        }
        return left.originalIndex - right.originalIndex;
      });
      batches.push(...buildBatchesForDocument(documentId, ordered, batchSize));
    }

    console.debug("FindingBatchingAgent:end", {
      findings: state.findings.length,
      batches: batches.length,
    });
    return { finding_batches: batches };
  }
}

export const findingBatchingAgent = new FindingBatchingAgent();
