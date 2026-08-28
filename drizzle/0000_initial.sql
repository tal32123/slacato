CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS personas (
  id text PRIMARY KEY, display_name text NOT NULL, role text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS accounts (id text PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS opportunities (
  id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id), name text NOT NULL,
  restricted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS contacts (
  id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id), name text NOT NULL, email text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS permission_grants (
  id text PRIMARY KEY, persona_id text NOT NULL REFERENCES personas(id), account_id text REFERENCES accounts(id), source_type text,
  can_read boolean NOT NULL DEFAULT false, can_read_restricted boolean NOT NULL DEFAULT false, can_approve boolean NOT NULL DEFAULT false, sensitive_pricing boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS document_versions (
  id text PRIMARY KEY, external_id text NOT NULL, version integer NOT NULL CHECK (version > 0), source_type text NOT NULL,
  content_hash text NOT NULL CHECK (length(content_hash) > 0), content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_versions_external_version_uq UNIQUE (external_id, version)
);
CREATE TABLE IF NOT EXISTS evidence_versions (
  id text PRIMARY KEY, document_version_id text NOT NULL REFERENCES document_versions(id), account_id text NOT NULL REFERENCES accounts(id),
  opportunity_id text REFERENCES opportunities(id), chunk_index integer NOT NULL CHECK (chunk_index >= 0), source_type text NOT NULL,
  sensitivity text NOT NULL, content_hash text NOT NULL CHECK (length(content_hash) > 0), content text NOT NULL,
  lexical_content tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED,
  embedding vector, embedding_provider text, embedding_model text, embedding_dimension integer, embedding_profile text,
  embedding_version text, embedding_normalization text, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_versions_document_chunk_uq UNIQUE (document_version_id, chunk_index),
  CONSTRAINT evidence_versions_embedding_profile_ck CHECK (
    (embedding IS NULL AND embedding_provider IS NULL AND embedding_model IS NULL AND embedding_dimension IS NULL AND embedding_profile IS NULL AND embedding_version IS NULL AND embedding_normalization IS NULL)
    OR (embedding IS NOT NULL AND embedding_provider IS NOT NULL AND embedding_model IS NOT NULL AND embedding_dimension > 0 AND embedding_profile IS NOT NULL AND embedding_version IS NOT NULL AND embedding_normalization IS NOT NULL AND vector_dims(embedding) = embedding_dimension)
  )
);
CREATE INDEX IF NOT EXISTS evidence_versions_fts_idx ON evidence_versions USING gin (lexical_content);
CREATE INDEX IF NOT EXISTS evidence_versions_authorized_exact_idx ON evidence_versions (account_id, opportunity_id, source_type, sensitivity, embedding_profile, embedding_dimension, id);

CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY, opportunity_id text NOT NULL REFERENCES opportunities(id), requested_by text NOT NULL REFERENCES personas(id),
  status text NOT NULL CHECK (status IN ('created','retrieving','specialists_running','synthesizing','validating','awaiting_approval','finalizing','completed','rejected','failed')),
  generation_provider text NOT NULL, generation_model text NOT NULL, version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS run_evidence_manifests (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), scope_hash text NOT NULL CHECK (length(scope_hash) > 0),
  policy_hash text NOT NULL CHECK (length(policy_hash) > 0), index_profile text NOT NULL CHECK (length(index_profile) > 0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS run_evidence_manifest_entries (
  manifest_id text NOT NULL REFERENCES run_evidence_manifests(id), evidence_version_id text NOT NULL REFERENCES evidence_versions(id),
  rank integer NOT NULL CHECK (rank > 0), score numeric NOT NULL, content_hash text NOT NULL CHECK (length(content_hash) > 0),
  PRIMARY KEY (manifest_id, evidence_version_id)
);
CREATE TABLE IF NOT EXISTS outbox_commands (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','published','dead_letter')),
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0), available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz, claim_owner text, claim_token text, claim_expires_at timestamptz, published_at timestamptz, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_commands_pending_idx ON outbox_commands (status, available_at, id);
CREATE TABLE IF NOT EXISTS step_invocations (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), step text NOT NULL, owner text,
  lease_token text, causal_command_id text REFERENCES outbox_commands(id), lease_expires_at timestamptz, heartbeat_at timestamptz, attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  status text NOT NULL DEFAULT 'leased' CHECK (status IN ('leased','completed','abandoned')), created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  CONSTRAINT step_invocations_run_step_attempt_uq UNIQUE (run_id, step, attempt),
  CONSTRAINT step_invocations_lease_ck CHECK ((status = 'leased' AND owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR (status <> 'leased'))
);
CREATE INDEX IF NOT EXISTS step_invocations_live_idx ON step_invocations (run_id, step, status, lease_expires_at);
CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), step text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT workflow_checkpoints_run_step_uq UNIQUE (run_id, step)
);
CREATE TABLE IF NOT EXISTS generation_attempts (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), invocation_id text REFERENCES step_invocations(id), operation text NOT NULL,
  status text NOT NULL CHECK (status IN ('attempt_started','completed','failed','possible_duplicate')), provider text NOT NULL, model text NOT NULL,
  request_id text, response_id text, possible_duplicate boolean NOT NULL DEFAULT false, input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0), started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS context_checkpoints (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), payload jsonb NOT NULL DEFAULT '{}'::jsonb, scope_hash text NOT NULL,
  policy_hash text NOT NULL, evidence_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS specialist_artifacts (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), kind text NOT NULL, evidence_manifest_id text REFERENCES run_evidence_manifests(id),
  content jsonb NOT NULL DEFAULT '{}'::jsonb, content_hash text NOT NULL CHECK (length(content_hash) > 0), created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT specialist_artifacts_run_kind_uq UNIQUE (run_id, kind)
);
CREATE TABLE IF NOT EXISTS claims (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), artifact_id text REFERENCES specialist_artifacts(id),
  statement text NOT NULL, confidence numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS citations (
  id text PRIMARY KEY, claim_id text NOT NULL REFERENCES claims(id), evidence_version_id text NOT NULL REFERENCES evidence_versions(id),
  locator text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT citations_claim_evidence_locator_uq UNIQUE (claim_id, evidence_version_id, locator)
);
CREATE TABLE IF NOT EXISTS approval_subjects (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), draft_version integer NOT NULL CHECK (draft_version >= 0), subject_hash text NOT NULL CHECK (length(subject_hash) > 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, policy_triggers jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_subjects_run_version_uq UNIQUE (run_id, draft_version), CONSTRAINT approval_subjects_subject_hash_uq UNIQUE (subject_hash),
  CONSTRAINT approval_subjects_id_run_hash_uq UNIQUE (id, run_id, subject_hash)
);
CREATE TABLE IF NOT EXISTS approval_decisions (
  id text PRIMARY KEY, approval_subject_id text NOT NULL REFERENCES approval_subjects(id),
  action text NOT NULL CHECK (action IN ('approve_unchanged','edit_and_approve','reject')), actor_id text NOT NULL REFERENCES personas(id), rationale text,
  edited_payload jsonb, created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT approval_decisions_subject_uq UNIQUE (approval_subject_id),
  CONSTRAINT approval_decisions_rationale_ck CHECK ((action IN ('edit_and_approve','reject') AND rationale IS NOT NULL AND length(btrim(rationale)) > 0) OR action = 'approve_unchanged'),
  CONSTRAINT approval_decisions_edit_ck CHECK ((action = 'edit_and_approve' AND edited_payload IS NOT NULL) OR action <> 'edit_and_approve')
);
CREATE TABLE IF NOT EXISTS briefs (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), approval_subject_id text REFERENCES approval_subjects(id),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, subject_hash text NOT NULL CHECK (length(subject_hash) > 0), finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT briefs_run_uq UNIQUE (run_id),
  CONSTRAINT briefs_approval_subject_snapshot_fk FOREIGN KEY (approval_subject_id, run_id, subject_hash) REFERENCES approval_subjects(id, run_id, subject_hash)
);
CREATE TABLE IF NOT EXISTS trace_spans (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), parent_id text, kind text NOT NULL, status text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz
);
CREATE TABLE IF NOT EXISTS run_events (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), sequence integer NOT NULL CHECK (sequence > 0), type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT run_events_run_sequence_uq UNIQUE (run_id, sequence)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY, run_id text REFERENCES runs(id), actor_id text REFERENCES personas(id), type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '55000'; END; $$;
DROP TRIGGER IF EXISTS document_versions_immutable ON document_versions;
CREATE TRIGGER document_versions_immutable BEFORE UPDATE OR DELETE ON document_versions FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
DROP TRIGGER IF EXISTS evidence_versions_immutable ON evidence_versions;
CREATE TRIGGER evidence_versions_immutable BEFORE UPDATE OR DELETE ON evidence_versions FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
DROP TRIGGER IF EXISTS run_evidence_manifests_immutable ON run_evidence_manifests;
CREATE TRIGGER run_evidence_manifests_immutable BEFORE UPDATE OR DELETE ON run_evidence_manifests FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
DROP TRIGGER IF EXISTS approval_subjects_immutable ON approval_subjects;
CREATE TRIGGER approval_subjects_immutable BEFORE UPDATE OR DELETE ON approval_subjects FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
DROP TRIGGER IF EXISTS approval_decisions_immutable ON approval_decisions;
CREATE TRIGGER approval_decisions_immutable BEFORE UPDATE OR DELETE ON approval_decisions FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

CREATE OR REPLACE FUNCTION reject_finalized_brief_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.finalized_at IS NOT NULL THEN RAISE EXCEPTION 'finalized briefs are immutable' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS briefs_finalized_immutable ON briefs;
CREATE TRIGGER briefs_finalized_immutable BEFORE UPDATE OR DELETE ON briefs FOR EACH ROW EXECUTE FUNCTION reject_finalized_brief_change();
