ALTER TABLE run_budgets ADD COLUMN IF NOT EXISTS reserved_output_tokens integer NOT NULL DEFAULT 0 CHECK (reserved_output_tokens >= 0);

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'run_budgets'::regclass AND (pg_get_constraintdef(oid) LIKE '%used_output_tokens <= max_output_tokens%' OR pg_get_constraintdef(oid) LIKE '%used_input_tokens <= max_input_tokens%')
  LOOP
    EXECUTE format('ALTER TABLE run_budgets DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE run_budget_reservations ADD COLUMN IF NOT EXISTS attempt_id text;
ALTER TABLE run_budget_reservations ADD COLUMN IF NOT EXISTS invocation_id text;
ALTER TABLE run_budget_reservations ADD COLUMN IF NOT EXISTS operation text;
ALTER TABLE run_budget_reservations ADD COLUMN IF NOT EXISTS ordinal integer;
ALTER TABLE run_budget_reservations ADD COLUMN IF NOT EXISTS granted_output_tokens integer;
ALTER TABLE run_budget_reservations ADD COLUMN IF NOT EXISTS reserved_input_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE run_budget_reservations ADD COLUMN IF NOT EXISTS actual_input_tokens integer;
ALTER TABLE run_budget_reservations ADD COLUMN IF NOT EXISTS request_id text;
ALTER TABLE run_budget_reservations ADD COLUMN IF NOT EXISTS response_id text;
ALTER TABLE run_budget_reservations ADD COLUMN IF NOT EXISTS failure_category text;
ALTER TABLE run_budget_reservations ADD COLUMN IF NOT EXISTS failure_code text;

UPDATE run_budget_reservations SET granted_output_tokens = reserved_output_tokens WHERE granted_output_tokens IS NULL;
-- 0008 is unreleased: repair its original non-unique legacy backfill in place.
-- A stable per-row operation preserves every pre-0008 reservation before the
-- NULLS NOT DISTINCT unique index is created; deployed databases need no reset.
UPDATE run_budget_reservations SET operation = 'legacy:' || id, ordinal = 1 WHERE operation IS NULL OR ordinal IS NULL;
ALTER TABLE run_budget_reservations ALTER COLUMN granted_output_tokens SET NOT NULL;
ALTER TABLE run_budget_reservations ALTER COLUMN operation SET NOT NULL;
ALTER TABLE run_budget_reservations ALTER COLUMN ordinal SET NOT NULL;
ALTER TABLE run_budget_reservations ADD CONSTRAINT run_budget_reservations_grant_ck CHECK (granted_output_tokens > 0);

ALTER TABLE generation_attempts ADD COLUMN IF NOT EXISTS ordinal integer NOT NULL DEFAULT 1;
ALTER TABLE run_budget_reservations ADD CONSTRAINT run_budget_reservations_attempt_fk FOREIGN KEY (attempt_id) REFERENCES generation_attempts(id);
CREATE UNIQUE INDEX IF NOT EXISTS run_budget_reservations_attempt_uq ON run_budget_reservations (attempt_id) WHERE attempt_id IS NOT NULL;
ALTER TABLE run_budget_reservations ADD CONSTRAINT run_budget_reservations_invocation_operation_ordinal_uq
  UNIQUE NULLS NOT DISTINCT (run_id, invocation_id, operation, ordinal);
