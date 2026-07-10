import path from 'node:path';
import { z } from 'zod';
import type { ProjectExecutionScope } from '../../shared/types';
import type { MediaUsageTotals } from '../../shared/media-types';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedStoreChangeListener,
  type ScopedStoreOptions,
} from '../orch/scoped-store';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';

/** Project-scoped media accounting backed by the V1 `media_artifacts` table. */

export interface MediaUsageRecord {
  kind: string;
  provider: string;
  model: string;
  storageKey: string;
  sha256: string;
  costUsd: number | null;
  durationMs: number;
  missionId?: string | null;
  agentName?: string | null;
}

interface MediaMetadata {
  schemaVersion: 1;
  model: string;
  estimatedCostUsd: number | null;
  costMicros: number | null;
  durationMs: number;
  agentName: string | null;
}

const MICROS_PER_USD = 1_000_000;
const entityIdSchema = z.string().min(1).max(256);
const storageKeySchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !path.isAbsolute(value), 'storageKey must be relative')
  .refine(
    (value) => {
      const posix = value.replaceAll('\\', '/');
      const normalized = path.posix.normalize(posix);
      return (
        value === posix &&
        value === normalized &&
        normalized !== '..' &&
        !normalized.startsWith('../')
      );
    },
    'storageKey must be a canonical project-relative POSIX path',
  );
const mediaUsageRecordSchema = z
  .object({
    kind: z.string().min(1).max(64),
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
    storageKey: storageKeySchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    costUsd: z.number().finite().nonnegative().nullable(),
    durationMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1000),
    missionId: entityIdSchema.nullish(),
    agentName: z.string().min(1).max(256).nullish(),
  })
  .strict();
const mediaMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    model: z.string().min(1).max(256),
    estimatedCostUsd: z.number().finite().nonnegative().nullable(),
    costMicros: z.number().int().nonnegative().nullable(),
    durationMs: z.number().int().nonnegative(),
    agentName: z.string().min(1).max(256).nullable(),
  })
  .strict();

export class ScopedMediaUsageStore {
  readonly #binding: ScopedStoreBinding;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ScopedStoreOptions = {},
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope, options);
  }

  get scope(): ProjectExecutionScope {
    return this.#binding.scope;
  }

  onChange(listener: ScopedStoreChangeListener): () => void {
    return this.#binding.onChange(listener);
  }

  record(rawRecord: MediaUsageRecord): string {
    const record = mediaUsageRecordSchema.parse(rawRecord);
    const costMicros =
      record.costUsd === null
        ? null
        : Math.round(record.costUsd * MICROS_PER_USD);
    if (
      costMicros !== null &&
      (!Number.isSafeInteger(costMicros) || costMicros < 0)
    ) {
      throw new Error('media cost exceeds the supported range');
    }
    const metadata: MediaMetadata = mediaMetadataSchema.parse({
      schemaVersion: 1,
      model: record.model,
      estimatedCostUsd: record.costUsd,
      costMicros,
      durationMs: record.durationMs,
      agentName: record.agentName ?? null,
    });
    const id = this.#binding.makeId('media');
    this.#binding
      .writeDatabase()
      .prepare(
        `INSERT INTO media_artifacts
           (id, mission_id, media_type, provider, storage_key, sha256,
            metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        record.missionId ?? null,
        record.kind,
        record.provider,
        record.storageKey,
        record.sha256,
        JSON.stringify(metadata),
        this.#binding.now(),
      );
    this.#binding.emitChange();
    return id;
  }

  totals(): MediaUsageTotals {
    return this.#totals();
  }

  totalsByMission(rawMissionId: string): MediaUsageTotals {
    return this.#totals(entityIdSchema.parse(rawMissionId));
  }

  #totals(missionId?: string): MediaUsageTotals {
    const rows = missionId
      ? this.#binding
          .readDatabase()
          .prepare(
            `SELECT metadata_json FROM media_artifacts
             WHERE mission_id = ?`,
          )
          .all(missionId)
      : this.#binding
          .readDatabase()
          .prepare('SELECT metadata_json FROM media_artifacts')
          .all();
    let costMicros = 0;
    for (const rawRow of rows as Array<{ metadata_json?: unknown }>) {
      try {
        const rawJson = z.string().parse(rawRow.metadata_json);
        const metadata = mediaMetadataSchema.parse(JSON.parse(rawJson));
        costMicros += metadata.costMicros ?? 0;
      } catch (error) {
        throw new ScopedStoreCorruptionError('media artifact metadata', {
          cause: error,
        });
      }
    }
    if (!Number.isSafeInteger(costMicros) || costMicros < 0) {
      throw new ScopedStoreCorruptionError('media usage totals');
    }
    return {
      generations: rows.length,
      costUsd: costMicros / MICROS_PER_USD,
    };
  }
}

export function createScopedMediaUsageStore(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: ScopedStoreOptions = {},
): ScopedMediaUsageStore {
  return new ScopedMediaUsageStore(runtimeManager, scope, options);
}
