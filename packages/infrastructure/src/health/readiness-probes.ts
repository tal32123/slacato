import type { ReadinessCheck, ReadinessDependencies } from '@slacato/core';
import type { DatabaseClient } from '../db/client.js';
import { type ConfiguredProvider, PROVIDER_REGISTRY } from '../model/registry.js';
import type { BullMqCommandQueue } from '../queue/bullmq.js';

/** Drizzle timestamp for 0021_operable_approval_grants, the migration required by this API build. */
export const LATEST_DRIZZLE_MIGRATION_TIMESTAMP = 1_788_730_200_000;

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

export type ProductionReadinessOptions = Readonly<{
  database: DatabaseClient;
  redis: BullMqCommandQueue;
  provider: ConfiguredProvider;
  timeoutMs?: number;
}>;

/** Converts a dependency operation into a deadline-bounded, fail-closed readiness check. */
function boundedCheck(
  operation: (signal: AbortSignal) => Promise<boolean>,
  timeoutMs: number
): ReadinessCheck {
  return {
    async isReady(): Promise<boolean> {
      const controller = new AbortController();
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (ready: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ready);
        };
        const timer = setTimeout(() => {
          controller.abort();
          settle(false);
        }, timeoutMs);
        void operation(controller.signal).then(settle, () => settle(false));
      });
    }
  };
}

/** Creates the bounded model/provider probe used by production and focused composition tests. */
export function createConfiguredModelReadinessCheck(
  configured: ConfiguredProvider,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS
): ReadinessCheck {
  return boundedCheck(
    (signal) => PROVIDER_REGISTRY[configured.provider].readinessProbe(configured, signal),
    timeoutMs
  );
}

/** Accepts the required migration and forward-compatible database migration levels. */
export function isRequiredMigrationApplied(applied: string | null): boolean {
  if (applied === null) return false;
  try {
    return BigInt(applied) >= BigInt(LATEST_DRIZZLE_MIGRATION_TIMESTAMP);
  } catch {
    return false;
  }
}

/** Creates production checks over shared PostgreSQL and Redis infrastructure capabilities. */
export function createProductionReadinessChecks(
  options: ProductionReadinessOptions
): ReadinessDependencies {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const database = options.database;
  const provider = options.provider;
  return {
    database: boundedCheck(async () => {
      const rows = await database.sql<{ connected: number }[]>`select 1::integer as connected`;
      return rows[0]?.connected === 1;
    }, timeoutMs),
    migration: boundedCheck(async () => {
      const rows = await database.sql<{ created_at: string | null }[]>`
        select max(created_at)::text as created_at from drizzle.__drizzle_migrations
      `;
      return isRequiredMigrationApplied(rows[0]?.created_at ?? null);
    }, timeoutMs),
    redis: boundedCheck(async () => {
      await options.redis.queue.getJobCounts();
      return true;
    }, timeoutMs),
    index: boundedCheck(async () => {
      const rows = await database.sql<{ total: number; matching: number; profiles: number }[]>`
        select
          count(*)::integer as total,
          count(*) filter (where
            embedding is not null
            and embedding_provider = ${provider.provider}
            and embedding_model = ${provider.embeddingModel}
            and embedding_dimension > 0
            and vector_dims(embedding) = embedding_dimension
            and length(embedding_profile) > 0
            and length(embedding_version) > 0
            and embedding_normalization in ('l2', 'none')
            and embedding_content_hash = content_hash
          )::integer as matching,
          count(distinct row(
            embedding_provider,
            embedding_model,
            embedding_dimension,
            embedding_profile,
            embedding_version,
            embedding_normalization
          ))::integer as profiles
        from evidence_versions
      `;
      const health = rows[0];
      return (
        health !== undefined &&
        health.total > 0 &&
        health.matching === health.total &&
        health.profiles === 1
      );
    }, timeoutMs),
    model: createConfiguredModelReadinessCheck(provider, timeoutMs)
  };
}
