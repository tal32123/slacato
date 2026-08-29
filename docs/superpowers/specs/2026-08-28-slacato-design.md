# SlaCato Design Specification

Date: 2026-08-28  
Status: Approved direction; implementation in progress (use the implementation plan and SDD ledger for task status)

## 1. Product Summary

SlaCato is a responsive deal-intelligence application that generates evidence-grounded strategic deal briefs from Salesforce, Gong, Slack, policy, pricing, and permission data. It is designed as a polished sales product rather than an engineering console, while still making authorization, evidence, workflow progress, approvals, and audit details inspectable.

The product is a **seller-assist system**: it prepares an auditable internal brief and routes sensitive recommendations to people. It does not autonomously negotiate, send customer-facing material, optimize for “winning” at any cost, or replace the account owner, Sales Leader, Deal Desk, or legal judgment.

The submission must satisfy every mandatory requirement in `Cato_GTM_AI_Engineer_Home_Task.docx` and add a small number of defensible differentiators: hybrid retrieval, provider portability, durable approvals, strong authorization boundaries, evaluation coverage, and a polished responsive interface.

## 2. Goals and Non-Goals

### Goals

- Generate all nine required brief sections using live LLM calls.
- Use at least four genuinely specialized agents with observable traces and artifacts.
- Enforce permissions before retrieval and again before generation and rendering.
- Use real indexed retrieval with stable, resolvable evidence citations.
- Persist runs, checkpoints, approvals, outputs, attempts, and audit events in PostgreSQL.
- Let a user close the tab and later rejoin the same run without losing progress.
- Support direct Ollama Cloud by default through a provider-neutral, capability-aware AI boundary.
- Provide a polished desktop and mobile experience using React, Vite, and shadcn/ui.
- Verify retrieval quality, groundedness, policy handling, and non-leakage with TypeScript tooling.
- Keep modules cohesive and business rules out of generic infrastructure services.

### Non-Goals

- Production authentication or identity provisioning.
- Runtime embedding-model switching or re-embedding workflows.
- Cross-encoder reranking in Part 1.
- A general-purpose agent platform or user-authored workflows.
- WebSockets where unidirectional server events are sufficient.
- Python or the Ragas package.
- PDF export unless later explicitly requested.
- Raw chain-of-thought display or persistence.
- Bonus cost-aware model routing or synthetic-data generators beyond the mandatory reviewed Slack fixture. Token/call budgets are reliability controls, not a claim that bonus model routing is implemented.

## 3. Assignment Compliance

The following requirement IDs are binding acceptance gates and are used by the implementation-plan traceability matrix:

| ID | Mandatory outcome |
|---|---|
| `ASG-PROD-01` | Seller-assist positioning is visible in product copy, README, and presentation; no autonomous customer action. |
| `ASG-DATA-01` | All eight provided source groups are parsed and exercised: accounts, opportunities, contacts, Gong summaries, Gong transcripts, pricing notes, access permissions, and Deal Desk policy; reviewed Slack is the additional ninth source. |
| `ASG-SLACK-01` | At least two clearly synthetic updates per opportunity pass PII, chronology, novelty, reinforcement, ambiguity/conflict, ingestion, authorization, citation, and brief-impact checks. |
| `ASG-LIVE-01` | Reviewer/demo/submission briefs, approvals, specialist artifacts, and traces are produced with live LLM calls. Mock is permitted only for deterministic tests and local development. |
| `ASG-AUTH-01` | Authorization occurs before retrieval and generation; denied results and traces leak no source/account details; authorization lookups are distinguished from evidence retrieval. |
| `ASG-CITE-01` | Every important claim resolves to an authorized manifest entry and visibly renders `source=<relative path>, <stable key>=<stable ID>`. |
| `ASG-HITL-01` | Category-specific approval requirements and multi-role quorum are deterministic, durable, immutable, and tested. |
| `ASG-AGENT-01` | At least three LLM-backed specialists have typed contracts, defined tools, validation, observable invocations, and explicit failure/degraded behavior. |
| `ASG-GUARD-01` | Unsupported claims, restricted data, prompt injection, unsafe customer language, low confidence, conflicting evidence, and missing evidence are blocked or routed to review. |
| `ASG-TRACE-01` | Retrieval, every agent attempt, tool/validation/repair action, policy/guardrail decision, approval, recommendation, usage, and finalization are linked in a replayable trace. |
| `ASG-DEMO-01` | Authorized standard, authorized restricted-with-approval, unauthorized restricted, and Slack-impact scenarios pass end to end, including malformed/missing/partial-failure paths. |
| `ASG-DOC-01` | Runnable prototype, logical and deployment diagrams, README, technical overview, security notes, sample artifacts, and an actual timed 15-minute presentation are delivered. |
| `ASG-PROVIDER-01` | Supported provider/model, inference parameters, environment variables, secret setup, live probe, and reviewer runbook are documented and verified. |

SlaCato will provide:

- Four specialized LLM agents and a deterministic business workflow.
- Live model-backed briefs, specialist artifacts, approval output, traces, and demo runs.
- Indexed RAG with metadata filters and evidence used in generation.
- Source-, account-, user-, and sensitivity-aware authorization before retrieval.
- Human approval with approve, reject, and edit actions and durable resumption.
- Persistent runs and artifacts across process and browser restarts.
- Traceable specialist steps, tool activity, retries, validation failures, and final output.
- Two or more synthetic Slack updates per opportunity in a documented TSV format.
- Demonstrations for authorized OPP-1001/OPP-1002, restricted OPP-1003 with approval, unauthorized OPP-1003 with no leakage, and a brief citing Slack.
- A README describing architecture, setup, models, environment variables, commands, assumptions, and demo flow.

Mock-generated output may demonstrate deterministic tests, but it never satisfies `ASG-LIVE-01`. Before review, demo, or submission, Ollama Cloud must pass its credentialed capability probe and the mandatory artifacts must be regenerated live.

Every brief contains:

1. Deal Snapshot
2. Executive Summary
3. Buyer Goals and Business Drivers
4. Stakeholder Map
5. Negotiation State
6. Recommended Next Actions
7. Missing Information
8. Source Evidence
9. Confidence and Review Warnings

## 4. User Experience

### Information Architecture

Primary navigation:

- Deals
- Runs
- Approvals
- Settings

The default deal workspace is brief-first. It shows the deal identity, commercial summary, confidence and risk, latest run state, brief sections, stakeholders, actions, and evidence entry points. Agent internals do not dominate the primary view.

Desktop uses a collapsible navigation rail. Selecting evidence, a source citation, or run details opens an optional right-side split panel. On mobile, the navigation becomes a four-item bottom bar and the split panel becomes a labeled bottom sheet or full-height drawer.

### Run Experience

Starting a brief immediately creates a persisted run ID and navigates to its stable URL. The UI receives generic typed progress events over Server-Sent Events. It may show:

- Current workflow phase
- Specialist status
- Tool names and retrieved-result counts
- Validation and repair attempts
- Completed and validated sections
- Approval state

It does not expose hidden chain of thought. User-facing reasoning is a concise, model-produced summary validated for disclosure. Partial structured objects are never trusted or persisted as final domain output.

### Approval Experience

There is no pause/resume button. When policy requires approval, the workflow persists an immutable, versioned approval subject and stops consuming model work. The assigned approver can approve unchanged, edit and approve with rationale, or reject with rationale. Compare-and-swap prevents stale decisions; edited content is revalidated for schema, citations, authorization, claim support, policy, and unsafe language. Approval finalizes that exact snapshot without another model synthesis. Closing and reopening the browser rejoins the persisted run.

Approval authority is category-specific and derived from the canonical policy plus explicit persona grants, never from a model-produced role label:

- The account owner may request approval. `can_request_approval` does not grant Deal Desk, Sales Leader, or legal approval authority.
- A discount greater than 10%, or any negative renewal uplift, requires Deal Desk approval.
- A discount greater than 15% requires a quorum of both Deal Desk and Sales Leader approvals from authorized actors; one decision cannot silently satisfy both roles.
- Liability-cap changes and data-retention, restricted-research, or customer-specific security language require distinct legal authority. The canonical fixture has neither a legal-approval flag nor a Sales Leader scoped to restricted OPP-1003, so those authorities must be represented by explicit, documented candidate-created demo grants; otherwise the request remains safely pending and customer-facing language is unavailable.
- Low-confidence, conflicting, or missing-evidence recommendations require a scoped human-review decision by an account owner or Sales Leader, recorded separately from commercial/legal approvals.
- Customer-facing concession language additionally requires account-owner confirmation after every underlying commercial, legal, and human-review requirement is satisfied. Until then the UI may show only an internal draft, never ready-to-send copy.

An approval subject can therefore require several entries. Every required entry must be approved; any rejection rejects the subject. The persisted decision records the actor, authority, subject hash, category, rationale, and time, and enforces separation between requesting a decision and possessing the authority to grant it.

### Demo Login and Settings

The login page is a polished persona selector backed by the canonical identities in the permissions fixture. Because the source policy requires legal approval but supplies no legal approver identity or Sales Leader scoped to restricted OPP-1003, clearly labeled candidate-created synthetic Legal Reviewer and Restricted Sales Leader personas may be added with only the explicit authority and minimum account scope needed for the demo. These grants are controls, not evidence, and cannot weaken canonical denials. Selecting a persona creates a signed, HTTP-only demo session. There are no passwords and no runtime arbitrary role creation.

Settings includes:

- Active persona selector
- Read-only permission matrix by account, source, sensitive pricing, approval authority, and restricted-opportunity access
- Read-only permission, provider/model, index-health, and runtime diagnostics in a clearly secondary Demo Diagnostics area

Changing persona affects subsequent server-authorized behavior. Existing runs retain their originating identity, but the current persona must still be authorized to view them. Switching persona aborts live streams, closes overlays, clears client state, and reauthorizes the current route.

### Visual Direction

The approved direction is **Verified Converged Workspace**.

Cato owns the palette and enterprise trust cues:

- Forest: `#182D2A`
- Medium green: `#0D483D`
- Cato green: `#158864`
- Fluorescent mint: `#81E5AC`
- Pale mint: `#DEF6EF`
- Neutral paper: `#F6F6F6`
- Amber attention accent: approximately `#F5C13D`

These values were verified against Cato's live production CSS on 2026-08-28. Slack influences modular information blocks, activity recency, collaboration signals, compact navigation, approachable language, and micro-interactions. SlaCato does not copy Slack logos, marks, layout, or trade dress.

The implementation will use Geist or another freely distributable modern sans-serif rather than Cato's proprietary site font.

### UX and Accessibility Rules

- WCAG AA contrast for ordinary text and controls.
- Visible keyboard focus and logical focus order.
- Minimum 44px touch targets on mobile.
- Status always has text or icon meaning in addition to color.
- Progressive disclosure for audit and evidence detail.
- Responsive content hierarchy rather than desktop shrinkage.
- Reduced-motion support and restrained animation.
- Loading, empty, unauthorized, approval, retry, and failure states are designed explicitly.
- Permission-denied experiences reveal neither hidden content nor sensitive metadata.

## 5. Technical Architecture

### Runtime Shape

A TypeScript workspace uses a React/Vite single-page application, a NestJS HTTP API, and a separately deployable NestJS BullMQ worker. The authenticated sales workspace does not require SSR or SEO, so keeping presentation static and placing all server behavior behind an explicit API produces a cleaner deployment-neutral seam than Next.js server actions or route handlers.

The architecture is a modular monolith with explicit boundaries:

- Presentation: React routes, components, view models, query/mutation clients, SSE client
- Application: NestJS controllers, use cases, workflow coordination, authorization orchestration
- Domain: deal briefs, claims, citations, approval policy, permissions, run state
- Infrastructure: Drizzle repositories, provider adapters, retrieval indexes, SSE transport, logging

Classes and interfaces are used for stateful or replaceable boundaries. Pure functions are preferred for deterministic transformations, validation, fusion, and React rendering. TypeScript best practices take priority over forced object orientation.

### Core Services

`DealBriefWorkflow` is intentionally business-aware. It controls the fixed sequence:

1. Authorize request
2. Retrieve authorized evidence
3. Run specialist agents in parallel
4. Validate and repair specialist outputs
5. Synthesize strategy and full brief
6. Validate citations, permissions, policy, and required sections
7. Persist `awaiting_approval` when required
8. Apply approval decision
9. Finalize and export

Specialist agents cannot call one another. The strategy agent receives validated specialist artifacts rather than hidden shared state. This makes the workflow predictable and auditable while preserving genuine specialization.

### Specialist Agents

1. **Conversation Intelligence Agent** — extracts goals, concerns, commitments, objections, and missing context from Gong and Slack evidence.
2. **Stakeholder Intelligence Agent** — builds the stakeholder map, influence assessment, relationship state, and coverage gaps.
3. **Commercial and Policy Agent** — analyzes Salesforce, pricing, commercial terms, policy triggers, and required approvals.
4. **Negotiation Strategy Agent** — synthesizes validated specialist artifacts into negotiation state, prioritized actions, warnings, and the final brief.

Salesforce loading, authorization, retrieval, citation validation, and policy enforcement remain deterministic tools or services rather than being mislabeled as agents.

Each contract defines `success`, `degraded`, and `failed` outcomes. Conversation failure removes conversation-derived assertions and creates a warning; stakeholder failure preserves deterministic CRM contacts but marks inferred roles unavailable; commercial/policy failure is fatal because approval cannot be decided safely; strategy failure is fatal because no brief exists. Partial specialist failure is persisted and traced, and synthesis may continue only when its explicit degraded-mode contract can still satisfy grounding and approval safety.

## 6. Generic Infrastructure Boundaries

### Model Gateway

`ModelGateway` knows only provider-neutral concepts:

- Provider and model identifiers
- Messages and system instructions
- Tools
- Structured output schema
- Retry and timeout policy
- Token usage and telemetry

It knows nothing about Cato, opportunities, sales, policy, or briefs. Provider adapters implement direct Ollama Cloud and may later support Anthropic or other AI SDK providers without changing domain agents.

A provider registry selects configured chat and embedding models. API keys remain server-side environment variables. No API-key field is rendered in the browser.

### Repositories

Domain repository ports describe concepts such as runs, approvals, evidence, permissions, and briefs. Drizzle adapters translate them to PostgreSQL. Application services do not import Drizzle query details.

### Event Streaming

The SSE service transports generic envelopes containing event ID, stream/run ID, event type, timestamp, version, and typed payload. It handles replay cursors, heartbeats, and disconnection. It contains no deal or policy decisions.

### Job Execution

BullMQ is a generic execution adapter backed by Redis. Queue processors deserialize a command and invoke an application use case; they contain no deal, policy, retrieval, or model logic. PostgreSQL remains authoritative for business workflow state. A transactional outbox prevents a committed run from being lost between the database transaction and queue publication. A PostgreSQL reconciler republishes nonterminal steps that have neither a committed invocation nor a live command, so accepted Redis jobs are not the sole recovery record. Redis uses persistence and `maxmemory-policy=noeviction`.

Jobs use stable idempotency keys, bounded delivery attempts with jittered backoff, dead-letter handling, and correlation metadata. Step invocations have an owner, lease expiry, heartbeat, and safe takeover rules. Queue delivery is at least once; external LLM inference can also be repeated if a process dies after receiving a provider response but before committing it. Provider-supported idempotency is used when available, and indeterminate attempts are persisted and counted against the run budget. Human approval never suspends a worker: the current job ends after persisting `awaiting_approval`, and the approval API atomically records the decision and enqueues any required deterministic continuation.

### Logging

Structured logs use stable event names, correlation IDs, run IDs, provider/model metadata, durations, retry counts, token usage, and safe error classifications. Prompts, source content, secrets, and restricted metadata are not logged by default. Domain services decide which redacted audit facts are safe to emit.

## 7. Persistence and State

PostgreSQL is the system of record. Drizzle ORM and Drizzle Kit own schema access and migrations. `pgvector` stores embeddings; PostgreSQL full-text indexes support lexical retrieval.

Primary persisted concepts include:

- Users/personas and signed demo sessions
- Permission grants
- Opportunities and source documents
- Chunks, metadata, embeddings, and lexical index fields
- Immutable run evidence manifests containing the authorized chunk versions, ranks, hashes, model/index version, policy hash, and scope hash used by a run
- Runs, workflow checkpoints, and current state
- Specialist attempts and validated artifacts
- Claims and stable citations
- Approval requests and decisions
- Final briefs and exports
- Audit events and model usage

State transitions are explicit and validated. PostgreSQL stores checkpoints, attempts, outbox records, invocation leases, and the current business state; BullMQ/Redis provides durable distributed delivery to a separate worker process. Repeated commands are idempotent using stable operation and invocation keys. A run resumes from its last committed checkpoint after a browser, API, worker, or Redis connection restart. Workflow correctness is exposed through a deep `WorkflowStore` seam whose atomic operations commit state, events, artifacts, and the next outbox command together.

## 8. Retrieval and Authorization

### Ingestion

The canonical assignment repository is imported by a repeatable TypeScript command. Parsers normalize Salesforce, Gong summaries, transcripts, policies, pricing, permissions, and reviewed Slack TSV data into source documents and chunks with stable IDs and source metadata.

Slack fixtures are generated once with live Ollama Cloud assistance, validated by deterministic TypeScript rules, reviewed, and committed as TSV plus generation metadata. Runtime ingestion consumes the reviewed fixture; it does not regenerate Slack messages for each run.

### Authorization Boundary

The effective evidence scope is calculated before retrieval from the signed persona, opportunity/account relationship, source permissions, sensitivity flags, and policy rules. Unauthorized rows and metadata never enter semantic search, lexical search, prompts, agent artifacts, citations, logs, or rendered errors.

Authorization is checked again when resolving citations and before rendering persisted artifacts. This defense-in-depth prevents a stale or malformed artifact from becoming a disclosure path.

The opportunity-to-account, requester, and permission-profile reads required to compute scope are recorded as redacted `authorization_lookup` trace events. They are not evidence retrieval, are never placed in model context, and are excluded from evidence/citation counts. Authorized evidence queries are separately recorded as `evidence_retrieval`; a denial trace contains only the safe decision code and correlation identifiers.

### Part 1 Retrieval

- PostgreSQL full-text search for lexical and keyword matching
- Exact cosine search over the already-authorized `pgvector` subset for semantic similarity
- Permission and metadata filters applied inside retrieval queries
- Parallel lexical and semantic retrieval
- Reciprocal Rank Fusion for deterministic result merging
- Transparent recency and source-reliability adjustments
- Policy documents treated deterministically and not penalized simply for age
- Stable chunk and citation identifiers
- Visible citation labels in the exact shape `source=<repository-relative path>, <stable key>=<stable ID>` (for example, `source=synthetic_data/gong/gong_call_summaries.tsv, call_id=CALL-008`), with the internal chunk ID available in evidence detail

### Deferred Decision — Part 2 Reranking

After implementing and evaluating the baseline retrieval system, pause to discuss whether to prototype cross-encoder/reranking. Do not implement it automatically. Review baseline metrics together first.

Hybrid FTS + bi-encoder similarity + deterministic fusion is the required internal baseline. Cross-encoder reranking is an optional post-baseline experiment only; submission wording must not imply that it is implemented unless a separate measured experiment is accepted. Likewise, source reliability and recency adjustments may be reported only when exercised by tests and evaluation output.

## 9. Structured Generation and Reliability

The model adapter probes the configured provider/model capabilities. It prefers AI SDK native structured output with Zod when the live model proves support; otherwise it uses ordinary generation with a trusted JSON-Schema instruction, deterministic JSON extraction, Zod validation, and bounded corrective retries. Every attempt records `native_schema` or `prompted_json`. Each final specialist artifact and brief must validate completely before persistence as a completed result.

Model retries are owned by one application retry controller; SDK-level retries are disabled. Total provider calls, transport retries, schema repairs, deadline, and token budget are bounded. On a schema failure, the next attempt receives a bounded prior invalid output plus precise Zod issue paths and correction instructions. Transport and rate-limit retries use exponential backoff with jitter. Business authorization and policy failures are not retried.

Each attempt persists safe metadata, validation issues, duration, and usage. If repair fails, the run enters a typed failure state with a safe user-facing recovery action.

### Context Budgeting and Compaction

`BudgetedModelGateway` is the only model-call interface exposed to agents and scripts. It always applies a deterministic, model-free `ContextWindowPolicy`, which reserves output capacity, budgets system instructions, current task input, validated specialist artifacts, and authorized retrieved evidence, and prevents large tool or retrieval payloads from entering context unbounded. Provider adapters remain private. Generated schemas bound every array, string, claim, citation, and total serialized artifact size. Specialist artifacts reference one immutable evidence manifest rather than duplicating excerpts; strategy receives bounded artifacts and only their cited evidence.

The Part 1 agents perform bounded analyses, so pruning and retrieval limits are the normal path. If a future multi-turn session crosses its configured threshold, a separate `ContextCompactor` makes a non-recursive budgeted summary call, validates a structured checkpoint, persists it alongside immutable raw history, and retains a recent tail. The checkpoint binds to covered message ranges, citations, evidence versions, authorization scope, policy, prompt, schema, model, and validation hashes. Authorization is recomputed before reuse; narrowed access invalidates and rebuilds the checkpoint from still-authorized raw history. Compaction has hard input-token, output-token, step, retry, and repeated-call limits. It is an application capability, not a reason to adopt a separate agent runtime; Vercel Eve and Workflow are not required.

The canonical brief JSON includes all nine sections, stable claim IDs, citation IDs, confidence values, and review warnings. The UI renders this model with shadcn components. Markdown and JSON exports are supported.

## 10. Model Providers

The deterministic-test and local-development default is the `AI_PROVIDER=mock` adapter. It is provider-neutral infrastructure, uses generic scriptable responses through the same budgeted gateway, and emits a documented `mock-*` profile with 64-dimensional deterministic unit-normalized non-empty embeddings. It is not a reviewer/demo/submission mode, is not live Ollama compatibility, and cannot be used to infer a real-model dimension.

`AI_PROVIDER=ollama` is the production AI mode. It uses server-side `OLLAMA_API_KEY`, base URL, generation model, and embedding model; all three required Ollama variables are strictly validated only in this mode. Ollama remains explicitly unverified until its credentialed discovery, schema, and embedding probe succeeds.

Task 3 stores embeddings in a dimension-flexible pgvector column with persisted provider/model/dimension/profile metadata. Exact authorized-subset cosine search remains the baseline and HNSW remains deferred. Application invariants reject mixed profiles; activating a real provider requires full re-embedding plus an explicit pre-production migration/operational gate, not runtime switching.

## 11. Evaluation and Testing

All project-owned evaluation logic remains TypeScript.

### Test Layers

- Vitest unit tests for parsers, policies, authorization, RRF, validation, state machines, and view models
- Repository integration tests against PostgreSQL and pgvector
- AI contract tests with deterministic fake gateways
- Live Ollama integration tests behind explicit environment flags
- Playwright responsive and accessibility-critical flows
- Promptfoo for model and RAG evaluation, red-team scenarios, and regression reports

### Core Metrics and Assertions

- Precision@k and recall@k for checked-in golden retrieval cases
- Citation resolution and claim-to-evidence validity
- Required-section completeness
- Permission leakage rate, which must be zero
- Policy-trigger and approval-decision correctness
- Context relevance, context recall, faithfulness, and answer relevance using Promptfoo-style RAG assertions
- Prompt injection, RBAC/BOLA, source attribution, and poisoned-context fixtures
- Slack synthetic-marker and PII checks (real names, customer names, emails, phone numbers, and sensitive identifiers), semantic novelty/non-duplication checks against the eight provided source groups, `source_type=slack` authorization, citation, and ablation showing a visible brief difference with Slack excluded
- Trace-completeness assertions linking authorization lookup, evidence retrieval, every specialist/strategy attempt, validation/repair, guardrail/policy decision, approval requirement/decision, recommendation, finalization, and usage
- Per-agent malformed-output, timeout, unavailable-provider, missing-input, denied-source, degraded-specialist, fatal-commercial/policy, and multi-agent partial-failure cases
- End-to-end malformed request, missing opportunity/source data, opaque denial, partial agent failure, approval quorum, unsafe-language rejection, and Slack-impact paths on desktop and mobile

Custom evaluators are limited to domain-specific behavior Promptfoo cannot know: citation authorization, stable citation resolution, policy triggers, permission leakage, and golden chunk identity. NDCG and broad bespoke evaluation frameworks are omitted unless baseline results later justify them.

### CI Strategy

Pull requests run deterministic lint, typecheck, unit, integration, and fixture-based evaluation suites. Live Promptfoo and Ollama evaluations run manually or on a scheduled workflow with protected secrets. A full live evaluation report is generated before submission.

## 12. Security and Privacy

- Signed, HTTP-only, secure session cookies outside local development
- Server-only provider credentials
- Default-deny authorization
- Retrieval filters before any model context construction
- Redacted logs and audit payloads
- Citation authorization on resolution
- Prompt-injection fixtures and untrusted-source delimiters
- Output encoding and safe Markdown rendering
- No raw chain of thought
- No sensitive content in URLs, client state, toast messages, or unauthorized counts
- Deterministic unsafe-language checks before persistence, approval, export, and rendering block threats, deception, discriminatory or harassing language, fabricated commitments, unapproved legal/pricing promises, and instructions to bypass policy. Ambiguous customer-facing text is routed to human review rather than silently rewritten as approved copy.

## 13. Deployment and Operations

The local runnable path is Docker Compose with `web`, `api`, `worker`, PostgreSQL/pgvector, and Redis services. The production reference deployment is Railway. The public web container serves the React build and reverse-proxies same-origin `/api` and SSE requests to the private NestJS API. The API, BullMQ worker, PostgreSQL/pgvector, and Redis communicate over Railway private networking; only the web service receives a public domain. The same proxy contract is used in local development. This avoids cross-site cookie and EventSource behavior while retaining strict origin checks and session-bound CSRF protection for mutations. Vercel hosting, Vercel Workflow, and Eve are not runtime dependencies.

SSE is selected over WebSockets because the browser only needs server-to-client progress events. Browser lifetime never controls work: refreshing or reopening reads the persisted run and reconnects using a snapshot watermark. PostgreSQL events are authoritative for replay; `LISTEN/NOTIFY` only wakes every live API replica after the worker commits an event. Health checks distinguish liveness from readiness for PostgreSQL migrations, Redis, provider capability, and index state. Production deployment includes separate scaling controls for API and worker, bounded connection pools and worker/model concurrency, redacted structured logs, graceful shutdown, queue draining, migration jobs, backups, outbox-age/queue-depth alerts, retention, and dead-letter inspection.

## 14. Error Handling

Errors use typed categories:

- Unauthorized or forbidden
- Missing or invalid source data
- Provider unavailable or rate limited
- Invalid structured output after repair
- Citation or policy validation failure
- Approval rejected
- Persistence or migration failure

User-facing errors contain safe next actions and correlation IDs. Internal details remain in redacted structured logs. The workflow never converts an authorization failure into a fallback retrieval path.

## 15. Documentation Deliverables

- Root README with architecture, prerequisites, environment, setup, ingestion, run, evaluation, and demo instructions
- `.env.example` with non-secret placeholders
- Architecture decision records for deterministic orchestration, authorization-before-retrieval, hybrid retrieval, and SSE
- Data dictionary and Slack fixture-generation notes
- Permission and policy examples
- Evaluation methodology and report interpretation
- Demo script covering every required scenario
- Known limitations and the explicit Part 2 reranking decision point
- A logical diagram showing agents, orchestration, RAG, state, approvals, guardrails, observability, and output channels
- A deployment diagram showing web/API/worker, PostgreSQL/pgvector, Redis, secrets, model gateway, monitoring, and trust boundaries
- A technical overview covering production scalability, high availability, monitoring, secrets management, incident/dead-letter operations, backups, retention, and support ownership
- Security notes covering the authorization lookup/evidence boundary, default-deny retrieval, approval authorities/quorum, prompt injection, unsafe-language checks, secrets, log redaction, and known limitations
- A real, timed 15-minute presentation artifact and speaker/demo script covering business value, design choices, live demo, evaluation results, and production failure modes; “slide-ready notes” alone do not satisfy this deliverable
- Provider documentation with exact Ollama Cloud model identifiers, supported output mode, inference parameters, required environment variables, secret configuration, live-probe result, and commands reviewers use to produce non-mock artifacts

## 16. Open Implementation Assumptions

- Required Ollama Cloud models are available to the evaluator.
- PostgreSQL supports both `vector` and the required full-text indexes.
- The assignment's canonical source fixtures remain the source of truth.
- Fake personas are sufficient because production authentication is outside the assignment.
- The one-time generated Slack TSV will be reviewed before being treated as canonical fixture data.

These assumptions must be validated during setup and surfaced clearly when unmet; they do not authorize silent fallbacks that would weaken the assignment requirements.

If Ollama Cloud is unavailable, deterministic development remains usable, but reviewer/demo/submission acceptance is blocked rather than silently falling back to mock.

## 17. Decision Summary

- Product: responsive web application named SlaCato
- Framework: React, Vite, NestJS, TypeScript, shadcn/ui
- Orchestration: deterministic workflow, no LLM orchestrator
- Agents: four specialists with validated structured artifacts
- AI: Vercel AI SDK, provider-neutral gateway, Ollama Cloud default
- Data: PostgreSQL, pgvector, PostgreSQL full-text search, Drizzle
- Retrieval: authorized hybrid lexical + semantic with RRF
- Progress: PostgreSQL workflow state/outbox/checkpoints, BullMQ/Redis delivery, separate worker, SSE projection, resumable URLs
- Approval: immutable versioned inbox subject, approve unchanged/edit-and-approve/reject, no post-approval synthesis
- Evaluation: Vitest, Playwright, Promptfoo, focused TypeScript evaluators
- Theme: Cato production green palette with Slack-inspired collaboration patterns
- Context: provider-aware budgeting and pruning, with persisted structured compaction only when thresholds require it
- Deployment: Docker Compose locally; Railway `web` + `api` + `worker` + PostgreSQL/pgvector + Redis in production
- Submission: sanitized mandatory live briefs, specialist artifacts, approvals, traces, usage, and evaluation reports
- Deferred: cross-encoder reranking discussion after Part 1 baseline evaluation
