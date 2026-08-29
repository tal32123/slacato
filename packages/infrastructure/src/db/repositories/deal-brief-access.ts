import type { ApprovalAuthority, ApprovalRequirementInput, DealBrief, DealBriefAccessControl } from '@slacato/core';
import type { DatabaseClient } from '../client.js';

/** Server-side opportunity authorization and account-scoped approval authorities. */
export class PostgresDealBriefAccessControl implements DealBriefAccessControl {
  public constructor(private readonly database: DatabaseClient) {}

  public async authorizeStart(input: Readonly<{ requestedBy: string; opportunityId: string }>) {
    const row = (await this.database.sql<{ account_id: string; restricted: boolean; readable: boolean; may_request: boolean }[]>`select opportunity.account_id, opportunity.restricted,
      coalesce(bool_or(grant.can_read and (not opportunity.restricted or grant.can_read_restricted)), false) readable,
      coalesce(bool_or(grant.can_request_approval), false) may_request
      from opportunities opportunity
      left join permission_grants grant on grant.account_id = opportunity.account_id and grant.persona_id = ${input.requestedBy}
      where opportunity.id = ${input.opportunityId}
      group by opportunity.account_id, opportunity.restricted`)[0];
    if (row === undefined || !row.readable || !row.may_request) return { allowed: false as const };
    return { allowed: true as const, accountId: row.account_id };
  }

  public async authoritiesFor(input: Readonly<{ actorId: string; opportunityId: string }>): Promise<readonly ApprovalAuthority[]> {
    const rows = await this.database.sql<{ authority: ApprovalAuthority }[]>`select authority.authority
      from opportunities opportunity
      join approval_authority_grants authority on authority.account_id = opportunity.account_id and authority.persona_id = ${input.actorId}
      where opportunity.id = ${input.opportunityId}
      order by authority.authority`;
    return rows.map(({ authority }) => authority);
  }

  public async recordOpaqueDenial(event: Readonly<Record<string, unknown>>): Promise<void> {
    const actorId = typeof event.actorId === 'string' ? event.actorId : null;
    await this.database.sql`insert into audit_events (id, actor_id, type, payload) values
      (${`audit_${crypto.randomUUID()}`}, ${actorId}, 'deal_brief_start_denied', '{"reason":"forbidden"}'::jsonb)`;
  }
}

/** Authoritative structured policy facts; generated prose is never a policy decision input. */
export class PostgresDealBriefPolicyFacts {
  public constructor(private readonly database: DatabaseClient) {}

  public async forBrief(opportunityId: string, brief: DealBrief): Promise<ApprovalRequirementInput> {
    const facts = (await this.database.sql<{
      discount_percent: string; renewal_uplift_percent: string; liability_cap_changed: boolean; data_retention_language: boolean;
      restricted_research_language: boolean; customer_specific_security_language: boolean; customer_facing_concession_language: boolean;
      conflicting_evidence: boolean; missing_material_evidence: boolean;
    }[]>`select discount_percent, renewal_uplift_percent, liability_cap_changed, data_retention_language, restricted_research_language,
      customer_specific_security_language, customer_facing_concession_language, conflicting_evidence, missing_material_evidence
      from opportunity_policy_facts where opportunity_id = ${opportunityId}`)[0];
    if (facts === undefined) throw new Error('Opportunity policy facts are unavailable');
    const warningCodes = new Set(brief.confidenceAndReviewWarnings.warnings.map(({ code }) => code));
    return {
      discountPercent: Number(facts.discount_percent), renewalUpliftPercent: Number(facts.renewal_uplift_percent), liabilityCapChanged: facts.liability_cap_changed,
      dataRetentionLanguage: facts.data_retention_language, restrictedResearchLanguage: facts.restricted_research_language,
      customerSpecificSecurityLanguage: facts.customer_specific_security_language, customerFacingConcessionLanguage: facts.customer_facing_concession_language,
      overallConfidence: brief.confidenceAndReviewWarnings.overallConfidence,
      conflictingEvidence: facts.conflicting_evidence || warningCodes.has('CONFLICTING_EVIDENCE'),
      missingMaterialEvidence: facts.missing_material_evidence || brief.missingInformation.items.length > 0 || warningCodes.has('MISSING_MATERIAL_EVIDENCE')
    };
  }
}
