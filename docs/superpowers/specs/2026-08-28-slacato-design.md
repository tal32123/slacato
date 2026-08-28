# SlaCato Design Specification

Date: 2026-08-28  
Status: Approved direction; implementation not started

## 1. Product Summary

SlaCato is a responsive deal-intelligence application that generates evidence-grounded strategic deal briefs from Salesforce, Gong, Slack, policy, pricing, and permission data. It is designed as a polished sales product rather than an engineering console, while still making authorization, evidence, workflow progress, approvals, and audit details inspectable.

The submission must satisfy every mandatory requirement in `Cato_GTM_AI_Engineer_Home_Task.docx` and add a small number of defensible differentiators: hybrid retrieval, provider portability, durable approvals, strong authorization boundaries, evaluation coverage, and a polished responsive interface.

## 2. Goals and Non-Goals

### Goals

- Generate all nine required brief sections using live LLM calls.
- Use at least four genuinely specialized agents with observable traces and artifacts.
- Enforce permissions before retrieval and again before generation and rendering.
- Use real indexed retrieval with stable, resolvable evidence citations.
- Persist runs, checkpoints, approvals, outputs, attempts, and audit events in PostgreSQL.
- Let a user close the tab and later rejoin the same run without losing progress.
- Support direct Ollama Cloud by default through a provider-neutral AI boundary.
- Provide a polished desktop and mobile experience using Next.js, React, and shadcn/ui.
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

## 3. Assignment Compliance

SlaCato will provide:

- Four specialized LLM agents and a deterministic business workflow.
- Live model-backed briefs, specialist artifacts, approval output, traces, and demo runs.
- Indexed RAG with metadata filters and evidence used in generation.
- Source-, account-, user-, and sensitivity-aware authorization before retrieval.
- Human approval with approve, reject, and edit actions and durable resumption.
- Persistent runs and artifacts across process and browser restarts.
- Traceable specialist steps, tool activity, retries, validation failures, and final output.
- Two or more synthetic Slack updates per opportunity in a documented TSV format.
- Demonstrations for authorized OPP1001/OPP1002, restricted OPP1003 with approval, unauthorized OPP1003 with no leakage, and a brief citing Slack.
- A README describing architecture, setup, models, environment variables, commands, assumptions, and demo flow.

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

There is no pause/resume button. When policy requires approval, the workflow persists `awaiting_approval` and stops consuming model work. The assigned approver sees the item in an inbox and can approve, reject, or edit the proposed output. Approval automatically resumes the workflow. Closing and reopening the browser simply rejoins the same persisted run.

### Demo Login and Settings

The login page is a polished persona selector backed by the canonical identities in the permissions fixture. Selecting a persona creates a signed, HTTP-only demo session. There are no passwords and no arbitrary role creation.

Settings includes:

- Active persona selector
- Read-only permission matrix by account, source, sensitive pricing, approval authority, and restricted-opportunity access
- Generation provider and model selection
- Read-only embedding provider/model and index-health display
- Theme and audit-visibility preferences
- Runtime and configuration information

Changing persona affects subsequent server-authorized behavior. Existing runs retain their originating identity.

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

A single TypeScript codebase uses Next.js App Router and React. NestJS is intentionally omitted: the workload does not justify a second application framework, deployment unit, or duplicate dependency-injection system. Next.js server modules host application services, route handlers, server actions where appropriate, and the SSE endpoint.

The architecture is a modular monolith with explicit boundaries:

- Presentation: pages, React components, view models, SSE client
- Application: use cases, workflow coordination, authorization orchestration
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

### Logging

Structured logs use stable event names, correlation IDs, run IDs, provider/model metadata, durations, retry counts, token usage, and safe error classifications. Prompts, source content, secrets, and restricted metadata are not logged by default. Domain services decide which redacted audit facts are safe to emit.

## 7. Persistence and State

PostgreSQL is the system of record. Drizzle ORM and Drizzle Kit own schema access and migrations. `pgvector` stores embeddings; PostgreSQL full-text indexes support lexical retrieval.

Primary persisted concepts include:

- Users/personas and signed demo sessions
- Permission grants
- Opportunities and source documents
- Chunks, metadata, embeddings, and lexical index fields
- Runs, workflow checkpoints, and current state
- Specialist attempts and validated artifacts
- Claims and stable citations
- Approval requests and decisions
- Final briefs and exports
- Audit events and model usage

State transitions are explicit and validated. Repeated commands are idempotent using stable operation keys. A run can resume from its last completed checkpoint after a browser or server restart.

## 8. Retrieval and Authorization

### Ingestion

The canonical assignment repository is imported by a repeatable TypeScript command. Parsers normalize Salesforce, Gong summaries, transcripts, policies, pricing, permissions, and reviewed Slack TSV data into source documents and chunks with stable IDs and source metadata.

Slack fixtures are generated once with live Ollama Cloud assistance, validated by deterministic TypeScript rules, reviewed, and committed as TSV plus generation metadata. Runtime ingestion consumes the reviewed fixture; it does not regenerate Slack messages for each run.

### Authorization Boundary

The effective evidence scope is calculated before retrieval from the signed persona, opportunity/account relationship, source permissions, sensitivity flags, and policy rules. Unauthorized rows and metadata never enter semantic search, lexical search, prompts, agent artifacts, citations, logs, or rendered errors.

Authorization is checked again when resolving citations and before rendering persisted artifacts. This defense-in-depth prevents a stale or malformed artifact from becoming a disclosure path.

### Part 1 Retrieval

- PostgreSQL full-text search for lexical and keyword matching
- Bi-encoder embeddings in `pgvector` for semantic similarity
- Permission and metadata filters applied inside retrieval queries
- Parallel lexical and semantic retrieval
- Reciprocal Rank Fusion for deterministic result merging
- Transparent recency and source-reliability adjustments
- Policy documents treated deterministically and not penalized simply for age
- Stable chunk and citation identifiers

### Deferred Decision — Part 2 Reranking

After implementing and evaluating the baseline retrieval system, pause to discuss whether to prototype cross-encoder/reranking. Do not implement it automatically. Review baseline metrics together first.

## 9. Structured Generation and Reliability

AI SDK structured output uses Zod schemas and the current `Output.object` pattern. Each final specialist artifact and brief must validate completely before persistence as a completed result.

Model retries are bounded, normally to three attempts. On a schema failure, the next attempt receives the prior invalid output plus precise Zod issue paths and correction instructions. Transport and rate-limit retries use exponential backoff with jitter. Business authorization and policy failures are not blindly retried.

Each attempt persists safe metadata, validation issues, duration, and usage. If repair fails, the run enters a typed failure state with a safe user-facing recovery action.

The canonical brief JSON includes all nine sections, stable claim IDs, citation IDs, confidence values, and review warnings. The UI renders this model with shadcn components. Markdown and JSON exports are supported.

## 10. Ollama Cloud

Ollama Cloud is the default direct provider. Configuration uses server-side `OLLAMA_API_KEY`, base URL, generation model, and embedding model. The provider registry isolates Ollama-specific request behavior from agents and domain services.

The initial design assumes an appropriate Ollama Cloud generation model and embedding model are available. Startup health checks verify both capabilities and fail with actionable configuration errors. The embedding model is deployment configuration and cannot be changed in the application.

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

## 13. Deployment and Operations

The application supports two documented deployment paths:

- Docker Compose for application plus PostgreSQL/pgvector
- Vercel for Next.js with a compatible managed PostgreSQL/pgvector database

The same migrations, ingestion, evaluation, and demo commands work in both paths. SSE is selected over WebSockets because the browser only needs server-to-client progress events. Long-lived durable work is controlled by persisted checkpoints rather than browser connection lifetime.

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

## 16. Open Implementation Assumptions

- Required Ollama Cloud models are available to the evaluator.
- PostgreSQL supports both `vector` and the required full-text indexes.
- The assignment's canonical source fixtures remain the source of truth.
- Fake personas are sufficient because production authentication is outside the assignment.
- The one-time generated Slack TSV will be reviewed before being treated as canonical fixture data.

These assumptions must be validated during setup and surfaced clearly when unmet; they do not authorize silent fallbacks that would weaken the assignment requirements.

## 17. Decision Summary

- Product: responsive web application named SlaCato
- Framework: Next.js App Router, React, TypeScript, shadcn/ui
- Orchestration: deterministic workflow, no LLM orchestrator
- Agents: four specialists with validated structured artifacts
- AI: Vercel AI SDK, provider-neutral gateway, Ollama Cloud default
- Data: PostgreSQL, pgvector, PostgreSQL full-text search, Drizzle
- Retrieval: authorized hybrid lexical + semantic with RRF
- Progress: SSE, durable checkpoints, resumable URLs
- Approval: durable inbox workflow, no pause/resume button
- Evaluation: Vitest, Playwright, Promptfoo, focused TypeScript evaluators
- Theme: Cato production green palette with Slack-inspired collaboration patterns
- Deferred: cross-encoder reranking discussion after Part 1 baseline evaluation
