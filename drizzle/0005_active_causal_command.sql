CREATE UNIQUE INDEX IF NOT EXISTS step_invocations_one_active_causal_command_uq ON step_invocations (causal_command_id) WHERE status = 'leased';
