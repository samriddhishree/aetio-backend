import { useEffect, useState, type ReactNode } from "react";

type SlideDefinition = {
  id: string;
  number: string;
  section: string;
  title: string;
  subtitle?: string;
  content: ReactNode;
  speakerHint: string;
};

type StatusTone = "live" | "prototype" | "gap" | "hypothesis" | "neutral";

function Status({ tone = "neutral", children }: { tone?: StatusTone; children: ReactNode }) {
  return <span className={`status status-${tone}`}>{children}</span>;
}

function SlideHeading({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <header className="slide-heading">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {subtitle ? <p className="slide-subtitle">{subtitle}</p> : null}
    </header>
  );
}

function Arrow({ vertical = false }: { vertical?: boolean }) {
  return (
    <span className={vertical ? "arrow arrow-vertical" : "arrow"} aria-hidden="true">
      {vertical ? "\u2193" : "\u2192"}
    </span>
  );
}

function Node({
  title,
  detail,
  tone = "paper",
  compact = false,
}: {
  title: string;
  detail?: string;
  tone?: "paper" | "ink" | "accent" | "mint" | "line";
  compact?: boolean;
}) {
  return (
    <div className={`node node-${tone}${compact ? " node-compact" : ""}`}>
      <strong>{title}</strong>
      {detail ? <span>{detail}</span> : null}
    </div>
  );
}

function MiniIcon({ name }: { name: "file" | "search" | "brain" | "db" | "shield" | "user" }) {
  const paths: Record<typeof name, ReactNode> = {
    file: <><path d="M7 2h7l5 5v15H7z" /><path d="M14 2v6h6M10 13h6M10 17h6" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></>,
    brain: <><path d="M9 4a3 3 0 0 0-5 2.2A3.5 3.5 0 0 0 4.5 13 3.5 3.5 0 0 0 9 18" /><path d="M15 4a3 3 0 0 1 5 2.2 3.5 3.5 0 0 1-.5 6.8A3.5 3.5 0 0 1 15 18M9 4v16M15 4v16M9 9H6M15 9h3M9 15H6M15 15h3" /></>,
    db: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
    shield: <path d="M12 2 4 5v6c0 5.2 3.4 9.2 8 11 4.6-1.8 8-5.8 8-11V5z" />,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 22c.8-5 3.5-7 8-7s7.2 2 8 7" /></>,
  };

  return (
    <svg className="mini-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      {paths[name]}
    </svg>
  );
}

const slides: SlideDefinition[] = [
  {
    id: "title",
    number: "01",
    section: "Opening",
    title: "Aetio: From Fragmented Documents to Evidence-Backed Enterprise Insights",
    speakerHint: "Open with the product thesis, then set expectations: this is a code-grounded prototype story, not a claim of commercial traction.",
    content: (
      <div className="title-slide">
        <div className="title-mark" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <p className="eyebrow">Engineering leadership case study</p>
        <h1>
          From fragmented documents to
          <em> evidence-backed</em> enterprise insights
        </h1>
        <p className="title-deck">
          Aetio transforms research and analytical artifacts into structured, searchable,
          source-linked insight objects.
        </p>
        <div className="title-footer">
          <div>
            <span className="label">Product thesis</span>
            <strong>Organize insights, not only documents.</strong>
          </div>
          <div>
            <span className="label">Role</span>
            <strong>Product and technical lead</strong>
            <small>[CONFIRM TITLE]</small>
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "problem",
    number: "02",
    section: "Problem",
    title: "The enterprise does not have a storage problem",
    subtitle: "It has a knowledge continuity problem.",
    speakerHint: "Connect fragmented artifacts to repeated work, lost context, and low trust in generated answers.",
    content: (
      <div className="standard-slide">
        <SlideHeading
          eyebrow="The user problem"
          title="The enterprise does not have a storage problem"
          subtitle="It has a knowledge continuity problem."
        />
        <div className="problem-map">
          <div className="source-cloud">
            <span className="source-chip chip-a">PDFs</span>
            <span className="source-chip chip-b">Presentations</span>
            <span className="source-chip chip-c">Reports</span>
            <span className="source-chip chip-d">Spreadsheets</span>
            <span className="source-chip chip-e">Dashboards</span>
            <span className="source-chip chip-f">Shared drives</span>
            <span className="source-chip chip-g">Team memory</span>
            <div className="source-caption">Knowledge is stored by artifact and owner</div>
          </div>
          <div className="broken-bridge">
            <span>context</span>
            <span>lineage</span>
            <span>ownership</span>
          </div>
          <div className="consequence-stack">
            <article><b>01</b><span>Prior work is hard to discover</span></article>
            <article><b>02</b><span>Teams repeat expensive analysis</span></article>
            <article><b>03</b><span>Search returns files, not reusable conclusions</span></article>
            <article><b>04</b><span>AI answers are difficult to trust without evidence</span></article>
          </div>
        </div>
        <p className="bottom-thesis">The cost is not just retrieval time. It is weak institutional memory.</p>
      </div>
    ),
  },
  {
    id: "thesis",
    number: "03",
    section: "Product",
    title: "Make the conclusion a durable product object",
    speakerHint: "Contrast ephemeral document Q&A with persistent, inspectable insight objects and their evidence.",
    content: (
      <div className="standard-slide">
        <SlideHeading eyebrow="Product thesis" title="Make the conclusion a durable product object" />
        <div className="comparison-grid">
          <section className="comparison-panel muted-panel">
            <div className="panel-kicker">Traditional search / document Q&amp;A</div>
            <div className="comparison-visual document-visual">
              <MiniIcon name="file" />
              <Arrow />
              <MiniIcon name="search" />
              <Arrow />
              <div className="ephemeral-answer">One-off answer</div>
            </div>
            <ul className="clean-list">
              <li>Retrieves documents or chunks</li>
              <li>Synthesizes transient responses</li>
              <li>Leaves conclusions difficult to reuse</li>
              <li>Weakens traceability after synthesis</li>
            </ul>
          </section>
          <section className="comparison-panel aetio-panel">
            <div className="panel-kicker">Aetio knowledge layer</div>
            <div className="comparison-visual insight-visual">
              <MiniIcon name="file" />
              <Arrow />
              <div className="insight-object"><span>INSIGHT</span><b>Reusable claim</b><small>evidence + metadata</small></div>
              <Arrow />
              <MiniIcon name="brain" />
            </div>
            <ul className="clean-list">
              <li>Persists reusable insight families</li>
              <li>Preserves supporting references and source URI</li>
              <li>Enables semantic and structured exploration</li>
              <li>Accumulates knowledge across workflows</li>
            </ul>
          </section>
        </div>
        <div className="statement-ribbon"><span>DIFFERENTIATOR</span> Organize insights, not only documents.</div>
      </div>
    ),
  },
  {
    id: "workflow",
    number: "04",
    section: "Product",
    title: "One loop: create, govern, discover, inspect",
    speakerHint: "Walk the implemented frontend path from authenticated upload through review, search, evidence inspection, and deeper analysis.",
    content: (
      <div className="standard-slide">
        <SlideHeading
          eyebrow="Primary product workflow"
          title="One loop: create, govern, discover, inspect"
          subtitle="The React application exposes both knowledge creation and retrieval journeys."
        />
        <div className="journey-grid">
          <article className="journey-step"><span>01</span><MiniIcon name="user" /><b>Authenticate</b><small>Cognito email, Google, optional SAML</small></article>
          <article className="journey-step"><span>02</span><MiniIcon name="file" /><b>Upload</b><small>Research output and optional context to S3</small></article>
          <article className="journey-step"><span>03</span><MiniIcon name="brain" /><b>Extract</b><small>Frontend currently invokes generate-insights-v2</small></article>
          <article className="journey-step"><span>04</span><MiniIcon name="shield" /><b>Review</b><small>Edit, accept, decline, and approve project bundle</small></article>
          <article className="journey-step"><span>05</span><MiniIcon name="db" /><b>Persist</b><small>DynamoDB record plus OpenSearch projection</small></article>
          <article className="journey-step"><span>06</span><MiniIcon name="search" /><b>Search</b><small>Natural-language search with local/GWI sources</small></article>
          <article className="journey-step"><span>07</span><MiniIcon name="file" /><b>Inspect</b><small>Insight tree, table, metadata, and source linkage</small></article>
          <article className="journey-step"><span>08</span><MiniIcon name="brain" /><b>Dive deeper</b><small>Context-first agent with bounded tools</small></article>
        </div>
        <div className="status-line">
          <Status tone="live">Implemented in code</Status>
          <span>Upload, review, search, insight detail, and Dive Deeper UI/API paths</span>
          <Status tone="gap">No verified usage metric</Status>
        </div>
      </div>
    ),
  },
  {
    id: "architecture",
    number: "05",
    section: "Architecture",
    title: "Two paths, one governed knowledge layer",
    speakerHint: "Explain the write and read paths, then emphasize DynamoDB as system of record and OpenSearch as a derived retrieval index.",
    content: (
      <div className="standard-slide architecture-slide">
        <SlideHeading eyebrow="High-level architecture" title="Two paths, one governed knowledge layer" />
        <div className="architecture-grid">
          <div className="lane-label creation-label"><span>01</span> Knowledge creation</div>
          <div className="architecture-lane creation-lane">
            <Node title="React + Vite" detail="Amplify Auth + Storage" />
            <Arrow />
            <Node title="Amazon S3" detail="uploaded artifacts" tone="mint" />
            <Arrow />
            <Node title="Express API" detail="v2 LangGraph / v3 agent" tone="ink" />
            <Arrow />
            <Node title="Unstructured" detail="parse + provenance" />
            <Arrow />
            <Node title="OpenAI" detail="extract + critique" tone="accent" />
          </div>
          <div className="knowledge-core">
            <div className="core-title">GOVERNED KNOWLEDGE LAYER</div>
            <div className="core-stores">
              <div><MiniIcon name="db" /><b>DynamoDB</b><small>system of record</small><em>insights / family data / dimensions / projects / evals</em></div>
              <div className="sync-mark"><span>project</span><span>sync</span></div>
              <div><MiniIcon name="search" /><b>OpenSearch</b><small>retrieval index</small><em>family-level search documents</em></div>
            </div>
          </div>
          <div className="lane-label retrieval-label"><span>02</span> Knowledge retrieval</div>
          <div className="architecture-lane retrieval-lane">
            <Node title="User question" detail="local / GWI / all" />
            <Arrow />
            <Node title="Search v2" detail="understand + retrieve" tone="ink" />
            <Arrow />
            <Node title="Rerank" detail="bounded candidates" />
            <Arrow />
            <Node title="Synthesize" detail="insight IDs as evidence" tone="accent" />
            <Arrow />
            <Node title="Inspect / Dive" detail="tree + agent tools" tone="mint" />
          </div>
        </div>
        <div className="architecture-foot">
          <span><Status tone="live">Implemented</Status> Cognito, S3, Express, DynamoDB, OpenSearch, OpenAI, Unstructured</span>
          <span><Status tone="prototype">Integrated prototype</Status> table-understanding service</span>
        </div>
      </div>
    ),
  },
  {
    id: "extraction",
    number: "06",
    section: "AI System",
    title: "Reliability comes from stage gates, not a single prompt",
    speakerHint: "Use v2 as the current frontend-integrated pipeline, then show v3 as the latest backend evolution toward grid-first agentic extraction.",
    content: (
      <div className="standard-slide extraction-slide">
        <SlideHeading
          eyebrow="AI extraction deep dive"
          title="Reliability comes from stage gates, not a single prompt"
          subtitle="Naive chunk-to-insight generation tends to be generic, redundant, or unsupported."
        />
        <div className="pipeline-band">
          <div className="phase phase-source">
            <span className="phase-label">SOURCE</span>
            <Node title="DocumentIntake" compact />
            <Node title="ContentExtraction" compact />
            <Node title="Normalization" compact />
          </div>
          <Arrow />
          <div className="phase phase-evidence">
            <span className="phase-label">EVIDENCE</span>
            <Node title="MetadataDimensionExtraction" compact />
            <Node title="FindingExtraction" compact />
            <Node title="FindingCritique" compact />
          </div>
          <Arrow />
          <div className="phase phase-insight">
            <span className="phase-label">INSIGHT</span>
            <Node title="ResearchContextPreprocess" compact />
            <Node title="FamilyGrouping" compact />
            <Node title="InsightFamilyDataBuilder" compact />
          </div>
          <Arrow />
          <div className="phase phase-trust">
            <span className="phase-label">TRUST</span>
            <Node title="InsightFamilyDataValidation" compact />
            <Node title="FinalValidation" compact />
            <Node title="PersistSearchableFamilies" compact />
          </div>
        </div>
        <div className="extraction-details">
          <div className="quality-card">
            <Status tone="live">v2 / frontend-integrated</Status>
            <b>Finding-first, deterministic orchestration</b>
            <p>Atomic findings preserve quantitative detail and supporting references before family-level synthesis.</p>
          </div>
          <div className="evolution-arrow"><span>EVOLUTION</span><Arrow /></div>
          <div className="quality-card v3-card">
            <Status tone="prototype">v3 / latest backend endpoint</Status>
            <b>Grid-first, bounded agent loop</b>
            <p>Find candidate grids, inspect context, detect explicit insight or synthesize, normalize, tag, validate, persist.</p>
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "data-model",
    number: "07",
    section: "Data",
    title: "The insight is the reusable semantic unit",
    speakerHint: "Describe the persisted graph: source references ground the family, structured rows power filtering, and the search document remains a projection.",
    content: (
      <div className="standard-slide data-slide">
        <SlideHeading eyebrow="Data model and evidence" title="The insight is the reusable semantic unit" />
        <div className="entity-map">
          <div className="entity-column source-entities">
            <div className="entity-card"><span>DOCUMENT</span><b>document_id</b><small>source_uri, file_type</small></div>
            <div className="entity-link"><Arrow vertical /></div>
            <div className="entity-card"><span>CHUNK / TABLE</span><b>source evidence</b><small>page, section, cells</small></div>
          </div>
          <div className="entity-spoke"><span>supports</span><Arrow /></div>
          <div className="hero-entity">
            <span>INSIGHT FAMILY</span>
            <b>Reusable conclusion</b>
            <small>insight_id + family_text</small>
            <div className="entity-fields"><i>supporting_refs</i><i>metadata</i><i>tags</i><i>status</i></div>
          </div>
          <div className="entity-spoke right-spoke"><Arrow /><span>structures</span></div>
          <div className="entity-column structured-entities">
            <div className="entity-card"><span>INSIGHT FAMILY DATA</span><b>table_id</b><small>dimensions, metrics, rows</small></div>
            <div className="entity-link"><Arrow vertical /></div>
            <div className="entity-card"><span>DIMENSION METADATA</span><b>canonical fields</b><small>dimension/value IDs</small></div>
          </div>
          <div className="project-rail">
            <div><span>PROJECT</span><b>approval bundle + lifecycle</b></div>
            <div><span>REVIEW EVENTS</span><b>edits + accept/decline outcomes</b></div>
            <div><span>OPENSEARCH DOC</span><b>derived family-level projection</b></div>
          </div>
        </div>
        <div className="data-principles">
          <span><b>Evidence</b> stays linked to source elements</span>
          <span><b>Structure</b> enables filterable drill-down</span>
          <span><b>Search</b> can be rebuilt from the record</span>
        </div>
      </div>
    ),
  },
  {
    id: "search",
    number: "08",
    section: "AI System",
    title: "Bound retrieval before open-ended exploration",
    speakerHint: "Explain Search v2's retrieval funnel, then Dive Deeper v2's context-first decision to call tools only when initial evidence is insufficient.",
    content: (
      <div className="standard-slide search-slide">
        <SlideHeading
          eyebrow="Search and Dive Deeper v2"
          title="Bound retrieval before open-ended exploration"
          subtitle="Predictability first; agentic expansion only when the evidence is insufficient."
        />
        <div className="search-funnel">
          <div className="funnel-step"><span>1</span><b>Understand</b><small>keywords, intent, filter hints</small></div>
          <Arrow />
          <div className="funnel-step"><span>2</span><b>Retrieve</b><small>OpenSearch local + optional GWI</small></div>
          <Arrow />
          <div className="funnel-step"><span>3</span><b>Rerank</b><small>candidate and synthesis limits</small></div>
          <Arrow />
          <div className="funnel-step"><span>4</span><b>Synthesize</b><small>bounded insight set</small></div>
          <Arrow />
          <div className="funnel-step"><span>5</span><b>Stream</b><small>results, tokens, source errors</small></div>
        </div>
        <div className="dive-panel">
          <div className="dive-title"><Status tone="live">POST /ai/dive-deeper/v2</Status><b>Context-first agent</b></div>
          <div className="dive-flow">
            <Node title="Selected insight IDs" detail="user intent anchor" />
            <Arrow />
            <Node title="Local graph expansion" detail="parents / children / siblings" tone="mint" />
            <Arrow />
            <div className="decision-diamond">Enough<br />evidence?</div>
            <div className="branch branch-yes"><span>YES</span><Arrow /><Node title="Answer" detail="cite insight IDs" tone="accent" /></div>
            <div className="branch branch-no"><span>NO</span><Arrow /><Node title="Agent tools" detail="max calls / results / turns" tone="ink" /></div>
          </div>
        </div>
        <div className="benefit-row"><span>lower latency</span><span>bounded cost</span><span>predictable grounding</span><span>observable tool use</span></div>
      </div>
    ),
  },
  {
    id: "decisions",
    number: "09",
    section: "Leadership",
    title: "Four decisions shaped the system",
    speakerHint: "Frame each choice as a tradeoff, not an absolute: quality, evolvability, operational complexity, and trust all moved together.",
    content: (
      <div className="standard-slide decision-slide">
        <SlideHeading eyebrow="Decisions and tradeoffs" title="Four decisions shaped the system" />
        <div className="decision-table">
          <div className="decision-header"><span>CONTEXT</span><span>DECISION</span><span>TRADEOFF</span><span>STATUS</span></div>
          <div className="decision-row"><b>Answers disappear after chat</b><span>Persist insight families as first-class objects</span><span>More schema and lifecycle complexity</span><Status tone="live">Implemented</Status></div>
          <div className="decision-row"><b>LLM outputs can sound right without support</b><span>Use evidence refs, critique, and deterministic validation</span><span>Narrower output and longer processing</span><Status tone="live">Implemented</Status></div>
          <div className="decision-row"><b>Transactional access and relevance search differ</b><span>DynamoDB as record; OpenSearch as projection</span><span>Index consistency must be managed</span><Status tone="live">Implemented</Status></div>
          <div className="decision-row"><b>Rigid graphs limit adaptation; free agents drift</b><span>Explicit v2 stages plus bounded agents in v3 and Dive Deeper</span><span>Two orchestration models to evaluate</span><Status tone="prototype">Evolving</Status></div>
        </div>
        <blockquote>Enterprise AI quality is a systems property, not a model selection exercise.</blockquote>
      </div>
    ),
  },
  {
    id: "evolution",
    number: "10",
    section: "Execution",
    title: "The architecture evolved around observed failure modes",
    speakerHint: "Tell the sequence as learning: establish the user loop, strengthen extraction, separate retrieval, then add bounded agentic behavior and evaluation traces.",
    content: (
      <div className="standard-slide evolution-slide">
        <SlideHeading eyebrow="Execution and project evolution" title="The architecture evolved around observed failure modes" />
        <div className="timeline">
          <article><span className="timeline-dot">1</span><div><small>FOUNDATION</small><b>Authenticated product shell</b><p>React/Vite, Amplify Auth, S3 upload, review and library screens.</p><em>Learned: discovery needs a governed creation path.</em></div></article>
          <article><span className="timeline-dot">2</span><div><small>REPRESENTATION</small><b>Finding-first extraction</b><p>LangGraph v2, family data, metadata dimensions, deterministic validation.</p><em>Learned: insight quality depends on inspectable intermediates.</em></div></article>
          <article><span className="timeline-dot">3</span><div><small>DISCOVERY</small><b>Search as a separate service</b><p>Search v2, OpenSearch DSL generation, reranking, GWI source orchestration.</p><em>Learned: source failures and retrieval limits need explicit contracts.</em></div></article>
          <article><span className="timeline-dot">4</span><div><small>DEPTH + LEARNING</small><b>Bounded agents and review telemetry</b><p>Dive Deeper v2, grid-first v3, trace and review-event aggregation.</p><em>Learned: human edits are the quality signal to operationalize.</em></div></article>
        </div>
        <div className="evolution-status">
          <Status tone="live">Code-complete paths</Status>
          <span>Builds, tests, and deployment configuration exist</span>
          <Status tone="gap">Unverified</Status>
          <span>production adoption, SLOs, business impact</span>
        </div>
      </div>
    ),
  },
  {
    id: "strategy",
    number: "11",
    section: "Strategy",
    title: "Start with a painful knowledge workflow, then compound",
    speakerHint: "Present the enterprise SaaS motion as a commercial hypothesis. Focus on the wedge and expansion logic, not unverified market outcomes.",
    content: (
      <div className="standard-slide strategy-slide">
        <SlideHeading eyebrow="Product strategy | commercial hypothesis" title="Start with a painful knowledge workflow, then compound" />
        <div className="strategy-layout">
          <div className="wedge-card">
            <p className="panel-kicker">INITIAL WEDGE</p>
            <h3>Research and analytics artifacts that are costly to recreate</h3>
            <div className="persona-row"><span>Data scientists</span><span>Researchers</span><span>Product managers</span><span>Strategy teams</span></div>
            <p>Creators gain durable visibility. Decision-makers gain fast, inspectable answers.</p>
          </div>
          <div className="expansion-stair">
            <div className="stair stair-1"><span>1</span><b>One workflow</b><small>prove repeated retrieval value</small></div>
            <div className="stair stair-2"><span>2</span><b>One team's layer</b><small>govern metadata and review</small></div>
            <div className="stair stair-3"><span>3</span><b>More corpora</b><small>connect sources and domains</small></div>
            <div className="stair stair-4"><span>4</span><b>Enterprise memory</b><small>cross-team discovery</small></div>
          </div>
        </div>
        <div className="commercial-row">
          <div><span>BASE</span><b>Enterprise platform fee</b></div>
          <div><span>USAGE</span><b>Document and AI processing</b></div>
          <div><span>PREMIUM</span><b>Private deployment, integrations, controls</b></div>
          <Status tone="hypothesis">Not commercially validated</Status>
        </div>
      </div>
    ),
  },
  {
    id: "learning",
    number: "12",
    section: "Reflection",
    title: "The prototype proved the loop, not the market",
    speakerHint: "Be candid: name what the repository proves, the unresolved technical risks, and the three choices you would change on a second pass.",
    content: (
      <div className="standard-slide learning-slide">
        <SlideHeading eyebrow="Results, learning, and what I would do differently" title="The prototype proved the loop, not the market" />
        <div className="learning-columns">
          <section><span className="column-number">01</span><h3>What worked</h3><ul><li>Authenticated upload and review flow</li><li>Structured, evidence-linked extraction</li><li>Persisted insight families and tables</li><li>Search, synthesis, and graph exploration</li><li>Review events and evaluation summaries</li></ul></section>
          <section><span className="column-number">02</span><h3>What remains hard</h3><ul><li>Cross-document deduplication</li><li>Quality evaluation at scale</li><li>Authorization parity across retrieval paths</li><li>Index consistency, cost, and latency</li><li>Generalization across document types</li></ul></section>
          <section><span className="column-number">03</span><h3>What I would change</h3><ol><li>Narrow the first vertical earlier</li><li>Build a labeled evaluation set first</li><li>Enforce tenant scope in every query path</li><li>Validate repeated user value before broadening</li></ol></section>
        </div>
        <div className="closing-thesis">Enterprise AI quality = representation + evidence + evaluation + workflow + security + trust</div>
      </div>
    ),
  },
  {
    id: "appendix-aws",
    number: "A",
    section: "Appendix",
    title: "Detailed AWS and service architecture",
    speakerHint: "Use this only for infrastructure follow-ups. Distinguish configured services from proposed hardening work.",
    content: (
      <div className="standard-slide appendix-slide">
        <SlideHeading eyebrow="Appendix A" title="Detailed AWS and service architecture" />
        <div className="aws-map">
          <div className="aws-zone edge-zone"><span>CLIENT + EDGE</span><Node title="Amplify-hosted React" detail="Vite SPA" /><Node title="Cognito" detail="email / Google / optional SAML" /></div>
          <Arrow />
          <div className="aws-zone service-zone"><span>COMPUTE</span><Node title="Backend Express" detail="Node 24 / EB config" tone="ink" /><Node title="Search Express" detail="Node 24 / EB config" tone="ink" /><Node title="Table understanding" detail="FastAPI prototype" tone="line" /></div>
          <Arrow />
          <div className="aws-zone data-zone"><span>STATE + RETRIEVAL</span><Node title="S3" detail="uploads/extraction/*" tone="mint" /><Node title="DynamoDB" detail="6 logical tables" tone="mint" /><Node title="OpenSearch" detail="insights index" tone="mint" /></div>
          <Arrow />
          <div className="aws-zone external-zone"><span>PROCESSORS</span><Node title="Unstructured API" detail="document parsing" tone="accent" /><Node title="OpenAI APIs" detail="extraction + synthesis" tone="accent" /><Node title="GWI Spark" detail="optional source" tone="line" /></div>
        </div>
        <div className="infra-notes">
          <span><b>System of record:</b> DynamoDB</span>
          <span><b>Derived index:</b> OpenSearch</span>
          <span><b>Current execution:</b> synchronous HTTP pipelines</span>
          <span><Status tone="hypothesis">Future</Status> queues, idempotency ledger, centralized telemetry</span>
        </div>
      </div>
    ),
  },
  {
    id: "appendix-graphs",
    number: "B",
    section: "Appendix",
    title: "Deterministic graph and bounded agent loops",
    speakerHint: "Compare v2's fixed LangGraph edges with v3's planner and loop guards. Both aim to bound failure, but in different ways.",
    content: (
      <div className="standard-slide appendix-slide graph-slide">
        <SlideHeading eyebrow="Appendix B" title="Deterministic graph and bounded agent loops" />
        <div className="graph-compare">
          <section>
            <div className="panel-kicker">GENERATE-INSIGHTS-V2 | LANGGRAPH</div>
            <div className="vertical-graph">
              <Node title="Intake -> Extract -> Normalize" compact />
              <Arrow vertical />
              <Node title="Dimensions -> Findings -> Critique" compact tone="mint" />
              <Arrow vertical />
              <Node title="Context -> Families -> Family data" compact tone="accent" />
              <Arrow vertical />
              <Node title="Validate -> Persist -> Index" compact tone="ink" />
            </div>
            <p>Fixed edges make state transitions inspectable and repeatable.</p>
          </section>
          <section>
            <div className="panel-kicker">GENERATE-INSIGHTS-V3 | GRID AGENT</div>
            <div className="agent-loop">
              <div className="loop-core">Planner<small>next valid action</small></div>
              <span className="loop-action action-a">parse file</span>
              <span className="loop-action action-b">find grids</span>
              <span className="loop-action action-c">inspect context</span>
              <span className="loop-action action-d">synthesize</span>
              <span className="loop-action action-e">normalize</span>
              <span className="loop-action action-f">validate</span>
            </div>
            <p>Allowed-action checks, per-input attempt limits, and max-step guards constrain the loop.</p>
          </section>
        </div>
      </div>
    ),
  },
  {
    id: "appendix-api",
    number: "C",
    section: "Appendix",
    title: "Current API surface",
    speakerHint: "Call out the version split explicitly: v3 is the latest extraction API, while the frontend still invokes v2.",
    content: (
      <div className="standard-slide appendix-slide api-slide">
        <SlideHeading eyebrow="Appendix C" title="Current API surface" subtitle="Grouped by product capability; latest versions highlighted." />
        <div className="api-grid">
          <section><h3>Generate + ingest</h3><code>POST /generate-insights-v3</code><Status tone="prototype">latest backend</Status><code>POST /generate-insights-v2</code><Status tone="live">frontend-integrated</Status><code>POST /generate-insights-v2-metadata-prepass</code></section>
          <section><h3>Review + lifecycle</h3><code>GET /projects</code><code>GET /projects/:projectId</code><code>PATCH /insight/:insightId</code><code>PATCH /insight-family-data/:tableId</code><code>PATCH /insights/accept/:projectId</code></section>
          <section><h3>Search + inspect</h3><code>POST /search/v2</code><Status tone="live">latest search</Status><code>GET /insight/:insightId</code><code>GET /insight/tree/:insightId</code><code>GET /opensearch-insights-by-text</code></section>
          <section><h3>AI exploration + quality</h3><code>POST /ai/dive-deeper/v2</code><Status tone="live">latest dive</Status><code>GET /evals/summary</code><code>GET /admin/insight-evaluations</code><code>POST /v1/tables/understand</code><Status tone="prototype">service API</Status></section>
        </div>
      </div>
    ),
  },
  {
    id: "appendix-schemas",
    number: "D",
    section: "Appendix",
    title: "Simplified persisted schemas",
    speakerHint: "Show only the fields that explain the product behavior: reusable text, provenance, structure, scope, status, and evaluation lineage.",
    content: (
      <div className="standard-slide appendix-slide schema-slide">
        <SlideHeading eyebrow="Appendix D" title="Simplified persisted schemas" />
        <div className="code-grid">
          <pre><span>Insight</span>{`\n{\n  insight_id, project_id, user_id,\n  text, question_answered, status,\n  metadata[], tags[],\n  supporting_chunks[], document_id,\n  insight_family_data_id, s3_node\n}`}</pre>
          <pre><span>InsightFamilyData</span>{`\n{\n  table_id, family_id, document_ids[],\n  dimensions[], metric_columns[],\n  rows: [{ filter_values[],\n           metric_values,\n           supporting_refs[] }]\n}`}</pre>
          <pre><span>DimensionMetadata</span>{`\n{\n  dimension_id, dimension,\n  values[], project_id,\n  organization_id?, user_id?,\n  created_at, updated_at\n}`}</pre>
          <pre><span>EvaluationTrace / ReviewEvent</span>{`\n{\n  run_id, project_id, insight_id,\n  pipeline_version, model_name,\n  prompt_version, source_mode,\n  outcome, delta, occurred_at\n}`}</pre>
        </div>
      </div>
    ),
  },
  {
    id: "appendix-reliability",
    number: "E",
    section: "Appendix",
    title: "Reliability and multi-tenancy: current state",
    speakerHint: "Be direct about the authorization inconsistency. The frontend and several mutation paths use Cognito JWTs, but search scoping is not uniformly enforced.",
    content: (
      <div className="standard-slide appendix-slide reliability-slide">
        <SlideHeading eyebrow="Appendix E" title="Reliability and multi-tenancy: current state" />
        <div className="control-matrix">
          <div className="matrix-row matrix-head"><span>CONTROL</span><span>CURRENT EVIDENCE</span><span>ASSESSMENT</span></div>
          <div className="matrix-row warning-row"><b>Authentication</b><span>Amplify Cognito client flow; APIs decode JWT payload without signature/claim verification</span><Status tone="gap">Known gap</Status></div>
          <div className="matrix-row"><b>Object access</b><span>Authenticated S3 read/write under uploads/extraction/*</span><Status tone="live">Implemented</Status></div>
          <div className="matrix-row"><b>Mutation authorization</b><span>Routes compare decoded sub to records, subject to the JWT verification gap</span><Status tone="prototype">Partial</Status></div>
          <div className="matrix-row warning-row"><b>Search tenant scope</b><span>/search/v2 removes body user_id and does not reapply JWT sub</span><Status tone="gap">Known gap</Status></div>
          <div className="matrix-row"><b>Dive Deeper scope</b><span>Body user_id replaced with decoded JWT sub when present</span><Status tone="prototype">Endpoint-specific</Status></div>
          <div className="matrix-row"><b>Retry / partial failure</b><span>DynamoDB batch retry; source search isolates local/GWI errors</span><Status tone="live">Partial</Status></div>
          <div className="matrix-row"><b>Idempotency / async jobs</b><span>No durable request ledger or queue-backed ingestion found</span><Status tone="hypothesis">Future</Status></div>
        </div>
      </div>
    ),
  },
  {
    id: "appendix-evaluation",
    number: "F",
    section: "Appendix",
    title: "Turn reviewer behavior into an evaluation system",
    speakerHint: "Separate implemented telemetry from the missing labeled benchmark. The code captures useful acceptance and edit signals, but no verified target metrics are supplied.",
    content: (
      <div className="standard-slide appendix-slide evaluation-slide">
        <SlideHeading eyebrow="Appendix F" title="Turn reviewer behavior into an evaluation system" />
        <div className="evaluation-loop">
          <div className="eval-node"><span>1</span><b>Generate</b><small>pipeline, model, prompt, source mode</small></div>
          <Arrow />
          <div className="eval-node"><span>2</span><b>Review</b><small>accept, edit, decline, delete</small></div>
          <Arrow />
          <div className="eval-node"><span>3</span><b>Measure</b><small>acceptance, edit distance, metadata/row delta</small></div>
          <Arrow />
          <div className="eval-node"><span>4</span><b>Compare</b><small>pipeline/model/prompt breakdowns</small></div>
          <Arrow />
          <div className="eval-node future-eval"><span>5</span><b>Regress</b><small>golden set + release gates</small></div>
        </div>
        <div className="eval-scorecard">
          <section><Status tone="live">Captured now</Status><p>Review quality score, text edit distance, metadata deltas, row deltas, acceptance and decline rates.</p></section>
          <section><Status tone="hypothesis">Add next</Status><p>Evidence coverage, unsupported-claim rate, numeric fidelity, citation correctness, retrieval precision, task completion.</p></section>
          <section><Status tone="gap">Missing</Status><p>[ADD VERIFIED METRIC] and a labeled cross-document benchmark with agreed quality thresholds.</p></section>
        </div>
      </div>
    ),
  },
];

function Slide({ slide, index, print = false }: { slide: SlideDefinition; index: number; print?: boolean }) {
  return (
    <article className={`slide slide-${slide.id}${print ? " print-slide" : ""}`} aria-label={`${slide.number}: ${slide.title}`}>
      <div className="slide-content">{slide.content}</div>
      <footer className="slide-chrome">
        <span className="aetio-wordmark">AETIO</span>
        <span>{slide.section}</span>
        <span>{index + 1} / {slides.length}</span>
      </footer>
    </article>
  );
}

function readInitialSlide(): number {
  const hash = window.location.hash.replace("#", "");
  const byId = slides.findIndex((slide) => slide.id === hash);
  if (byId >= 0) return byId;
  const parsed = Number(new URLSearchParams(window.location.search).get("slide"));
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= slides.length ? parsed - 1 : 0;
}

export default function App() {
  const [current, setCurrent] = useState(readInitialSlide);
  const [overview, setOverview] = useState(false);
  const [help, setHelp] = useState(false);
  const [notes, setNotes] = useState(false);

  const goTo = (next: number) => {
    const bounded = Math.max(0, Math.min(slides.length - 1, next));
    setCurrent(bounded);
    window.history.replaceState(null, "", `#${slides[bounded].id}`);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
        event.preventDefault();
        setCurrent((value) => {
          const next = Math.min(slides.length - 1, value + 1);
          window.history.replaceState(null, "", `#${slides[next].id}`);
          return next;
        });
      }
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        setCurrent((value) => {
          const next = Math.max(0, value - 1);
          window.history.replaceState(null, "", `#${slides[next].id}`);
          return next;
        });
      }
      if (event.key === "Home") goTo(0);
      if (event.key === "End") goTo(slides.length - 1);
      if (event.key.toLowerCase() === "o") setOverview((value) => !value);
      if (event.key.toLowerCase() === "n") setNotes((value) => !value);
      if (event.key === "?") setHelp((value) => !value);
      if (event.key === "Escape") {
        setOverview(false);
        setHelp(false);
        setNotes(false);
      }
      if (event.key.toLowerCase() === "f") {
        if (!document.fullscreenElement) void document.documentElement.requestFullscreen();
        else void document.exitFullscreen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <main className="deck-app">
      <div className="ambient-grid" aria-hidden="true" />
      <div className="deck-topbar">
        <div className="deck-title"><b>Aetio</b><span>Engineering Leadership Case Study</span></div>
        <div className="deck-actions">
          <button onClick={() => setNotes((value) => !value)} aria-label="Toggle speaker cue">N</button>
          <button onClick={() => setOverview((value) => !value)} aria-label="Toggle slide overview">O</button>
          <button onClick={() => window.print()} aria-label="Print or export PDF">PDF</button>
          <button onClick={() => setHelp((value) => !value)} aria-label="Keyboard help">?</button>
        </div>
      </div>

      <div className="stage">
        <div className="slide-frame">
          <Slide slide={slides[current]} index={current} />
        </div>
      </div>

      <div className="deck-nav">
        <button onClick={() => goTo(current - 1)} disabled={current === 0} aria-label="Previous slide">PREV</button>
        <div className="progress-track"><span style={{ width: `${((current + 1) / slides.length) * 100}%` }} /></div>
        <span>{slides[current].number}</span>
        <button onClick={() => goTo(current + 1)} disabled={current === slides.length - 1} aria-label="Next slide">NEXT</button>
      </div>

      {notes ? (
        <aside className="speaker-cue">
          <span>SPEAKER CUE</span>
          <p>{slides[current].speakerHint}</p>
          <small>Full notes: SPEAKER_NOTES.md</small>
        </aside>
      ) : null}

      {overview ? (
        <div className="overview" role="dialog" aria-label="Slide overview">
          <div className="overview-head"><b>Slide overview</b><button onClick={() => setOverview(false)}>Close</button></div>
          <div className="overview-grid">
            {slides.map((slide, index) => (
              <button key={slide.id} className={index === current ? "active" : ""} onClick={() => { goTo(index); setOverview(false); }}>
                <span>{slide.number}</span><b>{slide.title}</b><small>{slide.section}</small>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {help ? (
        <div className="help-card" role="dialog" aria-label="Keyboard shortcuts">
          <button className="help-close" onClick={() => setHelp(false)}>Close</button>
          <h3>Keyboard</h3>
          <dl><dt>Arrow / Space</dt><dd>Navigate</dd><dt>F</dt><dd>Fullscreen</dd><dt>O</dt><dd>Overview</dd><dt>N</dt><dd>Speaker cue</dd><dt>Home / End</dt><dd>Jump</dd><dt>Esc</dt><dd>Close overlay</dd></dl>
        </div>
      ) : null}

      <div className="print-deck" aria-hidden="true">
        {slides.map((slide, index) => <Slide key={slide.id} slide={slide} index={index} print />)}
      </div>
    </main>
  );
}
