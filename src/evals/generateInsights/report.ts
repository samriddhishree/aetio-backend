import {
  listExtractionTracesByProject,
  listExtractionTracesByRun,
  listReviewEventsByProject,
} from "../../common/services/insightEvaluationTable";
import { summarizeEvaluation } from "./summary";

export async function buildEvaluationSummaryReport(input: {
  projectId?: string;
  runId?: string;
}) {
  const traces = input.runId
    ? await listExtractionTracesByRun(input.runId)
    : input.projectId
      ? await listExtractionTracesByProject(input.projectId)
      : [];
  const reviewEvents = input.projectId ? await listReviewEventsByProject(input.projectId) : [];

  const deltas = reviewEvents
    .filter((event): event is typeof event & { delta: NonNullable<typeof event.delta> } => Boolean(event.delta))
    .map((event) => ({
      ...event.delta,
      insight_id: event.insight_id,
    }));

  return summarizeEvaluation({
    deltas,
    traces,
  });
}
