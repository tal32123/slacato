import { createHash } from 'node:crypto';
import type { AccessScope, AuthorizedSourceType } from '../../domain/permissions/authorize.js';

type AllowedScope = Extract<AccessScope, { allowed: true }> & Readonly<{ personaId: string }>;

/** Serializes authorization facts deterministically for stable scope hashes. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Canonical target and effective permission facts covered by one evidence manifest. */
export type EvidenceScopeBinding = Readonly<{
  target: Readonly<{ accountId: string; opportunityId: string }>;
  personaId: string;
  accountIds: readonly string[];
  sourceTypes: readonly AuthorizedSourceType[];
  canViewSensitivePricing: boolean;
  canViewRestrictedAccounts: boolean;
  canRequestApproval: boolean;
  canApprove: boolean;
}>;

/** Normalizes an authorized scope so equivalent grants hash identically and narrowed scopes do not. */
export function createEvidenceScopeBinding(
  target: Readonly<{ accountId: string; opportunityId: string }>,
  scope: AllowedScope
): EvidenceScopeBinding {
  return {
    target: { accountId: target.accountId, opportunityId: target.opportunityId },
    personaId: scope.personaId,
    accountIds: [...new Set(scope.accountIds)].sort(),
    sourceTypes: [...new Set(scope.sourceTypes)].sort(),
    canViewSensitivePricing: scope.canViewSensitivePricing,
    canViewRestrictedAccounts: scope.canViewRestrictedAccounts,
    canRequestApproval: scope.canRequestApproval,
    canApprove: scope.canApprove
  };
}

/** Hashes normalized scope facts for retrieval persistence and downstream authorization checks. */
export function hashEvidenceScopeBinding(binding: EvidenceScopeBinding): string {
  return createHash('sha256').update(stableJson(binding)).digest('hex');
}
