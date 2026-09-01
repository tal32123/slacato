import { describe, expect, it } from 'vitest';
import type { DealBrief, WorkflowRun } from '@slacato/core';
import type { PostgresBriefExportService, PostgresWorkflowStore } from '@slacato/infrastructure';
import { readBrief } from '../../scripts/brief-quality-live.js';
import { healthyBrief } from '../support/brief-fixtures.js';

/**
 * The live evaluator is the evidence the submission leans on for "a real model produces a usable
 * brief". A draft checkpoint is persisted by the synthesis step *before* the validation step runs,
 * so a run that terminally fails validation still leaves a `strategy:1` artifact behind. Reading
 * that artifact and scoring it would report quality for a run that never succeeded, which is worse
 * than reporting nothing. These tests pin the statuses the reader accepts.
 */

function runWithStatus(status: WorkflowRun['status']): WorkflowRun {
  return {
    id: 'run_brief_quality_live' as WorkflowRun['id'],
    opportunityId: 'OPP-1001' as WorkflowRun['opportunityId'],
    requestedBy: 'USR-5001' as WorkflowRun['requestedBy'],
    status,
    version: 7,
    generationProvider: 'openrouter',
    generationModel: 'test-model',
    startRequestHash: 'brief-quality-live:test'
  };
}

/** A store that holds the draft the synthesis step persisted before validation was ever attempted. */
function storeWithDraft(draft: DealBrief): Pick<PostgresWorkflowStore, 'getCheckpoint'> {
  return {
    async getCheckpoint(input: { runId: string; step: string }) {
      if (input.step !== 'strategy:1') return undefined;
      return { status: 'completed', value: draft };
    }
  } as unknown as Pick<PostgresWorkflowStore, 'getCheckpoint'>;
}

/** An exporter that returns the finalized brief only for a run that actually reached completion. */
function exporterWith(brief: DealBrief): Pick<PostgresBriefExportService, 'exportFinalized'> {
  return {
    async exportFinalized() {
      return { content: JSON.stringify(brief) };
    }
  } as unknown as Pick<PostgresBriefExportService, 'exportFinalized'>;
}

describe('live brief-quality run gating', () => {
  it('refuses the draft a terminally failed run left behind', async () => {
    const draft = healthyBrief();
    await expect(
      readBrief(exporterWith(draft), storeWithDraft(draft), runWithStatus('failed'))
    ).rejects.toThrow(/failed/);
  });

  it('refuses a run the pump abandoned before it reached any terminal state', async () => {
    const draft = healthyBrief();
    await expect(
      readBrief(exporterWith(draft), storeWithDraft(draft), runWithStatus('validating'))
    ).rejects.toThrow(/validating/);
  });

  it('refuses a cancelled run that still holds a draft checkpoint', async () => {
    const draft = healthyBrief();
    await expect(
      readBrief(exporterWith(draft), storeWithDraft(draft), runWithStatus('cancelled'))
    ).rejects.toThrow();
  });

  it('reads the finalized export of a completed run', async () => {
    const brief = healthyBrief();
    await expect(
      readBrief(exporterWith(brief), storeWithDraft(brief), runWithStatus('completed'))
    ).resolves.toMatchObject({ executiveSummary: brief.executiveSummary });
  });

  it('reads the approver-facing draft of a run stopped at approval', async () => {
    const draft = healthyBrief();
    await expect(
      readBrief(exporterWith(draft), storeWithDraft(draft), runWithStatus('awaiting_approval'))
    ).resolves.toMatchObject({ executiveSummary: draft.executiveSummary });
  });
});
