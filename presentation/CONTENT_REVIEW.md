# Content Review

## 1. Strongly Supported Claims

- Aetio has an implemented React/Vite frontend with Cognito-backed Amplify authentication configuration and authenticated S3 upload.
- The frontend includes upload, project review, insight editing, search, insight detail/tree, and Dive Deeper experiences.
- The frontend currently calls `POST /generate-insights-v2`.
- The backend implements a 12-node LangGraph v2 extraction workflow with provenance, findings, critique, family grouping, structured family data, validation, persistence, and OpenSearch synchronization.
- The backend also implements `POST /generate-insights-v3`, a newer grid-first agent workflow with allowed-action checks, validation, and loop guards.
- DynamoDB is used for insight, project, dimension, family-data, trace, and review-event records; OpenSearch stores retrieval projections.
- Search v2 implements query understanding, OpenSearch retrieval, reranking, synthesis, source orchestration, and SSE output.
- Dive Deeper v2 performs deterministic local context expansion before bounded agent tool use.
- Review/evaluation code aggregates acceptance, decline, deletion, edit distance, metadata deltas, row deltas, and pipeline/model/prompt breakdowns.

## 2. Claims Requiring Confirmation

- Exact presenter title, role, decision authority, and personal contribution.
- Team size, collaborator roles, and stakeholder-management examples.
- Which environments are currently deployed and accessible.
- Which document types have been validated beyond unit/integration fixtures.
- Whether the table-understanding FastAPI service is deployed or only local.
- Whether `generate-insights-v3` is intended to replace v2 or remain a specialized analytical path.
- Whether GWI is enabled in any current environment.
- Any customer, pilot, or internal user usage of the system.
- Any security review, penetration test, privacy assessment, or compliance posture.

## 3. Missing Product Metrics

- `[ADD VERIFIED ACTIVE USERS / TEAMS]`
- `[ADD VERIFIED DOCUMENTS PROCESSED]`
- `[ADD VERIFIED INSIGHTS ACCEPTED OR CITED]`
- `[ADD VERIFIED TIME SAVED OR DUPLICATION REDUCTION]`
- `[ADD VERIFIED SEARCH SUCCESS / REUSE RATE]`
- `[ADD VERIFIED REVIEW ACCEPTANCE AND EDIT RATE]`
- `[ADD VERIFIED INGESTION LATENCY, SEARCH LATENCY, AND AVAILABILITY]`
- `[ADD VERIFIED AI COST PER DOCUMENT OR INSIGHT]`

## 4. Missing User-Feedback Details

- Number and type of discovery interviews.
- Verbatim feedback that can be used with permission.
- Repeated behavior proving users return to prior insights.
- Which persona receives value first: creator, steward, or consumer.
- Specific usability failures and changes made in response.
- Evidence that users trust citations and supporting data enough to act.

The quotes in the supplied PRFAQ should not be presented as verified customer endorsements unless their permission and factual status are confirmed.

## 5. Missing Monetization Validation

- Buyer and budget owner.
- Willingness-to-pay evidence.
- Pricing metric: seats, processed documents, indexed insights, model usage, or platform tier.
- Procurement and deployment requirements.
- Sales-cycle assumptions.
- Competitive win/loss evidence.

The strategy slide is correctly labeled **Commercial hypothesis** and must remain framed as proposed.

## 6. Potential Interviewer Concerns

### Authorization is not production-ready

Both API services decode JWT payloads without verifying signatures or standard claims. In addition, `/search/v2` currently removes request `user_id` and does not restore JWT scope. This is the clearest production-readiness concern.

**Recommended answer:** "The frontend identity flow is configured, but API authorization is incomplete. Before production I would introduce shared JWT verification against Cognito JWKS, enforce issuer/audience/token-use/expiry, derive tenant scope once in middleware, and require that scope in every DynamoDB and OpenSearch repository call. I would add negative integration tests before enabling external traffic."

### Synchronous ingestion can be slow and fragile

Document parsing and multi-stage AI work execute inside an HTTP request.

**Recommended answer:** "The synchronous path accelerated prototype iteration. The production design would split intake from processing with a durable job record and queue, idempotency keys, stage checkpoints, bounded retries, cancellation, and progress events."

### Two extraction architectures increase complexity

V2 is a deterministic finding-first graph; v3 is a grid-first agent. The frontend still uses v2.

**Recommended answer:** "V3 is an evaluated architectural experiment, not an automatic replacement. I would compare both on a labeled corpus by source type, numeric fidelity, evidence coverage, reviewer edit distance, latency, and cost, then route by document characteristics or retire the weaker path."

### LLM-generated OpenSearch DSL adds failure and security risk

Search v2 requires OpenAI for query generation, then sanitizes the returned DSL.

**Recommended answer:** "The sanitizer constrains the output, but I would add a deterministic query builder as the default, reserve LLM interpretation for low-confidence queries, validate against a strict schema, cap complexity, and maintain adversarial query tests."

### Search index consistency is not formally guaranteed

DynamoDB and OpenSearch writes are separate operations.

**Recommended answer:** "The prototype uses explicit synchronous upserts. Production needs an outbox/change-stream pattern, idempotent indexing, reconciliation, index-version aliases, and freshness/error telemetry. DynamoDB remains authoritative."

### Evaluation signals are useful but not yet a quality bar

Review events exist, but no verified benchmark, target, or release gate is supplied.

**Recommended answer:** "Human edits are the beginning of the evaluation system. I would add a stratified golden set, evidence and numeric-fidelity graders, retrieval labels, quality thresholds by document class, and pre-release regression runs tied to model and prompt versions."

## 7. Recommended Answers to Leadership Questions

**How did you balance speed and quality?** I used explicit intermediate representations and deterministic checks for high-risk transformations, while keeping agent behavior bounded to tasks that benefit from adaptation. The tradeoff was additional orchestration and schema complexity.

**What was the most important product decision?** Persisting the insight as a governed object rather than treating each answer as disposable. That decision shaped review, storage, search, citations, and evaluation.

**What would you prioritize next?** First, authorization and tenant isolation. Second, a labeled quality benchmark. Third, asynchronous ingestion and index reconciliation. In parallel, validate one narrow repeated workflow with real users.

**How would you know the product works?** Users repeatedly retrieve and cite existing insights, duplicate analysis decreases, accepted insights require fewer edits, and evidence/citation quality meets a defined threshold at acceptable latency and cost.

**What is the moat?** Not access to a model. The defensible layer is governed insight representation, source-linked evidence, review feedback, domain metadata, and workflow integration that improve retrieval and trust over time. This remains a hypothesis until repeated use is demonstrated.

## 8. Five Areas to Avoid Overstating

1. Do not call the system production-ready while JWT verification and search scoping gaps remain.
2. Do not claim customer adoption, business impact, or quoted endorsements without confirmation.
3. Do not imply v3 is the active product workflow; the frontend still calls v2.
4. Do not claim complete multi-tenancy, compliance, or enterprise-grade security.
5. Do not present proposed pricing, private deployment, connectors, or next-best-action personalization as shipped capabilities.
