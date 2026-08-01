# Speaker Notes

## Slide 1 - Aetio: From Fragmented Documents to Evidence-Backed Enterprise Insights

**Key point:** Aetio is a reusable knowledge layer over enterprise research and analytical artifacts.

**Narrative (60-90 seconds):** Aetio began with a simple observation: companies have many documents but still lose the conclusions inside them. Search can retrieve a file or passage, and chat can generate an answer, but neither automatically creates a durable, governed unit of knowledge. Aetio turns source artifacts into structured insight objects that preserve evidence, metadata, and source lineage. The leadership challenge was therefore broader than integrating an LLM. It required product workflow, representation, extraction quality, retrieval, persistence, authorization, and human review to work as one system. This presentation focuses on what the repositories demonstrate, what remains a prototype, and what I learned while evolving the architecture.

**Leadership signal:** Frames a technical system through product value and establishes an evidence-based standard for claims.

**Likely follow-ups:** What was your exact role? What customer evidence exists? Which parts were deployed?

**Repository references:** `../src/index.ts`; `../../amplify-vite-aetio/src/app/Dashboard.tsx`; `../../aetio-search/src/index.ts`.

**Placeholder:** `[CONFIRM TITLE]`; `[ADD VERIFIED USER OR CUSTOMER EVIDENCE]`.

## Slide 2 - The Enterprise Does Not Have a Storage Problem

**Key point:** Fragmentation destroys continuity even when documents remain technically available.

**Narrative (60-90 seconds):** The user problem is not insufficient storage. Research lives in PDFs, presentations, spreadsheets, dashboards, shared drives, and individual memory. The conclusion, methodology, owner, and evidence become separated over time. Teams then repeat analysis, discover prior work through relationships rather than systems, or make decisions from summaries that cannot be verified. Generic document search helps locate artifacts but does not preserve the conclusion as a reusable object. The product opportunity is to create institutional memory that survives changes in teams and tools while keeping every conclusion inspectable.

**Leadership signal:** Connects a broad market problem to a concrete product boundary.

**Likely follow-ups:** Which user segment felt this most strongly? How was this problem validated? Why are existing enterprise search tools insufficient?

**Repository references:** Product workflow evidence in `../../amplify-vite-aetio/src/app/screens/DataSourceConnection.tsx`, `../../amplify-vite-aetio/src/app/screens/SearchResults.tsx`, and `../../amplify-vite-aetio/src/app/screens/InsightDetail.tsx`.

**Placeholder:** `[ADD VERIFIED DISCOVERY INTERVIEWS]`; `[ADD COST OF DUPLICATED ANALYSIS]`.

## Slide 3 - Make the Conclusion a Durable Product Object

**Key point:** Aetio persists reusable insight families rather than only producing ephemeral answers.

**Narrative (75-105 seconds):** The core representation decision was to organize insights, not only documents. A search result or generated answer is useful in the moment but difficult to govern, compare, edit, and reuse. Aetio persists an insight family with semantic text, a question answered, metadata, tags, supporting references, status, and optional structured family data. The source document remains available through the source URI and supporting references. OpenSearch receives a family-level projection for discovery while DynamoDB remains the record. This representation increases schema and workflow complexity, but it creates a stable unit that can be reviewed, cited, updated, and used in future synthesis.

**Leadership signal:** Shows product differentiation emerging from a data-model decision.

**Likely follow-ups:** How is an insight different from a finding? How do you prevent duplicate insights? Can the schema generalize across domains?

**Repository references:** `../src/generate-insights-v2/types.ts`; `../src/types.ts`; `../src/generate-insights-v2/services/familyPersistence.ts`; `../src/generate-insights-v2/nodes/persistSearchableFamilies.ts`.

**Placeholder:** `[ADD EXAMPLE INSIGHT AND SOURCE SCREENSHOT IF DESIRED]`.

## Slide 4 - One Loop: Create, Govern, Discover, Inspect

**Key point:** The frontend implements both the knowledge creation and retrieval journeys.

**Narrative (75-105 seconds):** The product loop begins with authentication and upload. Amplify Storage writes research artifacts to an authenticated S3 prefix. The frontend currently calls `generate-insights-v2`, then presents project-based approval screens where reviewers can edit insight text, metadata, and family tables before accepting or declining. Persisted families become available through the search service. Users can search across local insights or the optional GWI source, inspect insight relationships and supporting data, and launch Dive Deeper v2 from selected insights. The important product choice is that generation is not the endpoint. Review, persistence, retrieval, and evidence inspection close the loop.

**Leadership signal:** Demonstrates end-to-end ownership across frontend, API, data, and AI workflows.

**Likely follow-ups:** Why does the frontend still use v2? Which document types work? How does manual entry differ from upload?

**Repository references:** `../../amplify-vite-aetio/src/app/api/storage.ts`; `../../amplify-vite-aetio/src/app/api/insights.ts`; `../../amplify-vite-aetio/src/app/screens/data-source-connection/ApprovalReviewPanel.tsx`; `../../amplify-vite-aetio/src/app/components/DiveDeeperChat.tsx`.

**Placeholder:** `[CONFIRM SUPPORTED FILE-TYPE MATRIX]`.

## Slide 5 - Two Paths, One Governed Knowledge Layer

**Key point:** Creation and retrieval are separate service paths joined by a shared record and derived index.

**Narrative (90-120 seconds):** On the creation path, the React application uses Cognito-backed Amplify Auth and authenticated S3 storage. The backend Express service performs document intake, calls Unstructured for parsing, uses OpenAI in extraction and critique stages, and writes insights, family data, dimensions, projects, and evaluation records to DynamoDB. It synchronizes family-level search documents to OpenSearch, intentionally excluding large row payloads. On the retrieval path, the search Express service understands a query, retrieves and reranks candidates, synthesizes from a bounded set, and streams results. This separation lets the transactional model and relevance index evolve independently, but it creates consistency and authorization responsibilities that must be explicit. The client identity flow is configured, while API JWT verification is a known production gap covered in the appendix.

**Leadership signal:** Explains service boundaries and the tradeoff behind polyglot persistence.

**Likely follow-ups:** Why DynamoDB instead of a relational database? How is index drift repaired? Is ingestion asynchronous?

**Repository references:** `../src/common/services/config.ts`; `../src/common/services/dynamo.ts`; `../src/common/services/elasticsearch.ts`; `../../aetio-search/src/search/v2/SearchV2Service.ts`; `../../amplify-vite-aetio/amplify/backend.ts`.

**Placeholder:** `[CONFIRM DEPLOYMENT TOPOLOGY]`; `[ADD VERIFIED LATENCY AND COST]`.

## Slide 6 - Reliability Comes from Stage Gates

**Key point:** The current integrated v2 pipeline uses explicit intermediate representations; v3 explores a bounded grid-first agent.

**Narrative (90-120 seconds):** The v2 LangGraph has twelve named stages. Intake and extraction preserve source provenance. Normalization promotes text and tables to first-class objects. Metadata extraction establishes reusable dimensions. Finding extraction produces atomic, evidence-grounded claims, and critique applies deterministic checks for support, duplication, vagueness, and numeric mismatch with optional semantic critique. Family grouping creates broader reusable conclusions. Family data construction and validation produce structured rows, and final validation drops unsupported families before persistence. The latest backend endpoint, v3, changes the extraction strategy: it discovers explicit and implied grids, inspects nearby context, detects an explicit conclusion or synthesizes one, normalizes rows and dimensions, builds tags, validates, and persists. The frontend still invokes v2, so v3 should be presented as implemented backend code awaiting integration and comparative evaluation.

**Leadership signal:** Shows how architecture evolves from concrete model-quality failure modes.

**Likely follow-ups:** Why grid-first? How are numeric mismatches detected? When should v3 replace v2?

**Repository references:** `../src/generate-insights-v2/graph.ts`; `../src/generate-insights-v2/nodes/critiqueFindings.ts`; `../src/generate-insights-v2/nodes/finalValidation.ts`; `../src/generate-insights-v3/agent.ts`; `../src/generate-insights-v3/tools.ts`; `../../amplify-vite-aetio/src/app/api/insights.ts`.

**Placeholder:** `[ADD V2 VS V3 EVALUATION RESULT]`.

## Slide 7 - The Insight Is the Reusable Semantic Unit

**Key point:** Evidence, semantic meaning, structured dimensions, and lifecycle data are linked but stored for different responsibilities.

**Narrative (75-105 seconds):** A document descriptor identifies the source. Normalized chunks and tables preserve page, section, cell, and source references. Findings are the atomic evidence-bearing layer in v2. The user-facing reusable unit is an insight family, which links to supporting findings or chunks, semantic metadata, lifecycle status, and a project. For analytical material, `InsightFamilyData` stores dimensions, metrics, normalized rows, and row-level supporting references. `DimensionMetadata` provides canonical dimension and value IDs. Projects package generated insights for review, while trace and review-event tables capture pipeline lineage and human decisions. OpenSearch stores only a derived family-level projection, so search remains lightweight and the record remains reconstructable.

**Leadership signal:** Demonstrates that trustworthy AI depends on representation and lineage, not only prompts.

**Likely follow-ups:** How are IDs generated? Can a source support multiple families? How are table edits propagated to search?

**Repository references:** `../src/generate-insights-v2/types.ts`; `../src/generate-insights-v2/services/insightFamilyDataBuilder.ts`; `../src/common/services/dimensionMetadataTable.ts`; `../src/common/services/projectsTable.ts`; `../src/common/services/insightEvaluationTable.ts`.

**Placeholder:** `[CONFIRM LONG-TERM SCHEMA MIGRATION STRATEGY]`.

## Slide 8 - Bound Retrieval Before Open-Ended Exploration

**Key point:** Search uses a bounded funnel; Dive Deeper expands agentically only after deterministic local context.

**Narrative (90-120 seconds):** Search v2 first extracts intent, keywords, expansion terms, and filter hints. It generates a sanitized OpenSearch DSL query, retrieves a bounded candidate set, reranks it, and synthesizes from a smaller top set. The source orchestrator can run local and GWI retrieval independently and report partial source failures. Dive Deeper v2 starts from insight IDs selected by the user, loads deterministic local context through parent, child, and sibling relationships, and asks the agent whether that context is sufficient. Only then may it call graph or broader search tools. Tool calls, results, selected IDs, expanded IDs, and used IDs stream to the frontend. Tool-call, result, retrieval, and turn limits constrain cost and drift.

**Leadership signal:** Balances agent capability with latency, cost, observability, and trust.

**Likely follow-ups:** Why generate OpenSearch DSL with an LLM? What happens without an OpenAI key? How are citations enforced?

**Repository references:** `../../aetio-search/src/search/v2/SearchV2Service.ts`; `../../aetio-search/src/search/v2/OpenSearchQueryBuilder.ts`; `../../aetio-search/src/search/v2/sourceSearchOrchestrator.ts`; `../../aetio-search/src/services/diveDeeper/DiveDeeperV2Controller.ts`; `../../aetio-search/src/services/diveDeeper/DiveDeeperAgentService.ts`.

**Placeholder:** `[ADD RETRIEVAL PRECISION, LATENCY, AND TOOL-USE RATE]`.

## Slide 9 - Four Decisions Shaped the System

**Key point:** The architecture is a set of explicit quality and operability tradeoffs.

**Narrative (75-105 seconds):** Four decisions define the system. First, persistent insight families create reuse and governance at the cost of schema complexity. Second, evidence references, critique, and validation favor narrower grounded output over unconstrained breadth. Third, separating DynamoDB from OpenSearch matches storage to access pattern but requires explicit index synchronization. Fourth, the system uses deterministic stages where repeatability matters and bounded agents where adaptation is valuable. None of these choices removes risk. They make the risk visible, measurable, and assignable to a system boundary.

**Leadership signal:** Communicates decisions through context, alternatives, and consequences rather than technology preference.

**Likely follow-ups:** Which decision would you reverse? What was the highest-cost complexity? What evidence supported each choice?

**Repository references:** `../src/generate-insights-v2/graph.ts`; `../src/generate-insights-v2/nodes/persistSearchableFamilies.ts`; `../src/generate-insights-v3/agent.ts`; `../../aetio-search/src/services/diveDeeper/DiveDeeperAgentService.ts`.

**Placeholder:** `[ADD DECISION LOG OR TEAM REVIEW DETAILS]`.

## Slide 10 - The Architecture Evolved Around Failure Modes

**Key point:** The project moved from user loop to representation, discovery, bounded depth, and feedback telemetry.

**Narrative (90-120 seconds):** The initial product layer established authentication, upload, review, and insight browsing. The extraction architecture then introduced findings, family grouping, structured family data, and validation because direct generation did not provide enough control over support and quantitative fidelity. Search became a separate service because retrieval has different scaling, dependency, and failure characteristics from ingestion. Dive Deeper v2 added controlled agentic exploration, while v3 explored grid-first extraction for analytical artifacts. Review traces and admin evaluation summaries began turning user edits and decisions into observable quality signals. The repositories contain builds, tests, and deployment configuration, but they do not prove production adoption, reliability targets, or business impact.

**Leadership signal:** Shows iterative execution and learning without overstating maturity.

**Likely follow-ups:** How did you prioritize phases? What did you stop doing? How many engineers contributed?

**Repository references:** Git history across `../`, `../../aetio-search/`, and `../../amplify-vite-aetio/`; `../src/evals/generateInsights/review.ts`; `../../aetio-search/src/search/adminInsightEvaluations.ts`.

**Placeholder:** `[CONFIRM TEAM, TIMELINE, AND PERSONAL CONTRIBUTION]`; `[ADD VERIFIED DEPLOYMENT STATUS]`.

## Slide 11 - Start with a Painful Knowledge Workflow

**Key point:** The commercial plan is an enterprise SaaS hypothesis built around a narrow, high-cost wedge.

**Narrative (60-90 seconds):** The initial target is teams that create or repeatedly consume expensive analytical work: data scientists, researchers, product managers, analysts, and strategy teams. The wedge should be one recurring artifact workflow where duplicated effort and lost evidence are visible. If Aetio proves repeated retrieval and reuse for one team, the expansion path is to add related corpora, governance workflows, and teams until the insight layer becomes shared institutional memory. A credible commercial model could combine a platform fee, usage-based processing, and premium integration or private-deployment controls. This is a hypothesis from the supplied product context, not evidence of pricing validation or revenue.

**Leadership signal:** Connects architecture investment to a disciplined adoption and expansion model.

**Likely follow-ups:** Who is the buyer? What is the first vertical? How would you price AI usage? What is the competitive moat?

**Repository references:** Product surface in `../../amplify-vite-aetio/src/app/`; integration boundaries in `../src/` and `../../aetio-search/src/`.

**Placeholder:** `[ADD ICP VALIDATION]`; `[ADD WILLINGNESS-TO-PAY EVIDENCE]`; `[ADD COMPETITIVE RESEARCH]`.

## Slide 12 - The Prototype Proved the Loop, Not the Market

**Key point:** The repositories demonstrate a substantial working prototype, while market value and production readiness remain unverified.

**Narrative (90-120 seconds):** What worked is the connected technical loop: authenticated upload, extraction into structured insight families, human review and editing, persistence, search, evidence inspection, graph exploration, and review telemetry. The hardest unresolved problems are cross-document deduplication, quality evaluation, authorization parity, index consistency, cost and latency, and generalization across source types. On a second pass I would narrow the first vertical sooner, build a labeled evaluation set before expanding orchestration, enforce tenant scope through a single authorization abstraction, and validate repeated user behavior before generalizing the platform. The central lesson is that enterprise AI quality is a systems problem involving representation, evidence, evaluation, workflow, security, and human trust.

**Leadership signal:** Demonstrates candor, learning, and a concrete change in future execution.

**Likely follow-ups:** What is the single biggest risk? What would the next 90 days look like? Which metric gates production?

**Repository references:** `../src/generate-insights-v2/__tests__/`; `../src/generate-insights-v3/__tests__/`; `../../aetio-search/src/search/adminInsightEvaluations.ts`; `../../aetio-search/README.md` authorization notes.

**Placeholder:** `[ADD VERIFIED RESULTS]`; `[DEFINE LAUNCH QUALITY BAR]`.
