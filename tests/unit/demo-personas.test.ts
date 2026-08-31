import type { Persona } from '@slacato/contracts';
import { describe, expect, it } from 'vitest';
import {
  demoPersonaPurpose,
  groupDemoPersonas
} from '../../apps/web/src/features/personas/demo-personas';

/** Mirrors the canonical directory listing, including its fixture ordering. */
const canonicalPersonas: readonly Persona[] = [
  { userId: 'USR-5007', displayName: 'Harper Noor', role: 'Unauthorized Requester' },
  { userId: 'USR-5006', displayName: 'Iris Wynn', role: 'Legal Reviewer' },
  { userId: 'USR-5001', displayName: 'Maya Levin', role: 'Account Owner' },
  { userId: 'USR-5003', displayName: 'Nora Chen', role: 'Restricted Account Owner' },
  { userId: 'USR-5002', displayName: 'Owen Patel', role: 'Account Owner' },
  { userId: 'USR-5005', displayName: 'Rina Vale', role: 'Deal Desk Approver' },
  { userId: 'USR-5004', displayName: 'Sam Hale', role: 'Sales Leader' },
  { userId: 'USR-5008', displayName: 'Tomas Reed', role: 'Restricted Sales Leader' }
];

describe('groupDemoPersonas', () => {
  it('leads with the identities the graded scenarios need', () => {
    const [scenario] = groupDemoPersonas(canonicalPersonas);

    expect(scenario?.id).toBe('scenario');
    expect(scenario?.collapsed).toBe(false);
    expect(scenario?.personas.map((persona) => persona.userId)).toEqual([
      'USR-5001',
      'USR-5002',
      'USR-5003',
      'USR-5007'
    ]);
  });

  it('keeps every authority the restricted-deal quorum requires available without hiding it', () => {
    const authority = groupDemoPersonas(canonicalPersonas).find(
      (group) => group.id === 'authority'
    );

    expect(authority?.collapsed).toBe(false);
    expect(authority?.personas.map((persona) => persona.userId)).toEqual([
      'USR-5005',
      'USR-5008',
      'USR-5006'
    ]);
  });

  it('folds identities no scenario needs into a collapsed group instead of dropping them', () => {
    const groups = groupDemoPersonas(canonicalPersonas);
    const supporting = groups.find((group) => group.id === 'supporting');

    expect(supporting?.collapsed).toBe(true);
    expect(supporting?.personas.map((persona) => persona.userId)).toEqual(['USR-5004']);
    expect(groups.flatMap((group) => group.personas)).toHaveLength(canonicalPersonas.length);
  });

  it('promotes both interchangeable Scenario 1 owners to the top-level list, not just one', () => {
    const [scenario] = groupDemoPersonas(canonicalPersonas);
    const supporting = groupDemoPersonas(canonicalPersonas).find(
      (group) => group.id === 'supporting'
    );

    expect(scenario?.personas.map((persona) => persona.userId)).toContain('USR-5002');
    expect(supporting?.personas.map((persona) => persona.userId)).not.toContain('USR-5002');
  });

  it('never drops an unrecognized canonical identity', () => {
    const groups = groupDemoPersonas([
      ...canonicalPersonas,
      { userId: 'USR-6000', displayName: 'New Fixture Identity', role: 'Account Owner' }
    ]);

    expect(groups.flatMap((group) => group.personas.map((persona) => persona.userId))).toContain(
      'USR-6000'
    );
  });

  it('omits groups that the current directory cannot fill', () => {
    const groups = groupDemoPersonas([canonicalPersonas[2] as Persona]);

    expect(groups.map((group) => group.id)).toEqual(['scenario']);
  });
});

describe('demoPersonaPurpose', () => {
  it('explains why each curated identity is present without naming another persona', () => {
    const names = canonicalPersonas.map((persona) => persona.displayName);
    for (const persona of canonicalPersonas) {
      const purpose = demoPersonaPurpose(persona);
      expect(purpose.length).toBeGreaterThan(0);
      for (const name of names.filter((value) => value !== persona.displayName))
        expect(purpose).not.toContain(name);
    }
  });

  it('falls back to a truthful description for an unknown identity', () => {
    expect(
      demoPersonaPurpose({ userId: 'USR-6000', displayName: 'New', role: 'Account Owner' })
    ).toContain('canonical permissions');
  });
});
