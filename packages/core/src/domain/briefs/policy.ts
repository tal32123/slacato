import type { DealBrief } from './schema.js';
export const APPROVAL_QUORUM_VERSION = 'deal-brief-approval-v1' as const;

export type ApprovalAuthority = 'deal_desk' | 'sales_leader' | 'legal_reviewer' | 'account_owner';
export type ApprovalCategory =
  | 'commercial_discount'
  | 'legal_terms'
  | 'evidence_review'
  | 'customer_communication'
  | 'customer_concession';

export type ApprovalRequirementEntry = Readonly<{
  id: string;
  category: ApprovalCategory;
  eligibleAuthorities: readonly ApprovalAuthority[];
  policyTriggers: readonly string[];
  dependsOn: readonly string[];
}>;

export type ApprovalRequirement = Readonly<{
  quorumVersion: typeof APPROVAL_QUORUM_VERSION;
  policyTriggers: readonly string[];
  entries: readonly ApprovalRequirementEntry[];
}>;

export type ApprovalRequirementInput = Readonly<{
  discountPercent: number;
  renewalUpliftPercent: number;
  liabilityCapChanged: boolean;
  dataRetentionLanguage: boolean;
  restrictedResearchLanguage: boolean;
  customerSpecificSecurityLanguage: boolean;
  customerFacingLanguage: boolean;
  customerFacingConcessionLanguage: boolean;
  overallConfidence: number;
  conflictingEvidence: boolean;
  missingMaterialEvidence: boolean;
}>;

export type EditedPolicySignals = Readonly<
  Pick<
    ApprovalRequirementInput,
    | 'liabilityCapChanged'
    | 'dataRetentionLanguage'
    | 'restrictedResearchLanguage'
    | 'customerSpecificSecurityLanguage'
    | 'customerFacingConcessionLanguage'
  >
>;

/** Normalizes independent human-readable semantic units, never structural metadata. */
function semanticFields(payload: DealBrief): readonly string[] {
  const claimStatements = (
    claims: readonly Readonly<{ statement: string }>[] | undefined
  ): readonly string[] => claims?.map(({ statement }) => statement) ?? [];
  const claimGroups = [
    payload.dealSnapshot.claims,
    payload.executiveSummary.claims,
    payload.buyerGoalsAndBusinessDrivers.claims,
    payload.stakeholderMap.claims,
    ...payload.stakeholderMap.stakeholders.map(({ claims }) => claims),
    payload.negotiationState.claims,
    ...payload.sourceEvidence.evidence.map(({ claims }) => claims)
  ];
  const values = [
    payload.executiveSummary.narrative,
    ...payload.buyerGoalsAndBusinessDrivers.goals,
    ...payload.buyerGoalsAndBusinessDrivers.businessDrivers,
    ...(payload.stakeholderMap.coverageGaps ?? []),
    ...payload.stakeholderMap.stakeholders.flatMap(({ goals, concerns }) => [
      ...goals,
      ...concerns
    ]),
    payload.negotiationState.currentState,
    ...(payload.negotiationState.leverage ?? []),
    ...payload.negotiationState.risks,
    ...payload.recommendedNextActions.actions.map(({ action, rationale, claims }) =>
      [action, rationale, ...claimStatements(claims)].join(' ')
    ),
    ...payload.missingInformation.items.flatMap(({ question, whyItMatters }) => [
      question,
      whyItMatters
    ]),
    ...payload.sourceEvidence.evidence.map(({ summary }) => summary),
    ...payload.confidenceAndReviewWarnings.warnings.map(({ message }) => message),
    ...claimGroups.flatMap(claimStatements)
  ];
  return values
    .map(
      (value) =>
        ` ${value
          .normalize('NFKC')
          .toLocaleLowerCase('en-US')
          .replaceAll(/[^a-z0-9]+/g, ' ')} `
    )
    .filter((value) => value.trim().length > 0);
}

/** Reports whether normalized brief prose contains any configured policy concept. */
function containsConcept(text: string, concepts: readonly string[]): boolean {
  return concepts.some((concept) => text.includes(` ${concept} `));
}

/** Requires every concept group to occur within the same prose field. */
function containsConceptGroups(
  fields: readonly string[],
  groups: readonly (readonly string[])[]
): boolean {
  return fields.some((field) => groups.every((concepts) => containsConcept(field, concepts)));
}

/** Classifies approval-sensitive concepts in edited brief prose using conservative deterministic rules. */
export function extractEditedPolicySignals(payload: DealBrief): EditedPolicySignals {
  const fields = semanticFields(payload);
  const liabilitySubjects = [
    'liability',
    'liabilities',
    'indemnity',
    'indemnification',
    'exposure',
    'damages',
    'risk allocation'
  ];
  const liabilityChanges = [
    'broader',
    'increase',
    'increased',
    'expand',
    'expanded',
    'uncapped',
    'unlimited',
    'accept',
    'accepted',
    'change',
    'changed',
    'revise',
    'revised'
  ];
  const commitments = [
    'offer',
    'offered',
    'accept',
    'accepted',
    'agree',
    'agreed',
    'promise',
    'promised',
    'commit',
    'committed',
    'provide',
    'provided',
    'grant',
    'granted',
    'concede',
    'conceded',
    'waive',
    'waived'
  ];
  const commercialBenefits = [
    'concession',
    'discount',
    'reduction',
    'reduced',
    'credit',
    'rebate',
    'waiver',
    'free',
    'complimentary'
  ];
  const dataSubjects = ['data', 'records', 'recordings', 'transcripts'];
  const retentionSubjects = [
    'retention',
    'retain',
    'retained',
    'delete',
    'deletion',
    'preserve',
    'storage'
  ];
  const researchSubjects = ['research', 'study', 'studies', 'benchmark', 'analysis'];
  const restrictedSubjects = ['restricted', 'confidential', 'private', 'nonpublic', 'sensitive'];
  const securitySubjects = [
    'security',
    'encryption',
    'breach',
    'incident',
    'vulnerability',
    'compliance'
  ];
  const customerSpecificSubjects = [
    'customer',
    'client',
    'account',
    'bespoke',
    'custom',
    'specific'
  ];
  return {
    liabilityCapChanged: containsConceptGroups(fields, [liabilitySubjects, liabilityChanges]),
    dataRetentionLanguage: containsConceptGroups(fields, [dataSubjects, retentionSubjects]),
    restrictedResearchLanguage: containsConceptGroups(fields, [
      researchSubjects,
      restrictedSubjects
    ]),
    customerSpecificSecurityLanguage: containsConceptGroups(fields, [
      securitySubjects,
      customerSpecificSubjects
    ]),
    customerFacingConcessionLanguage: containsConceptGroups(fields, [
      commercialBenefits,
      commitments
    ])
  };
}

export const DEMO_APPROVAL_IDENTITIES = Object.freeze([
  Object.freeze({
    userId: 'USR-5006',
    displayName: 'Iris Wynn',
    role: 'Legal Reviewer',
    accountId: 'ACC-2003',
    authorities: Object.freeze(['legal_reviewer'] as const),
    demoOnly: true as const,
    evidenceRetrieval: false as const
  }),
  Object.freeze({
    userId: 'USR-5008',
    displayName: 'Tomas Reed',
    role: 'Restricted Sales Leader',
    accountId: 'ACC-2003',
    authorities: Object.freeze(['sales_leader'] as const),
    demoOnly: true as const,
    evidenceRetrieval: false as const
  })
]);

/** Builds one immutable approval requirement with its authorities and dependencies. */
function entry(
  category: ApprovalCategory,
  eligibleAuthorities: readonly ApprovalAuthority[],
  policyTriggers: readonly string[],
  dependsOn: readonly string[] = []
): ApprovalRequirementEntry {
  return Object.freeze({
    id: `approval:${category}:${eligibleAuthorities.join('-or-')}`,
    category,
    eligibleAuthorities: Object.freeze([...eligibleAuthorities]),
    policyTriggers: Object.freeze([...policyTriggers]),
    dependsOn: Object.freeze([...dependsOn])
  });
}

/** Determines the approvals required by the canonical provider-independent policy. */
export function decideApprovalRequirement(input: ApprovalRequirementInput): ApprovalRequirement {
  if (
    ![input.discountPercent, input.renewalUpliftPercent, input.overallConfidence].every(
      Number.isFinite
    )
  ) {
    throw new TypeError('Approval policy numeric inputs must be finite');
  }
  if (input.overallConfidence < 0 || input.overallConfidence > 1) {
    throw new RangeError('Approval policy confidence must be between zero and one');
  }

  const entries: ApprovalRequirementEntry[] = [];
  const triggers: string[] = [];
  const commercialTriggers: string[] = [];
  if (input.discountPercent > 10) commercialTriggers.push('discount_above_10_percent');
  if (input.renewalUpliftPercent < 0) commercialTriggers.push('negative_renewal_uplift');
  if (commercialTriggers.length > 0) {
    entries.push(entry('commercial_discount', ['deal_desk'], commercialTriggers));
    triggers.push(...commercialTriggers);
  }
  if (input.discountPercent > 15) {
    const trigger = 'discount_above_15_percent';
    entries.push(entry('commercial_discount', ['sales_leader'], [trigger]));
    triggers.push(trigger);
  }

  const legalTriggers = [
    ...(input.liabilityCapChanged ? ['liability_cap_change'] : []),
    ...(input.dataRetentionLanguage ? ['data_retention_language'] : []),
    ...(input.restrictedResearchLanguage ? ['restricted_research_language'] : []),
    ...(input.customerSpecificSecurityLanguage ? ['customer_specific_security_language'] : [])
  ];
  if (legalTriggers.length > 0) {
    entries.push(entry('legal_terms', ['legal_reviewer'], legalTriggers));
    triggers.push(...legalTriggers);
  }

  const reviewTriggers = [
    ...(input.overallConfidence < 0.7 ? ['low_confidence'] : []),
    ...(input.conflictingEvidence ? ['conflicting_evidence'] : []),
    ...(input.missingMaterialEvidence ? ['missing_material_evidence'] : [])
  ];
  if (reviewTriggers.length > 0) {
    entries.push(entry('evidence_review', ['account_owner', 'sales_leader'], reviewTriggers));
    triggers.push(...reviewTriggers);
  }

  const customerFacingTriggers = [
    ...(input.customerFacingLanguage ? ['customer_facing_language'] : []),
    ...(input.customerFacingConcessionLanguage ? ['customer_facing_concession_language'] : [])
  ];
  if (customerFacingTriggers.length > 0) {
    entries.push(
      entry(
        input.customerFacingLanguage ? 'customer_communication' : 'customer_concession',
        ['account_owner'],
        customerFacingTriggers,
        entries.map(({ id }) => id)
      )
    );
    triggers.push(...customerFacingTriggers);
  }

  return Object.freeze({
    quorumVersion: APPROVAL_QUORUM_VERSION,
    policyTriggers: Object.freeze(triggers),
    entries: Object.freeze(entries)
  });
}
