ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS event_date date;
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS reliability_class text;
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS source_locator text;
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS classification_reason text;
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS policy_hash text;

ALTER TABLE evidence_versions ADD COLUMN IF NOT EXISTS event_date date;
ALTER TABLE evidence_versions ADD COLUMN IF NOT EXISTS reliability_class text;
ALTER TABLE evidence_versions ADD COLUMN IF NOT EXISTS source_locator text;
ALTER TABLE evidence_versions ADD COLUMN IF NOT EXISTS classification_reason text;
ALTER TABLE evidence_versions ADD COLUMN IF NOT EXISTS policy_hash text;

ALTER TABLE document_versions DROP CONSTRAINT IF EXISTS document_versions_provenance_ck;
ALTER TABLE document_versions ADD CONSTRAINT document_versions_provenance_ck CHECK (
  num_nonnulls(reliability_class, source_locator, classification_reason, policy_hash) = 0
  OR (num_nulls(reliability_class, source_locator, classification_reason, policy_hash) = 0
    AND length(reliability_class) > 0 AND length(source_locator) > 0 AND length(classification_reason) > 0 AND policy_hash ~ '^[0-9a-f]{64}$')
);
ALTER TABLE evidence_versions DROP CONSTRAINT IF EXISTS evidence_versions_provenance_ck;
ALTER TABLE evidence_versions ADD CONSTRAINT evidence_versions_provenance_ck CHECK (
  num_nonnulls(reliability_class, source_locator, classification_reason, policy_hash) = 0
  OR (num_nulls(reliability_class, source_locator, classification_reason, policy_hash) = 0
    AND length(reliability_class) > 0 AND length(source_locator) > 0 AND length(classification_reason) > 0 AND policy_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS evidence_versions_provenance_idx
  ON evidence_versions (account_id, opportunity_id, source_type, sensitivity, event_date, id);
