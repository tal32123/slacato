CREATE TABLE IF NOT EXISTS run_budgets (
  run_id text PRIMARY KEY REFERENCES runs(id), max_calls integer NOT NULL CHECK (max_calls > 0), max_input_tokens integer NOT NULL CHECK (max_input_tokens > 0), max_output_tokens integer NOT NULL CHECK (max_output_tokens > 0),
  used_calls integer NOT NULL DEFAULT 0 CHECK (used_calls >= 0), used_input_tokens integer NOT NULL DEFAULT 0 CHECK (used_input_tokens >= 0), used_output_tokens integer NOT NULL DEFAULT 0 CHECK (used_output_tokens >= 0),
  CHECK (used_calls <= max_calls), CHECK (used_input_tokens <= max_input_tokens), CHECK (used_output_tokens <= max_output_tokens)
);
CREATE TABLE IF NOT EXISTS run_budget_reservations (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), reserved_output_tokens integer NOT NULL CHECK (reserved_output_tokens > 0), actual_output_tokens integer,
  status text NOT NULL CHECK (status IN ('reserved','settled','released','possible_duplicate')), created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz
);
