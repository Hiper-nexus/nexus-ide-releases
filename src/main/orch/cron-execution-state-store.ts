import { z } from 'zod';
import {
  projectExecutionScopeSchema,
  type ProjectExecutionScope,
} from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { ScopedStoreCorruptionError } from './scoped-store';

export type CronExecutionMode = 'shared' | 'local';
export type CronExecutionStatus =
  | 'started'
  | 'completed'
  | 'failed'
  | 'suppressed';

export interface CronExecutionState {
  readonly jobId: string;
  readonly scheduledFor: number;
  readonly executionMode: CronExecutionMode;
  readonly status: CronExecutionStatus;
  readonly reason: string | null;
  readonly leaseExpiresAt: number | null;
  readonly error: string | null;
  readonly updatedAt: number;
}

export interface StartCronOccurrence {
  readonly jobId: string;
  readonly scheduledFor: number;
  readonly executionMode: CronExecutionMode;
  readonly leaseExpiresAt: number | null;
  readonly updatedAt: number;
}

export interface SuppressCronOccurrence extends StartCronOccurrence {
  readonly reason: string;
  readonly error: string | null;
}

const jobIdSchema = z.string().min(1).max(256);
const timestampSchema = z.number().int().nonnegative();
const nullableTimestampSchema = timestampSchema.nullable();
const executionModeSchema = z.enum(['shared', 'local']);
const statusSchema = z.enum(['started', 'completed', 'failed', 'suppressed']);
const reasonSchema = z.string().min(1).max(128);
const errorSchema = z.string().max(4_096).nullable();

const startSchema = z
  .object({
    jobId: jobIdSchema,
    scheduledFor: timestampSchema,
    executionMode: executionModeSchema,
    leaseExpiresAt: nullableTimestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const suppressSchema = startSchema.extend({
  reason: reasonSchema,
  error: errorSchema,
});

const rowSchema = z
  .object({
    job_id: jobIdSchema,
    scheduled_for: timestampSchema,
    execution_mode: executionModeSchema,
    status: statusSchema,
    reason: reasonSchema.nullable(),
    lease_expires_at: nullableTimestampSchema,
    error: errorSchema,
    updated_at: timestampSchema,
  })
  .strict();

function immutableScope(scope: ProjectExecutionScope): ProjectExecutionScope {
  return Object.freeze(projectExecutionScopeSchema.parse({ ...scope }));
}

/**
 * Durable, scope-bound replay receipt for cron effects. It deliberately keeps
 * no remote lease token: the token is opaque authority and remains in memory.
 */
export class CronExecutionStateStore {
  readonly scope: ProjectExecutionScope;
  readonly #runtimeManager: ProjectRuntimeManager;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
  ) {
    this.#runtimeManager = runtimeManager;
    this.scope = immutableScope(scope);
  }

  read(rawJobId: string): CronExecutionState | null {
    const jobId = jobIdSchema.parse(rawJobId);
    const row = this.#runtimeManager
      .open(this.scope)
      .db.prepare(
        `SELECT job_id, scheduled_for, execution_mode, status, reason,
                lease_expires_at, error, updated_at
         FROM cron_execution_state WHERE job_id = ?`,
      )
      .get(jobId);
    if (row === undefined) return null;
    return this.#state(row);
  }

  start(rawInput: StartCronOccurrence): boolean {
    const input = startSchema.parse(rawInput);
    return this.#recordLatest({
      ...input,
      status: 'started',
      reason: null,
      error: null,
    });
  }

  suppress(rawInput: SuppressCronOccurrence): boolean {
    const input = suppressSchema.parse(rawInput);
    return this.#recordLatest({
      ...input,
      status: 'suppressed',
    });
  }

  finish(
    rawJobId: string,
    rawScheduledFor: number,
    rawStatus: 'completed' | 'failed',
    rawError: string | null,
    rawUpdatedAt: number,
  ): void {
    const jobId = jobIdSchema.parse(rawJobId);
    const scheduledFor = timestampSchema.parse(rawScheduledFor);
    const status = z.enum(['completed', 'failed']).parse(rawStatus);
    const error = errorSchema.parse(rawError);
    const updatedAt = timestampSchema.parse(rawUpdatedAt);
    const runtime = this.#runtimeManager.open(this.scope);
    runtime.assertWritable();
    const result = runtime.db
      .prepare(
        `UPDATE cron_execution_state
         SET status = ?, reason = NULL, error = ?, updated_at = ?
         WHERE job_id = ? AND scheduled_for = ? AND status = 'started'`,
      )
      .run(status, error, updatedAt, jobId, scheduledFor);
    if (result.changes !== 1) {
      throw new Error('cron occurrence is not the active durable receipt');
    }
  }

  #recordLatest(input: {
    readonly jobId: string;
    readonly scheduledFor: number;
    readonly executionMode: CronExecutionMode;
    readonly status: CronExecutionStatus;
    readonly reason: string | null;
    readonly leaseExpiresAt: number | null;
    readonly error: string | null;
    readonly updatedAt: number;
  }): boolean {
    const runtime = this.#runtimeManager.open(this.scope);
    runtime.assertWritable();
    const result = runtime.db
      .prepare(
        `INSERT INTO cron_execution_state
           (job_id, scheduled_for, execution_mode, status, reason,
            lease_expires_at, error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           scheduled_for = excluded.scheduled_for,
           execution_mode = excluded.execution_mode,
           status = excluded.status,
           reason = excluded.reason,
           lease_expires_at = excluded.lease_expires_at,
           error = excluded.error,
           updated_at = excluded.updated_at
         WHERE cron_execution_state.scheduled_for < excluded.scheduled_for`,
      )
      .run(
        input.jobId,
        input.scheduledFor,
        input.executionMode,
        input.status,
        input.reason,
        input.leaseExpiresAt,
        input.error,
        input.updatedAt,
      );
    return result.changes === 1;
  }

  #state(rawRow: unknown): CronExecutionState {
    let row: z.infer<typeof rowSchema>;
    try {
      row = rowSchema.parse(rawRow);
    } catch (error) {
      throw new ScopedStoreCorruptionError('cron execution state', {
        cause: error,
      });
    }
    return Object.freeze({
      jobId: row.job_id,
      scheduledFor: row.scheduled_for,
      executionMode: row.execution_mode,
      status: row.status,
      reason: row.reason,
      leaseExpiresAt: row.lease_expires_at,
      error: row.error,
      updatedAt: row.updated_at,
    });
  }
}
