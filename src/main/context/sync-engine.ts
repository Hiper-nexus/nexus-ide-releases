import { z } from 'zod';
import {
  normalizeSyncEntities,
  syncEntityKey,
  syncProjectIdSchema,
} from '../../../shared/sync-contract';
export type {
  SyncEntityType,
  SyncJsonScalar,
  SyncJsonValue,
  SyncMutation,
  SyncProjectState,
} from '../../../shared/sync-contract';
import type {
  SyncMutation,
  SyncProjectState,
} from '../../../shared/sync-contract';
export {
  normalizeSyncEntities,
  normalizeSyncMutation,
  syncProjectIdSchema,
} from '../../../shared/sync-contract';

export interface SyncBackend {
  read(projectId: string): Promise<SyncProjectState>;
  compareAndSwap(
    projectId: string,
    expectedRevision: number,
    next: readonly SyncMutation[],
  ): Promise<boolean>;
}

export type SyncPublishResult =
  | { readonly ok: true; readonly remoteRevision: number }
  | {
      readonly ok: false;
      readonly reason: 'remote-revision-conflict' | 'entity-version-conflict';
      readonly expectedRemoteRevision: number;
      readonly actualRemoteRevision: number;
      readonly conflictingEntityIds: readonly string[];
    };

const publishMetadataSchema = z
  .object({
    projectId: syncProjectIdSchema,
    expectedRemoteRevision: z.number().int().nonnegative(),
  })
  .strict();

function conflict(
  reason: 'remote-revision-conflict' | 'entity-version-conflict',
  expected: number,
  actual: number,
  entityIds: readonly string[],
): SyncPublishResult {
  return Object.freeze({
    ok: false,
    reason,
    expectedRemoteRevision: expected,
    actualRemoteRevision: actual,
    conflictingEntityIds: Object.freeze([...entityIds].sort()),
  });
}

export class OptimisticSyncEngine {
  readonly #backend: SyncBackend;

  constructor(backend: SyncBackend) {
    if (!backend) throw new Error('sync backend is required');
    this.#backend = backend;
  }

  async publish(input: {
    readonly projectId: string;
    readonly expectedRemoteRevision: number;
    readonly mutations: readonly SyncMutation[];
  }): Promise<SyncPublishResult> {
    const metadata = publishMetadataSchema.parse({
      projectId: input.projectId,
      expectedRemoteRevision: input.expectedRemoteRevision,
    });
    const mutations = normalizeSyncEntities(input.mutations);
    const keys = mutations.map(syncEntityKey);
    const remote = await this.#backend.read(metadata.projectId);
    if (remote.revision !== metadata.expectedRemoteRevision) {
      return conflict(
        'remote-revision-conflict',
        metadata.expectedRemoteRevision,
        remote.revision,
        keys,
      );
    }
    const remoteByKey = new Map(
      remote.entities.map((entity) => [
        syncEntityKey(entity),
        entity,
      ]),
    );
    const versionConflicts = mutations.filter((mutation) => {
      const existing = remoteByKey.get(
        syncEntityKey(mutation),
      );
      return (existing?.entityVersion ?? 0) !== mutation.baseVersion;
    });
    if (versionConflicts.length > 0) {
      return conflict(
        'entity-version-conflict',
        metadata.expectedRemoteRevision,
        remote.revision,
        versionConflicts.map(
          syncEntityKey,
        ),
      );
    }
    for (const mutation of mutations) {
      remoteByKey.set(syncEntityKey(mutation), mutation);
    }
    const next = [...remoteByKey.values()].sort((left, right) =>
      syncEntityKey(left).localeCompare(syncEntityKey(right)),
    );
    const updated = await this.#backend.compareAndSwap(
      metadata.projectId,
      remote.revision,
      next,
    );
    if (!updated) {
      const latest = await this.#backend.read(metadata.projectId);
      return conflict(
        'remote-revision-conflict',
        metadata.expectedRemoteRevision,
        latest.revision,
        keys,
      );
    }
    return Object.freeze({ ok: true, remoteRevision: remote.revision + 1 });
  }
}
