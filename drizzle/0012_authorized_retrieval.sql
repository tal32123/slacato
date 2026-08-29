DROP TRIGGER IF EXISTS evidence_versions_immutable ON evidence_versions;
DROP TRIGGER IF EXISTS run_evidence_manifests_immutable ON run_evidence_manifests;
DROP TRIGGER IF EXISTS run_evidence_manifest_entries_immutable ON run_evidence_manifest_entries;
ALTER TABLE evidence_versions ADD COLUMN IF NOT EXISTS embedding_content_hash text;
UPDATE evidence_versions SET embedding_content_hash = content_hash WHERE embedding IS NOT NULL AND embedding_content_hash IS NULL;
ALTER TABLE evidence_versions DROP CONSTRAINT IF EXISTS evidence_versions_embedding_profile_ck;
ALTER TABLE evidence_versions ADD CONSTRAINT evidence_versions_embedding_profile_ck CHECK (
  (embedding IS NULL AND embedding_provider IS NULL AND embedding_model IS NULL AND embedding_dimension IS NULL
    AND embedding_profile IS NULL AND embedding_version IS NULL AND embedding_normalization IS NULL AND embedding_content_hash IS NULL)
  OR (embedding IS NOT NULL AND embedding_provider IS NOT NULL AND embedding_model IS NOT NULL AND embedding_dimension > 0
    AND embedding_profile IS NOT NULL AND embedding_version IS NOT NULL AND embedding_normalization IS NOT NULL
    AND embedding_content_hash = content_hash AND vector_dims(embedding) = embedding_dimension)
);
CREATE OR REPLACE FUNCTION bind_embedding_content_hash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.embedding IS NOT NULL AND NEW.embedding_content_hash IS NULL THEN NEW.embedding_content_hash := NEW.content_hash; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS evidence_versions_bind_embedding_content_hash ON evidence_versions;
CREATE TRIGGER evidence_versions_bind_embedding_content_hash BEFORE INSERT ON evidence_versions
  FOR EACH ROW EXECUTE FUNCTION bind_embedding_content_hash();

ALTER TABLE run_evidence_manifests ADD COLUMN IF NOT EXISTS query_hash text;
ALTER TABLE run_evidence_manifests ADD COLUMN IF NOT EXISTS embedding_provider text;
ALTER TABLE run_evidence_manifests ADD COLUMN IF NOT EXISTS embedding_model text;
ALTER TABLE run_evidence_manifests ADD COLUMN IF NOT EXISTS embedding_dimension integer;
ALTER TABLE run_evidence_manifests ADD COLUMN IF NOT EXISTS embedding_version text;
ALTER TABLE run_evidence_manifests ADD COLUMN IF NOT EXISTS embedding_normalization text;

UPDATE run_evidence_manifests SET
  query_hash = coalesce(query_hash, repeat('0', 64)),
  embedding_provider = coalesce(embedding_provider, 'legacy'),
  embedding_model = coalesce(embedding_model, 'legacy'),
  embedding_dimension = coalesce(embedding_dimension, 1),
  embedding_version = coalesce(embedding_version, 'legacy'),
  embedding_normalization = coalesce(embedding_normalization, 'legacy');

ALTER TABLE run_evidence_manifests ALTER COLUMN query_hash SET NOT NULL;
ALTER TABLE run_evidence_manifests ALTER COLUMN embedding_provider SET NOT NULL;
ALTER TABLE run_evidence_manifests ALTER COLUMN embedding_model SET NOT NULL;
ALTER TABLE run_evidence_manifests ALTER COLUMN embedding_dimension SET NOT NULL;
ALTER TABLE run_evidence_manifests ALTER COLUMN embedding_version SET NOT NULL;
ALTER TABLE run_evidence_manifests ALTER COLUMN embedding_normalization SET NOT NULL;
ALTER TABLE run_evidence_manifests ADD CONSTRAINT run_evidence_manifests_query_hash_ck CHECK (query_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE run_evidence_manifests ADD CONSTRAINT run_evidence_manifests_embedding_dimension_ck CHECK (embedding_dimension > 0);
CREATE UNIQUE INDEX IF NOT EXISTS run_evidence_manifests_run_uq ON run_evidence_manifests (run_id);

ALTER TABLE run_evidence_manifest_entries ADD COLUMN IF NOT EXISTS citation_id text;
ALTER TABLE run_evidence_manifest_entries ADD COLUMN IF NOT EXISTS source_locator text;
ALTER TABLE run_evidence_manifest_entries ADD COLUMN IF NOT EXISTS source_type text;
ALTER TABLE run_evidence_manifest_entries ADD COLUMN IF NOT EXISTS sensitivity text;
ALTER TABLE run_evidence_manifest_entries ADD COLUMN IF NOT EXISTS classification_reason text;
ALTER TABLE run_evidence_manifest_entries ADD COLUMN IF NOT EXISTS policy_hash text;
ALTER TABLE run_evidence_manifest_entries ADD COLUMN IF NOT EXISTS lexical_rank integer;
ALTER TABLE run_evidence_manifest_entries ADD COLUMN IF NOT EXISTS semantic_rank integer;
ALTER TABLE run_evidence_manifest_entries ADD COLUMN IF NOT EXISTS query_rank integer;
ALTER TABLE run_evidence_manifest_entries ADD COLUMN IF NOT EXISTS reliability_adjustment numeric;
ALTER TABLE run_evidence_manifest_entries ADD COLUMN IF NOT EXISTS recency_adjustment numeric;

UPDATE run_evidence_manifest_entries SET
  citation_id = coalesce(citation_id, 'citation_legacy_' || md5(manifest_id || evidence_version_id)),
  source_locator = coalesce(source_locator, 'legacy'),
  source_type = coalesce(source_type, 'legacy'),
  sensitivity = coalesce(sensitivity, 'legacy'),
  classification_reason = coalesce(classification_reason, 'legacy'),
  policy_hash = coalesce(policy_hash, repeat('0', 64)),
  query_rank = coalesce(query_rank, rank),
  reliability_adjustment = coalesce(reliability_adjustment, 0),
  recency_adjustment = coalesce(recency_adjustment, 0);

ALTER TABLE run_evidence_manifest_entries ALTER COLUMN citation_id SET NOT NULL;
ALTER TABLE run_evidence_manifest_entries ALTER COLUMN source_locator SET NOT NULL;
ALTER TABLE run_evidence_manifest_entries ALTER COLUMN source_type SET NOT NULL;
ALTER TABLE run_evidence_manifest_entries ALTER COLUMN sensitivity SET NOT NULL;
ALTER TABLE run_evidence_manifest_entries ALTER COLUMN classification_reason SET NOT NULL;
ALTER TABLE run_evidence_manifest_entries ALTER COLUMN policy_hash SET NOT NULL;
ALTER TABLE run_evidence_manifest_entries ALTER COLUMN query_rank SET NOT NULL;
ALTER TABLE run_evidence_manifest_entries ALTER COLUMN reliability_adjustment SET NOT NULL;
ALTER TABLE run_evidence_manifest_entries ALTER COLUMN recency_adjustment SET NOT NULL;
ALTER TABLE run_evidence_manifest_entries ADD CONSTRAINT run_evidence_manifest_entries_query_rank_ck CHECK (query_rank > 0);
ALTER TABLE run_evidence_manifest_entries ADD CONSTRAINT run_evidence_manifest_entries_lexical_rank_ck CHECK (lexical_rank IS NULL OR lexical_rank > 0);
ALTER TABLE run_evidence_manifest_entries ADD CONSTRAINT run_evidence_manifest_entries_semantic_rank_ck CHECK (semantic_rank IS NULL OR semantic_rank > 0);
CREATE UNIQUE INDEX IF NOT EXISTS run_evidence_manifest_entries_citation_uq ON run_evidence_manifest_entries (citation_id);

CREATE TRIGGER run_evidence_manifests_immutable BEFORE UPDATE OR DELETE ON run_evidence_manifests
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER run_evidence_manifest_entries_immutable BEFORE UPDATE OR DELETE ON run_evidence_manifest_entries
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

CREATE OR REPLACE FUNCTION enforce_evidence_version_indexing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence_versions rows are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.document_version_id IS DISTINCT FROM NEW.document_version_id
    OR OLD.account_id IS DISTINCT FROM NEW.account_id OR OLD.opportunity_id IS DISTINCT FROM NEW.opportunity_id
    OR OLD.chunk_index IS DISTINCT FROM NEW.chunk_index OR OLD.source_type IS DISTINCT FROM NEW.source_type
    OR OLD.sensitivity IS DISTINCT FROM NEW.sensitivity OR OLD.content_hash IS DISTINCT FROM NEW.content_hash
    OR OLD.content IS DISTINCT FROM NEW.content OR OLD.event_date IS DISTINCT FROM NEW.event_date
    OR OLD.reliability_class IS DISTINCT FROM NEW.reliability_class OR OLD.source_locator IS DISTINCT FROM NEW.source_locator
    OR OLD.classification_reason IS DISTINCT FROM NEW.classification_reason OR OLD.policy_hash IS DISTINCT FROM NEW.policy_hash
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'evidence_versions content rows are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.embedding IS NOT NULL OR OLD.embedding_provider IS NOT NULL OR OLD.embedding_model IS NOT NULL
    OR OLD.embedding_dimension IS NOT NULL OR OLD.embedding_profile IS NOT NULL OR OLD.embedding_version IS NOT NULL
    OR OLD.embedding_normalization IS NOT NULL OR OLD.embedding_content_hash IS NOT NULL THEN
    RAISE EXCEPTION 'evidence_versions embedding profile is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER evidence_versions_immutable BEFORE UPDATE OR DELETE ON evidence_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_evidence_version_indexing();
