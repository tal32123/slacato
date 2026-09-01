import { type EvidenceDetail, evidenceDetailSchema, isoDateSchema } from '@slacato/contracts';
import { resolveEvidenceIdentity } from '../../domain/briefs/references.js';
import type { DealEvidence } from './contracts.js';

/** Projects an authorized evidence record into the provenance-safe detail shown to reviewers. */
export function projectEvidenceDetail(evidence: DealEvidence): EvidenceDetail | undefined {
  const locator = evidence.sourceLocator?.trim();
  if (!locator) return undefined;

  const fields: Record<string, string> = {};
  for (const line of evidence.content.split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key && value) fields[key] = value;
  }
  const stableIdentity = resolveEvidenceIdentity(locator, fields);
  if (stableIdentity === undefined) return undefined;
  if (evidence.eventDate !== null && !isoDateSchema.safeParse(evidence.eventDate).success)
    return undefined;

  const capturedAt =
    evidence.eventDate === null
      ? (evidence.createdAt instanceof Date
          ? evidence.createdAt
          : new Date(evidence.createdAt)
        ).toISOString()
      : `${evidence.eventDate}T00:00:00.000Z`;
  const detail = evidenceDetailSchema.safeParse({
    id: evidence.id,
    sourceType: evidence.sourceType,
    sourcePath: stableIdentity.sourcePath,
    stableKey: stableIdentity.key,
    stableId: stableIdentity.id,
    citationLabel: `source=${stableIdentity.sourcePath}, ${stableIdentity.key}=${stableIdentity.id}`,
    chunkId: evidence.id,
    capturedAt,
    content: evidence.content
  });
  return detail.success ? detail.data : undefined;
}
