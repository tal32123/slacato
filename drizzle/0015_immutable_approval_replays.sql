DROP TRIGGER IF EXISTS approval_decisions_immutable ON approval_decisions;

ALTER TABLE approval_decisions ADD COLUMN IF NOT EXISTS result_run_version integer;
ALTER TABLE approval_decisions ADD COLUMN IF NOT EXISTS result_status text;
ALTER TABLE approval_decisions ADD COLUMN IF NOT EXISTS result_quorum_satisfied boolean;
ALTER TABLE approval_decisions ADD COLUMN IF NOT EXISTS result_rejected boolean;

WITH recovered AS (
  SELECT decision.id,
    coalesce(
      CASE
        WHEN decision.action = 'edit_and_approve' THEN replacement.draft_version
        ELSE result_event.result_version
      END,
      subject.draft_version + row_number() OVER (
        PARTITION BY decision.approval_subject_id ORDER BY decision.created_at, decision.id
      )::integer
    ) result_run_version,
    CASE
      WHEN decision.action = 'edit_and_approve' THEN 'awaiting_approval'
      WHEN result_event.type = 'approval_rejected' OR decision.action = 'reject' THEN 'rejected'
      WHEN result_event.type = 'approval_granted' THEN 'finalizing'
      ELSE 'awaiting_approval'
    END result_status
  FROM approval_decisions decision
  JOIN approval_subjects subject ON subject.id = decision.approval_subject_id
  LEFT JOIN approval_subjects replacement ON replacement.id = subject.superseded_by_subject_id
  LEFT JOIN LATERAL (
    SELECT event.type, (event.payload->>'version')::integer result_version
    FROM run_events event
    WHERE event.run_id = subject.run_id
      AND event.type IN ('approval_entry_recorded', 'approval_granted', 'approval_rejected')
      AND event.payload->>'approvalSubjectId' = decision.approval_subject_id
      AND event.payload->>'entryId' = decision.entry_id
      AND event.payload->>'action' = decision.action
    ORDER BY event.sequence
    LIMIT 1
  ) result_event ON true
)
UPDATE approval_decisions decision SET
  result_run_version = recovered.result_run_version,
  result_status = recovered.result_status,
  result_quorum_satisfied = recovered.result_status = 'finalizing',
  result_rejected = recovered.result_status = 'rejected'
FROM recovered WHERE recovered.id = decision.id;

ALTER TABLE approval_decisions ALTER COLUMN result_run_version SET NOT NULL;
ALTER TABLE approval_decisions ALTER COLUMN result_status SET NOT NULL;
ALTER TABLE approval_decisions ALTER COLUMN result_quorum_satisfied SET NOT NULL;
ALTER TABLE approval_decisions ALTER COLUMN result_rejected SET NOT NULL;
ALTER TABLE approval_decisions ADD CONSTRAINT approval_decisions_result_run_version_ck CHECK (result_run_version >= 0);
ALTER TABLE approval_decisions ADD CONSTRAINT approval_decisions_result_status_ck CHECK (result_status IN ('awaiting_approval','finalizing','rejected'));
ALTER TABLE approval_decisions ADD CONSTRAINT approval_decisions_result_consistency_ck CHECK (
  result_quorum_satisfied = (result_status = 'finalizing')
  AND result_rejected = (result_status = 'rejected')
);

CREATE TRIGGER approval_decisions_immutable BEFORE UPDATE OR DELETE ON approval_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
