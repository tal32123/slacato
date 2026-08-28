ALTER TABLE personas ADD COLUMN IF NOT EXISTS source_commit text;

ALTER TABLE personas DROP CONSTRAINT IF EXISTS personas_source_commit_check;
ALTER TABLE personas ADD CONSTRAINT personas_source_commit_check
  CHECK (source_commit IS NULL OR source_commit ~ '^[0-9a-f]{40}$');

CREATE INDEX IF NOT EXISTS personas_source_commit_display_name_idx
  ON personas (source_commit, display_name, id);
