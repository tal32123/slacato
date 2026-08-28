ALTER TABLE personas ADD COLUMN IF NOT EXISTS source_commit text;
ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS source_commit text;
ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS can_request_approval boolean NOT NULL DEFAULT false;

ALTER TABLE personas DROP CONSTRAINT IF EXISTS personas_source_commit_check;
ALTER TABLE personas ADD CONSTRAINT personas_source_commit_check
  CHECK (source_commit IS NULL OR source_commit ~ '^[0-9a-f]{40}$');

CREATE INDEX IF NOT EXISTS personas_source_commit_display_name_idx
  ON personas (source_commit, display_name, id);

ALTER TABLE permission_grants DROP CONSTRAINT IF EXISTS permission_grants_source_commit_check;
ALTER TABLE permission_grants ADD CONSTRAINT permission_grants_source_commit_check
  CHECK (source_commit IS NULL OR source_commit ~ '^[0-9a-f]{40}$');

CREATE INDEX IF NOT EXISTS permission_grants_source_commit_persona_idx
  ON permission_grants (source_commit, persona_id, account_id, source_type, id);
