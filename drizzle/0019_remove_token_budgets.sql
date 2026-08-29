DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'run_budgets'::regclass
      AND (pg_get_constraintdef(oid) LIKE '%max_input_tokens%'
        OR pg_get_constraintdef(oid) LIKE '%max_output_tokens%')
  LOOP
    EXECUTE format('ALTER TABLE run_budgets DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE run_budgets ALTER COLUMN max_input_tokens DROP NOT NULL;
ALTER TABLE run_budgets ALTER COLUMN max_output_tokens DROP NOT NULL;

