# Repository Evidence

Status definitions:

- **Implemented:** Executable code and a connected product/API path exist.
- **Prototype:** Executable code exists, but integration, deployment, or product adoption is not established.
- **Designed:** The repository documents or types the capability, but end-to-end behavior is not established.
- **Proposed:** Product or architecture hypothesis, not repository-proven behavior.

Paths are relative to the `aetio-backend` repository root; sibling services use `../aetio-search`, `../amplify-vite-aetio`, and `../aetio-table-understanding-service`.

| Slide | Claim | Status | Repository evidence | Confidence |
| --- | --- | --- | --- | --- |
| 1 | Aetio transforms analytical artifacts into structured, searchable insight objects. | Implemented prototype | `src/generate-insights-v2/graph.ts` (`toGenerateInsightsV2Response`); `src/generate-insights-v2/nodes/persistSearchableFamilies.ts`; `../aetio-search/src/search/v2/SearchV2Service.ts` | High |
| 1 | The presenter's role was product and technical lead. | Requires confirmation | No repository artifact establishes an individual's title or scope. | Low |
| 2 | The product accepts document-based analytical artifacts. | Implemented | `../amplify-vite-aetio/src/app/screens/data-source-connection/UploadResearchTab.tsx`; `../amplify-vite-aetio/src/app/api/storage.ts`; `src/common/services/document-loader.ts` | High |
| 2 | Fragmentation causes duplicated work and weak institutional memory. | Product-context claim | Supplied one-pager and PRFAQ; not independently demonstrated by repository behavior. | Medium |
| 3 | The system persists insight families rather than only returning chat answers. | Implemented | `src/generate-insights-v2/types.ts` (`InsightFamily`); `src/generate-insights-v2/services/familyPersistence.ts`; `src/common/services/dynamo.ts` | High |
| 3 | Insight families retain supporting evidence and source identifiers. | Implemented | `src/generate-insights-v2/types.ts` (`supporting_finding_ids`, `supporting_refs`, `document_ids`); `src/types.ts` (`supporting_chunks`, `s3_node`, `document_id`) | High |
| 3 | OpenSearch stores a family-level projection instead of full family row payloads. | Implemented | `src/generate-insights-v2/nodes/persistSearchableFamilies.ts`; `src/generate-insights-v2/services/familyPersistence.ts`; `README.md` persistence section | High |
| 4 | The frontend includes authenticated application routes. | Implemented on client | `../amplify-vite-aetio/src/routes.tsx`; `../amplify-vite-aetio/src/AuthGate.tsx`; `../amplify-vite-aetio/amplify/auth/resource.ts` | High |
| 4 | Uploads use Amplify Storage under an authenticated S3 prefix. | Implemented | `../amplify-vite-aetio/src/app/api/storage.ts`; `../amplify-vite-aetio/amplify/storage/resource.ts` | High |
| 4 | The frontend currently invokes `POST /generate-insights-v2`. | Implemented | `../amplify-vite-aetio/src/app/api/insights.ts` (`generateInsights`) | High |
| 4 | Reviewers can edit insight text/metadata/family data and accept or decline project insights. | Implemented | `../amplify-vite-aetio/src/app/screens/data-source-connection/ApprovalReviewPanel.tsx`; `src/index.ts` (`PATCH /insight/:insightId`, `PATCH /insight-family-data/:tableId`, `PATCH /insights/accept/:projectId`) | High |
| 4 | The frontend supports search, insight detail/tree, and Dive Deeper. | Implemented | `../amplify-vite-aetio/src/app/screens/SearchResults.tsx`; `../amplify-vite-aetio/src/app/screens/InsightDetail.tsx`; `../amplify-vite-aetio/src/app/components/DiveDeeperChat.tsx` | High |
| 5 | Cognito-backed email, Google, and optional SAML login are configured. | Implemented configuration | `../amplify-vite-aetio/amplify/auth/resource.ts` | High |
| 5 | The backend uses Unstructured for source parsing. | Implemented | `src/generate-insights-v2/nodes/contentExtraction.ts`; `src/common/services/document-loader.ts`; `src/common/services/config.ts` | High |
| 5 | The backend uses OpenAI in extraction, critique, and synthesis flows. | Implemented | `src/common/services/openai.ts`; `src/generate-insights-v2/prompts.ts`; `src/generate-insights-v3/tools.ts`; `../aetio-search/src/common/services/openai.ts` | High |
| 5 | DynamoDB is the record and OpenSearch is the retrieval projection. | Implemented architectural pattern | `src/common/services/dynamo.ts`; `src/generate-insights-v2/services/insightFamilyDataPersistence.ts`; `src/common/services/elasticsearch.ts`; `../aetio-search/src/search/v2/OpenSearchSearchRepository.ts` | High |
| 5 | Backend and search are configured for Elastic Beanstalk deployment. | Configuration present | `.elasticbeanstalk/config.yml`; `../aetio-search/.elasticbeanstalk/config.yml`; app-version artifacts in both repositories | High for configuration, low for current runtime status |
| 5 | The table-understanding service participates in v3 extraction. | Prototype integration | `src/services/tableUnderstandingClient.ts`; `src/generate-insights-v3/tableUnderstandingTools.ts`; `../aetio-table-understanding-service/app/main.py` | High for code, medium for deployed availability |
| 6 | Generate-insights-v2 is a 12-node LangGraph workflow. | Implemented | `src/generate-insights-v2/graph.ts` (`buildGenerateInsightsV2Graph`) | High |
| 6 | Finding critique checks support, duplicates, vagueness, and numeric mismatch, with optional semantic critique. | Implemented | `src/generate-insights-v2/nodes/critiqueFindings.ts`; graph responsibility comments in `src/generate-insights-v2/graph.ts` | High |
| 6 | Final validation removes unsupported or incomplete families. | Implemented | `src/generate-insights-v2/nodes/finalValidation.ts`; `src/generate-insights-v2/graph.ts` | High |
| 6 | `POST /generate-insights-v3` is the newest implemented extraction endpoint. | Implemented backend endpoint | `src/index.ts`; `src/generate-insights-v3/handler.ts`; `src/generate-insights-v3/agent.ts` | High |
| 6 | V3 is grid-first and uses bounded agent actions with validation and loop guards. | Implemented backend code | `src/generate-insights-v3/tools.ts` (`defaultPlanner`, `isActionAllowed`); `src/generate-insights-v3/agent.ts` (`MAX_ACTION_ATTEMPTS_PER_INPUT`, `runDocumentAgentOnBundle`) | High |
| 6 | V3 is not yet the frontend's generation path. | Implemented mismatch | Frontend calls v2 in `../amplify-vite-aetio/src/app/api/insights.ts`; v3 route exists in `src/index.ts` | High |
| 7 | Insight family data stores dimensions, metrics, rows, and row evidence. | Implemented | `src/generate-insights-v2/types.ts`; `src/generate-insights-v2/services/insightFamilyDataBuilder.ts`; `src/generate-insights-v2/services/insightFamilyDataPersistence.ts` | High |
| 7 | Canonical dimension metadata is persisted separately. | Implemented | `src/generate-insights-v2/services/metadataService.ts`; `src/generate-insights-v2/services/dimensionMetadataPersistence.ts`; `src/common/services/dimensionMetadataTable.ts` | High |
| 7 | Projects package insight IDs and review lifecycle state. | Implemented | `src/common/services/projectsTable.ts`; `src/index.ts` (`GET /projects`, `GET /projects/:projectId`) | High |
| 7 | Extraction traces and review events store model/prompt/pipeline lineage and reviewer deltas. | Implemented | `src/common/services/insightEvaluationTable.ts`; `src/evals/generateInsights/trace.ts`; `src/evals/generateInsights/review.ts`; `src/evals/generateInsights/types.ts` | High |
| 8 | `POST /search/v2` is the latest search endpoint. | Implemented | `../aetio-search/src/search/index.ts`; `../aetio-search/README.md` | High |
| 8 | Search v2 performs query understanding, OpenSearch retrieval, reranking, and bounded synthesis. | Implemented | `../aetio-search/src/search/v2/SearchV2Service.ts`; `QueryUnderstandingService.ts`; `OpenSearchSearchRepository.ts`; `CandidateReranker.ts`; `SearchSynthesisService.ts` | High |
| 8 | Search can orchestrate local, GWI, or both sources and isolate source failures. | Implemented | `../aetio-search/src/search/v2/sourceSearchOrchestrator.ts`; local and GWI handlers under `../aetio-search/src/search/v2/handlers/` | High |
| 8 | Dive Deeper v2 begins with deterministic local expansion, then allows selective tools. | Implemented | `../aetio-search/src/services/diveDeeper/DiveDeeperV2Controller.ts`; `LocalContextExpansionService.ts`; `DiveDeeperAgentService.ts` | High |
| 8 | Dive Deeper v2 constrains calls, results, retrieved insights, and turns. | Implemented | `../aetio-search/src/services/diveDeeper/DiveDeeperAgentService.ts` (`DEFAULT_OPTIONS`) | High |
| 9 | DynamoDB/OpenSearch synchronization is explicit create/update/delete behavior. | Implemented | `src/generate-insights-v2/nodes/persistSearchableFamilies.ts`; `src/generate-insights-v2/services/familyPersistence.ts` | High |
| 9 | The system intentionally mixes deterministic and agentic orchestration. | Implemented | V2 LangGraph in `src/generate-insights-v2/graph.ts`; v3 agent in `src/generate-insights-v3/agent.ts`; Dive Deeper agent in `../aetio-search/src/services/diveDeeper/DiveDeeperAgentService.ts` | High |
| 10 | The codebase evolved through UI/review, extraction, search, agent, and evaluation work. | Repository-history inference | Git history in the frontend, backend, and search repositories; versioned modules and endpoints | Medium |
| 10 | Tests exist for v2, v3, search, and table understanding. | Implemented | `src/generate-insights-v2/__tests__/`; `src/generate-insights-v3/__tests__/`; `../aetio-search/src/**/*.test.ts`; `../aetio-table-understanding-service/tests/` | High |
| 10 | Production adoption, SLOs, and business impact are not repository-verified. | Not verified | No repository evidence supplying production telemetry, active users, customer contracts, or impact metrics. | High |
| 11 | Data scientists, researchers, product managers, and strategy teams are target users. | Product hypothesis | Supplied one-pager and PRFAQ; the frontend workflows are consistent with these personas. | Medium |
| 11 | Platform, usage, and premium-enterprise pricing is a possible model. | Proposed | No pricing or revenue implementation/evidence in the repositories. | Low |
| 12 | A connected technical loop exists from upload through review and discovery. | Implemented prototype | Combined frontend, backend, and search evidence above. | High |
| 12 | Cross-document deduplication, evaluation scale, authorization parity, consistency, cost, and latency remain risks. | Inference and known gaps | TODOs in backend/search; separate record/index; no verified SLO or cost data; no golden benchmark found | High |
| A | The frontend Amplify backend defines auth and storage, not an AppSync data API. | Implemented configuration | `../amplify-vite-aetio/amplify/backend.ts` includes only `auth` and `storage` | High |
| A | Backend and search pipelines execute synchronously over HTTP. | Implemented | Express route handlers await pipeline/search completion in `src/index.ts` and `../aetio-search/src/search/index.ts`; no queue resource found | High |
| B | V2 uses fixed LangGraph edges. | Implemented | `src/generate-insights-v2/graph.ts` | High |
| B | V3 constrains planner actions and repeated attempts. | Implemented | `src/generate-insights-v3/tools.ts`; `src/generate-insights-v3/agent.ts` | High |
| C | The displayed endpoint list reflects current route registrations. | Implemented | `src/index.ts`; `../aetio-search/src/index.ts`; `../aetio-search/src/search/index.ts`; `../aetio-table-understanding-service/app/main.py` | High |
| D | Displayed schema fields are simplified from current TypeScript/Python models. | Implemented | `src/types.ts`; `src/generate-insights-v2/types.ts`; `src/evals/generateInsights/types.ts`; `../aetio-table-understanding-service/app/schemas.py` | High |
| E | Client-side Cognito authentication is configured. | Implemented | `../amplify-vite-aetio/amplify/auth/resource.ts`; `../amplify-vite-aetio/src/AuthGate.tsx` | High |
| E | API services verify JWT signatures and claims. | Not implemented | Backend `src/index.ts` (`decodeJwtPayload`) and search `../aetio-search/src/common/utils/jwt.ts` decode payloads but do not verify signature, issuer, audience, token use, or expiry. | High |
| E | `/search/v2` enforces JWT user scope. | Known gap | `../aetio-search/src/search/index.ts` deletes body `user_id` and has a TODO to restore JWT filtering. | High |
| E | Dive Deeper replaces supplied `user_id` with JWT `sub` when present. | Implemented, subject to JWT verification gap | `../aetio-search/src/index.ts` | High |
| E | DynamoDB batch operations retry unprocessed items. | Implemented | `src/common/services/dynamo.ts`; `src/common/services/dimensionMetadataTable.ts`; `src/common/services/insightEvaluationTable.ts` | High |
| E | A durable idempotency ledger and queue-backed job model exist. | Not found | No queue resource, job table, or idempotency-key persistence found in inspected services. | Medium-high |
| F | Review evaluation includes acceptance, decline, deletion, edit distance, metadata/row deltas, and version breakdowns. | Implemented | `../aetio-search/src/search/adminInsightEvaluations.ts`; `../amplify-vite-aetio/src/app/screens/AdminInsightEvaluations.tsx` | High |
| F | A labeled golden evaluation set gates extraction releases. | Not found | Offline evaluation script exists (`scripts/generate-insights-offline-eval.mjs`), but no verified labeled cross-document release gate or target thresholds were found. | Medium-high |
