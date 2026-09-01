import {
  type AgentEvidenceRecord,
  type ApprovalAuthority,
  type ApprovalRequirement,
  type ApprovalRequirementInput,
  AuthorizationDeniedError,
  CANONICAL_FIXTURE_COMMIT,
  collectDealBriefReferences,
  type DealBrief,
  type DealBriefAccessControl,
  DomainValidationError,
  decideApprovalRequirement,
  extractEditedPolicySignals,
  hashApprovalPayload,
  type OpaqueDenialEvent,
  validateDealBrief
} from '@slacato/core';
import type { DatabaseClient } from '../client.js';

/** Server-side opportunity authorization and account-scoped approval authorities. */
export class PostgresDealBriefAccessControl implements DealBriefAccessControl {
  /** Creates opportunity access control backed by the database. */
  public constructor(private readonly database: DatabaseClient) {}

  /** Authorizes an actor to start a run for an opportunity. */
  public async authorizeStart(input: Readonly<{ requestedBy: string; opportunityId: string }>) {
    const row = (
      await this.database.sql<
        { account_id: string; readable: boolean; may_request: boolean }[]
      >`select opportunity.account_id,
      exists (select 1 from authorized_opportunity_grants opportunity_grant
        where opportunity_grant.opportunity_id = opportunity.id
          and opportunity_grant.persona_id = ${input.requestedBy}
          and opportunity_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}) readable,
      exists (select 1 from permission_grants permission
        where permission.account_id = opportunity.account_id
          and permission.persona_id = ${input.requestedBy}
          and permission.source_commit = ${CANONICAL_FIXTURE_COMMIT}
          and permission.can_request_approval) may_request
      from opportunities opportunity
      where opportunity.id = ${input.opportunityId}`
    )[0];
    if (row === undefined || !row.readable || !row.may_request) return { allowed: false as const };
    return { allowed: true as const, accountId: row.account_id };
  }

  /** Returns the actor's approval authorities for an opportunity. */
  public async authoritiesFor(
    input: Readonly<{ actorId: string; opportunityId: string }>
  ): Promise<readonly ApprovalAuthority[]> {
    const rows = await this.database.sql<
      { authority: ApprovalAuthority }[]
    >`select authority.authority
      from opportunities opportunity
      join approval_authority_grants authority on authority.account_id = opportunity.account_id
        and authority.persona_id = ${input.actorId} and authority.source_commit = ${CANONICAL_FIXTURE_COMMIT}
      where opportunity.id = ${input.opportunityId}
      order by authority.authority`;
    return rows.map(({ authority }) => authority);
  }

  /**
   * Records an opaque audit trail for a denied access attempt.
   *
   * The row names the actor and nothing else. It carries no run, opportunity, account, source, or
   * count, and every denial - whichever operation was refused, and whether or not the target record
   * exists - produces a byte-identical row apart from its id, actor, and timestamp. `audit_events`
   * has no read path in the API, so a denial can never be read back by the persona it refused.
   */
  public async recordOpaqueDenial(event: OpaqueDenialEvent): Promise<void> {
    await this.database.sql`insert into audit_events (id, actor_id, type, payload) values
      (${`audit_${crypto.randomUUID()}`}, ${event.actorId}, 'deal_brief_access_denied',
        ${JSON.stringify({ reason: event.reason })}::jsonb)`;
  }

  /** Validates an edited approval payload and determines its approval requirement. */
  public async validateApprovalEdit(
    input: Readonly<{
      actorId: string;
      opportunityId: string;
      runId: string;
      originalPayload: DealBrief;
      payload: DealBrief;
    }>
  ): Promise<ApprovalRequirement> {
    type EvidenceRow = Readonly<{
      citation_id: string;
      evidence_version_id: string;
      source_locator: string;
      content: string;
      content_hash: string;
      source_type: AgentEvidenceRecord['sourceType'];
      sensitivity: string;
      classification_reason: string;
      policy_hash: string;
      event_date: string | null;
      reliability_class: string;
      lexical_rank: number | null;
      semantic_rank: number | null;
      fusion_score: string;
      reliability_adjustment: string;
      recency_adjustment: string;
      score: string;
      rank: number;
      included_characters: number;
    }>;
    const manifest = (
      await this.database.sql<
        { id: string }[]
      >`select manifest.id from run_evidence_manifests manifest
      join runs run on run.id = manifest.run_id where manifest.run_id = ${input.runId} and run.opportunity_id = ${input.opportunityId}`
    )[0];
    if (manifest === undefined) throw new Error('Approval evidence manifest is unavailable');
    const readableManifestEvidence = await this.database.sql<
      EvidenceRow[]
    >`select entry.citation_id, entry.evidence_version_id, entry.source_locator,
      evidence.content, entry.content_hash, entry.source_type, entry.sensitivity, entry.classification_reason, entry.policy_hash,
      evidence.event_date::text, evidence.reliability_class, entry.lexical_rank, entry.semantic_rank, entry.fusion_score,
      entry.reliability_adjustment, entry.recency_adjustment, entry.score, entry.rank, entry.included_characters
      from run_evidence_manifest_entries entry
      join evidence_versions evidence on evidence.id = entry.evidence_version_id
      join authorized_evidence_grants evidence_grant
        on evidence_grant.evidence_id = evidence.id
        and evidence_grant.opportunity_id = ${input.opportunityId}
        and evidence_grant.persona_id = ${input.actorId}
        and evidence_grant.source_commit = ${CANONICAL_FIXTURE_COMMIT}
      where entry.manifest_id = ${manifest.id}
      order by entry.rank`;
    const manifestEvidenceByCitationId = new Map(
      readableManifestEvidence.map((entry) => [entry.citation_id, entry])
    );
    const originalEvidenceIds = collectDealBriefReferences(input.originalPayload).evidenceIds;
    const readableEvidenceIds = new Set(
      readableManifestEvidence.map((entry) => entry.evidence_version_id)
    );
    if (originalEvidenceIds.some((evidenceId) => !readableEvidenceIds.has(evidenceId)))
      throw new AuthorizationDeniedError('Approval edit denied');
    for (const citation of collectDealBriefReferences(input.payload).citations) {
      const manifestEntry = manifestEvidenceByCitationId.get(citation.id);
      if (
        manifestEntry === undefined ||
        manifestEntry.evidence_version_id !== citation.evidenceId ||
        manifestEntry.source_locator !== citation.locator
      ) {
        throw new DomainValidationError(
          'Edited approval citation is not bound to the immutable run manifest'
        );
      }
    }
    const identity = (
      await this.database.sql<
        { account_id: string; account_name: string; opportunity_name: string; payload: DealBrief }[]
      >`
      select account.id account_id, account.name account_name, opportunity.name opportunity_name, subject.payload
      from runs run join opportunities opportunity on opportunity.id = run.opportunity_id join accounts account on account.id = opportunity.account_id
      join approval_subjects subject on subject.run_id = run.id and subject.superseded_by_subject_id is null
      where run.id = ${input.runId}`
    )[0];
    if (identity === undefined) throw new Error('Approval subject identity is unavailable');
    const evidence: AgentEvidenceRecord[] = readableManifestEvidence.map((entry) => ({
      evidenceId: entry.evidence_version_id,
      citationId: entry.citation_id as AgentEvidenceRecord['citationId'],
      content: entry.content.slice(0, entry.included_characters),
      contentHash: entry.content_hash,
      sourceType: entry.source_type,
      sensitivity: entry.sensitivity,
      sourceLocator: entry.source_locator,
      classificationReason: entry.classification_reason,
      policyHash: entry.policy_hash,
      reliabilityClass: entry.reliability_class,
      lexicalRank: entry.lexical_rank ?? undefined,
      semanticRank: entry.semantic_rank ?? undefined,
      fusionScore: Number(entry.fusion_score),
      reliabilityAdjustment: Number(entry.reliability_adjustment),
      recencyAdjustment: Number(entry.recency_adjustment),
      score: Number(entry.score),
      rank: entry.rank,
      accountId: identity.account_id,
      opportunityId: input.opportunityId,
      ...(entry.event_date === null ? {} : { eventDate: entry.event_date })
    }));
    const grounded = validateDealBrief(input.payload, evidence, {
      account: { id: identity.account_id, name: identity.account_name },
      opportunity: {
        id: input.opportunityId,
        name: identity.opportunity_name,
        stage: identity.payload.dealSnapshot.stage
      }
    });
    if (hashApprovalPayload(grounded) !== hashApprovalPayload(input.payload)) {
      throw new DomainValidationError(
        'Edited approval payload contains unsupported or altered evidence claims'
      );
    }
    const facts = await new PostgresDealBriefPolicyFacts(this.database).forBrief(
      input.opportunityId,
      input.payload
    );
    const semantic = extractEditedPolicySignals(input.payload);
    return decideApprovalRequirement({
      ...facts,
      liabilityCapChanged: facts.liabilityCapChanged || semantic.liabilityCapChanged,
      dataRetentionLanguage: facts.dataRetentionLanguage || semantic.dataRetentionLanguage,
      restrictedResearchLanguage:
        facts.restrictedResearchLanguage || semantic.restrictedResearchLanguage,
      customerSpecificSecurityLanguage:
        facts.customerSpecificSecurityLanguage || semantic.customerSpecificSecurityLanguage,
      customerFacingConcessionLanguage:
        facts.customerFacingConcessionLanguage || semantic.customerFacingConcessionLanguage
    });
  }
}

/** Authoritative structured policy facts; generated prose is never a policy decision input. */
export class PostgresDealBriefPolicyFacts {
  /** Creates policy-fact access backed by the database. */
  public constructor(private readonly database: DatabaseClient) {}

  /** Returns the authoritative approval facts for a deal brief. */
  public async forBrief(
    opportunityId: string,
    brief: DealBrief
  ): Promise<ApprovalRequirementInput> {
    const facts = (
      await this.database.sql<
        {
          discount_percent: string;
          renewal_uplift_percent: string;
          liability_cap_changed: boolean;
          data_retention_language: boolean;
          restricted_research_language: boolean;
          customer_specific_security_language: boolean;
          customer_facing_concession_language: boolean;
          conflicting_evidence: boolean;
          missing_material_evidence: boolean;
        }[]
      >`select discount_percent, renewal_uplift_percent, liability_cap_changed, data_retention_language, restricted_research_language,
      customer_specific_security_language, customer_facing_concession_language, conflicting_evidence, missing_material_evidence
      from opportunity_policy_facts where opportunity_id = ${opportunityId}`
    )[0];
    if (facts === undefined) throw new Error('Opportunity policy facts are unavailable');
    const warningCodes = new Set(
      brief.confidenceAndReviewWarnings.warnings.map(({ code }) => code)
    );
    return {
      discountPercent: Number(facts.discount_percent),
      renewalUpliftPercent: Number(facts.renewal_uplift_percent),
      liabilityCapChanged: facts.liability_cap_changed,
      dataRetentionLanguage: facts.data_retention_language,
      restrictedResearchLanguage: facts.restricted_research_language,
      customerSpecificSecurityLanguage: facts.customer_specific_security_language,
      customerFacingConcessionLanguage: facts.customer_facing_concession_language,
      overallConfidence: brief.confidenceAndReviewWarnings.overallConfidence,
      conflictingEvidence: facts.conflicting_evidence || warningCodes.has('CONFLICTING_EVIDENCE'),
      missingMaterialEvidence:
        facts.missing_material_evidence ||
        brief.missingInformation.items.length > 0 ||
        warningCodes.has('MISSING_MATERIAL_EVIDENCE')
    };
  }
}
