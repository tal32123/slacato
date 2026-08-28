export interface ReadinessCheck {
  isReady(): Promise<boolean>;
}

export interface ReadinessDependencies {
  database: ReadinessCheck;
  migration: ReadinessCheck;
  redis: ReadinessCheck;
  index: ReadinessCheck;
  model: ReadinessCheck;
}

export type ReadinessCheckName = keyof ReadinessDependencies;
export type ReadinessCheckStatus = 'ready' | 'unavailable';

export interface ReadyHealth {
  status: 'ready';
  checks: Record<ReadinessCheckName, 'ready'>;
}

export interface NotReadyHealth {
  status: 'not_ready';
  checks: Record<ReadinessCheckName, ReadinessCheckStatus>;
  detail: { code: 'MODEL_UNAVAILABLE' | 'DEPENDENCY_UNAVAILABLE'; generation: 'disabled' };
}

export type ReadinessHealth = ReadyHealth | NotReadyHealth;

/** Coordinates replaceable readiness probes without constructing real infrastructure. */
export class HealthService {
  public constructor(private readonly dependencies: ReadinessDependencies) {}

  public async readiness(): Promise<ReadinessHealth> {
    const entries = await Promise.all(
      (Object.entries(this.dependencies) as Array<[ReadinessCheckName, ReadinessCheck]>).map(async ([name, check]) => {
        try {
          return [name, (await check.isReady()) ? 'ready' : 'unavailable'] as const;
        } catch {
          return [name, 'unavailable'] as const;
        }
      })
    );
    const checks = Object.fromEntries(entries) as Record<ReadinessCheckName, ReadinessCheckStatus>;
    const unavailable = (Object.entries(checks) as Array<[ReadinessCheckName, ReadinessCheckStatus]>).find(([, status]) => status === 'unavailable');

    if (!unavailable) return { status: 'ready', checks: checks as Record<ReadinessCheckName, 'ready'> };

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
