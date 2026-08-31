import type { Persona } from '@slacato/contracts';

export type DemoPersonaGroupId = 'scenario' | 'authority' | 'supporting';

export type DemoPersonaGroup = Readonly<{
  id: DemoPersonaGroupId;
  title: string;
  description: string;
  /** Whether the group starts closed in surfaces that offer a disclosure. */
  collapsed: boolean;
  personas: readonly Persona[];
}>;

/**
 * Presentation order for the personas that drive the four graded demo scenarios.
 * The canonical fixture is never filtered server-side; only this ordering is curated.
 * USR-5001 and USR-5002 are interchangeable Scenario 1 owners (OPP-1001 and OPP-1002),
 * so both lead the list at parity rather than one of them hiding in a supporting group.
 */
const scenarioOrder = ['USR-5001', 'USR-5002', 'USR-5003', 'USR-5007'] as const;

/** Presentation order for the authorities that complete the restricted-deal approval quorum. */
const authorityOrder = ['USR-5005', 'USR-5008', 'USR-5006'] as const;

const groupDefinitions = [
  {
    id: 'scenario',
    title: 'Start the demo here',
    description:
      'These identities drive the graded scenarios: two interchangeable authorized owners, the restricted-deal owner, and an unauthorized requester.',
    collapsed: false,
    order: scenarioOrder
  },
  {
    id: 'authority',
    title: 'Approval authorities',
    description:
      'The restricted deal needs a separate decision from each of these authorities before anything is published.',
    collapsed: false,
    order: authorityOrder
  }
] as const;

const supportingGroup = {
  id: 'supporting',
  title: 'Other fixture identities',
  description:
    'Available for completeness. No graded scenario needs them, so they stay out of the way.',
  collapsed: true
} as const;

/** Explains, per identity, why the demo keeps it and what it proves. */
const purposes: Readonly<Record<string, string>> = {
  'USR-5001':
    'Owns OPP-1001. Use this identity to generate an authorized, evidence-grounded brief.',
  'USR-5002': 'Owns OPP-1002. A second authorized owner, interchangeable with the first.',
  'USR-5003':
    'Owns the restricted renewal. Use this identity to trigger pricing, legal, and customer-facing approval routing.',
  'USR-5004': 'Reads the ACC-2001 and ACC-2002 team pipeline. Not required by any graded scenario.',
  'USR-5005': 'Deal Desk decision on the discount above the policy threshold.',
  'USR-5006': 'Legal decision on liability and restricted-data language.',
  'USR-5007':
    'Has no access to the restricted account. Use this identity to prove denials never leak restricted data.',
  'USR-5008': 'Sales Leader decision required once a discount passes fifteen percent.'
};

/** Describes why the demo presents each canonical identity. */
export function demoPersonaPurpose(persona: Persona): string {
  return (
    purposes[persona.userId] ?? 'Uses the canonical permissions assigned to this demo identity.'
  );
}

/** Groups canonical personas so the demo leads with the identities the graded scenarios need. */
export function groupDemoPersonas(personas: readonly Persona[]): readonly DemoPersonaGroup[] {
  const byId = new Map(personas.map((persona) => [persona.userId, persona]));
  const claimed = new Set<string>();
  const curated = groupDefinitions.map((definition) => {
    const members = definition.order.flatMap((userId) => {
      const persona = byId.get(userId);
      if (persona === undefined) return [];
      claimed.add(userId);
      return [persona];
    });
    return {
      id: definition.id,
      title: definition.title,
      description: definition.description,
      collapsed: definition.collapsed,
      personas: members
    } satisfies DemoPersonaGroup;
  });
  const supporting = {
    ...supportingGroup,
    personas: personas.filter((persona) => !claimed.has(persona.userId))
  } satisfies DemoPersonaGroup;
  return [...curated, supporting].filter((group) => group.personas.length > 0);
}
