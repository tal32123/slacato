CREATE VIEW authorized_opportunity_grants
WITH (security_barrier = true, security_invoker = true)
AS
SELECT DISTINCT
  permission.persona_id,
  permission.source_commit,
  permission.source_type,
  opportunity.id AS opportunity_id,
  opportunity.account_id
FROM permission_grants permission
JOIN opportunities opportunity ON opportunity.account_id = permission.account_id
WHERE permission.can_read = true
  AND (opportunity.restricted = false OR permission.can_read_restricted = true);

CREATE VIEW authorized_evidence_grants
WITH (security_barrier = true, security_invoker = true)
AS
SELECT DISTINCT
  permission.persona_id,
  permission.source_commit,
  evidence.id AS evidence_id,
  evidence.opportunity_id,
  evidence.account_id,
  evidence.source_type
FROM permission_grants permission
JOIN evidence_versions evidence
  ON evidence.account_id = permission.account_id
  AND evidence.source_type = permission.source_type
JOIN opportunities opportunity ON opportunity.id = evidence.opportunity_id
WHERE permission.can_read = true
  AND (opportunity.restricted = false OR permission.can_read_restricted = true)
  AND (
    evidence.sensitivity <> 'restricted'
    OR (evidence.source_type = 'pricing' AND permission.sensitive_pricing = true)
    OR (evidence.source_type <> 'pricing' AND permission.can_read_restricted = true)
  );

CREATE VIEW authorized_run_approval_grants
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
  authority_grant.authority
FROM approval_authority_grants authority_grant
JOIN opportunities opportunity ON opportunity.account_id = authority_grant.account_id
JOIN runs run ON run.opportunity_id = opportunity.id
JOIN approval_subjects subject ON subject.run_id = run.id
JOIN approval_requirement_entries requirement
  ON requirement.approval_subject_id = subject.id
JOIN LATERAL jsonb_array_elements_text(requirement.eligible_authorities) eligible(authority)
  ON eligible.authority = authority_grant.authority;
