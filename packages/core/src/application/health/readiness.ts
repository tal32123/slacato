/** Result returned by a dependency readiness port. */
export type ReadinessProbeResult = boolean | 'unconfigured';

/** Reports whether one required runtime dependency is ready. */
export interface ReadinessCheck {
  isReady(): Promise<ReadinessProbeResult>;
}

/** Required dependency probes composed by an application delivery boundary. */
export interface ReadinessDependencies {
  database: ReadinessCheck;
  migration: ReadinessCheck;
  redis: ReadinessCheck;
  index: ReadinessCheck;
  model: ReadinessCheck;
}
