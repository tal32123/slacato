import { z } from 'zod';

/** Maximum length of an opaque persisted identifier, keeping identifiers bounded in every contract. */
export const MAX_ID_LENGTH = 128;

const opaqueIdSuffix = '[A-Za-z0-9][A-Za-z0-9_-]*';

function prefixedIdSchema<Brand extends string>(prefix: string, canonicalPrefix?: string) {
  const pattern = canonicalPrefix === undefined
    ? `^${prefix}_${opaqueIdSuffix}$`
    : `^(?:${prefix}_${opaqueIdSuffix}|${canonicalPrefix}-\\d+)$`;
  return z.string()
    .min(Math.min(prefix.length + 1, canonicalPrefix === undefined ? Number.POSITIVE_INFINITY : canonicalPrefix.length + 2))
    .max(MAX_ID_LENGTH)
    .regex(new RegExp(pattern), `Expected a ${prefix}_ opaque identifier or canonical ${canonicalPrefix ?? prefix} identifier`)
    .brand<Brand>();
}

/** Runtime-validated identifier for a user/persona. */
export const userIdSchema = prefixedIdSchema<'UserId'>('user', 'USR');
/** Runtime-validated identifier for a CRM account. */
export const accountIdSchema = prefixedIdSchema<'AccountId'>('account', 'ACC');
/** Runtime-validated identifier for a CRM opportunity. */
export const opportunityIdSchema = prefixedIdSchema<'OpportunityId'>('opportunity', 'OPP');
/** Runtime-validated identifier for a persisted workflow run. */
export const runIdSchema = prefixedIdSchema<'RunId'>('run');
/** Runtime-validated identifier for an immutable evidence version. */
export const evidenceIdSchema = prefixedIdSchema<'EvidenceId'>('evidence');
/** Runtime-validated identifier for a stable evidence citation. */
export const citationIdSchema = prefixedIdSchema<'CitationId'>('citation');
/** Runtime-validated identifier for a generated factual claim. */
export const claimIdSchema = prefixedIdSchema<'ClaimId'>('claim');

export type UserId = z.infer<typeof userIdSchema>;
export type AccountId = z.infer<typeof accountIdSchema>;
export type OpportunityId = z.infer<typeof opportunityIdSchema>;
export type RunId = z.infer<typeof runIdSchema>;
export type EvidenceId = z.infer<typeof evidenceIdSchema>;
export type CitationId = z.infer<typeof citationIdSchema>;
export type ClaimId = z.infer<typeof claimIdSchema>;
