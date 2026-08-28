-- Existing runs did not persist this request-scoped limit, so no value can be
-- truthfully backfilled. A restarted run adopts its caller's exact deadline
-- atomically; all newly-created runs write the value explicitly.
ALTER TABLE run_budgets ADD COLUMN IF NOT EXISTS deadline_ms integer CHECK (deadline_ms > 0);
