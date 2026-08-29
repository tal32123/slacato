import type { DealBrief } from './schema.js';
export const APPROVAL_QUORUM_VERSION = 'deal-brief-approval-v1' as const;

export type ApprovalAuthority = 'deal_desk' | 'sales_leader' | 'legal_reviewer' | 'account_owner';
export type ApprovalCategory =
  | 'commercial_discount'
  | 'legal_terms'
  | 'evidence_review'
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

/** Normalizes all brief prose for deterministic policy concept matching. */
function semanticText(payload: DealBrief): string {
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value !== null && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(payload);
  return values
    .join(' ')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replaceAll(/[^a-z0-9]+/g, ' ');
}

/** Reports whether normalized brief prose contains any configured policy concept. */
function containsConcept(text: string, concepts: readonly string[]): boolean {
  return concepts.some((concept) => text.includes(` ${concept} `));
}

/** Classifies approval-sensitive concepts in edited brief prose using conservative deterministic rules. */
export function extractEditedPolicySignals(payload: DealBrief): EditedPolicySignals {
  const text = ` ${semanticText(payload)} `;
  const liabilitySubject = containsConcept(text, [
    'liability',
    'liabilities',
    'indemnity',
    'indemnification',
    'exposure',
    'damages',
    'risk allocation'
  ]);
  const liabilityChange = containsConcept(text, [
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
  ]);
  const commitment = containsConcept(text, [
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
  ]);
  const commercialBenefit = containsConcept(text, [
    'concession',
    'discount',
    'reduction',
    'reduced',
    'credit',
    'rebate',
    'waiver',
    'free',
    'complimentary'
  ]);
  const dataSubject = containsConcept(text, ['data', 'records', 'recordings', 'transcripts']);
  const retentionSubject = containsConcept(text, [
    'retention',
    'retain',
    'retained',
    'delete',
    'deletion',
    'preserve',
    'storage'
  ]);
  const researchSubject = containsConcept(text, [
    'research',
    'study',
    'studies',
    'benchmark',
    'analysis'
  ]);
  const restrictedSubject = containsConcept(text, [
    'restricted',
    'confidential',
    'private',
    'nonpublic',
    'sensitive'
  ]);
  const securitySubject = containsConcept(text, [
    'security',
    'encryption',
    'breach',
    'incident',
    'vulnerability',
    'compliance'
  ]);
  const customerSpecific = containsConcept(text, [
    'customer',
    'client',
    'account',
    'bespoke',
    'custom',
    'specific'
  ]);
  return {
    liabilityCapChanged: liabilitySubject && liabilityChange,
    dataRetentionLanguage: dataSubject && retentionSubject,
    restrictedResearchLanguage: researchSubject && restrictedSubject,
    customerSpecificSecurityLanguage: securitySubject && customerSpecific,
    customerFacingConcessionLanguage: commercialBenefit && commitment
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

  if (input.customerFacingConcessionLanguage) {
    const trigger = 'customer_facing_concession_language';
    entries.push(
      entry(
        'customer_concession',
        ['account_owner'],
        [trigger],
        entries.map(({ id }) => id)
      )
    );
    triggers.push(trigger);
  }

  return Object.freeze({
    quorumVersion: APPROVAL_QUORUM_VERSION,
    policyTriggers: Object.freeze(triggers),
    entries: Object.freeze(entries)
  });
}
