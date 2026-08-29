export type ReadinessProbeResult = boolean | 'unconfigured';

export interface ReadinessCheck {
  isReady(): Promise<ReadinessProbeResult>;
}

export interface ReadinessDependencies {
  database: ReadinessCheck;
  migration: ReadinessCheck;
  redis: ReadinessCheck;
  index: ReadinessCheck;
  model: ReadinessCheck;
}

export type ReadinessCheckName = keyof ReadinessDependencies;
export type ReadinessCheckStatus = 'ready' | 'unavailable' | 'unconfigured';

export interface ReadyHealth {
  status: 'ready';
  checks: Record<ReadinessCheckName, 'ready'>;
}

export interface NotReadyHealth {
  status: 'not_ready';
  checks: Record<ReadinessCheckName, ReadinessCheckStatus>;
  detail: { code: 'MODEL_UNAVAILABLE' | 'DEPENDENCY_UNAVAILABLE'; generation: 'disabled' };
}

export interface UnconfiguredHealth {
  status: 'unconfigured';
  checks: Record<ReadinessCheckName, 'ready' | 'unconfigured'>;
  detail: { code: 'CHECKS_UNCONFIGURED'; generation: 'disabled' };
}

export type ReadinessHealth = ReadyHealth | NotReadyHealth | UnconfiguredHealth;

/** Coordinates replaceable readiness probes without constructing real infrastructure. */
export class HealthService {
  public constructor(private readonly dependencies: ReadinessDependencies) {}

  public async readiness(): Promise<ReadinessHealth> {
    const entries = await Promise.all(
      (Object.entries(this.dependencies) as Array<[ReadinessCheckName, ReadinessCheck]>).map(async ([name, check]) => {
        try {
          const result = await check.isReady();
          return [name, result === 'unconfigured' ? 'unconfigured' : result ? 'ready' : 'unavailable'] as const;
        } catch {
          return [name, 'unavailable'] as const;
        }
      })
    );
    const checks = Object.fromEntries(entries) as Record<ReadinessCheckName, ReadinessCheckStatus>;
    const unavailable = (Object.entries(checks) as Array<[ReadinessCheckName, ReadinessCheckStatus]>).find(([, status]) => status === 'unavailable');
    if (unavailable === undefined) {
      const unconfigured = Object.values(checks).some((status) => status === 'unconfigured');
      if (unconfigured) {
        return {
          status: 'unconfigured',
          checks: checks as Record<ReadinessCheckName, 'ready' | 'unconfigured'>,
          detail: { code: 'CHECKS_UNCONFIGURED', generation: 'disabled' }
        };
      }
      return { status: 'ready', checks: checks as Record<ReadinessCheckName, 'ready'> };
    }

    return {
      status: 'not_ready',
      checks,
      detail: {
        code: unavailable[0] === 'model' ? 'MODEL_UNAVAILABLE' : 'DEPENDENCY_UNAVAILABLE',
        generation: 'disabled'
      }
    };
  }
}
