import { runPeriodicTask, stopPeriodicTask } from '../observability/periodic-task';
import path from 'node:path';
import { z } from 'zod';
import {
  projectExecutionScopeSchema,
  type ProjectExecutionScope,
} from '../../shared/types';
import {
  DistributedLeaseCoordinator,
  type LeaseAcquireResult,
  type LeaseBackend,
  type SharedScheduleLeaseRequest,
} from '../context/distributed-lease';
import { resolveProjectExecutionScope } from '../persistence/project-identity';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { CRON_STALE_MS, type CronJob } from './cron-loop';
import {
  CronExecutionStateStore,
  type CronExecutionMode,
} from './cron-execution-state-store';
import {
  cronDefinitionHash,
  portableCronDefinitionSchema,
  portableScheduleIdSchema,
} from './portable-cron-definition';

export type CronOccurrenceDisposition =
  | 'completed'
  | 'fire-failed'
  | 'interrupted'
  | 'already-recorded'
  | 'lease-held'
  | 'lease-conflict'
  | 'definition-conflict'
  | 'backend-unavailable'
  | 'lease-lost'
  | 'persistence-unavailable'
  | 'authority-invalid'
  | 'invalid-scope';

export interface CronOccurrenceResult {
  /** True only when the scheduled effect returned successfully. */
  readonly fired: boolean;
  readonly disposition: CronOccurrenceDisposition;
  readonly error?: string;
}

export interface CronOccurrenceExecutor {
  execute(
    job: CronJob,
    scheduledFor: number,
    fire: (job: CronJob) => Promise<void>,
  ): Promise<CronOccurrenceResult>;
}

export interface CronRenewalTimer {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface CronExecutionCoordinatorOptions {
  readonly runtimeManager: ProjectRuntimeManager;
  readonly leaseBackend?: LeaseBackend;
  readonly resolveScope?: (job: CronJob) => ProjectExecutionScope;
  /**
   * Validates durable execution authority before any local receipt or remote
   * lease is acquired. The physical fire boundary revalidates independently.
   */
  readonly preflight?: (
    job: CronJob,
    scope: ProjectExecutionScope,
  ) => void;
  readonly now?: () => number;
  readonly leaseTtlMs?: number;
  readonly staleMs?: number;
  readonly renewalTimer?: CronRenewalTimer;
}

const timestampSchema = z.number().int().nonnegative();
const MAX_LEASE_TTL_MS = 24 * 60 * 60_000;
const durationSchema = z.number().int().min(1_000).max(MAX_LEASE_TTL_MS);
const definitionVersionSchema = z.number().int().positive().max(2_147_483_647);

const systemRenewalTimer: CronRenewalTimer = {
  setInterval: (callback, milliseconds) => {
    const timer = setInterval(callback, milliseconds);
    timer.unref?.();
    return timer;
  },
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}

function immutableResult(result: CronOccurrenceResult): CronOccurrenceResult {
  return Object.freeze(result);
}

function defaultResolveScope(job: CronJob): ProjectExecutionScope {
  if (!job.workspacePath || !job.projectId || !job.checkoutId) {
    throw new Error('cron job has no immutable project/checkout binding');
  }
  const scope = projectExecutionScopeSchema.parse(
    resolveProjectExecutionScope(job.workspacePath),
  );
  if (scope.projectId !== job.projectId || scope.checkoutId !== job.checkoutId) {
    throw new Error('cron job scope no longer matches its workspace identity');
  }
  return scope;
}

function executionMode(job: CronJob): CronExecutionMode {
  return job.executionMode === 'local' ? 'local' : 'shared';
}

/**
 * Remote authority uses only project + portable schedule + occurrence. Local
 * checkout and installation coordinates remain in the physical runtime and
 * never enter the synchronized payload.
 */
export function createCronLeaseRequest(
  rawScope: ProjectExecutionScope,
  job: Pick<
    CronJob,
    | 'name'
    | 'schedule'
    | 'brief'
    | 'workingDirectory'
    | 'status'
    | 'agentName'
    | 'squadId'
    | 'portableScheduleId'
    | 'definitionVersion'
    | 'definitionHash'
  >,
  rawScheduledFor: number,
  rawTtlMs: number,
): SharedScheduleLeaseRequest {
  const scope = projectExecutionScopeSchema.parse(rawScope);
  const scheduleId = portableScheduleIdSchema.parse(job.portableScheduleId);
  const definitionVersion = definitionVersionSchema.parse(job.definitionVersion);
  const storedHash = z.string().regex(/^[a-f0-9]{64}$/).parse(job.definitionHash);
  const scheduledFor = timestampSchema.parse(rawScheduledFor);
  const ttlMs = durationSchema.parse(rawTtlMs);
  const relativeWorkingDirectory = job.workingDirectory
    ? path.relative(scope.rootRealPath, job.workingDirectory)
    : '';
  if (
    relativeWorkingDirectory === '..' ||
    relativeWorkingDirectory.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeWorkingDirectory)
  ) {
    throw new Error('cron working directory escapes its project root');
  }
  const definition = portableCronDefinitionSchema.parse({
    schemaVersion: 1,
    name: job.name,
    schedule: job.schedule,
    brief: job.brief,
    workingDirectory: relativeWorkingDirectory
      ? relativeWorkingDirectory.split(path.sep).join('/')
      : undefined,
    target: job.agentName
      ? { kind: 'agent', id: job.agentName }
      : { kind: 'squad', id: job.squadId },
    status: job.status,
  });
  const computedHash = cronDefinitionHash(definition);
  if (computedHash !== storedHash) {
    throw new Error('local cron definition conflicts with its portable hash');
  }
  return Object.freeze({
    projectId: scope.projectId,
    scheduleId,
    definitionVersion,
    definitionHash: storedHash,
    occurrenceAt: scheduledFor,
    ttlMs,
  });
}

function dispositionForLeaseFailure(
  result: Extract<LeaseAcquireResult, { acquired: false }>,
): CronOccurrenceDisposition {
  if (result.reason === 'backend-unavailable') return 'backend-unavailable';
  if (result.reason === 'held-by-peer') return 'lease-held';
  if (result.reason === 'concurrent-conflict') return 'lease-conflict';
  if (result.reason === 'definition-conflict') return 'definition-conflict';
  return 'lease-lost';
}

export class CronExecutionCoordinator implements CronOccurrenceExecutor {
  // OptimisticSyncEngine is intentionally not an execution authority here:
  // checkout/installation coordinates are forbidden sync payloads and a CAS
  // metadata publish is not a lease. Portable schedule-definition sync needs
  // its own conflict UI; execution safety remains on the remote lease backend.
  readonly #runtimeManager: ProjectRuntimeManager;
  readonly #leaseBackend: LeaseBackend | undefined;
  readonly #resolveScope: (job: CronJob) => ProjectExecutionScope;
  readonly #preflight: (
    job: CronJob,
    scope: ProjectExecutionScope,
  ) => void;
  readonly #now: () => number;
  readonly #leaseTtlMs: number;
  readonly #occurrenceFenceTtlMs: number;
  readonly #staleMs: number;
  readonly #renewalTimer: CronRenewalTimer;

  constructor(options: CronExecutionCoordinatorOptions) {
    this.#runtimeManager = options.runtimeManager;
    this.#leaseBackend = options.leaseBackend;
    this.#resolveScope = options.resolveScope ?? defaultResolveScope;
    this.#preflight = options.preflight ?? (() => {});
    this.#now = options.now ?? Date.now;
    this.#leaseTtlMs = durationSchema.parse(options.leaseTtlMs ?? 90_000);
    this.#staleMs = durationSchema.parse(options.staleMs ?? CRON_STALE_MS);
    this.#occurrenceFenceTtlMs = durationSchema.parse(
      Math.min(
        MAX_LEASE_TTL_MS,
        Math.max(this.#leaseTtlMs, this.#staleMs + 1_000),
      ),
    );
    this.#renewalTimer = options.renewalTimer ?? systemRenewalTimer;
  }

  async execute(
    job: CronJob,
    rawScheduledFor: number,
    fire: (job: CronJob) => Promise<void>,
  ): Promise<CronOccurrenceResult> {
    const scheduledFor = timestampSchema.parse(rawScheduledFor);
    let scope: ProjectExecutionScope;
    try {
      scope = projectExecutionScopeSchema.parse(this.#resolveScope(job));
      if (job.projectId !== scope.projectId || job.checkoutId !== scope.checkoutId) {
        throw new Error('cron job does not match the resolved execution scope');
      }
    } catch (error) {
      return immutableResult({
        fired: false,
        disposition: 'invalid-scope',
        error: errorMessage(error),
      });
    }

    try {
      this.#preflight(job, scope);
    } catch (error) {
      return immutableResult({
        fired: false,
        disposition: 'authority-invalid',
        error:
          `${errorMessage(error)} ` +
          'CTA: Recrie a agenda neste dispositivo para revisar a autorização.',
      });
    }

    const mode = executionMode(job);
    const state = new CronExecutionStateStore(this.#runtimeManager, scope);
    try {
      const existing = state.read(job.id);
      if (existing && existing.scheduledFor > scheduledFor) {
        return immutableResult({
          fired: false,
          disposition: 'already-recorded',
          ...(existing.error ? { error: existing.error } : {}),
        });
      }
      if (existing?.scheduledFor === scheduledFor) {
        if (existing.status === 'started') {
          const interrupted =
            'A ocorrência foi interrompida antes de comprovar a publicação ' +
            'da missão. CTA: Revise a agenda e execute a ocorrência manualmente.';
          state.finish(
            job.id,
            scheduledFor,
            'failed',
            interrupted,
            this.#validNow(),
          );
          return immutableResult({
            fired: false,
            disposition: 'interrupted',
            error: interrupted,
          });
        }
        return immutableResult({
          fired: false,
          disposition: 'already-recorded',
          ...(existing.error ? { error: existing.error } : {}),
        });
      }
    } catch (error) {
      return immutableResult({
        fired: false,
        disposition: 'persistence-unavailable',
        error: errorMessage(error),
      });
    }

    if (mode === 'local') {
      return this.#executeLocal(state, job, scheduledFor, fire);
    }
    if (!this.#leaseBackend) {
      return this.#suppress(
        state,
        job,
        scheduledFor,
        'backend-unavailable',
        'remote cron lease backend is not configured',
      );
    }

    const lease = new DistributedLeaseCoordinator(this.#leaseBackend);
    let request: SharedScheduleLeaseRequest;
    try {
      request = createCronLeaseRequest(
        scope,
        job,
        scheduledFor,
        this.#occurrenceFenceTtlMs,
      );
    } catch (error) {
      return immutableResult({
        fired: false,
        disposition: 'invalid-scope',
        error: errorMessage(error),
      });
    }
    const acquired = await lease.acquire(request);
    if (!acquired.acquired) {
      return this.#suppress(
        state,
        job,
        scheduledFor,
        dispositionForLeaseFailure(acquired),
        `remote cron lease denied: ${acquired.reason}`,
      );
    }

    let didStart: boolean;
    try {
      didStart = state.start({
        jobId: job.id,
        scheduledFor,
        executionMode: 'shared',
        leaseExpiresAt: acquired.expiresAt,
        updatedAt: this.#validNow(),
      });
    } catch (error) {
      await lease.release(request, acquired.token);
      return immutableResult({
        fired: false,
        disposition: 'persistence-unavailable',
        error: errorMessage(error),
      });
    }
    // A concurrent tick in this same installation reuses the same token. It
    // must not release authority owned by the tick that won the durable insert.
    if (!didStart) {
      return immutableResult({ fired: false, disposition: 'already-recorded' });
    }

    return this.#fireWithLease({
      state,
      scope,
      job,
      scheduledFor,
      fire,
      lease,
      request,
      token: acquired.token,
    });
  }

  readonly #validNow = (): number => timestampSchema.parse(this.#now());

  async #executeLocal(
    state: CronExecutionStateStore,
    job: CronJob,
    scheduledFor: number,
    fire: (job: CronJob) => Promise<void>,
  ): Promise<CronOccurrenceResult> {
    try {
      const didStart = state.start({
        jobId: job.id,
        scheduledFor,
        executionMode: 'local',
        leaseExpiresAt: null,
        updatedAt: this.#validNow(),
      });
      if (!didStart) {
        return immutableResult({ fired: false, disposition: 'already-recorded' });
      }
    } catch (error) {
      return immutableResult({
        fired: false,
        disposition: 'persistence-unavailable',
        error: errorMessage(error),
      });
    }

    try {
      await fire(job);
    } catch (error) {
      const message = errorMessage(error);
      try {
        state.finish(job.id, scheduledFor, 'failed', message, this.#validNow());
      } catch (persistenceError) {
        return immutableResult({
          fired: false,
          disposition: 'persistence-unavailable',
          error: `${message}; ${errorMessage(persistenceError)}`.slice(0, 4_096),
        });
      }
      return immutableResult({
        fired: false,
        disposition: 'fire-failed',
        error: message,
      });
    }

    try {
      state.finish(job.id, scheduledFor, 'completed', null, this.#validNow());
      return immutableResult({ fired: true, disposition: 'completed' });
    } catch (error) {
      return immutableResult({
        fired: true,
        disposition: 'persistence-unavailable',
        error: errorMessage(error),
      });
    }
  }

  async #fireWithLease(input: {
    state: CronExecutionStateStore;
    scope: ProjectExecutionScope;
    job: CronJob;
    scheduledFor: number;
    fire: (job: CronJob) => Promise<void>;
    lease: DistributedLeaseCoordinator;
    request: SharedScheduleLeaseRequest;
    token: string;
  }): Promise<CronOccurrenceResult> {
    let renewalFailure: string | null = null;
    let renewalFlight: Promise<void> | null = null;
    let renewalPending = false;
    let renewalAdmission = true;
    const cadenceMs = Math.max(1, Math.floor(this.#leaseTtlMs / 3));
    const taskId = `cron-lease-renewal:${input.scope.projectId}:${input.job.id}:${input.scheduledFor}`;
    const requestRenewal = () => {
      if (!renewalAdmission || renewalFailure) return;
      if (renewalFlight) { renewalPending = true; return; }
      const current = runPeriodicTask(taskId, async (context) => {
        do {
          renewalPending = false;
          await context.checkpoint();
          if (!renewalAdmission) return;
          const renewed = await context.wait(input.lease.renew(input.request, input.token));
          if (!renewed.acquired) renewalFailure = `remote cron lease renewal failed: ${renewed.reason}`;
        } while (renewalAdmission && renewalPending && !renewalFailure);
      }, { cadenceMs }).catch((error) => { renewalFailure = errorMessage(error); });
      renewalFlight = current;
      void current.finally(() => { if (renewalFlight === current) renewalFlight = null; });
    };
    const timer = this.#renewalTimer.setInterval(requestRenewal, cadenceMs);

    let fireFailure: string | null = null;
    try {
      await input.fire(input.job);
    } catch (error) {
      fireFailure = errorMessage(error);
    } finally {
      renewalAdmission = false;
      renewalPending = false;
      this.#renewalTimer.clearInterval(timer);
      await renewalFlight;
      await stopPeriodicTask(taskId);
    }

    if (fireFailure) {
      try {
        input.state.finish(
          input.job.id,
          input.scheduledFor,
          'failed',
          fireFailure,
          this.#validNow(),
        );
      } catch (error) {
        fireFailure = `${fireFailure}; ${errorMessage(error)}`.slice(0, 4_096);
      }
      // `fire()` is an effect boundary: an exception cannot prove that spawn,
      // mission creation or a provider call did not commit. Keep the original
      // occurrence lease as a durable fence until the cron stale window ends.
      return immutableResult({
        fired: false,
        disposition: 'fire-failed',
        error: fireFailure,
      });
    }

    if (renewalFailure) {
      try {
        input.state.finish(
          input.job.id,
          input.scheduledFor,
          'failed',
          renewalFailure,
          this.#validNow(),
        );
      } catch {
        // The durable `started` receipt still prevents a local restart replay.
      }
      // The effect completed and authority became uncertain. Releasing would
      // explicitly invite a peer to repeat the same occurrence.
      return immutableResult({
        fired: true,
        disposition: 'lease-lost',
        error: renewalFailure,
      });
    }

    // Convert the execution lease into a completion fence. The occurrence is
    // part of the remote key, so this fence cannot block the next schedule.
    const fenceTtl = Math.min(
      MAX_LEASE_TTL_MS,
      Math.max(
        1_000,
        input.scheduledFor + this.#staleMs + 1_000 - this.#validNow(),
      ),
    );
    const fenceRequest = createCronLeaseRequest(
      input.scope,
      input.job,
      input.scheduledFor,
      fenceTtl,
    );
    const fenced = await input.lease.renew(fenceRequest, input.token);
    if (!fenced.acquired) {
      const message = `remote cron completion fence failed: ${fenced.reason}`;
      try {
        input.state.finish(
          input.job.id,
          input.scheduledFor,
          'failed',
          message,
          this.#validNow(),
        );
      } catch {
        // The started receipt remains the local replay barrier.
      }
      // Preserve the still-valid original fence even when extending it fails.
      return immutableResult({
        fired: true,
        disposition: 'lease-lost',
        error: message,
      });
    }

    try {
      input.state.finish(
        input.job.id,
        input.scheduledFor,
        'completed',
        null,
        this.#validNow(),
      );
    } catch (error) {
      return immutableResult({
        fired: true,
        disposition: 'persistence-unavailable',
        error: errorMessage(error),
      });
    }
    // Do not release a successful occurrence: the remote fence is how a peer
    // that ticks seconds later learns not to execute it. It expires naturally.
    return immutableResult({ fired: true, disposition: 'completed' });
  }

  #suppress(
    state: CronExecutionStateStore,
    job: CronJob,
    scheduledFor: number,
    disposition: CronOccurrenceDisposition,
    error: string,
  ): CronOccurrenceResult {
    try {
      state.suppress({
        jobId: job.id,
        scheduledFor,
        executionMode: 'shared',
        reason: disposition,
        leaseExpiresAt: null,
        error,
        updatedAt: this.#validNow(),
      });
      return immutableResult({ fired: false, disposition, error });
    } catch (persistenceError) {
      return immutableResult({
        fired: false,
        disposition: 'persistence-unavailable',
        error: errorMessage(persistenceError),
      });
    }
  }
}
