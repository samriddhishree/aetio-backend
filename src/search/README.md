# DynamoDB Cheap-First Search Layer

This module implements iterative hierarchical search over insights using DynamoDB-only access.

## Recommended Temporary GSIs

1. `GSI_UserId`
- Partition key: `user_id`
- Sort key: `insight_id`
- Purpose: fast user-scoped seed retrieval.

2. `GSI_DocumentId`
- Partition key: `document_id`
- Sort key: `insight_id`
- Purpose: document-local retrieval and ranking.

3. `GSI_ParentInsightId`
- Partition key: `parent_insight_id`
- Sort key: `insight_id`
- Purpose: hierarchy expansion (parent -> children).

4. `GSI_Status` (optional)
- Partition key: `status`
- Sort key: `insight_id`
- Purpose: status-scoped searches.

5. `GSI_UserStatus` (optional)
- Partition key: `user_id`
- Sort key: `status`
- Purpose: cheap combined `user_id + status` retrieval.

## What To Swap When Moving To OpenSearch

- Replace direct scoring in `service.ts` (keyword + metadata scoring) with OpenSearch query scoring.
- Replace `fetchStageACandidates` seed retrieval with OpenSearch candidate retrieval.
- Keep hierarchy expansion (`expandHierarchyContext`) and result shaping since those still provide context-rich graph output.
- Keep `InsightSearchRepository` methods for parent/ancestor hydration if hierarchy remains in DynamoDB.
