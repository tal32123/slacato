DROP TRIGGER IF EXISTS run_evidence_manifests_immutable ON run_evidence_manifests;
DROP TRIGGER IF EXISTS run_evidence_manifest_entries_immutable ON run_evidence_manifest_entries;

ALTER TABLE run_evidence_manifests ADD COLUMN IF NOT EXISTS context_limit integer;
ALTER TABLE run_evidence_manifests ADD COLUMN IF NOT EXISTS diagnostics jsonb;
UPDATE run_evidence_manifests SET context_limit = coalesce(context_limit, 24000), diagnostics = coalesce(diagnostics, jsonb_build_object(
  'returned', (select count(*) from run_evidence_manifest_entries entry where entry.manifest_id = run_evidence_manifests.id),
  'contextCharacters', 0,
  'exactContextAvailable', 0,
  'exactLookups', jsonb_build_object('account', 0, 'opportunity', 0, 'contacts', 0),
  'sectionMatches', '{}'::jsonb,
  'mandatoryPolicy', 'not_evaluated',
  'truncatedEvidenceIds', '[]'::jsonb,
  'missingSourceTypes', '[]'::jsonb
));
ALTER TABLE run_evidence_manifests ALTER COLUMN context_limit SET NOT NULL;
ALTER TABLE run_evidence_manifests ALTER COLUMN diagnostics SET NOT NULL;
ALTER TABLE run_evidence_manifests ADD CONSTRAINT run_evidence_manifests_context_limit_ck CHECK (context_limit > 0);

ALTER TABLE run_evidence_manifest_entries ADD COLUMN IF NOT EXISTS included_characters integer;
ALTER TABLE run_evidence_manifest_entries ADD COLUMN IF NOT EXISTS fusion_score numeric;
UPDATE run_evidence_manifest_entries entry SET included_characters = length(evidence.content)
  FROM evidence_versions evidence WHERE evidence.id = entry.evidence_version_id AND entry.included_characters IS NULL;
UPDATE run_evidence_manifest_entries SET fusion_score = score - reliability_adjustment - recency_adjustment
  WHERE fusion_score IS NULL;
ALTER TABLE run_evidence_manifest_entries ALTER COLUMN included_characters SET NOT NULL;
ALTER TABLE run_evidence_manifest_entries ALTER COLUMN fusion_score SET NOT NULL;
ALTER TABLE run_evidence_manifest_entries ADD CONSTRAINT run_evidence_manifest_entries_included_characters_ck CHECK (included_characters > 0);

CREATE TRIGGER run_evidence_manifests_immutable BEFORE UPDATE OR DELETE ON run_evidence_manifests
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER run_evidence_manifest_entries_immutable BEFORE UPDATE OR DELETE ON run_evidence_manifest_entries
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
