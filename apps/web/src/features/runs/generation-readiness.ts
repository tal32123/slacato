import type { ReadinessHealth } from '@slacato/contracts';

/** Explains, honestly and specifically, whether brief generation can currently succeed. */
export type GenerationGate = Readonly<{
  blocked: boolean;
  reason?: string;
}>;

/** A gate that never blocks, used whenever readiness is unknown rather than confirmed bad. */
const UNKNOWN_GATE: GenerationGate = { blocked: false };

/**
 * Derives whether the Generate Brief control should be gated from the API's readiness
 * report. Fails toward usable: a missing result or a failed readiness check never blocks
 * the control, only a readiness report that positively says generation cannot succeed does.
 */
export function describeGenerationReadiness(
  health: ReadinessHealth | undefined,
  isError: boolean
): GenerationGate {
  if (isError || health === undefined || health.status === 'ready') return UNKNOWN_GATE;

  if (health.status === 'unconfigured') {
    return {
      blocked: true,
      reason: 'Generation unavailable — required dependency checks are not configured.'
    };
  }

  if (health.checks.index === 'unavailable') {
    return { blocked: true, reason: 'Generation unavailable — evidence index not ready.' };
  }
  if (health.checks.model === 'unavailable') {
    return { blocked: true, reason: 'Generation unavailable — the generation model is not ready.' };
  }
  return { blocked: true, reason: 'Generation unavailable — a required dependency is not ready.' };
}
