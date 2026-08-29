# Whole-System Code Review TODO

This backlog captures the general code review supplied on 2026-08-29. It is an investigation plan, not a list of confirmed defects. Each workstream must compare the implementation with the home-task requirements and record evidence before changing behavior.

Priority legend: **P0** security or correctness, **P1** architecture or maintainability, **P2** clarity, tooling, or documentation.

For every item, record:

- **Finding:** confirmed issue, acceptable design, deferred improvement, or not applicable.
- **Evidence:** relevant requirement and source file/line references.
- **Decision:** keep, document, refactor, replace, or remove.
- **Verification:** tests or checks that prove the decision was implemented safely.

## P0 — Authentication, authorization, and data boundaries

- [ ] Review the custom demo authentication and session flow, especially `session.ts`, `guard.ts`, session storage, persona selection, and CSRF handling.
  - Map signing, verification, expiry, revocation, cookie flags, session fixation protection, identity switching, and fail-closed behavior.
  - Compare the current implementation with Nest Passport, guards, and established session libraries using official Nest documentation.
  - Distinguish a proportionate home-task demo mechanism from a production authentication solution.
  - Deliver a current-flow diagram, risk table, official documentation links, and a keep/replace recommendation.

- [ ] Audit authorization logic across the entire system, beginning with evidence listing in `deals.repository.ts` and `DiagnosticsService.decisionAuthority`.
  - Inventory duplicated roles, authorities, grants, and SQL `WHERE` predicates.
  - Verify authorization occurs before retrieval and generation and prevents restricted-data leakage.
  - Compare the current model with a centralized policy service, repository specifications, RBAC, ABAC, ReBAC, and OpenFGA.
  - Clarify that an external authorization engine may centralize decisions but does not eliminate database filtering and reauthorization requirements.
  - Deliver an authorization matrix, duplicate-rule inventory, recommended policy boundary, and regression-test plan.

- [ ] Audit repository and query boundaries.
  - Find services and processors that query storage directly, including `ExportService`.
  - Decide whether each case is an intentional read-model/query-service design or harmful persistence coupling.
  - Deliver an exception list and proposed repository, port, or query-service boundaries.

## P1 — Ingestion, embeddings, and retrieval

- [ ] Trace the complete source-data lifecycle: fixture/TSV read, validation, PostgreSQL ingestion, chunking, embedding, indexing, retrieval, and citation.
  - Identify every runtime TSV/file read and distinguish bootstrap or development ingestion from request-time reads.
  - Compare the lifecycle with `Cato_GTM_AI_Engineer_Home_Task.docx`; do not assume PostgreSQL ingestion is mandatory where the assignment permits local files or mocked tools.
  - Deliver a data-flow map and a keep/change decision for every direct file read.

- [ ] Profile the full corpus before changing chunking.
  - Analyze every TSV, Markdown, transcript, policy, CRM, and other embedded source in parallel by source type.
  - Measure row/document/token distributions, semantic structure, current chunk size/overlap, metadata, provenance, embedding limits, and retrieval quality.
  - Determine a per-source chunking strategy from evidence instead of applying one rule to every record.
  - Deliver a corpus report, current-behavior report, recommended chunk plan, reindex implications, and retrieval/security tests.

- [ ] Review evidence listing and citation design.
  - Verify evidence is scoped, ranked, traceable, immutable where required, and understandable to API/UI consumers.
  - Separate authorization-policy concerns from retrieval/ranking concerns.
  - Rename unclear operations such as `referencedEvidence` after documenting their actual behavior.

## P1 — SOLID boundaries and provider portability

- [ ] Audit run-level concurrency, locking, queue/database consistency, and cancellation recovery.
  - Prove that one active run per opportunity is enforced consistently across PostgreSQL, BullMQ/Redis, API idempotency, and worker leases.
  - Reproduce and eliminate the observed specialist-timeout deadlock in `completeLease`, where BullMQ considered a job completed while PostgreSQL retained an unconsumed command and leased invocation.
  - Review lock acquisition order for run rows, step invocations, outbox commands, checkpoints, trace spans, and run-event advisory locks.
  - Verify concurrent specialist completion or failure cannot race terminalization, enqueue duplicate work, or leave a run stuck in an active state.
  - Add recovery tests for duplicate delivery, stale leases, worker restart, cancellation during inference, database deadlocks, and Redis/PostgreSQL disagreement.
  - Deliver a lock-order specification, idempotency matrix, failure/reconciliation state diagram, and concurrency regression suite.

- [ ] Perform a whole-system responsibility and cohesion audit, starting with `DealService`, `DiagnosticsService`, and `DealBriefProcessor`.
  - Find generic parsing helpers such as `numberOrNull` and `isoDateOrNull` embedded in domain services.
  - Find classes mixing fetching, orchestration, business rules, validation, persistence, and presentation.
  - Find infrastructure details or provider identities leaking into consumers that should depend on interfaces.
  - Deliver a responsibility map and a concrete extraction/refactor backlog with file/line evidence.

- [ ] Review the model-provider boundary and dependency injection.
  - Inventory provider unions, conditional branches, Ollama/OpenRouter-specific knowledge, factories, adapters, and gateway interfaces.
  - Verify whether the existing `ModelGateway` abstraction already solves part of the concern before proposing replacement.
  - Evaluate Nest DI tokens plus adapter, factory, or strategy selection for configuration-driven providers.
  - Demonstrate how a new provider would be added and protected by contract tests.

- [ ] Deep-review `deal-brief.processor.ts` and analogous processors.
  - Separate data fetching, orchestration, business logic, validation, and persistence where the current boundaries are unclear.
  - Produce a before/after responsibility map and behavior-oriented rename table.
  - Apply confirmed findings across comparable modules rather than fixing only the examples named in the review.

## P1 — Contracts, DTOs, types, and naming

- [ ] Inventory every `contracts.ts` and classify its contents as DTOs, domain models, ports, events, schemas, configuration, or inferred types.
  - Research and link official Nest guidance for DTOs, validation, modules, providers, and interfaces.
  - Evaluate feature-cohesive contract modules versus role-specific files; avoid a blanket one-type-per-file rule.
  - Document that runtime-validated Nest DTOs often benefit from classes, while TypeScript interfaces/types and Zod schemas do not become more cohesive merely by being placed in a class.
  - Deliver a project convention and a targeted move/rename list.

- [ ] Audit snake_case and camelCase throughout the system.
  - Separate external wire, database, and source-file naming from internal TypeScript naming.
  - Identify intentional mapping boundaries and accidental inconsistencies.
  - Deliver a casing policy, mapper/serialization tasks, and compatibility tests.

- [ ] Audit class, function, and variable names.
  - Flag vague, misleading, or implementation-shaped names with file/line evidence.
  - Propose names that explain observable behavior without mechanically renaming stable public contracts.

## P2 — CI, linting, formatting, and readability

- [ ] Verify actual CI coverage rather than relying on local package scripts.
  - Confirm unit, integration, and appropriate end-to-end tests run in CI.
  - Confirm type checking, linting, and format checking are required gates.
  - Separate deterministic required checks from optional live-provider checks.
  - If no CI definition exists in the submitted repository, add one only after documenting the intended database/Redis setup and test isolation.

- [ ] Ask the user to choose the lint/format stack before a mechanical rewrite.
  - Option A: retain ESLint and add Prettier.
  - Option B: adopt oxlint plus oxfmt, retaining ESLint where plugin or boundary-rule coverage is still needed.
  - Option C: evaluate Biome, again retaining specialized ESLint rules where necessary.
  - Do not describe oxlint alone as a Prettier replacement.

- [ ] After the tooling decision, define line width, imports, scripts, CI gates, and optional pre-commit hooks.
- [ ] Run formatting as a separate, reviewable mechanical change and address long lines consistently.

## P2 — Comments, documentation, and assignment scope

- [ ] Add a PM-readable responsibility comment above every production class, organized module by module.
  - Use at most one short paragraph per class.
  - Explain the class's responsibility and boundary rather than restating its name or implementation.

- [ ] Confirm docstring scope with the user, then add one-sentence behavior/contract docstrings.
  - Recommended scope: exported, public, and business-critical production functions.
  - Decide explicitly whether private helpers, tests, scripts, configuration, generated files, and migrations are included.
  - Avoid comments that merely narrate syntax.

- [ ] Build a requirement-to-code matrix from `Cato_GTM_AI_Engineer_Home_Task.docx`.
  - Classify every feature as required, defensible demo enhancement, production-only improvement, or unnecessary scope.
  - Review audit logging, observability/traces, approvals, exports, and every other added feature individually.
  - Note that observable traces and an auditable brief appear to be explicit requirements; verify this against the source document.
  - Note that JSON/Markdown exports may be extra scope; decide whether to retain, defer, or remove them.

- [ ] Produce the requested `/lavish` architecture plan and interactive artifact.
  - ERD with a one-sentence hover description for every field.
  - Class/module/dependency diagram.
  - Logical and deployment views.
  - Authentication, authorization, ingestion, retrieval, provider, workflow, approval, audit, and trace flows.
  - Requirement-to-code map showing where every requested behavior lives.
  - Trust boundaries, provider seams, legend, and links to source files.

## Execution order

1. Build inventories and the assignment-to-code matrix.
2. Review authentication, authorization, and data boundaries.
3. Review ingestion, chunking, embeddings, and retrieval.
4. Review provider DI, processors, services, contracts, and naming.
5. Make user decisions on tooling, comment scope, optional features, and artifact location.
6. Refactor in small behavior-preserving changes with targeted tests.
7. Apply comments, docstrings, and formatting after responsibilities and names stabilize.
8. Generate the interactive architecture artifact from the final reviewed design.

## Decisions required from the user

- [ ] Choose ESLint + Prettier, oxlint + oxfmt, or Biome/specialized ESLint coverage.
- [ ] Choose docstring scope: literally every function, or exported/public/business-critical production functions only (recommended).
- [ ] Decide whether exports remain as a demo enhancement, are deferred, or are removed.
- [ ] Choose the `/lavish` artifact location: repository-local HTML under `docs/`, or a Codex visualization artifact with a Markdown index/snapshot.
