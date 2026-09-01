import { type DealBriefGenerationMetadata, dealBriefAgentOperations } from '@slacato/core';
import { describe, expect, it } from 'vitest';
import {
  type PersistedGenerationAttempt,
  projectWorkflowTrace
} from '../../packages/infrastructure/src/db/repositories/workflow-trace-projector.ts';

const runId = 'run_failure_projection';

function persistedAttempt(
  id: string,
  metadata: DealBriefGenerationMetadata,
  ordinal: number,
  status: string,
  possibleDuplicate: boolean
): PersistedGenerationAttempt {
  return {
    id,
    logicalGenerationId: metadata.logicalGenerationId,
    operation: metadata.operation,
    ordinal,
    provider: metadata.provider,
    model: metadata.model,
    outputMode: null,
    validationAttempts: 0,
    validationIssues: [],
    inputTokens: null,
    outputTokens: null,
    status,
    possibleDuplicate
  };
}

describe('workflow failure trace projection', () => {
  it.each(['draft_validation_failed', 'processor_attempts_exhausted'])(
    'projects %s without inventing a generation or provider attempt',
    (reason) => {
      const projection = projectWorkflowTrace({
        type: 'failed',
        runId,
        version: 4,
        reason
      });

      expect(projection.generationAttempt).toBeUndefined();
      expect(
        projection.spans.filter(({ kind }) =>
          ['specialist_attempt', 'strategy_attempt', 'model_call', 'usage'].includes(kind)
        )
      ).toEqual([]);
      const fatal = projection.spans.find(({ kind }) => kind === 'fatal_failure');
      expect(fatal).toMatchObject({
        status: 'failed',
        data: {
          decision: 'fatal',
          reasonCode: reason === 'draft_validation_failed' ? reason : 'workflow_failed'
        }
      });
      expect(fatal?.parent).toBeDefined();

      const validations = projection.spans.filter(({ kind }) => kind === 'validation');
      if (reason === 'draft_validation_failed') {
        expect(validations).toEqual([
          expect.objectContaining({
            status: 'failed',
            data: { decision: 'rejected', validationAttempts: 0 }
          })
        ]);
        expect(fatal?.parent).toEqual({ type: 'direct', spanId: validations[0]?.spanId });
      } else {
        expect(validations).toEqual([]);
      }
    }
  );

  it('does not turn draft validation into a generation failure when generation context is supplied', () => {
    const metadata: DealBriefGenerationMetadata = {
      invocationId: 'invocation_draft_validation',
      logicalGenerationId: 'generation_draft_validation',
      operation: dealBriefAgentOperations.strategy,
      provider: 'mock',
      model: 'mock-brief',
      possibleDuplicate: false
    };
    const projection = projectWorkflowTrace({
      type: 'failed',
      runId,
      version: 5,
      reason: 'draft_validation_failed',
      generationFailure: {
        metadata,
        persistedAttempts: [
          persistedAttempt('attempt_draft_validation', metadata, 1, 'completed', false)
        ]
      }
    });

    expect(projection.generationAttempt).toBeUndefined();
    expect(
      projection.spans.filter(({ kind }) =>
        ['specialist_attempt', 'strategy_attempt', 'model_call', 'usage'].includes(kind)
      )
    ).toEqual([]);
    expect(projection.spans.map(({ kind }) => kind)).toEqual(['validation', 'fatal_failure']);
  });

  it('projects only persisted provider attempts for an explicit failed generation', () => {
    const metadata: DealBriefGenerationMetadata = {
      invocationId: 'invocation_failure_projection',
      logicalGenerationId: 'generation_failure_projection',
      operation: dealBriefAgentOperations.commercial,
      provider: 'mock',
      model: 'mock-brief',
      possibleDuplicate: false
    };
    const attempts = [
      persistedAttempt('attempt_possible_duplicate', metadata, 1, 'possible_duplicate', true),
      persistedAttempt('attempt_unresolved', metadata, 2, 'attempt_started', false)
    ];

    const projection = projectWorkflowTrace({
      type: 'failed',
      runId,
      version: 5,
      reason: 'commercial_specialist_failed',
      generationFailure: { metadata, persistedAttempts: attempts }
    });

    expect(projection.generationAttempt).toBeUndefined();
    expect(
      projection.spans
        .filter(({ kind }) => kind === 'model_call')
        .map((span) => ({ status: span.status, ...span.data }))
    ).toEqual([
      expect.objectContaining({
        status: 'degraded',
        durableAttemptId: 'attempt_possible_duplicate',
        ordinal: 1,
        possibleDuplicate: true
      }),
      expect.objectContaining({
        status: 'degraded',
        durableAttemptId: 'attempt_unresolved',
        ordinal: 2,
        possibleDuplicate: false
      })
    ]);
    const failedGeneration = projection.spans.find(({ kind }) => kind === 'specialist_attempt');
    expect(failedGeneration).toMatchObject({
      status: 'failed',
      data: {
        operation: metadata.operation,
        logicalGenerationId: metadata.logicalGenerationId
      }
    });
    expect(projection.spans.filter(({ kind }) => kind === 'specialist_attempt')).toHaveLength(1);
    expect(projection.spans.filter(({ kind }) => kind === 'fatal_failure')).toEqual([
      expect.objectContaining({
        status: 'failed',
        parent: { type: 'direct', spanId: failedGeneration?.spanId }
      })
    ]);
  });

  it('does not invent a provider-attempt ID for explicit generation metadata without a ledger row', () => {
    const metadata: DealBriefGenerationMetadata = {
      invocationId: 'invocation_unpersisted_failure',
      logicalGenerationId: 'generation_unpersisted_failure',
      operation: dealBriefAgentOperations.strategy,
      provider: 'mock',
      model: 'mock-brief',
      possibleDuplicate: false
    };

    const projection = projectWorkflowTrace({
      type: 'failed',
      runId,
      version: 6,
      reason: 'strategy_generation_failed',
      generationFailure: { metadata, persistedAttempts: [] }
    });

    expect(projection.generationAttempt).toBeUndefined();
    expect(projection.spans.filter(({ kind }) => kind === 'model_call')).toEqual([]);
    expect(projection.spans.filter(({ kind }) => kind === 'strategy_attempt')).toEqual([
      expect.objectContaining({
        status: 'failed',
        data: {
          operation: metadata.operation,
          logicalGenerationId: metadata.logicalGenerationId
        }
      })
    ]);
  });
});
