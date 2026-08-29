import { describe, expect, it } from 'vitest';
import {
  AuthorizationDeniedError,
  CancelDealBrief,
  DomainConflictError,
  transitionRun,
  type DealBriefAccessControl,
  type WorkflowRun
} from '@slacato/core';
import { cancelRunResponseSchema, runStatusSchema } from '@slacato/contracts';

const activeRun: WorkflowRun = {
  id: 'run_active', opportunityId: 'OPP-1001', requestedBy: 'maya', status: 'specialists_running',
  version: 3, generationProvider: 'openrouter', generationModel: 'z-ai/glm-5.3-flash', startRequestHash: 'a'.repeat(64)
};

describe('run cancellation', () => {
  it('persists cancellation as an explicit terminal lifecycle state', () => {
    expect(runStatusSchema.parse('cancelled')).toBe('cancelled');
    expect(transitionRun('specialists_running', 'cancel')).toBe('cancelled');
    expect(cancelRunResponseSchema.parse({ runId: 'run_active', status: 'cancelled', version: 4 })).toEqual({
      runId: 'run_active', status: 'cancelled', version: 4
    });
  });

  it('allows only the initiating authorized user to cancel an active run', async () => {
    let persisted: Parameters<ConstructorParameters<typeof CancelDealBrief>[0]['cancelRun']>[0] | undefined;
    const service = new CancelDealBrief({
      getRun: async () => activeRun,
      cancelRun: async (input) => {
        persisted = input;
        return { ...activeRun, status: 'cancelled', version: 4 };
      }
    }, access(true));

    const result = await service.execute({ runId: activeRun.id, requestedBy: 'maya' });

    expect(result.status).toBe('cancelled');
    expect(persisted).toEqual({ runId: 'run_active', expectedVersion: 3, cancelledBy: 'maya' });
  });

  it('keeps unauthorized cancellation opaque', async () => {
    const service = new CancelDealBrief({
      getRun: async () => activeRun,
      cancelRun: async () => { throw new Error('must not persist'); }
    }, access(false));

    await expect(service.execute({ runId: activeRun.id, requestedBy: 'outsider' })).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  it('does not rewrite terminal history', async () => {
    const service = new CancelDealBrief({
      getRun: async () => ({ ...activeRun, status: 'completed' }),
      cancelRun: async () => { throw new Error('must not persist'); }
    }, access(true));

    await expect(service.execute({ runId: activeRun.id, requestedBy: 'maya' })).rejects.toBeInstanceOf(DomainConflictError);
  });
});

function access(allowed: boolean): DealBriefAccessControl {
  return {
    authorizeStart: async () => allowed ? { allowed: true, accountId: 'ACC-1' } : { allowed: false },
    authoritiesFor: async () => [],
    validateApprovalEdit: async () => { throw new Error('unused'); },
    recordOpaqueDenial: async () => undefined
  };
}
