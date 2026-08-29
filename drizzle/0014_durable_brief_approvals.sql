ALTER TABLE runs ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS start_request_hash text;
UPDATE runs SET start_request_hash = repeat('0', 64) WHERE start_request_hash IS NULL;
ALTER TABLE runs ALTER COLUMN start_request_hash SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency_key_uq ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_opportunity_uq ON runs(opportunity_id)
  WHERE status IN ('created','retrieving','specialists_running','synthesizing','validating','awaiting_approval','finalizing');

ALTER TABLE run_budgets ADD COLUMN IF NOT EXISTS deadline_at timestamptz;
UPDATE run_budgets budget SET deadline_at = run.created_at + (coalesce(budget.deadline_ms, 60000)::text || ' milliseconds')::interval
  FROM runs run WHERE run.id = budget.run_id AND budget.deadline_at IS NULL;
ALTER TABLE run_budgets ALTER COLUMN deadline_at SET NOT NULL;
ALTER TABLE run_budgets ALTER COLUMN deadline_at SET DEFAULT (now() + interval '1 hour');

ALTER TABLE workflow_checkpoints ADD COLUMN IF NOT EXISTS invocation_id text REFERENCES step_invocations(id);
ALTER TABLE workflow_checkpoints ADD COLUMN IF NOT EXISTS logical_generation_id text;
CREATE UNIQUE INDEX IF NOT EXISTS workflow_checkpoints_logical_generation_uq ON workflow_checkpoints(run_id, logical_generation_id)
  WHERE logical_generation_id IS NOT NULL;

ALTER TABLE generation_attempts ADD COLUMN IF NOT EXISTS logical_generation_id text;
ALTER TABLE generation_attempts ADD COLUMN IF NOT EXISTS output_mode text;
ALTER TABLE generation_attempts ADD COLUMN IF NOT EXISTS validation_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE generation_attempts ADD COLUMN IF NOT EXISTS validation_issues jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE generation_attempts ADD COLUMN IF NOT EXISTS warnings jsonb NOT NULL DEFAULT '[]'::jsonb;
UPDATE generation_attempts SET logical_generation_id = 'generation_' || id WHERE logical_generation_id IS NULL;
ALTER TABLE generation_attempts ALTER COLUMN logical_generation_id SET NOT NULL;
ALTER TABLE generation_attempts ADD CONSTRAINT generation_attempts_output_mode_ck CHECK (output_mode IS NULL OR output_mode IN ('native_schema','prompted_json'));
ALTER TABLE generation_attempts ADD CONSTRAINT generation_attempts_validation_attempts_ck CHECK (validation_attempts >= 0);
CREATE INDEX IF NOT EXISTS generation_attempts_logical_generation_idx ON generation_attempts(run_id, logical_generation_id, operation, ordinal);

ALTER TABLE run_budget_reservations ADD COLUMN IF NOT EXISTS logical_generation_id text;
UPDATE run_budget_reservations reservation SET logical_generation_id = attempt.logical_generation_id
  FROM generation_attempts attempt WHERE attempt.id = reservation.attempt_id AND reservation.logical_generation_id IS NULL;
UPDATE run_budget_reservations SET logical_generation_id = 'generation_' || id WHERE logical_generation_id IS NULL;
ALTER TABLE run_budget_reservations ALTER COLUMN logical_generation_id SET NOT NULL;
ALTER TABLE run_budget_reservations DROP CONSTRAINT IF EXISTS run_budget_reservations_invocation_operation_ordinal_uq;
ALTER TABLE run_budget_reservations ADD CONSTRAINT run_budget_reservations_generation_operation_ordinal_uq
  UNIQUE (run_id, logical_generation_id, operation, ordinal);

ALTER TABLE specialist_artifacts DROP CONSTRAINT IF EXISTS specialist_artifacts_run_kind_uq;
ALTER TABLE specialist_artifacts ADD COLUMN IF NOT EXISTS draft_version integer NOT NULL DEFAULT 0;
ALTER TABLE specialist_artifacts ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'success';
ALTER TABLE specialist_artifacts ADD COLUMN IF NOT EXISTS warnings jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE specialist_artifacts ADD COLUMN IF NOT EXISTS logical_generation_id text;
ALTER TABLE specialist_artifacts ADD COLUMN IF NOT EXISTS generation_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE specialist_artifacts ADD CONSTRAINT specialist_artifacts_outcome_ck CHECK (outcome IN ('success','degraded','failed'));
ALTER TABLE specialist_artifacts ADD CONSTRAINT specialist_artifacts_draft_version_ck CHECK (draft_version >= 0);
ALTER TABLE specialist_artifacts ADD CONSTRAINT specialist_artifacts_run_kind_version_uq UNIQUE (run_id, kind, draft_version);
CREATE UNIQUE INDEX IF NOT EXISTS specialist_artifacts_logical_generation_uq ON specialist_artifacts(logical_generation_id) WHERE logical_generation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS approval_authority_grants (
  id text PRIMARY KEY,
  persona_id text NOT NULL REFERENCES personas(id),
  account_id text NOT NULL REFERENCES accounts(id),
  authority text NOT NULL CHECK (authority IN ('deal_desk','sales_leader','legal_reviewer','account_owner')),
  demo_only boolean NOT NULL DEFAULT false,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_authority_grants_scope_uq UNIQUE (persona_id, account_id, authority)
);

CREATE TABLE IF NOT EXISTS opportunity_policy_facts (
  opportunity_id text PRIMARY KEY REFERENCES opportunities(id),
  discount_percent numeric NOT NULL,
  renewal_uplift_percent numeric NOT NULL,
  liability_cap_changed boolean NOT NULL DEFAULT false,
  data_retention_language boolean NOT NULL DEFAULT false,
  restricted_research_language boolean NOT NULL DEFAULT false,
  customer_specific_security_language boolean NOT NULL DEFAULT false,
  customer_facing_concession_language boolean NOT NULL DEFAULT false,
  conflicting_evidence boolean NOT NULL DEFAULT false,
  missing_material_evidence boolean NOT NULL DEFAULT false,
  source_commit text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS approval_subjects_immutable ON approval_subjects;
ALTER TABLE approval_subjects DROP CONSTRAINT IF EXISTS approval_subjects_subject_hash_uq;
ALTER TABLE approval_subjects ADD COLUMN IF NOT EXISTS section_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE approval_subjects ADD COLUMN IF NOT EXISTS recommendation_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE approval_subjects ADD COLUMN IF NOT EXISTS citation_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE approval_subjects ADD COLUMN IF NOT EXISTS quorum_version text NOT NULL DEFAULT 'deal-brief-approval-v1';
ALTER TABLE approval_subjects ADD COLUMN IF NOT EXISTS decision_version integer NOT NULL DEFAULT 0;
ALTER TABLE approval_subjects ADD COLUMN IF NOT EXISTS superseded_by_subject_id text REFERENCES approval_subjects(id);
ALTER TABLE approval_subjects ADD CONSTRAINT approval_subjects_decision_version_ck CHECK (decision_version >= 0);
ALTER TABLE approval_subjects ADD CONSTRAINT approval_subjects_id_run_uq UNIQUE (id, run_id);

CREATE TABLE IF NOT EXISTS approval_requirement_entries (
  id text NOT NULL,
  approval_subject_id text NOT NULL REFERENCES approval_subjects(id),
  category text NOT NULL CHECK (category IN ('commercial_discount','legal_terms','evidence_review','customer_concession')),
  eligible_authorities jsonb NOT NULL,
  policy_triggers jsonb NOT NULL DEFAULT '[]'::jsonb,
  depends_on jsonb NOT NULL DEFAULT '[]'::jsonb,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_requirement_entries_subject_entry_uq PRIMARY KEY (approval_subject_id, id),
  CONSTRAINT approval_requirement_entries_subject_ordinal_uq UNIQUE (approval_subject_id, ordinal)
);

DROP TRIGGER IF EXISTS approval_decisions_immutable ON approval_decisions;
ALTER TABLE approval_decisions DROP CONSTRAINT IF EXISTS approval_decisions_subject_uq;
ALTER TABLE approval_decisions ADD COLUMN IF NOT EXISTS entry_id text;
ALTER TABLE approval_decisions ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE approval_decisions ADD COLUMN IF NOT EXISTS authority text;
ALTER TABLE approval_decisions ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE approval_decisions ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE approval_decisions ADD COLUMN IF NOT EXISTS original_payload jsonb;
ALTER TABLE approval_decisions ADD COLUMN IF NOT EXISTS approved_payload jsonb;
ALTER TABLE approval_decisions ADD COLUMN IF NOT EXISTS original_subject_hash text;
ALTER TABLE approval_decisions ADD COLUMN IF NOT EXISTS approved_subject_hash text;
ALTER TABLE approval_decisions ADD COLUMN IF NOT EXISTS diff jsonb;
INSERT INTO approval_requirement_entries (id, approval_subject_id, category, eligible_authorities, policy_triggers, depends_on, ordinal)
  SELECT 'legacy_entry_' || subject.id, subject.id, 'evidence_review', '["account_owner"]'::jsonb, subject.policy_triggers, '[]'::jsonb, 0
  FROM approval_subjects subject WHERE NOT EXISTS (SELECT 1 FROM approval_requirement_entries entry WHERE entry.approval_subject_id = subject.id);
UPDATE approval_decisions decision SET
  entry_id = coalesce(decision.entry_id, 'legacy_entry_' || decision.approval_subject_id),
  category = coalesce(decision.category, 'evidence_review'), authority = coalesce(decision.authority, 'account_owner'),
  idempotency_key = coalesce(decision.idempotency_key, 'legacy:' || decision.id),
  original_payload = coalesce(decision.original_payload, subject.payload), approved_payload = coalesce(decision.approved_payload, decision.edited_payload, subject.payload),
  original_subject_hash = coalesce(decision.original_subject_hash, subject.subject_hash), approved_subject_hash = coalesce(decision.approved_subject_hash, subject.subject_hash),
  request_hash = coalesce(decision.request_hash, 'legacy:' || decision.id)
  FROM approval_subjects subject WHERE subject.id = decision.approval_subject_id;
ALTER TABLE approval_decisions ALTER COLUMN entry_id SET NOT NULL;
ALTER TABLE approval_decisions ALTER COLUMN category SET NOT NULL;
ALTER TABLE approval_decisions ALTER COLUMN authority SET NOT NULL;
ALTER TABLE approval_decisions ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE approval_decisions ALTER COLUMN request_hash SET NOT NULL;
ALTER TABLE approval_decisions ALTER COLUMN original_payload SET NOT NULL;
ALTER TABLE approval_decisions ALTER COLUMN approved_payload SET NOT NULL;
ALTER TABLE approval_decisions ALTER COLUMN original_subject_hash SET NOT NULL;
ALTER TABLE approval_decisions ALTER COLUMN approved_subject_hash SET NOT NULL;
ALTER TABLE approval_decisions ADD CONSTRAINT approval_decisions_entry_fk FOREIGN KEY (approval_subject_id, entry_id) REFERENCES approval_requirement_entries(approval_subject_id, id);
ALTER TABLE approval_decisions ADD CONSTRAINT approval_decisions_subject_entry_uq UNIQUE (approval_subject_id, entry_id);
ALTER TABLE approval_decisions ADD CONSTRAINT approval_decisions_idempotency_uq UNIQUE (idempotency_key);

ALTER TABLE briefs DROP CONSTRAINT IF EXISTS briefs_approval_subject_snapshot_fk;
ALTER TABLE briefs DROP CONSTRAINT IF EXISTS briefs_run_uq;
ALTER TABLE briefs ADD COLUMN IF NOT EXISTS draft_version integer NOT NULL DEFAULT 0;
ALTER TABLE briefs ADD CONSTRAINT briefs_draft_version_ck CHECK (draft_version >= 0);
ALTER TABLE briefs ADD CONSTRAINT briefs_run_version_uq UNIQUE (run_id, draft_version);
ALTER TABLE briefs ADD CONSTRAINT briefs_approval_subject_run_fk FOREIGN KEY (approval_subject_id, run_id) REFERENCES approval_subjects(id, run_id);

CREATE OR REPLACE FUNCTION protect_approval_subject_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER approval_subjects_immutable BEFORE UPDATE OR DELETE ON approval_subjects FOR EACH ROW EXECUTE FUNCTION protect_approval_subject_snapshot();
CREATE TRIGGER approval_decisions_immutable BEFORE UPDATE OR DELETE ON approval_decisions FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER approval_requirement_entries_immutable BEFORE UPDATE OR DELETE ON approval_requirement_entries FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
