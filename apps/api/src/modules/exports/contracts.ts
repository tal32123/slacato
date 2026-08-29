import type { DealBriefExportFormat } from '@slacato/core';

export const BRIEF_EXPORT_SERVICE = Symbol('BRIEF_EXPORT_SERVICE');

export type BriefExportResult = Readonly<{
  content: string;
  format: DealBriefExportFormat;
}>;

/** Supplies finalized brief exports to the API delivery layer. */
export interface BriefExportService {
  /** Exports an authorized finalized run, or returns undefined when access is denied. */
  exportFinalized(input: Readonly<{
    actorId: string;
    runId: string;
    format: DealBriefExportFormat;
  }>): Promise<BriefExportResult | undefined>;
}
