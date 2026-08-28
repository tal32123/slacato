ALTER TABLE outbox_commands ADD COLUMN IF NOT EXISTS claim_owner text;
ALTER TABLE outbox_commands ADD COLUMN IF NOT EXISTS claim_token text;
ALTER TABLE outbox_commands ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;
ALTER TABLE outbox_commands ADD COLUMN IF NOT EXISTS consumed_at timestamptz;
ALTER TABLE step_invocations ADD COLUMN IF NOT EXISTS lease_token text;

DROP TRIGGER IF EXISTS run_evidence_manifest_entries_immutable ON run_evidence_manifest_entries;
CREATE TRIGGER run_evidence_manifest_entries_immutable BEFORE UPDATE OR DELETE ON run_evidence_manifest_entries FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
