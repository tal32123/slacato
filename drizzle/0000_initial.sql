CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
--> statement-breakpoint
CREATE FUNCTION public.bind_embedding_content_hash() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.embedding IS NOT NULL AND NEW.embedding_content_hash IS NULL THEN NEW.embedding_content_hash := NEW.content_hash; END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE FUNCTION public.enforce_evidence_version_indexing() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence_versions rows are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.document_version_id IS DISTINCT FROM NEW.document_version_id
    OR OLD.account_id IS DISTINCT FROM NEW.account_id OR OLD.opportunity_id IS DISTINCT FROM NEW.opportunity_id
    OR OLD.chunk_index IS DISTINCT FROM NEW.chunk_index OR OLD.source_type IS DISTINCT FROM NEW.source_type
    OR OLD.sensitivity IS DISTINCT FROM NEW.sensitivity OR OLD.content_hash IS DISTINCT FROM NEW.content_hash
    OR OLD.content IS DISTINCT FROM NEW.content OR OLD.event_date IS DISTINCT FROM NEW.event_date
    OR OLD.reliability_class IS DISTINCT FROM NEW.reliability_class OR OLD.source_locator IS DISTINCT FROM NEW.source_locator
    OR OLD.classification_reason IS DISTINCT FROM NEW.classification_reason OR OLD.policy_hash IS DISTINCT FROM NEW.policy_hash
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'evidence_versions content rows are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.embedding IS NOT NULL OR OLD.embedding_provider IS NOT NULL OR OLD.embedding_model IS NOT NULL
    OR OLD.embedding_dimension IS NOT NULL OR OLD.embedding_profile IS NOT NULL OR OLD.embedding_version IS NOT NULL
    OR OLD.embedding_normalization IS NOT NULL OR OLD.embedding_content_hash IS NOT NULL THEN
    RAISE EXCEPTION 'evidence_versions embedding profile is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE FUNCTION public.protect_approval_subject_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'immutable row cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.run_id IS DISTINCT FROM NEW.run_id OR OLD.draft_version IS DISTINCT FROM NEW.draft_version
    OR OLD.subject_hash IS DISTINCT FROM NEW.subject_hash OR OLD.payload IS DISTINCT FROM NEW.payload
    OR OLD.section_ids IS DISTINCT FROM NEW.section_ids OR OLD.recommendation_ids IS DISTINCT FROM NEW.recommendation_ids
    OR OLD.citation_ids IS DISTINCT FROM NEW.citation_ids OR OLD.policy_triggers IS DISTINCT FROM NEW.policy_triggers
    OR OLD.quorum_version IS DISTINCT FROM NEW.quorum_version OR OLD.decision_version IS DISTINCT FROM NEW.decision_version
    OR (OLD.superseded_by_subject_id IS NOT NULL AND OLD.superseded_by_subject_id IS DISTINCT FROM NEW.superseded_by_subject_id)
  THEN RAISE EXCEPTION 'immutable approval subject snapshot cannot be changed' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.reject_finalized_brief_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.finalized_at IS NOT NULL THEN RAISE EXCEPTION 'finalized briefs are immutable' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE FUNCTION public.reject_immutable_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '55000'; END; $$;
--> statement-breakpoint
CREATE FUNCTION public.reject_observability_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TABLE public.accounts (
    id text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.approval_authority_grants (
    id text NOT NULL,
    persona_id text NOT NULL,
    account_id text NOT NULL,
    authority text NOT NULL,
    demo_only boolean DEFAULT false NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_commit text NOT NULL,
    CONSTRAINT approval_authority_grants_authority_check CHECK ((authority = ANY (ARRAY['deal_desk'::text, 'sales_leader'::text, 'legal_reviewer'::text, 'account_owner'::text]))),
    CONSTRAINT approval_authority_grants_source_commit_ck CHECK ((source_commit ~ '^[0-9a-f]{40}$'::text))
);
--> statement-breakpoint
CREATE TABLE public.approval_decisions (
    id text NOT NULL,
    approval_subject_id text NOT NULL,
    action text NOT NULL,
    actor_id text NOT NULL,
    rationale text,
    edited_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    entry_id text NOT NULL,
    category text NOT NULL,
    authority text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    original_payload jsonb NOT NULL,
    approved_payload jsonb NOT NULL,
    original_subject_hash text NOT NULL,
    approved_subject_hash text NOT NULL,
    diff jsonb,
    result_run_version integer NOT NULL,
    result_status text NOT NULL,
    result_quorum_satisfied boolean NOT NULL,
    result_rejected boolean NOT NULL,
    CONSTRAINT approval_decisions_action_check CHECK ((action = ANY (ARRAY['approve_unchanged'::text, 'edit_and_approve'::text, 'reject'::text]))),
    CONSTRAINT approval_decisions_edit_ck CHECK ((((action = 'edit_and_approve'::text) AND (edited_payload IS NOT NULL)) OR (action <> 'edit_and_approve'::text))),
    CONSTRAINT approval_decisions_rationale_ck CHECK ((((action = ANY (ARRAY['edit_and_approve'::text, 'reject'::text])) AND (rationale IS NOT NULL) AND (length(btrim(rationale)) > 0)) OR (action = 'approve_unchanged'::text))),
    CONSTRAINT approval_decisions_result_consistency_ck CHECK (((result_quorum_satisfied = (result_status = 'finalizing'::text)) AND (result_rejected = (result_status = 'rejected'::text)))),
    CONSTRAINT approval_decisions_result_run_version_ck CHECK ((result_run_version >= 0)),
    CONSTRAINT approval_decisions_result_status_ck CHECK ((result_status = ANY (ARRAY['awaiting_approval'::text, 'finalizing'::text, 'rejected'::text])))
);
--> statement-breakpoint
CREATE TABLE public.approval_requirement_entries (
    id text NOT NULL,
    approval_subject_id text NOT NULL,
    category text NOT NULL,
    eligible_authorities jsonb NOT NULL,
    policy_triggers jsonb DEFAULT '[]'::jsonb NOT NULL,
    depends_on jsonb DEFAULT '[]'::jsonb NOT NULL,
    ordinal integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT approval_requirement_entries_category_check CHECK ((category = ANY (ARRAY['commercial_discount'::text, 'legal_terms'::text, 'evidence_review'::text, 'customer_concession'::text]))),
    CONSTRAINT approval_requirement_entries_ordinal_check CHECK ((ordinal >= 0))
);
--> statement-breakpoint
CREATE TABLE public.approval_subjects (
    id text NOT NULL,
    run_id text NOT NULL,
    draft_version integer NOT NULL,
    subject_hash text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    policy_triggers jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    section_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    recommendation_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    citation_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    quorum_version text DEFAULT 'deal-brief-approval-v1'::text NOT NULL,
    decision_version integer DEFAULT 0 NOT NULL,
    superseded_by_subject_id text,
    CONSTRAINT approval_subjects_decision_version_ck CHECK ((decision_version >= 0)),
    CONSTRAINT approval_subjects_draft_version_check CHECK ((draft_version >= 0)),
    CONSTRAINT approval_subjects_subject_hash_check CHECK ((length(subject_hash) > 0))
);
--> statement-breakpoint
CREATE TABLE public.audit_events (
    id text NOT NULL,
    run_id text,
    actor_id text,
    type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.auth_sessions (
    version uuid NOT NULL,
    persona_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT auth_sessions_expiry_ck CHECK ((expires_at > created_at))
);
--> statement-breakpoint
CREATE TABLE public.evidence_versions (
    id text NOT NULL,
    document_version_id text NOT NULL,
    account_id text NOT NULL,
    opportunity_id text,
    chunk_index integer NOT NULL,
    source_type text NOT NULL,
    sensitivity text NOT NULL,
    content_hash text NOT NULL,
    content text NOT NULL,
    lexical_content tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(content, ''::text))) STORED,
    embedding public.vector,
    embedding_provider text,
    embedding_model text,
    embedding_dimension integer,
    embedding_profile text,
    embedding_version text,
    embedding_normalization text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    event_date date,
    reliability_class text,
    source_locator text,
    classification_reason text,
    policy_hash text,
    embedding_content_hash text,
    CONSTRAINT evidence_versions_chunk_index_check CHECK ((chunk_index >= 0)),
    CONSTRAINT evidence_versions_content_hash_check CHECK ((length(content_hash) > 0)),
    CONSTRAINT evidence_versions_embedding_profile_ck CHECK ((((embedding IS NULL) AND (embedding_provider IS NULL) AND (embedding_model IS NULL) AND (embedding_dimension IS NULL) AND (embedding_profile IS NULL) AND (embedding_version IS NULL) AND (embedding_normalization IS NULL) AND (embedding_content_hash IS NULL)) OR ((embedding IS NOT NULL) AND (embedding_provider IS NOT NULL) AND (embedding_model IS NOT NULL) AND (embedding_dimension > 0) AND (embedding_profile IS NOT NULL) AND (embedding_version IS NOT NULL) AND (embedding_normalization IS NOT NULL) AND (embedding_content_hash = content_hash) AND (public.vector_dims(embedding) = embedding_dimension)))),
    CONSTRAINT evidence_versions_provenance_ck CHECK (((num_nonnulls(reliability_class, source_locator, classification_reason, policy_hash) = 0) OR ((num_nulls(reliability_class, source_locator, classification_reason, policy_hash) = 0) AND (length(reliability_class) > 0) AND (length(source_locator) > 0) AND (length(classification_reason) > 0) AND (policy_hash ~ '^[0-9a-f]{64}$'::text))))
);
--> statement-breakpoint
CREATE TABLE public.opportunities (
    id text NOT NULL,
    account_id text NOT NULL,
    name text NOT NULL,
    restricted boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.permission_grants (
    id text NOT NULL,
    persona_id text NOT NULL,
    account_id text,
    source_type text,
    can_read boolean DEFAULT false NOT NULL,
    can_approve boolean DEFAULT false NOT NULL,
    sensitive_pricing boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    can_read_restricted boolean DEFAULT false NOT NULL,
    source_commit text,
    can_request_approval boolean DEFAULT false NOT NULL,
    CONSTRAINT permission_grants_source_commit_check CHECK (((source_commit IS NULL) OR (source_commit ~ '^[0-9a-f]{40}$'::text)))
);
--> statement-breakpoint
CREATE VIEW public.authorized_evidence_grants WITH (security_barrier='true', security_invoker='true') AS
 SELECT DISTINCT permission.persona_id,
    permission.source_commit,
    evidence.id AS evidence_id,
    evidence.opportunity_id,
    evidence.account_id,
    evidence.source_type
   FROM ((public.permission_grants permission
     JOIN public.evidence_versions evidence ON (((evidence.account_id = permission.account_id) AND (evidence.source_type = permission.source_type))))
     JOIN public.opportunities opportunity ON ((opportunity.id = evidence.opportunity_id)))
  WHERE ((permission.can_read = true) AND ((opportunity.restricted = false) OR (permission.can_read_restricted = true)) AND ((evidence.sensitivity <> 'restricted'::text) OR ((evidence.source_type = 'pricing'::text) AND (permission.sensitive_pricing = true)) OR ((evidence.source_type <> 'pricing'::text) AND (permission.can_read_restricted = true))));
--> statement-breakpoint
CREATE VIEW public.authorized_opportunity_grants WITH (security_barrier='true', security_invoker='true') AS
 SELECT DISTINCT permission.persona_id,
    permission.source_commit,
    permission.source_type,
    opportunity.id AS opportunity_id,
    opportunity.account_id
   FROM (public.permission_grants permission
     JOIN public.opportunities opportunity ON ((opportunity.account_id = permission.account_id)))
  WHERE ((permission.can_read = true) AND ((opportunity.restricted = false) OR (permission.can_read_restricted = true)));
--> statement-breakpoint
CREATE TABLE public.runs (
    id text NOT NULL,
    opportunity_id text NOT NULL,
    requested_by text NOT NULL,
    status text NOT NULL,
    generation_provider text NOT NULL,
    generation_model text NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    idempotency_key text,
    start_request_hash text NOT NULL,
    CONSTRAINT runs_status_check CHECK ((status = ANY (ARRAY['created'::text, 'retrieving'::text, 'specialists_running'::text, 'synthesizing'::text, 'validating'::text, 'awaiting_approval'::text, 'finalizing'::text, 'completed'::text, 'rejected'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT runs_version_check CHECK ((version >= 0))
);
--> statement-breakpoint
CREATE VIEW public.authorized_run_approval_grants WITH (security_barrier='true', security_invoker='true') AS
 SELECT DISTINCT authority_grant.persona_id,
    authority_grant.source_commit,
    run.id AS run_id,
    subject.id AS approval_subject_id,
    requirement.id AS approval_entry_id,
    opportunity.id AS opportunity_id,
    opportunity.account_id,
    authority_grant.authority,
    ((run.status = 'awaiting_approval'::text) AND (subject.superseded_by_subject_id IS NULL) AND (NOT (EXISTS ( SELECT 1
           FROM public.approval_decisions decision
          WHERE ((decision.approval_subject_id = subject.id) AND (decision.entry_id = requirement.id))))) AND (NOT (EXISTS ( SELECT 1
           FROM jsonb_array_elements_text(requirement.depends_on) dependency(entry_id)
          WHERE (NOT (EXISTS ( SELECT 1
                   FROM public.approval_decisions dependency_decision
                  WHERE ((dependency_decision.approval_subject_id = subject.id) AND (dependency_decision.entry_id = dependency.entry_id) AND (dependency_decision.action = ANY (ARRAY['approve_unchanged'::text, 'edit_and_approve'::text])))))))))) AS operable
   FROM (((((public.approval_authority_grants authority_grant
     JOIN public.opportunities opportunity ON ((opportunity.account_id = authority_grant.account_id)))
     JOIN public.runs run ON ((run.opportunity_id = opportunity.id)))
     JOIN public.approval_subjects subject ON ((subject.run_id = run.id)))
     JOIN public.approval_requirement_entries requirement ON ((requirement.approval_subject_id = subject.id)))
     JOIN LATERAL jsonb_array_elements_text(requirement.eligible_authorities) eligible(authority) ON ((eligible.authority = authority_grant.authority)));
--> statement-breakpoint
CREATE TABLE public.briefs (
    id text NOT NULL,
    run_id text NOT NULL,
    approval_subject_id text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    subject_hash text NOT NULL,
    finalized_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    draft_version integer DEFAULT 0 NOT NULL,
    CONSTRAINT briefs_draft_version_ck CHECK ((draft_version >= 0)),
    CONSTRAINT briefs_subject_hash_check CHECK ((length(subject_hash) > 0))
);
--> statement-breakpoint
CREATE TABLE public.citations (
    id text NOT NULL,
    claim_id text NOT NULL,
    evidence_version_id text NOT NULL,
    locator text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.claims (
    id text NOT NULL,
    run_id text NOT NULL,
    artifact_id text,
    statement text NOT NULL,
    confidence numeric NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT claims_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))
);
--> statement-breakpoint
CREATE TABLE public.contacts (
    id text NOT NULL,
    account_id text NOT NULL,
    name text NOT NULL,
    email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.context_checkpoints (
    id text NOT NULL,
    run_id text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    scope_hash text NOT NULL,
    policy_hash text NOT NULL,
    evidence_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.document_versions (
    id text NOT NULL,
    external_id text NOT NULL,
    version integer NOT NULL,
    source_type text NOT NULL,
    content_hash text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    event_date date,
    reliability_class text,
    source_locator text,
    classification_reason text,
    policy_hash text,
    CONSTRAINT document_versions_content_hash_check CHECK ((length(content_hash) > 0)),
    CONSTRAINT document_versions_provenance_ck CHECK (((num_nonnulls(reliability_class, source_locator, classification_reason, policy_hash) = 0) OR ((num_nulls(reliability_class, source_locator, classification_reason, policy_hash) = 0) AND (length(reliability_class) > 0) AND (length(source_locator) > 0) AND (length(classification_reason) > 0) AND (policy_hash ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT document_versions_version_check CHECK ((version > 0))
);
--> statement-breakpoint
CREATE TABLE public.generation_attempts (
    id text NOT NULL,
    run_id text NOT NULL,
    invocation_id text,
    operation text NOT NULL,
    status text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    request_id text,
    response_id text,
    possible_duplicate boolean DEFAULT false NOT NULL,
    input_tokens integer,
    output_tokens integer,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    ordinal integer DEFAULT 1 NOT NULL,
    logical_generation_id text NOT NULL,
    output_mode text,
    validation_attempts integer DEFAULT 0 NOT NULL,
    validation_issues jsonb DEFAULT '[]'::jsonb NOT NULL,
    warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT generation_attempts_input_tokens_check CHECK ((input_tokens >= 0)),
    CONSTRAINT generation_attempts_output_mode_ck CHECK (((output_mode IS NULL) OR (output_mode = ANY (ARRAY['native_schema'::text, 'prompted_json'::text])))),
    CONSTRAINT generation_attempts_output_tokens_check CHECK ((output_tokens >= 0)),
    CONSTRAINT generation_attempts_status_check CHECK ((status = ANY (ARRAY['attempt_started'::text, 'completed'::text, 'failed'::text, 'possible_duplicate'::text]))),
    CONSTRAINT generation_attempts_validation_attempts_ck CHECK ((validation_attempts >= 0))
);
--> statement-breakpoint
CREATE TABLE public.opportunity_policy_facts (
    opportunity_id text NOT NULL,
    discount_percent numeric NOT NULL,
    renewal_uplift_percent numeric NOT NULL,
    liability_cap_changed boolean DEFAULT false NOT NULL,
    data_retention_language boolean DEFAULT false NOT NULL,
    restricted_research_language boolean DEFAULT false NOT NULL,
    customer_specific_security_language boolean DEFAULT false NOT NULL,
    customer_facing_concession_language boolean DEFAULT false NOT NULL,
    conflicting_evidence boolean DEFAULT false NOT NULL,
    missing_material_evidence boolean DEFAULT false NOT NULL,
    source_commit text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.outbox_commands (
    id text NOT NULL,
    run_id text NOT NULL,
    type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    idempotency_key text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    delivery_attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    claim_owner text,
    claim_token text,
    claim_expires_at timestamp with time zone,
    published_at timestamp with time zone,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outbox_commands_delivery_attempts_check CHECK ((delivery_attempts >= 0)),
    CONSTRAINT outbox_commands_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'claimed'::text, 'published'::text, 'dead_letter_claimed'::text, 'dead_letter'::text])))
);
--> statement-breakpoint
CREATE TABLE public.personas (
    id text NOT NULL,
    display_name text NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_commit text,
    CONSTRAINT personas_source_commit_check CHECK (((source_commit IS NULL) OR (source_commit ~ '^[0-9a-f]{40}$'::text)))
);
--> statement-breakpoint
CREATE TABLE public.run_budget_reservations (
    id text NOT NULL,
    run_id text NOT NULL,
    reserved_output_tokens integer NOT NULL,
    actual_output_tokens integer,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    attempt_id text,
    invocation_id text,
    operation text NOT NULL,
    ordinal integer NOT NULL,
    granted_output_tokens integer NOT NULL,
    reserved_input_tokens integer DEFAULT 0 NOT NULL,
    actual_input_tokens integer,
    request_id text,
    response_id text,
    failure_category text,
    failure_code text,
    logical_generation_id text NOT NULL,
    CONSTRAINT run_budget_reservations_grant_ck CHECK ((granted_output_tokens > 0)),
    CONSTRAINT run_budget_reservations_reserved_output_tokens_check CHECK ((reserved_output_tokens > 0)),
    CONSTRAINT run_budget_reservations_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'settled'::text, 'released'::text, 'possible_duplicate'::text])))
);
--> statement-breakpoint
CREATE TABLE public.run_budgets (
    run_id text NOT NULL,
    max_calls integer NOT NULL,
    used_calls integer DEFAULT 0 NOT NULL,
    used_input_tokens integer DEFAULT 0 NOT NULL,
    used_output_tokens integer DEFAULT 0 NOT NULL,
    reserved_output_tokens integer DEFAULT 0 NOT NULL,
    deadline_ms integer,
    deadline_at timestamp with time zone DEFAULT (now() + '01:00:00'::interval) NOT NULL,
    CONSTRAINT run_budgets_check CHECK ((used_calls <= max_calls)),
    CONSTRAINT run_budgets_deadline_ms_check CHECK ((deadline_ms > 0)),
    CONSTRAINT run_budgets_max_calls_check CHECK ((max_calls > 0)),
    CONSTRAINT run_budgets_reserved_output_tokens_check CHECK ((reserved_output_tokens >= 0)),
    CONSTRAINT run_budgets_used_calls_check CHECK ((used_calls >= 0)),
    CONSTRAINT run_budgets_used_input_tokens_check CHECK ((used_input_tokens >= 0)),
    CONSTRAINT run_budgets_used_output_tokens_check CHECK ((used_output_tokens >= 0))
);
--> statement-breakpoint
CREATE TABLE public.run_events (
    id text NOT NULL,
    run_id text NOT NULL,
    sequence integer NOT NULL,
    type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT run_events_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT run_events_version_ck CHECK ((version > 0))
);
--> statement-breakpoint
CREATE TABLE public.run_evidence_manifest_entries (
    manifest_id text NOT NULL,
    evidence_version_id text NOT NULL,
    rank integer NOT NULL,
    score numeric NOT NULL,
    content_hash text NOT NULL,
    citation_id text NOT NULL,
    source_locator text NOT NULL,
    source_type text NOT NULL,
    sensitivity text NOT NULL,
    classification_reason text NOT NULL,
    policy_hash text NOT NULL,
    lexical_rank integer,
    semantic_rank integer,
    query_rank integer NOT NULL,
    reliability_adjustment numeric NOT NULL,
    recency_adjustment numeric NOT NULL,
    included_characters integer NOT NULL,
    fusion_score numeric NOT NULL,
    CONSTRAINT run_evidence_manifest_entries_content_hash_check CHECK ((length(content_hash) > 0)),
    CONSTRAINT run_evidence_manifest_entries_included_characters_ck CHECK ((included_characters > 0)),
    CONSTRAINT run_evidence_manifest_entries_lexical_rank_ck CHECK (((lexical_rank IS NULL) OR (lexical_rank > 0))),
    CONSTRAINT run_evidence_manifest_entries_query_rank_ck CHECK ((query_rank > 0)),
    CONSTRAINT run_evidence_manifest_entries_rank_check CHECK ((rank > 0)),
    CONSTRAINT run_evidence_manifest_entries_semantic_rank_ck CHECK (((semantic_rank IS NULL) OR (semantic_rank > 0)))
);
--> statement-breakpoint
CREATE TABLE public.run_evidence_manifests (
    id text NOT NULL,
    run_id text NOT NULL,
    scope_hash text NOT NULL,
    policy_hash text NOT NULL,
    index_profile text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    query_hash text NOT NULL,
    embedding_provider text NOT NULL,
    embedding_model text NOT NULL,
    embedding_dimension integer NOT NULL,
    embedding_version text NOT NULL,
    embedding_normalization text NOT NULL,
    context_limit integer NOT NULL,
    diagnostics jsonb NOT NULL,
    CONSTRAINT run_evidence_manifests_context_limit_ck CHECK ((context_limit > 0)),
    CONSTRAINT run_evidence_manifests_embedding_dimension_ck CHECK ((embedding_dimension > 0)),
    CONSTRAINT run_evidence_manifests_index_profile_check CHECK ((length(index_profile) > 0)),
    CONSTRAINT run_evidence_manifests_policy_hash_check CHECK ((length(policy_hash) > 0)),
    CONSTRAINT run_evidence_manifests_query_hash_ck CHECK ((query_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT run_evidence_manifests_scope_hash_check CHECK ((length(scope_hash) > 0))
);
--> statement-breakpoint
CREATE TABLE public.specialist_artifacts (
    id text NOT NULL,
    run_id text NOT NULL,
    kind text NOT NULL,
    evidence_manifest_id text,
    content jsonb DEFAULT '{}'::jsonb NOT NULL,
    content_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    draft_version integer DEFAULT 0 NOT NULL,
    outcome text DEFAULT 'success'::text NOT NULL,
    warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    logical_generation_id text,
    generation_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT specialist_artifacts_content_hash_check CHECK ((length(content_hash) > 0)),
    CONSTRAINT specialist_artifacts_draft_version_ck CHECK ((draft_version >= 0)),
    CONSTRAINT specialist_artifacts_outcome_ck CHECK ((outcome = ANY (ARRAY['success'::text, 'degraded'::text, 'failed'::text])))
);
--> statement-breakpoint
CREATE TABLE public.step_invocations (
    id text NOT NULL,
    run_id text NOT NULL,
    step text NOT NULL,
    owner text,
    lease_token text,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    attempt integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'leased'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    causal_command_id text,
    CONSTRAINT step_invocations_attempt_check CHECK ((attempt > 0)),
    CONSTRAINT step_invocations_lease_ck CHECK ((((status = 'leased'::text) AND (owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR (status <> 'leased'::text))),
    CONSTRAINT step_invocations_status_check CHECK ((status = ANY (ARRAY['leased'::text, 'completed'::text, 'abandoned'::text])))
);
--> statement-breakpoint
CREATE TABLE public.trace_spans (
    id text NOT NULL,
    run_id text NOT NULL,
    parent_id text,
    kind text NOT NULL,
    status text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    trace_id text NOT NULL,
    span_id text NOT NULL,
    step text NOT NULL,
    attempt integer NOT NULL,
    CONSTRAINT trace_spans_attempt_ck CHECK ((attempt > 0))
);
--> statement-breakpoint
CREATE TABLE public.workflow_checkpoints (
    id text NOT NULL,
    run_id text NOT NULL,
    step text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    invocation_id text,
    logical_generation_id text
);
--> statement-breakpoint
ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_authority_grants
    ADD CONSTRAINT approval_authority_grants_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_authority_grants
    ADD CONSTRAINT approval_authority_grants_scope_uq UNIQUE (persona_id, account_id, authority);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_decisions
    ADD CONSTRAINT approval_decisions_idempotency_uq UNIQUE (idempotency_key);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_decisions
    ADD CONSTRAINT approval_decisions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_decisions
    ADD CONSTRAINT approval_decisions_subject_entry_uq UNIQUE (approval_subject_id, entry_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_requirement_entries
    ADD CONSTRAINT approval_requirement_entries_subject_entry_uq PRIMARY KEY (approval_subject_id, id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_requirement_entries
    ADD CONSTRAINT approval_requirement_entries_subject_ordinal_uq UNIQUE (approval_subject_id, ordinal);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_subjects
    ADD CONSTRAINT approval_subjects_id_run_hash_uq UNIQUE (id, run_id, subject_hash);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_subjects
    ADD CONSTRAINT approval_subjects_id_run_uq UNIQUE (id, run_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_subjects
    ADD CONSTRAINT approval_subjects_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_subjects
    ADD CONSTRAINT approval_subjects_run_version_uq UNIQUE (run_id, draft_version);
--> statement-breakpoint
ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (version);
--> statement-breakpoint
ALTER TABLE ONLY public.briefs
    ADD CONSTRAINT briefs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.briefs
    ADD CONSTRAINT briefs_run_version_uq UNIQUE (run_id, draft_version);
--> statement-breakpoint
ALTER TABLE ONLY public.citations
    ADD CONSTRAINT citations_claim_evidence_locator_uq UNIQUE (claim_id, evidence_version_id, locator);
--> statement-breakpoint
ALTER TABLE ONLY public.citations
    ADD CONSTRAINT citations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.claims
    ADD CONSTRAINT claims_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.context_checkpoints
    ADD CONSTRAINT context_checkpoints_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_external_version_uq UNIQUE (external_id, version);
--> statement-breakpoint
ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.evidence_versions
    ADD CONSTRAINT evidence_versions_document_chunk_uq UNIQUE (document_version_id, chunk_index);
--> statement-breakpoint
ALTER TABLE ONLY public.evidence_versions
    ADD CONSTRAINT evidence_versions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.generation_attempts
    ADD CONSTRAINT generation_attempts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.opportunities
    ADD CONSTRAINT opportunities_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.opportunity_policy_facts
    ADD CONSTRAINT opportunity_policy_facts_pkey PRIMARY KEY (opportunity_id);
--> statement-breakpoint
ALTER TABLE ONLY public.outbox_commands
    ADD CONSTRAINT outbox_commands_idempotency_key_key UNIQUE (idempotency_key);
--> statement-breakpoint
ALTER TABLE ONLY public.outbox_commands
    ADD CONSTRAINT outbox_commands_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.permission_grants
    ADD CONSTRAINT permission_grants_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.personas
    ADD CONSTRAINT personas_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_budget_reservations
    ADD CONSTRAINT run_budget_reservations_generation_operation_ordinal_uq UNIQUE (run_id, logical_generation_id, operation, ordinal);
--> statement-breakpoint
ALTER TABLE ONLY public.run_budget_reservations
    ADD CONSTRAINT run_budget_reservations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_budgets
    ADD CONSTRAINT run_budgets_pkey PRIMARY KEY (run_id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_events
    ADD CONSTRAINT run_events_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_events
    ADD CONSTRAINT run_events_run_sequence_uq UNIQUE (run_id, sequence);
--> statement-breakpoint
ALTER TABLE ONLY public.run_evidence_manifest_entries
    ADD CONSTRAINT run_evidence_manifest_entries_pkey PRIMARY KEY (manifest_id, evidence_version_id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_evidence_manifests
    ADD CONSTRAINT run_evidence_manifests_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.specialist_artifacts
    ADD CONSTRAINT specialist_artifacts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.specialist_artifacts
    ADD CONSTRAINT specialist_artifacts_run_kind_version_uq UNIQUE (run_id, kind, draft_version);
--> statement-breakpoint
ALTER TABLE ONLY public.step_invocations
    ADD CONSTRAINT step_invocations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.step_invocations
    ADD CONSTRAINT step_invocations_run_step_attempt_uq UNIQUE (run_id, step, attempt);
--> statement-breakpoint
ALTER TABLE ONLY public.trace_spans
    ADD CONSTRAINT trace_spans_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.trace_spans
    ADD CONSTRAINT trace_spans_run_span_uq UNIQUE (run_id, span_id);
--> statement-breakpoint
ALTER TABLE ONLY public.workflow_checkpoints
    ADD CONSTRAINT workflow_checkpoints_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.workflow_checkpoints
    ADD CONSTRAINT workflow_checkpoints_run_step_uq UNIQUE (run_id, step);
--> statement-breakpoint
CREATE INDEX approval_authority_grants_source_commit_scope_idx ON public.approval_authority_grants USING btree (source_commit, persona_id, account_id, authority, id);
--> statement-breakpoint
CREATE INDEX auth_sessions_active_idx ON public.auth_sessions USING btree (version, persona_id, expires_at) WHERE (revoked_at IS NULL);
--> statement-breakpoint
CREATE INDEX evidence_versions_authorized_exact_idx ON public.evidence_versions USING btree (account_id, opportunity_id, source_type, sensitivity, embedding_profile, embedding_dimension, id);
--> statement-breakpoint
CREATE INDEX evidence_versions_fts_idx ON public.evidence_versions USING gin (lexical_content);
--> statement-breakpoint
CREATE INDEX evidence_versions_provenance_idx ON public.evidence_versions USING btree (account_id, opportunity_id, source_type, sensitivity, event_date, id);
--> statement-breakpoint
CREATE INDEX generation_attempts_logical_generation_idx ON public.generation_attempts USING btree (run_id, logical_generation_id, operation, ordinal);
--> statement-breakpoint
CREATE INDEX outbox_commands_pending_idx ON public.outbox_commands USING btree (status, available_at, id);
--> statement-breakpoint
CREATE INDEX permission_grants_source_commit_persona_idx ON public.permission_grants USING btree (source_commit, persona_id, account_id, source_type, id);
--> statement-breakpoint
CREATE INDEX personas_source_commit_display_name_idx ON public.personas USING btree (source_commit, display_name, id);
--> statement-breakpoint
CREATE UNIQUE INDEX run_budget_reservations_attempt_uq ON public.run_budget_reservations USING btree (attempt_id) WHERE (attempt_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX run_events_run_created_idx ON public.run_events USING btree (run_id, created_at, sequence);
--> statement-breakpoint
CREATE UNIQUE INDEX run_evidence_manifest_entries_citation_uq ON public.run_evidence_manifest_entries USING btree (citation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX run_evidence_manifests_run_uq ON public.run_evidence_manifests USING btree (run_id);
--> statement-breakpoint
CREATE UNIQUE INDEX runs_idempotency_key_uq ON public.runs USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX runs_one_active_opportunity_uq ON public.runs USING btree (opportunity_id) WHERE (status = ANY (ARRAY['created'::text, 'retrieving'::text, 'specialists_running'::text, 'synthesizing'::text, 'validating'::text, 'awaiting_approval'::text, 'finalizing'::text]));
--> statement-breakpoint
CREATE UNIQUE INDEX specialist_artifacts_logical_generation_uq ON public.specialist_artifacts USING btree (logical_generation_id) WHERE (logical_generation_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX step_invocations_live_idx ON public.step_invocations USING btree (run_id, step, status, lease_expires_at);
--> statement-breakpoint
CREATE UNIQUE INDEX step_invocations_one_active_causal_command_uq ON public.step_invocations USING btree (causal_command_id) WHERE (status = 'leased'::text);
--> statement-breakpoint
CREATE INDEX trace_spans_run_started_idx ON public.trace_spans USING btree (run_id, started_at, span_id);
--> statement-breakpoint
CREATE INDEX trace_spans_trace_idx ON public.trace_spans USING btree (trace_id, started_at, span_id);
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_checkpoints_logical_generation_uq ON public.workflow_checkpoints USING btree (run_id, logical_generation_id) WHERE (logical_generation_id IS NOT NULL);
--> statement-breakpoint
CREATE TRIGGER approval_decisions_immutable BEFORE DELETE OR UPDATE ON public.approval_decisions FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
--> statement-breakpoint
CREATE TRIGGER approval_requirement_entries_immutable BEFORE DELETE OR UPDATE ON public.approval_requirement_entries FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
--> statement-breakpoint
CREATE TRIGGER approval_subjects_immutable BEFORE DELETE OR UPDATE ON public.approval_subjects FOR EACH ROW EXECUTE FUNCTION public.protect_approval_subject_snapshot();
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE DELETE OR UPDATE ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_observability_mutation();
--> statement-breakpoint
CREATE TRIGGER briefs_finalized_immutable BEFORE DELETE OR UPDATE ON public.briefs FOR EACH ROW EXECUTE FUNCTION public.reject_finalized_brief_change();
--> statement-breakpoint
CREATE TRIGGER document_versions_immutable BEFORE DELETE OR UPDATE ON public.document_versions FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
--> statement-breakpoint
CREATE TRIGGER evidence_versions_bind_embedding_content_hash BEFORE INSERT ON public.evidence_versions FOR EACH ROW EXECUTE FUNCTION public.bind_embedding_content_hash();
--> statement-breakpoint
CREATE TRIGGER evidence_versions_immutable BEFORE DELETE OR UPDATE ON public.evidence_versions FOR EACH ROW EXECUTE FUNCTION public.enforce_evidence_version_indexing();
--> statement-breakpoint
CREATE TRIGGER run_events_append_only BEFORE DELETE OR UPDATE ON public.run_events FOR EACH ROW EXECUTE FUNCTION public.reject_observability_mutation();
--> statement-breakpoint
CREATE TRIGGER run_evidence_manifest_entries_immutable BEFORE DELETE OR UPDATE ON public.run_evidence_manifest_entries FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
--> statement-breakpoint
CREATE TRIGGER run_evidence_manifests_immutable BEFORE DELETE OR UPDATE ON public.run_evidence_manifests FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
--> statement-breakpoint
CREATE TRIGGER trace_spans_append_only BEFORE DELETE OR UPDATE ON public.trace_spans FOR EACH ROW EXECUTE FUNCTION public.reject_observability_mutation();
--> statement-breakpoint
ALTER TABLE ONLY public.approval_authority_grants
    ADD CONSTRAINT approval_authority_grants_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_authority_grants
    ADD CONSTRAINT approval_authority_grants_persona_id_fkey FOREIGN KEY (persona_id) REFERENCES public.personas(id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_decisions
    ADD CONSTRAINT approval_decisions_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.personas(id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_decisions
    ADD CONSTRAINT approval_decisions_approval_subject_id_fkey FOREIGN KEY (approval_subject_id) REFERENCES public.approval_subjects(id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_decisions
    ADD CONSTRAINT approval_decisions_entry_fk FOREIGN KEY (approval_subject_id, entry_id) REFERENCES public.approval_requirement_entries(approval_subject_id, id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_requirement_entries
    ADD CONSTRAINT approval_requirement_entries_approval_subject_id_fkey FOREIGN KEY (approval_subject_id) REFERENCES public.approval_subjects(id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_subjects
    ADD CONSTRAINT approval_subjects_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_subjects
    ADD CONSTRAINT approval_subjects_superseded_by_subject_id_fkey FOREIGN KEY (superseded_by_subject_id) REFERENCES public.approval_subjects(id);
--> statement-breakpoint
ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.personas(id);
--> statement-breakpoint
ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_persona_id_fkey FOREIGN KEY (persona_id) REFERENCES public.personas(id);
--> statement-breakpoint
ALTER TABLE ONLY public.briefs
    ADD CONSTRAINT briefs_approval_subject_id_fkey FOREIGN KEY (approval_subject_id) REFERENCES public.approval_subjects(id);
--> statement-breakpoint
ALTER TABLE ONLY public.briefs
    ADD CONSTRAINT briefs_approval_subject_run_fk FOREIGN KEY (approval_subject_id, run_id) REFERENCES public.approval_subjects(id, run_id);
--> statement-breakpoint
ALTER TABLE ONLY public.briefs
    ADD CONSTRAINT briefs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.citations
    ADD CONSTRAINT citations_claim_id_fkey FOREIGN KEY (claim_id) REFERENCES public.claims(id);
--> statement-breakpoint
ALTER TABLE ONLY public.citations
    ADD CONSTRAINT citations_evidence_version_id_fkey FOREIGN KEY (evidence_version_id) REFERENCES public.evidence_versions(id);
--> statement-breakpoint
ALTER TABLE ONLY public.claims
    ADD CONSTRAINT claims_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.specialist_artifacts(id);
--> statement-breakpoint
ALTER TABLE ONLY public.claims
    ADD CONSTRAINT claims_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
--> statement-breakpoint
ALTER TABLE ONLY public.context_checkpoints
    ADD CONSTRAINT context_checkpoints_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.evidence_versions
    ADD CONSTRAINT evidence_versions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
--> statement-breakpoint
ALTER TABLE ONLY public.evidence_versions
    ADD CONSTRAINT evidence_versions_document_version_id_fkey FOREIGN KEY (document_version_id) REFERENCES public.document_versions(id);
--> statement-breakpoint
ALTER TABLE ONLY public.evidence_versions
    ADD CONSTRAINT evidence_versions_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES public.opportunities(id);
--> statement-breakpoint
ALTER TABLE ONLY public.generation_attempts
    ADD CONSTRAINT generation_attempts_invocation_id_fkey FOREIGN KEY (invocation_id) REFERENCES public.step_invocations(id);
--> statement-breakpoint
ALTER TABLE ONLY public.generation_attempts
    ADD CONSTRAINT generation_attempts_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.opportunities
    ADD CONSTRAINT opportunities_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
--> statement-breakpoint
ALTER TABLE ONLY public.opportunity_policy_facts
    ADD CONSTRAINT opportunity_policy_facts_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES public.opportunities(id);
--> statement-breakpoint
ALTER TABLE ONLY public.outbox_commands
    ADD CONSTRAINT outbox_commands_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.permission_grants
    ADD CONSTRAINT permission_grants_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
--> statement-breakpoint
ALTER TABLE ONLY public.permission_grants
    ADD CONSTRAINT permission_grants_persona_id_fkey FOREIGN KEY (persona_id) REFERENCES public.personas(id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_budget_reservations
    ADD CONSTRAINT run_budget_reservations_attempt_fk FOREIGN KEY (attempt_id) REFERENCES public.generation_attempts(id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_budget_reservations
    ADD CONSTRAINT run_budget_reservations_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_budgets
    ADD CONSTRAINT run_budgets_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_events
    ADD CONSTRAINT run_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_evidence_manifest_entries
    ADD CONSTRAINT run_evidence_manifest_entries_evidence_version_id_fkey FOREIGN KEY (evidence_version_id) REFERENCES public.evidence_versions(id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_evidence_manifest_entries
    ADD CONSTRAINT run_evidence_manifest_entries_manifest_id_fkey FOREIGN KEY (manifest_id) REFERENCES public.run_evidence_manifests(id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_evidence_manifests
    ADD CONSTRAINT run_evidence_manifests_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES public.opportunities(id);
--> statement-breakpoint
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.personas(id);
--> statement-breakpoint
ALTER TABLE ONLY public.specialist_artifacts
    ADD CONSTRAINT specialist_artifacts_evidence_manifest_id_fkey FOREIGN KEY (evidence_manifest_id) REFERENCES public.run_evidence_manifests(id);
--> statement-breakpoint
ALTER TABLE ONLY public.specialist_artifacts
    ADD CONSTRAINT specialist_artifacts_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.step_invocations
    ADD CONSTRAINT step_invocations_causal_command_fk FOREIGN KEY (causal_command_id) REFERENCES public.outbox_commands(id);
--> statement-breakpoint
ALTER TABLE ONLY public.step_invocations
    ADD CONSTRAINT step_invocations_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.trace_spans
    ADD CONSTRAINT trace_spans_parent_fk FOREIGN KEY (run_id, parent_id) REFERENCES public.trace_spans(run_id, span_id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE ONLY public.workflow_checkpoints
    ADD CONSTRAINT workflow_checkpoints_invocation_id_fkey FOREIGN KEY (invocation_id) REFERENCES public.step_invocations(id);
--> statement-breakpoint
ALTER TABLE ONLY public.workflow_checkpoints
    ADD CONSTRAINT workflow_checkpoints_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);
