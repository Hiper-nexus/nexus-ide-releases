import { and, count, eq } from 'drizzle-orm';
import {
  canonicalSyncJson,
  normalizeSyncEntities,
  SYNC_MAX_ENTITIES_PER_PROJECT,
  SYNC_MAX_PROJECTS_PER_ACCOUNT,
  SYNC_MAX_STATE_BYTES,
  syncEntityKey,
  type SyncMutation,
  type SyncProjectState,
  type SyncStateLimits,
} from '../../../shared/sync-contract';
import type { Db } from '../db/client';
import { accounts, syncProjects } from '../db/schema';

export interface SyncLimits {
  readonly maxProjectsPerAccount?: number;
  readonly maxEntitiesPerProject?: number;
  readonly maxStateBytes?: number;
}

export interface SyncServiceDeps {
  readonly db: Db;
  readonly now?: () => number;
  readonly limits?: SyncLimits;
}

export type SyncConflictReason =
  | 'revision-conflict'
  | 'entity-version-conflict';

export type SyncCasResult =
  | { readonly ok: true; readonly revision: number; readonly serverTime: number }
  | {
      readonly ok: false;
      readonly reason: SyncConflictReason;
      readonly expectedRevision: number;
      readonly actualRevision: number;
      readonly conflictingEntityIds: readonly string[];
      readonly serverTime: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'projects-per-account';
      readonly limit: number;
      readonly actual: number;
      readonly serverTime: number;
    };

function stateFromRow(
  row: typeof syncProjects.$inferSelect | undefined,
): SyncProjectState {
  if (!row) return Object.freeze({ revision: 0, entities: Object.freeze([]) });
  return Object.freeze({
    revision: row.revision,
    entities: normalizeSyncEntities(row.entities),
  });
}

function maxProjects(deps: SyncServiceDeps): number {
  return deps.limits?.maxProjectsPerAccount ?? SYNC_MAX_PROJECTS_PER_ACCOUNT;
}

function stateLimits(deps: SyncServiceDeps): Required<SyncStateLimits> {
  return {
    maxEntities:
      deps.limits?.maxEntitiesPerProject ?? SYNC_MAX_ENTITIES_PER_PROJECT,
    maxStateBytes: deps.limits?.maxStateBytes ?? SYNC_MAX_STATE_BYTES,
  };
}

async function findProject(
  db: Db,
  accountId: string,
  projectId: string,
) {
  const [row] = await db
    .select()
    .from(syncProjects)
    .where(
      and(
        eq(syncProjects.accountId, accountId),
        eq(syncProjects.projectId, projectId),
      ),
    )
    .limit(1);
  return row;
}

export async function readSyncProject(
  deps: SyncServiceDeps,
  accountId: string,
  projectId: string,
): Promise<SyncProjectState> {
  return stateFromRow(await findProject(deps.db, accountId, projectId));
}

function transitionConflicts(
  current: readonly SyncMutation[],
  next: readonly SyncMutation[],
): string[] {
  const currentByKey = new Map(current.map((entity) => [syncEntityKey(entity), entity]));
  const nextByKey = new Map(next.map((entity) => [syncEntityKey(entity), entity]));
  const conflicts: string[] = [];

  for (const [key, existing] of currentByKey) {
    const candidate = nextByKey.get(key);
    if (!candidate) {
      conflicts.push(key);
      continue;
    }
    if (canonicalSyncJson(candidate) === canonicalSyncJson(existing)) continue;
    if (
      candidate.baseVersion !== existing.entityVersion ||
      candidate.entityVersion !== existing.entityVersion + 1
    ) {
      conflicts.push(key);
    }
  }
  for (const [key, candidate] of nextByKey) {
    if (currentByKey.has(key)) continue;
    if (candidate.baseVersion !== 0 || candidate.entityVersion !== 1) {
      conflicts.push(key);
    }
  }
  return [...new Set(conflicts)].sort();
}

function conflict(
  reason: SyncConflictReason,
  expectedRevision: number,
  actualRevision: number,
  conflictingEntityIds: readonly string[],
  serverTime: number,
): SyncCasResult {
  return {
    ok: false,
    reason,
    expectedRevision,
    actualRevision,
    conflictingEntityIds: Object.freeze([...conflictingEntityIds].sort()),
    serverTime,
  };
}

export async function compareAndSwapSyncProject(
  deps: SyncServiceDeps,
  input: {
    readonly accountId: string;
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly entities: unknown;
  },
): Promise<SyncCasResult> {
  const entities = normalizeSyncEntities(input.entities, stateLimits(deps));
  const stateBytes = Buffer.byteLength(canonicalSyncJson(entities), 'utf8');
  const serverTime = (deps.now ?? Date.now)();
  const updatedAt = new Date(serverTime);

  if (input.expectedRevision === 0) {
    const initialConflicts = transitionConflicts([], entities);
    if (initialConflicts.length > 0) {
      return conflict(
        'entity-version-conflict',
        0,
        0,
        initialConflicts,
        serverTime,
      );
    }
    return deps.db.transaction(async (tx) => {
      await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, input.accountId))
        .for('update');

      const current = await findProject(
        tx as unknown as Db,
        input.accountId,
        input.projectId,
      );
      if (current) {
        return conflict(
          'revision-conflict',
          0,
          current.revision,
          entities.map(syncEntityKey),
          serverTime,
        );
      }

      const [usage] = await tx
        .select({ value: count() })
        .from(syncProjects)
        .where(eq(syncProjects.accountId, input.accountId));
      const limit = maxProjects(deps);
      if (usage.value >= limit) {
        return {
          ok: false,
          reason: 'projects-per-account',
          limit,
          actual: usage.value + 1,
          serverTime,
        };
      }

      const [created] = await tx
        .insert(syncProjects)
        .values({
          accountId: input.accountId,
          projectId: input.projectId,
          revision: 1,
          entities,
          entityCount: entities.length,
          stateBytes,
          updatedAt,
        })
        .onConflictDoNothing()
        .returning({ revision: syncProjects.revision });
      if (created) return { ok: true, revision: 1, serverTime };

      const raced = await findProject(
        tx as unknown as Db,
        input.accountId,
        input.projectId,
      );
      return conflict(
        'revision-conflict',
        0,
        raced?.revision ?? 0,
        entities.map(syncEntityKey),
        serverTime,
      );
    });
  }

  const currentRow = await findProject(
    deps.db,
    input.accountId,
    input.projectId,
  );
  if (!currentRow || currentRow.revision !== input.expectedRevision) {
    return conflict(
      'revision-conflict',
      input.expectedRevision,
      currentRow?.revision ?? 0,
      entities.map(syncEntityKey),
      serverTime,
    );
  }
  const current = stateFromRow(currentRow);
  const entityConflicts = transitionConflicts(current.entities, entities);
  if (entityConflicts.length > 0) {
    return conflict(
      'entity-version-conflict',
      input.expectedRevision,
      current.revision,
      entityConflicts,
      serverTime,
    );
  }

  const [updated] = await deps.db
    .update(syncProjects)
    .set({
      revision: input.expectedRevision + 1,
      entities,
      entityCount: entities.length,
      stateBytes,
      updatedAt,
    })
    .where(
      and(
        eq(syncProjects.accountId, input.accountId),
        eq(syncProjects.projectId, input.projectId),
        eq(syncProjects.revision, input.expectedRevision),
      ),
    )
    .returning({ revision: syncProjects.revision });
  if (updated) return { ok: true, revision: updated.revision, serverTime };

  const raced = await findProject(deps.db, input.accountId, input.projectId);
  return conflict(
    'revision-conflict',
    input.expectedRevision,
    raced?.revision ?? 0,
    entities.map(syncEntityKey),
    serverTime,
  );
}
