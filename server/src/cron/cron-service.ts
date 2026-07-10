import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { cronLeases, cronSchedules } from '../db/schema';
import { hashToken, newToken } from '../auth/tokens';
import {
  cronDefinitionHash,
  portableCronDefinitionSchema,
  type PortableCronDefinition,
} from './cron-contract';

export interface CronServiceDeps {
  db: Db;
  now?: () => number;
  makeToken?: () => string;
}

export interface StoredCronSchedule {
  projectId: string;
  scheduleId: string;
  version: number;
  definition: PortableCronDefinition;
  definitionHash: string;
  updatedAt: number;
}

export type PublishScheduleResult =
  | { ok: true; created: boolean; schedule: StoredCronSchedule }
  | {
      ok: false;
      expectedVersion: number;
      actualVersion: number;
      current: StoredCronSchedule | null;
    };

export type LeaseOperationResult =
  | {
      acquired: true;
      token: string;
      expiresAt: number;
      reused: boolean;
    }
  | {
      acquired: false;
      reason: 'held-by-peer' | 'expired-or-not-owner' | 'definition-conflict';
      retryAt?: number;
      actualVersion?: number;
      actualDefinitionHash?: string;
    };

interface LeaseCoordinates {
  projectId: string;
  scheduleId: string;
  definitionVersion: number;
  definitionHash: string;
  occurrenceAt: number;
  ttlMs: number;
}

function resultRows(result: unknown): readonly unknown[] {
  if (Array.isArray(result)) return result;
  if (
    typeof result === 'object' &&
    result !== null &&
    'rows' in result &&
    Array.isArray(result.rows)
  ) {
    return result.rows;
  }
  return [];
}

function scheduleRecord(raw: typeof cronSchedules.$inferSelect): StoredCronSchedule {
  return Object.freeze({
    projectId: raw.projectId,
    scheduleId: raw.scheduleId,
    version: raw.version,
    definition: portableCronDefinitionSchema.parse(raw.definition),
    definitionHash: raw.definitionHash,
    updatedAt: raw.updatedAt.getTime(),
  });
}

async function findSchedule(
  db: Db,
  accountId: string,
  projectId: string,
  scheduleId: string,
): Promise<StoredCronSchedule | null> {
  const [row] = await db
    .select()
    .from(cronSchedules)
    .where(
      and(
        eq(cronSchedules.accountId, accountId),
        eq(cronSchedules.projectId, projectId),
        eq(cronSchedules.scheduleId, scheduleId),
      ),
    )
    .limit(1);
  return row ? scheduleRecord(row) : null;
}

export async function listCronSchedules(
  deps: CronServiceDeps,
  accountId: string,
  projectId: string,
): Promise<StoredCronSchedule[]> {
  const rows = await deps.db
    .select()
    .from(cronSchedules)
    .where(
      and(
        eq(cronSchedules.accountId, accountId),
        eq(cronSchedules.projectId, projectId),
      ),
    )
    .orderBy(cronSchedules.scheduleId);
  return rows.map(scheduleRecord);
}

export async function publishCronSchedule(
  deps: CronServiceDeps,
  input: {
    accountId: string;
    projectId: string;
    scheduleId: string;
    expectedVersion: number;
    definition: PortableCronDefinition;
  },
): Promise<PublishScheduleResult> {
  const definition = portableCronDefinitionSchema.parse(input.definition);
  const definitionHash = cronDefinitionHash(definition);
  const now = new Date((deps.now ?? Date.now)());
  if (input.expectedVersion === 0) {
    const [created] = await deps.db
      .insert(cronSchedules)
      .values({
        accountId: input.accountId,
        projectId: input.projectId,
        scheduleId: input.scheduleId,
        version: 1,
        definition,
        definitionHash,
        status: definition.status,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (created) {
      return { ok: true, created: true, schedule: scheduleRecord(created) };
    }
  } else {
    const [updated] = await deps.db
      .update(cronSchedules)
      .set({
        version: input.expectedVersion + 1,
        definition,
        definitionHash,
        status: definition.status,
        updatedAt: now,
      })
      .where(
        and(
          eq(cronSchedules.accountId, input.accountId),
          eq(cronSchedules.projectId, input.projectId),
          eq(cronSchedules.scheduleId, input.scheduleId),
          eq(cronSchedules.version, input.expectedVersion),
        ),
      )
      .returning();
    if (updated) {
      return { ok: true, created: false, schedule: scheduleRecord(updated) };
    }
  }

  const current = await findSchedule(
    deps.db,
    input.accountId,
    input.projectId,
    input.scheduleId,
  );
  return {
    ok: false,
    expectedVersion: input.expectedVersion,
    actualVersion: current?.version ?? 0,
    current,
  };
}

async function definitionConflict(
  deps: CronServiceDeps,
  accountId: string,
  input: LeaseCoordinates,
): Promise<Extract<LeaseOperationResult, { acquired: false }> | null> {
  const current = await findSchedule(
    deps.db,
    accountId,
    input.projectId,
    input.scheduleId,
  );
  if (
    !current ||
    current.version !== input.definitionVersion ||
    current.definitionHash !== input.definitionHash ||
    current.definition.status !== 'active'
  ) {
    return {
      acquired: false,
      reason: 'definition-conflict',
      actualVersion: current?.version ?? 0,
      actualDefinitionHash: current?.definitionHash,
    };
  }
  return null;
}

function leaseWhere(accountId: string, input: LeaseCoordinates) {
  return and(
    eq(cronLeases.accountId, accountId),
    eq(cronLeases.projectId, input.projectId),
    eq(cronLeases.scheduleId, input.scheduleId),
    eq(cronLeases.occurrenceAt, input.occurrenceAt),
  );
}

export async function acquireCronLease(
  deps: CronServiceDeps,
  accountId: string,
  input: LeaseCoordinates,
): Promise<LeaseOperationResult> {
  const nowMs = (deps.now ?? Date.now)();
  const now = new Date(nowMs);
  const expiresAt = new Date(nowMs + input.ttlMs);
  const token = (deps.makeToken ?? newToken)();
  const tokenHash = hashToken(token);
  const result = await deps.db.execute(sql`
    WITH current_schedule AS MATERIALIZED (
      SELECT account_id, project_id, schedule_id
      FROM cron_schedules
      WHERE account_id = ${accountId}
        AND project_id = ${input.projectId}
        AND schedule_id = ${input.scheduleId}
        AND version = ${input.definitionVersion}
        AND definition_hash = ${input.definitionHash}
        AND status = 'active'
      FOR UPDATE
    )
    INSERT INTO cron_leases AS lease (
      account_id, project_id, schedule_id, occurrence_at,
      token_hash, version, expires_at, updated_at
    )
    SELECT
      schedule.account_id, schedule.project_id, schedule.schedule_id,
      ${input.occurrenceAt}, ${tokenHash}, 1, ${expiresAt}, ${now}
    FROM current_schedule AS schedule
    ON CONFLICT (account_id, project_id, schedule_id, occurrence_at)
    DO UPDATE SET
      token_hash = EXCLUDED.token_hash,
      expires_at = EXCLUDED.expires_at,
      updated_at = EXCLUDED.updated_at,
      version = lease.version + 1
    WHERE lease.token_hash IS NULL OR lease.expires_at <= ${now}
    RETURNING lease.expires_at
  `);
  if (resultRows(result).length > 0) {
    return { acquired: true, token, expiresAt: expiresAt.getTime(), reused: false };
  }

  const conflict = await definitionConflict(deps, accountId, input);
  if (conflict) return conflict;

  const [held] = await deps.db
    .select({ expiresAt: cronLeases.expiresAt })
    .from(cronLeases)
    .where(leaseWhere(accountId, input))
    .limit(1);
  return {
    acquired: false,
    reason: 'held-by-peer',
    ...(held ? { retryAt: held.expiresAt.getTime() } : {}),
  };
}

export async function renewCronLease(
  deps: CronServiceDeps,
  accountId: string,
  input: LeaseCoordinates & { token: string },
): Promise<LeaseOperationResult> {
  const nowMs = (deps.now ?? Date.now)();
  const now = new Date(nowMs);
  const expiresAt = new Date(nowMs + input.ttlMs);
  const result = await deps.db.execute(sql`
    WITH current_schedule AS MATERIALIZED (
      SELECT account_id, project_id, schedule_id
      FROM cron_schedules
      WHERE account_id = ${accountId}
        AND project_id = ${input.projectId}
        AND schedule_id = ${input.scheduleId}
        AND version = ${input.definitionVersion}
        AND definition_hash = ${input.definitionHash}
        AND status = 'active'
      FOR UPDATE
    )
    UPDATE cron_leases AS lease
    SET
      expires_at = ${expiresAt},
      updated_at = ${now},
      version = lease.version + 1
    FROM current_schedule AS schedule
    WHERE lease.account_id = ${accountId}
      AND lease.project_id = ${input.projectId}
      AND lease.schedule_id = ${input.scheduleId}
      AND lease.occurrence_at = ${input.occurrenceAt}
      AND lease.token_hash = ${hashToken(input.token)}
      AND lease.expires_at > ${now}
      AND schedule.account_id = lease.account_id
      AND schedule.project_id = lease.project_id
      AND schedule.schedule_id = lease.schedule_id
    RETURNING lease.expires_at
  `);
  if (resultRows(result).length > 0) {
    return {
      acquired: true,
      token: input.token,
      expiresAt: expiresAt.getTime(),
      reused: true,
    };
  }
  const conflict = await definitionConflict(deps, accountId, input);
  return conflict ?? { acquired: false, reason: 'expired-or-not-owner' };
}

export async function releaseCronLease(
  deps: CronServiceDeps,
  accountId: string,
  input: LeaseCoordinates & { token: string },
): Promise<boolean> {
  const now = new Date((deps.now ?? Date.now)());
  const [released] = await deps.db
    .update(cronLeases)
    .set({
      tokenHash: null,
      expiresAt: now,
      updatedAt: now,
      version: sql`${cronLeases.version} + 1`,
    })
    .where(
      and(
        leaseWhere(accountId, input),
        eq(cronLeases.tokenHash, hashToken(input.token)),
      ),
    )
    .returning();
  return released !== undefined;
}
