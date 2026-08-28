ALTER TABLE step_invocations ADD COLUMN IF NOT EXISTS causal_command_id text;
DO $$ BEGIN
  ALTER TABLE step_invocations ADD CONSTRAINT step_invocations_causal_command_fk FOREIGN KEY (causal_command_id) REFERENCES outbox_commands(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
