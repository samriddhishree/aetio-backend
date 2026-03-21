import { InsightSearchRepository } from "./repository";
import { InsightSearchService } from "./service";

export async function searchInsightsExample(): Promise<void> {
  const repository = new InsightSearchRepository();
  const service = new InsightSearchService(repository);

  const result = await service.searchInsights({
    query: "churn reduction strategy enterprise",
    filters: {
      user_id: "user-123",
      document_id: "doc-abc",
      status: "Accepted",
      metadata: [
        { tag: "region", value: "north america" },
        { tag: "segment", value: "enterprise" },
      ],
    },
    pagination: {
      limit: 20,
    },
    include_ancestors: true,
    include_descendants: true,
    ancestor_depth: 2,
    descendant_depth: 1,
  });

  console.log("searchInsightsExample", JSON.stringify(result, null, 2));
}
