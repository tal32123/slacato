CREATE TABLE auth_sessions (
  version uuid PRIMARY KEY,
  persona_id text NOT NULL REFERENCES personas(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_sessions_expiry_ck CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_active_idx ON auth_sessions (version, persona_id, expires_at) WHERE revoked_at IS NULL;

ALTER TABLE approval_authority_grants ADD COLUMN source_commit text;
UPDATE approval_authority_grants
SET source_commit = '076c659c3c7afd416f8d26729774b67042a55761'
WHERE source = '076c659c3c7afd416f8d26729774b67042a55761';
DELETE FROM approval_authority_grants WHERE source_commit IS NULL;
ALTER TABLE approval_authority_grants ALTER COLUMN source_commit SET NOT NULL;
ALTER TABLE approval_authority_grants ADD CONSTRAINT approval_authority_grants_source_commit_ck
  CHECK (source_commit ~ '^[0-9a-f]{40}$');
CREATE INDEX approval_authority_grants_source_commit_scope_idx
  ON approval_authority_grants (source_commit, persona_id, account_id, authority, id);

DELETE FROM permission_grants
WHERE source_commit IS DISTINCT FROM '076c659c3c7afd416f8d26729774b67042a55761';
