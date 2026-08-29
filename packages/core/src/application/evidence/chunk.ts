import { classifyEvidenceSensitivity, type FixtureSet } from './fixture-schemas.js';

export type EvidenceSourceType = 'salesforce' | 'gong_summary' | 'gong_transcript' | 'slack' | 'pricing' | 'policy';
export type EvidenceDocument = Readonly<{
  externalId: string; sourceType: EvidenceSourceType; accountId: string; opportunityId?: string | undefined;
  eventDate?: string | undefined; accessLevel: 'standard' | 'restricted'; reliability: string;
  classificationReason: string; policyHash: string; sourceLocator: string; content: string;
}>;
export type EvidenceChunk = Readonly<{
  id: string; documentExternalId: string; chunkIndex: number; content: string; accountId: string;
  opportunityId?: string | undefined; sourceType: EvidenceSourceType; accessLevel: 'standard' | 'restricted';
  eventDate?: string | undefined; reliability: string; classificationReason: string; policyHash: string; sourceLocator: string;
}>;

/** Builds overlapping transcript-turn windows while repeating the explicit transcript header and metadata blocks. */
function transcriptWindows(content: string): string[] {
  const blocks = content.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const hasTranscriptHeading = /^#{1,6}\s+Transcript(?:\s*:|\b)/i.test(blocks[0] ?? '');
  const metadataCandidate = hasTranscriptHeading ? blocks[1] : undefined;
  const hasTranscriptMetadata = metadataCandidate !== undefined
    && ['Opportunity', 'Account', 'Date', 'Source access level']
      .every((label) => new RegExp(`^\\*\\*${label}:\\*\\*\\s*\\S+`, 'mi').test(metadataCandidate));
  const headerBlockCount = Number(hasTranscriptHeading) + Number(hasTranscriptMetadata);
  const header = blocks.slice(0, headerBlockCount);
  const turns = blocks.slice(headerBlockCount);
  if (turns.length <= 6) return [[...header, ...turns].join('\n\n')];
  const windows: string[] = [];
  for (let start = 0; start < turns.length; start += 5) {
    const window = turns.slice(start, start + 6);
    if (start > 0 && window.length < 2) break;
    windows.push([...header, ...window].join('\n\n'));
    if (start + 6 >= turns.length) break;
  }
  return windows;
}

/** Deterministically chunks at source-semantic boundaries and preserves authorization metadata. */
export function chunkDocument(document: EvidenceDocument): EvidenceChunk[] {
  const contents = document.sourceType === 'gong_transcript'
    ? transcriptWindows(document.content)
    : [document.content.trim()];
  return contents.map((content, chunkIndex) => ({
    id: `${document.sourceType}:${document.externalId}:${chunkIndex}`,
    documentExternalId: document.externalId,
    chunkIndex,
    content,
    accountId: document.accountId,
    ...(document.opportunityId === undefined ? {} : { opportunityId: document.opportunityId }),
    sourceType: document.sourceType,
    accessLevel: document.accessLevel,
    ...(document.eventDate === undefined ? {} : { eventDate: document.eventDate }),
    reliability: document.reliability,
    classificationReason: document.classificationReason,
    policyHash: document.policyHash,
    sourceLocator: `${document.sourceLocator}#chunk-${chunkIndex}`
  }));
}

/** Converts a structured fixture row into readable evidence text. */
function recordContent(record: Readonly<Record<string, unknown>>): string {
  return Object.entries(record).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`).join('\n');
}

/** Normalizes canonical fixtures into classified, provider-free source documents. */
export function buildEvidenceDocuments(fixtures: FixtureSet): EvidenceDocument[] {
  const documents: EvidenceDocument[] = [];
  const opportunityById = new Map(fixtures.opportunities.map((opportunity) => [opportunity.opportunityId, opportunity]));
  const accountById = new Map(fixtures.accounts.map((account) => [account.accountId, account]));
  const opportunitiesByAccount = new Map<string, typeof fixtures.opportunities>();
  for (const opportunity of fixtures.opportunities) {
    const existing = opportunitiesByAccount.get(opportunity.accountId) ?? [];
    opportunitiesByAccount.set(opportunity.accountId, [...existing, opportunity].sort((left, right) => left.opportunityId.localeCompare(right.opportunityId)));
  }
  const policy = fixtures.policy;
  const add = (
    source: Omit<EvidenceDocument, 'accessLevel' | 'classificationReason' | 'policyHash'>,
    classificationRecord: Parameters<typeof classifyEvidenceSensitivity>[0],
    opportunity?: Parameters<typeof classifyEvidenceSensitivity>[1]
  ) => {
    const classification = classifyEvidenceSensitivity(classificationRecord, opportunity, policy);
    documents.push({ ...source, accessLevel: classification.accessLevel, classificationReason: classification.reason, policyHash: classification.policyHash });
  };

  for (const account of fixtures.accounts) for (const opportunity of opportunitiesByAccount.get(account.accountId) ?? []) add({
    externalId: `${account.accountId}:${opportunity.opportunityId}:account`, sourceType: 'salesforce', accountId: account.accountId,
    opportunityId: opportunity.opportunityId, reliability: 'authoritative_system',
    sourceLocator: `salesforce/accounts.tsv#${account.accountId}/opportunity/${opportunity.opportunityId}`, content: recordContent(account)
  }, { sourceType: 'salesforce', sourceAccessLevel: account.accessLevel }, opportunity);
  for (const opportunity of fixtures.opportunities) add({
    externalId: opportunity.opportunityId, sourceType: 'salesforce', accountId: opportunity.accountId,
    opportunityId: opportunity.opportunityId, reliability: 'authoritative_system',
    sourceLocator: `salesforce/opportunities.tsv#${opportunity.opportunityId}`, content: recordContent(opportunity)
  }, { sourceType: 'salesforce' }, opportunity);
  for (const contact of fixtures.contacts) {
    const account = accountById.get(contact.accountId);
    for (const opportunity of opportunitiesByAccount.get(contact.accountId) ?? []) add({
      externalId: `${contact.contactId}:${opportunity.opportunityId}:contact`, sourceType: 'salesforce', accountId: contact.accountId,
      opportunityId: opportunity.opportunityId,
      eventDate: contact.lastInteractionDate, reliability: 'authoritative_system',
      sourceLocator: `salesforce/contacts.tsv#${contact.contactId}/opportunity/${opportunity.opportunityId}`, content: recordContent(contact)
    }, { sourceType: 'salesforce', sourceAccessLevel: account?.accessLevel }, opportunity);
  }
  for (const summary of fixtures.gongSummaries) add({
    externalId: `${summary.callId}:summary`, sourceType: 'gong_summary', accountId: summary.accountId,
    opportunityId: summary.opportunityId, eventDate: summary.callDate, reliability: 'conversation_summary',
    sourceLocator: `gong/gong_call_summaries.tsv#${summary.callId}`, content: recordContent(summary)
  }, { sourceType: 'gong_summary', sourceAccessLevel: summary.sourceAccessLevel }, opportunityById.get(summary.opportunityId));
  for (const transcript of fixtures.transcripts) add({
    externalId: `${transcript.callId}:transcript`, sourceType: 'gong_transcript', accountId: transcript.accountId,
    opportunityId: transcript.opportunityId, eventDate: transcript.callDate, reliability: 'direct_conversation',
    sourceLocator: transcript.sourceLocator, content: transcript.content
  }, { sourceType: 'gong_transcript', sourceAccessLevel: transcript.sourceAccessLevel }, opportunityById.get(transcript.opportunityId));
  for (const note of fixtures.pricingNotes) {
    const opportunity = opportunityById.get(note.opportunityId);
    if (opportunity === undefined) throw new Error(`Unknown pricing opportunity ${note.opportunityId}`);
    add({
      externalId: note.pricingNoteId, sourceType: 'pricing', accountId: opportunity.accountId,
      opportunityId: note.opportunityId, reliability: 'authoritative_system',
      sourceLocator: `pricing/pricing_notes.tsv#${note.pricingNoteId}`, content: recordContent(note)
    }, {
      sourceType: 'pricing',
      requestedDiscount: note.requestedDiscount,
      renewalUplift: note.renewalUplift,
      approvalStatus: note.approvalStatus,
      pricingNotes: note.pricingNotes
    }, opportunity);
  }
  for (const update of fixtures.slackUpdates) add({
    externalId: update.updateId, sourceType: 'slack', accountId: update.accountId,
    opportunityId: update.opportunityId, eventDate: update.updateDate, reliability: 'internal_collaboration',
    sourceLocator: `slack/account_team_updates.tsv#${update.updateId}`, content: recordContent(update)
  }, { sourceType: 'slack', sourceAccessLevel: update.sourceAccessLevel }, opportunityById.get(update.opportunityId));
  for (const opportunity of fixtures.opportunities) add({
    externalId: `deal-desk-policy:${opportunity.opportunityId}`, sourceType: 'policy', accountId: opportunity.accountId,
    opportunityId: opportunity.opportunityId, reliability: 'authoritative_policy',
    sourceLocator: `policies/deal_desk_policy.md#opportunity/${opportunity.opportunityId}`, content: policy.content
  }, { sourceType: 'policy', sourceAccessLevel: 'standard' }, opportunity);
  return documents;
}
