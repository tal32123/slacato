CREATE OR REPLACE VIEW authorized_run_approval_grants
WITH (security_barrier = true, security_invoker = true)
AS
SELECT DISTINCT
  authority_grant.persona_id,
  authority_grant.source_commit,
  run.id AS run_id,
  subject.id AS approval_subject_id,
  requirement.id AS approval_entry_id,
  opportunity.id AS opportunity_id,
  opportunity.account_id,
  authority_grant.authority,
  (
    run.status = 'awaiting_approval'
    AND subject.superseded_by_subject_id IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM approval_decisions decision
      WHERE decision.approval_subject_id = subject.id
        AND decision.entry_id = requirement.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(requirement.depends_on) dependency(entry_id)
      WHERE NOT EXISTS (
        SELECT 1
        FROM approval_decisions dependency_decision
        WHERE dependency_decision.approval_subject_id = subject.id
          AND dependency_decision.entry_id = dependency.entry_id
          AND dependency_decision.action IN ('approve_unchanged', 'edit_and_approve')
      )
    )
  ) AS operable
FROM approval_authority_grants authority_grant
JOIN opportunities opportunity ON opportunity.account_id = authority_grant.account_id
JOIN runs run ON run.opportunity_id = opportunity.id
JOIN approval_subjects subject ON subject.run_id = run.id
JOIN approval_requirement_entries requirement
  ON requirement.approval_subject_id = subject.id
JOIN LATERAL jsonb_array_elements_text(requirement.eligible_authorities) eligible(authority)
  ON eligible.authority = authority_grant.authority;
