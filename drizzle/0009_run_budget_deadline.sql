ALTER TABLE run_budgets ADD COLUMN IF NOT EXISTS deadline_ms integer NOT NULL DEFAULT 60000 CHECK (deadline_ms > 0);
