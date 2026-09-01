import { describe, expect, it } from 'vitest';
import {
  approvalDecisionRequestSchema,
  approvalInboxResponseSchema,
  runDetailResponseSchema,
  runListResponseSchema,
  startBriefRequestSchema
} from '@slacato/contracts';

const timestamp = '2026-08-29T12:00:00.000Z';

describe('run and approval wire contracts', () => {
  it('accepts create requests without caller-defined token budgets and rejects untyped fields', () => {
    expect(startBriefRequestSchema.parse({
      opportunityId: 'OPP-1001',
      idempotencyKey: 'browser-operation-1'
    })).toMatchObject({ opportunityId: 'OPP-1001' });
    expect(() => startBriefRequestSchema.parse({
      opportunityId: 'OPP-1001', idempotencyKey: 'operation-1',
      budget: { maxCalls: 20, maxInputTokens: 50_000, maxOutputTokens: 20_000, deadlineMs: 60_000 }
    })).toThrow();
  });

  it('validates scoped list and resumable detail projections without accepting raw workflow data', () => {
    expect(runListResponseSchema.parse({
      sessionVersion: 'session-1',
      runs: [{
        runId: 'run-1', opportunityId: 'OPP-1001', opportunityName: 'Atlas Renewal', accountName: 'Atlas',
        initiatedBy: 'Maya Chen', status: 'awaiting_approval', createdAt: timestamp, updatedAt: timestamp
      }]
    }).runs).toHaveLength(1);

    const detail = {
      sessionVersion: 'session-1', runId: 'run-1', opportunityId: 'OPP-1001', opportunityName: 'Atlas Renewal',
      accountName: 'Atlas', initiatedBy: 'Maya Chen', status: 'validating', version: 5,
      watermark: 'event-5', watermarkSequence: 5, terminal: false, createdAt: timestamp, updatedAt: timestamp,
      failureReason: null,
      progress: {
        phase: 'validating', retrievalCount: 17, validationRetries: 1,
        specialists: [{ name: 'commercial', status: 'completed' }], completedSections: ['Executive Summary'],
        timeline: [{ sequence: 5, eventId: 'event-5', phase: 'validating', label: 'Validating the brief', at: timestamp }]
      }
    };
    expect(runDetailResponseSchema.parse(detail).watermarkSequence).toBe(5);
    expect(() => runDetailResponseSchema.parse({ ...detail, rawPrompt: 'never expose this' })).toThrow();
  });

  it('requires CAS coordinates and action-specific approval rationale semantics', () => {
    const base = {
      runId: 'run-1', approvalSubjectId: 'subject-1', expectedRunVersion: 7,
      expectedSubjectHash: 'a'.repeat(64), entryId: 'legal-1', category: 'legal_terms' as const,
      authority: 'legal_reviewer' as const, idempotencyKey: 'decision-1'
    };
    expect(approvalDecisionRequestSchema.parse({ ...base, action: 'approve_unchanged' })).toMatchObject(base);
    expect(() => approvalDecisionRequestSchema.parse({ ...base, action: 'reject' })).toThrow();
    expect(() => approvalDecisionRequestSchema.parse({ ...base, action: 'approve_unchanged', editedPayload: {} })).toThrow();
  });

  it('separates pending authority-scoped work from decided history', () => {
    const entry = {
      approvalSubjectId: 'subject-1', runId: 'run-1', runVersion: 7, subjectHash: 'b'.repeat(64),
      opportunityId: 'OPP-1001', opportunityName: 'Atlas Renewal', accountName: 'Atlas',
      entryId: 'communication-1',
      category: 'customer_communication',
      policyTriggers: ['customer_facing_language', 'customer_facing_concession_language'],
      requiredAuthorities: ['account_owner'],
      availableAuthority: 'account_owner',
      assignedApprover: null, quorum: { completed: 0, required: 2 }, ageStartedAt: timestamp,
      updatedAt: timestamp, decision: null
    };
    const parsed = approvalInboxResponseSchema.parse({ sessionVersion: 'session-1', pending: [entry], history: [] });
    expect(parsed.pending[0]?.decision).toBeNull();
    expect(parsed.pending[0]?.policyTriggers).toEqual([
      'customer_facing_language',
      'customer_facing_concession_language'
    ]);
    expect(() =>
      approvalInboxResponseSchema.parse({
        sessionVersion: 'session-1',
        pending: [{ ...entry, policyTriggers: undefined }],
        history: []
      })
    ).toThrow();
    expect(() =>
      approvalInboxResponseSchema.parse({
        sessionVersion: 'session-1',
        pending: [{ ...entry, policyTriggers: ['Customer Facing Language'] }],
        history: []
      })
    ).toThrow();
    expect(parsed.history).toEqual([]);
  });
});
