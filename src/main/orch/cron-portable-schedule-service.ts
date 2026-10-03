import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  projectExecutionScopeSchema,
  type ProjectExecutionScope,
} from '../../shared/types';
import {
  nextCronAfter,
  parseCronExpr,
  withCronJobsMutationLock,
  cronExecutionAuthoritySchema,
  type CronExecutionAuthority,
  type CronJob,
} from './cron-loop';
import {
  assertMcpInvocationCurrent,
  type McpToolInvocation,
} from './mcp-protocol';
import { resolveCwdForScope } from './workspace-path';
import {
  cronDefinitionHash,
  portableCronDefinitionSchema,
  portableScheduleIdSchema,
  type PortableCronDefinition,
  type PortableCronSchedule,
  type PortableCronScheduleBackend,
  type PublishPortableScheduleResult,
} from './portable-cron-definition';

export interface PortableCronCreateInput {
  readonly name: string;
  readonly schedule: string;
  readonly brief: string;
  readonly workingDirectory?: string;
  readonly agentName?: string;
  readonly squadId?: string;
}

export interface PortableCronUpdateInput {
  readonly name?: string;
  readonly schedule?: string;
  readonly brief?: string;
  readonly workingDirectory?: string | null;
  readonly agentName?: string;
  readonly squadId?: string;
  readonly status?: 'active' | 'paused';
}

export interface CronPortableScheduleServiceOptions {
  readonly backend: PortableCronScheduleBackend;
  readonly load: () => CronJob[] | Promise<CronJob[]>;
  readonly save: (jobs: CronJob[]) => void | Promise<void>;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

export type PortableCronSyncResult =
  | { ok: true; imported: number; updated: number; deleted: number }
  | {
      ok: false;
      reason: 'backend-unavailable' | 'definition-conflict';
      scheduleIds?: readonly string[];
    };

export class CronPortableScheduleConflictError extends Error {
  readonly expectedVersion: number;
  readonly actualVersion: number;
  readonly current: PortableCronSchedule | null;

  constructor(
    expectedVersion: number,
    actualVersion: number,
    current: PortableCronSchedule | null,
  ) {
    super(
      `portable cron version conflict: expected ${expectedVersion}, remote ${actualVersion}`,
    );
    this.name = 'CronPortableScheduleConflictError';
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
    this.current = current;
  }
}

export class CronPortableBackendUnavailableError extends Error {
  constructor() {
    super('portable cron backend is unavailable');
    this.name = 'CronPortableBackendUnavailableError';
  }
}

const createInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    schedule: z.string().trim().min(1).max(512),
    brief: z.string().max(64 * 1024),
    workingDirectory: z.string().min(1).max(4_096).optional(),
    agentName: z.string().trim().min(1).max(256).optional(),
    squadId: z.string().trim().min(1).max(256).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.agentName) !== Boolean(value.squadId), {
    message: 'portable cron requires exactly one target',
  });

const updateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    schedule: z.string().trim().min(1).max(512).optional(),
    brief: z.string().max(64 * 1024).optional(),
    workingDirectory: z.string().min(1).max(4_096).nullable().optional(),
    agentName: z.string().trim().min(1).max(256).optional(),
    squadId: z.string().trim().min(1).max(256).optional(),
    status: z.enum(['active', 'paused']).optional(),
  })
  .strict()
  .refine((value) => !(value.agentName && value.squadId), {
    message: 'portable cron target update is ambiguous',
  });

function immutableScope(scope: ProjectExecutionScope): ProjectExecutionScope {
  const parsed = projectExecutionScopeSchema.parse(scope);
  if (parsed.identitySource !== 'manifest') {
    throw new Error('shared portable cron requires a versioned project manifest');
  }
  // Shared control-plane ids are UUIDs; provisional/path-derived ids are not.
  z.string().uuid().parse(parsed.projectId);
  return Object.freeze({ ...parsed });
}

function validNow(now: () => number): number {
  return z.number().int().nonnegative().parse(now());
}

function portableWorkingDirectory(
  scope: ProjectExecutionScope,
  absolute: string | undefined,
): string | undefined {
  if (!absolute || absolute === scope.rootRealPath) return undefined;
  const relative = path.relative(scope.rootRealPath, absolute);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('cron working directory escapes its project root');
  }
  return relative.split(path.sep).join('/');
}

function definitionFromJob(
  job: CronJob,
  scope: ProjectExecutionScope,
): PortableCronDefinition {
  return portableCronDefinitionSchema.parse({
    schemaVersion: 1,
    name: job.name,
    schedule: job.schedule,
    brief: job.brief,
    workingDirectory: portableWorkingDirectory(scope, job.workingDirectory),
    target: job.agentName
      ? { kind: 'agent', id: job.agentName }
      : { kind: 'squad', id: job.squadId },
    status: job.status,
  });
}

function scopedJob(job: CronJob, scope: ProjectExecutionScope): boolean {
  return job.projectId === scope.projectId && job.checkoutId === scope.checkoutId;
}

export class CronPortableScheduleService {
  readonly #backend: PortableCronScheduleBackend;
  readonly #load: () => CronJob[] | Promise<CronJob[]>;
  readonly #save: (jobs: CronJob[]) => void | Promise<void>;
  readonly #now: () => number;
  readonly #idFactory: () => string;

  constructor(options: CronPortableScheduleServiceOptions) {
    this.#backend = options.backend;
    this.#load = options.load;
    this.#save = options.save;
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async create(
    rawInput: PortableCronCreateInput,
    rawScope: ProjectExecutionScope,
    invocation?: McpToolInvocation,
    authorize?: (candidate: CronJob) => CronExecutionAuthority,
  ): Promise<CronJob> {
    return withCronJobsMutationLock(
      () =>
        this.#create(
          rawInput,
          rawScope,
          invocation,
          authorize,
        ),
      invocation?.signal,
    );
  }

  async #create(
    rawInput: PortableCronCreateInput,
    rawScope: ProjectExecutionScope,
    invocation?: McpToolInvocation,
    authorize?: (candidate: CronJob) => CronExecutionAuthority,
  ): Promise<CronJob> {
    assertMcpInvocationCurrent(invocation);
    const input = createInputSchema.parse(rawInput);
    const scope = immutableScope(rawScope);
    const scheduleId = portableScheduleIdSchema.parse(this.#idFactory());
    const definition = portableCronDefinitionSchema.parse({
      schemaVersion: 1,
      name: input.name,
      schedule: input.schedule,
      brief: input.brief,
      workingDirectory: portableWorkingDirectory(
        scope,
        input.workingDirectory,
      ),
      target: input.agentName
        ? { kind: 'agent', id: input.agentName }
        : { kind: 'squad', id: input.squadId },
      status: 'active',
    });
    // The exact-consent authority must bind the final stable schedule identity
    // before the remote publish effect begins. expectedVersion=0 can only
    // create version 1; any backend response that disagrees is rejected.
    const expectedHash = cronDefinitionHash(definition);
    const candidate = this.#materialize(
      {
        projectId: scope.projectId,
        scheduleId,
        version: 1,
        definition,
        definitionHash: expectedHash,
        updatedAt: validNow(this.#now),
      },
      scope,
    );
    const executionAuthority = authorize?.(candidate);
    assertMcpInvocationCurrent(invocation);
    const published = await this.#backend.publish(
      scope.projectId,
      scheduleId,
      0,
      definition,
      invocation,
    );
    assertMcpInvocationCurrent(invocation);
    const remote = this.#published(published);
    if (
      remote.projectId !== scope.projectId ||
      remote.scheduleId !== scheduleId ||
      remote.version !== 1 ||
      remote.definitionHash !== expectedHash
    ) {
      throw new Error(
        'portable cron backend returned an unexpected created definition',
      );
    }
    const jobs = await this.#load();
    assertMcpInvocationCurrent(invocation);
    if (
      jobs.some(
        (job) =>
          scopedJob(job, scope) && job.portableScheduleId === scheduleId,
      )
    ) {
      throw new Error('portable cron schedule already has a local binding');
    }
    const materialized = this.#materialize(remote, scope);
    const created = executionAuthority
      ? {
          ...materialized,
          executionAuthority:
            cronExecutionAuthoritySchema.parse(executionAuthority),
        }
      : materialized;
    assertMcpInvocationCurrent(invocation);
    await this.#save([...jobs, created]);
    return created;
  }

  async update(
    rawJobId: string,
    rawPatch: PortableCronUpdateInput,
    rawScope: ProjectExecutionScope,
    invocation?: McpToolInvocation,
    reauthorize?: (
      current: CronJob,
      candidate: CronJob,
    ) => CronExecutionAuthority,
  ): Promise<CronJob> {
    return withCronJobsMutationLock(
      () =>
        this.#update(
          rawJobId,
          rawPatch,
          rawScope,
          invocation,
          reauthorize,
        ),
      invocation?.signal,
    );
  }

  async #update(
    rawJobId: string,
    rawPatch: PortableCronUpdateInput,
    rawScope: ProjectExecutionScope,
    invocation?: McpToolInvocation,
    reauthorize?: (
      current: CronJob,
      candidate: CronJob,
    ) => CronExecutionAuthority,
  ): Promise<CronJob> {
    assertMcpInvocationCurrent(invocation);
    const jobId = z.string().min(1).max(256).parse(rawJobId);
    const patch = updateInputSchema.parse(rawPatch);
    const scope = immutableScope(rawScope);
    const jobs = await this.#load();
    assertMcpInvocationCurrent(invocation);
    const index = jobs.findIndex(
      (job) => job.id === jobId && scopedJob(job, scope),
    );
    if (index < 0) throw new Error('portable cron job was not found in scope');
    const current = jobs[index];
    this.#assertClean(current, scope);
    const candidate: CronJob = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
      ...(patch.brief !== undefined ? { brief: patch.brief } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.workingDirectory !== undefined
        ? { workingDirectory: patch.workingDirectory ?? undefined }
        : {}),
      ...(patch.agentName !== undefined
        ? { agentName: patch.agentName, squadId: undefined }
        : {}),
      ...(patch.squadId !== undefined
        ? { squadId: patch.squadId, agentName: undefined }
        : {}),
    };
    const definition = definitionFromJob(candidate, scope);
    const scheduleId = portableScheduleIdSchema.parse(
      current.portableScheduleId,
    );
    const expectedVersion = z
      .number()
      .int()
      .positive()
      .parse(current.definitionVersion);
    const expectedHash = cronDefinitionHash(definition);
    const authorityCandidate: CronJob = {
      ...candidate,
      definitionVersion: expectedVersion + 1,
      definitionHash: expectedHash,
    };
    const executionAuthority = reauthorize?.(current, authorityCandidate);
    assertMcpInvocationCurrent(invocation);
    const remote = this.#published(
      await this.#backend.publish(
        scope.projectId,
        scheduleId,
        expectedVersion,
        definition,
        invocation,
      ),
    );
    assertMcpInvocationCurrent(invocation);
    if (
      remote.projectId !== scope.projectId ||
      remote.scheduleId !== scheduleId ||
      remote.version !== expectedVersion + 1 ||
      remote.definitionHash !== expectedHash
    ) {
      throw new Error(
        'portable cron backend returned an unexpected updated definition',
      );
    }
    const materialized = this.#materialize(remote, scope, current);
    const updated = executionAuthority
      ? {
          ...materialized,
          executionAuthority:
            cronExecutionAuthoritySchema.parse(executionAuthority),
        }
      : materialized;
    const next = [...jobs];
    next[index] = updated;
    assertMcpInvocationCurrent(invocation);
    await this.#save(next);
    return updated;
  }

  async delete(
    rawJobId: string,
    rawScope: ProjectExecutionScope,
    invocation?: McpToolInvocation,
  ): Promise<boolean> {
    return withCronJobsMutationLock(
      () => this.#delete(rawJobId, rawScope, invocation),
      invocation?.signal,
    );
  }

  async #delete(
    rawJobId: string,
    rawScope: ProjectExecutionScope,
    invocation?: McpToolInvocation,
  ): Promise<boolean> {
    assertMcpInvocationCurrent(invocation);
    const jobId = z.string().min(1).max(256).parse(rawJobId);
    const scope = immutableScope(rawScope);
    const jobs = await this.#load();
    assertMcpInvocationCurrent(invocation);
    const index = jobs.findIndex(
      (job) => job.id === jobId && scopedJob(job, scope),
    );
    if (index < 0) return false;
    const current = jobs[index];
    this.#assertClean(current, scope);
    const definition = {
      ...definitionFromJob(current, scope),
      status: 'deleted' as const,
    };
    this.#published(
      await this.#backend.publish(
        scope.projectId,
        portableScheduleIdSchema.parse(current.portableScheduleId),
        z.number().int().positive().parse(current.definitionVersion),
        definition,
        invocation,
      ),
    );
    assertMcpInvocationCurrent(invocation);
    await this.#save(jobs.filter((_job, candidate) => candidate !== index));
    return true;
  }

  async syncScope(
    rawScope: ProjectExecutionScope,
    invocation?: McpToolInvocation,
  ): Promise<PortableCronSyncResult> {
    return withCronJobsMutationLock(
      () => this.#syncScope(rawScope, invocation),
      invocation?.signal,
    );
  }

  async #syncScope(
    rawScope: ProjectExecutionScope,
    invocation?: McpToolInvocation,
  ): Promise<PortableCronSyncResult> {
    assertMcpInvocationCurrent(invocation);
    const scope = immutableScope(rawScope);
    const listed = await this.#backend.list(scope.projectId, invocation);
    assertMcpInvocationCurrent(invocation);
    if (!listed.ok) return { ok: false, reason: 'backend-unavailable' };
    const jobs = await this.#load();
    assertMcpInvocationCurrent(invocation);
    const next = [...jobs];
    const conflicts = new Set<string>();
    let imported = 0;
    let updated = 0;
    let deleted = 0;
    let changed = false;
    const remoteById = new Map<string, PortableCronSchedule>();
    for (const remote of listed.schedules) {
      if (
        remote.projectId !== scope.projectId ||
        cronDefinitionHash(remote.definition) !== remote.definitionHash ||
        remoteById.has(remote.scheduleId)
      ) {
        conflicts.add(remote.scheduleId);
        continue;
      }
      remoteById.set(remote.scheduleId, remote);
      const index = next.findIndex(
        (job) =>
          scopedJob(job, scope) &&
          job.portableScheduleId === remote.scheduleId,
      );
      if (index < 0) {
        if (remote.definition.status !== 'deleted') {
          next.push(this.#materialize(remote, scope));
          imported += 1;
          changed = true;
        }
        continue;
      }
      const local = next[index];
      let localHash: string;
      try {
        localHash = cronDefinitionHash(definitionFromJob(local, scope));
      } catch {
        localHash = '';
      }
      if (
        localHash !== local.definitionHash ||
        remote.version < (local.definitionVersion ?? 0) ||
        (remote.version === local.definitionVersion &&
          remote.definitionHash !== localHash)
      ) {
        next[index] = {
          ...local,
          lastError: 'portable schedule conflict: local definition diverged from its CAS version',
        };
        conflicts.add(remote.scheduleId);
        changed = true;
        continue;
      }
      if (remote.definition.status === 'deleted') {
        next.splice(index, 1);
        deleted += 1;
        changed = true;
      } else if (
        remote.version > (local.definitionVersion ?? 0) ||
        remote.definitionHash !== local.definitionHash
      ) {
        next[index] = this.#materialize(remote, scope, local);
        updated += 1;
        changed = true;
      }
    }

    for (const local of next) {
      if (
        scopedJob(local, scope) &&
        local.executionMode !== 'local' &&
        local.portableScheduleId &&
        !remoteById.has(local.portableScheduleId)
      ) {
        local.lastError = 'portable schedule conflict: definition is absent remotely';
        conflicts.add(local.portableScheduleId);
        changed = true;
      }
    }
    if (changed) {
      assertMcpInvocationCurrent(invocation);
      await this.#save(next);
    }
    return conflicts.size > 0
      ? {
          ok: false,
          reason: 'definition-conflict',
          scheduleIds: Object.freeze([...conflicts].sort()),
        }
      : { ok: true, imported, updated, deleted };
  }

  #assertClean(job: CronJob, scope: ProjectExecutionScope): void {
    const computed = cronDefinitionHash(definitionFromJob(job, scope));
    if (computed !== job.definitionHash) {
      throw new Error('portable schedule has an unresolved local definition conflict');
    }
  }

  #published(result: PublishPortableScheduleResult): PortableCronSchedule {
    if (result.ok) return result.schedule;
    if (result.reason === 'version-conflict') {
      throw new CronPortableScheduleConflictError(
        result.expectedVersion,
        result.actualVersion,
        result.current,
      );
    }
    throw new CronPortableBackendUnavailableError();
  }

  #materialize(
    remote: PortableCronSchedule,
    scope: ProjectExecutionScope,
    existing?: CronJob,
  ): CronJob {
    const definition = portableCronDefinitionSchema.parse(remote.definition);
    if (definition.status === 'deleted') {
      throw new Error('deleted portable schedule cannot be materialized');
    }
    const now = validNow(this.#now);
    const workingDirectory = definition.workingDirectory
      ? resolveCwdForScope(scope, definition.workingDirectory)
      : undefined;
    const scheduleChanged = existing?.schedule !== definition.schedule;
    const nextFireAt =
      !existing || scheduleChanged || existing.nextFireAt == null
        ? nextCronAfter(parseCronExpr(definition.schedule), new Date(now))?.getTime()
        : existing.nextFireAt;
    return {
      ...(existing ?? {}),
      id: existing?.id ?? `cron-${remote.scheduleId}`,
      name: definition.name,
      schedule: definition.schedule,
      brief: definition.brief,
      status: definition.status,
      executionMode: 'shared',
      portableScheduleId: remote.scheduleId,
      definitionVersion: remote.version,
      definitionHash: remote.definitionHash,
      workspacePath: scope.rootRealPath,
      workingDirectory,
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
      agentName:
        definition.target.kind === 'agent' ? definition.target.id : undefined,
      squadId:
        definition.target.kind === 'squad' ? definition.target.id : undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      nextFireAt,
      lastError: undefined,
    };
  }
}
