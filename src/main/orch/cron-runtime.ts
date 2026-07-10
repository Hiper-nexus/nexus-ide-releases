import { randomUUID } from 'node:crypto';
import {
  CRON_STALE_MS,
  CRON_TICK_MS,
  loadCronJobs,
  nextCronAfter,
  parseCronExpr,
  saveCronJobs,
  shouldFire,
  type CronJob,
} from './cron-loop';
import { getSquad, findAgent } from './squad-store';
import { spawnPaneAndMaybePrompt } from './tool-util';
import { getProjectDomainStores } from './project-domain-store-registry';
import { resolveCwdForScope } from './workspace-path';
import { resolveProjectExecutionScope } from '../persistence/project-identity';
import type { ProjectExecutionScope } from '../../shared/types';
import type { LeaseBackend } from '../context/distributed-lease';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  CronExecutionCoordinator,
  type CronOccurrenceExecutor,
} from './cron-execution-coordinator';
import {
  CronPortableScheduleService,
  type PortableCronUpdateInput,
} from './cron-portable-schedule-service';
import type { PortableCronScheduleBackend } from './portable-cron-definition';

/**
 * Runtime do cron: tick de 60s no main. Jobs vencidos disparam o brief num
 * pane novo (agente do squad ou orquestrador do squad), skip-if-stale, e
 * reavançam nextFireAt. IO/spawn injetáveis → testável; a instância default
 * usa os stores reais.
 */

export interface CronRuntimeDeps {
  load(): CronJob[];
  save(jobs: CronJob[]): void;
  fire(job: CronJob): Promise<void>;
  executeOccurrence: CronOccurrenceExecutor['execute'];
  syncSchedules?: () => Promise<void>;
  now(): number;
}

/** Dispara um job: cria missão + spawna o alvo com o brief. */
export async function fireCronJob(job: CronJob): Promise<void> {
  // Revalida também jobs legados ou alterados no disco. Sem workspace aberto,
  // ou se o caminho escapar do workspace ativo, falha antes de criar missão.
  if (!job.workspacePath) throw new Error('job sem workspace registrado');
  const scope = resolveProjectExecutionScope(job.workspacePath);
  if (job.projectId && job.projectId !== scope.projectId) {
    throw new Error('cron project identity no longer matches its workspace');
  }
  if (job.checkoutId && job.checkoutId !== scope.checkoutId) {
    throw new Error('cron checkout identity no longer matches this installation');
  }
  const workspacePath = resolveCwdForScope(scope, job.workingDirectory);
  const missionStore = getProjectDomainStores(scope).missions;
  const mission = missionStore.create({
    title: `⏰ ${job.name}`,
    description: job.brief,
  });
  if (job.squadId) {
    const squad = getSquad(job.squadId);
    if (!squad) throw new Error(`squad ${job.squadId} não existe`);
    const orch =
      squad.agents.find((a) => a.category === 'orchestrator') ?? squad.agents[0];
    if (!orch) throw new Error(`squad ${job.squadId} sem agentes`);
    try {
      await spawnPaneAndMaybePrompt({
      adapterId: orch.cli,
      model: orch.model,
      cwd: workspacePath,
      title: `${squad.name} (cron)`,
      missionId: mission.id,
      agentName: orch.agentName,
      allowedTools: orch.allowedTools ?? null,
      allowedSkills: orch.allowedSkills ?? null,
      role: 'orchestrator',
      prompt: `${squad.orchestratorInstructions ?? ''}\n\nMISSÃO AGENDADA: ${job.brief}`,
      scope,
      });
    } catch (error) {
      missionStore.setStatus(mission.id, 'failed');
      throw error;
    }
    return;
  }
  if (job.agentName) {
    const found = findAgent(job.agentName);
    if (!found) throw new Error(`agente ${job.agentName} não encontrado`);
    const { agent } = found;
    try {
      await spawnPaneAndMaybePrompt({
      adapterId: agent.cli,
      model: agent.model,
      cwd: workspacePath,
      title: `${agent.agentName} (cron)`,
      missionId: mission.id,
      agentName: agent.agentName,
      allowedTools: agent.allowedTools ?? null,
      allowedSkills: agent.allowedSkills ?? null,
      role: agent.category === 'orchestrator' ? 'orchestrator' : 'worker',
      prompt: job.brief,
      scope,
      });
    } catch (error) {
      missionStore.setStatus(mission.id, 'failed');
      throw error;
    }
    return;
  }
  throw new Error('job sem agentName nem squadId');
}

let configuredOccurrenceExecutor: CronOccurrenceExecutor | null = null;
let configuredPortableSchedules: CronPortableScheduleService | null = null;
let configuredScopeList: (() => readonly ProjectExecutionScope[]) | null = null;

/**
 * Binds cron persistence to the physical project runtime. A missing remote
 * backend is intentional fail-closed state for shared jobs, never a local
 * fallback.
 */
export function configureCronRuntime(options: {
  runtimeManager: ProjectRuntimeManager;
  leaseBackend?: LeaseBackend;
  scheduleBackend?: PortableCronScheduleBackend;
  listScopes?: () => readonly ProjectExecutionScope[];
}): CronOccurrenceExecutor {
  const executor = new CronExecutionCoordinator(options);
  configuredOccurrenceExecutor = executor;
  configuredPortableSchedules = options.scheduleBackend
    ? new CronPortableScheduleService({
        backend: options.scheduleBackend,
        load: loadCronJobs,
        save: saveCronJobs,
      })
    : null;
  configuredScopeList = options.listScopes ?? null;
  return executor;
}

export function disposeCronRuntime(): void {
  configuredOccurrenceExecutor = null;
  configuredPortableSchedules = null;
  configuredScopeList = null;
}

export async function syncCronJobsForScope(
  scope: ProjectExecutionScope,
): Promise<void> {
  if (!configuredPortableSchedules) return;
  const result = await configuredPortableSchedules.syncScope(scope);
  if (!result.ok && result.reason === 'definition-conflict') {
    console.warn(
      '[cron] portable definition conflict:',
      result.scheduleIds?.join(', ') ?? 'unknown schedule',
    );
  }
}

async function syncConfiguredCronScopes(): Promise<void> {
  if (!configuredPortableSchedules || !configuredScopeList) return;
  const seen = new Set<string>();
  for (const scope of configuredScopeList().slice(0, 32)) {
    const key = `${scope.projectId}:${scope.checkoutId}`;
    if (seen.has(key) || scope.identitySource !== 'manifest') continue;
    seen.add(key);
    try {
      await configuredPortableSchedules.syncScope(scope);
    } catch (error) {
      console.warn('[cron] portable schedule sync failed:', cronErrorMessage(error));
    }
  }
}

async function executeConfiguredOccurrence(
  job: CronJob,
  scheduledFor: number,
  fire: (job: CronJob) => Promise<void>,
) {
  if (!configuredOccurrenceExecutor) {
    return Object.freeze({
      fired: false,
      disposition: 'persistence-unavailable' as const,
      error: 'cron runtime is not configured',
    });
  }
  return configuredOccurrenceExecutor.execute(job, scheduledFor, fire);
}

export const defaultCronDeps: CronRuntimeDeps = {
  load: loadCronJobs,
  save: saveCronJobs,
  fire: fireCronJob,
  executeOccurrence: executeConfiguredOccurrence,
  syncSchedules: syncConfiguredCronScopes,
  now: Date.now,
};

function cronErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}

/**
 * Processa um tick: dispara os jobs vencidos, marca stale-skips, e reavança
 * nextFireAt de todos. Puro em relação ao tempo (recebe `now`/deps). Retorna
 * quantos dispararam.
 */
export async function runCronTick(deps: CronRuntimeDeps): Promise<number> {
  await deps.syncSchedules?.();
  const jobs = deps.load();
  const now = deps.now();
  let fired = 0;
  let changed = false;

  for (const job of jobs) {
    if (job.status !== 'active') continue;
    let fields;
    try {
      fields = parseCronExpr(job.schedule);
    } catch (err) {
      job.lastError = cronErrorMessage(err);
      changed = true;
      continue;
    }
    const decision = shouldFire(job, now, CRON_STALE_MS);
    if (decision.fire) {
      try {
        const scheduledFor = job.nextFireAt;
        if (scheduledFor == null) throw new Error('cron occurrence has no schedule');
        const result = await deps.executeOccurrence(
          job,
          scheduledFor,
          deps.fire,
        );
        if (result.fired) {
          job.lastFiredAt = now;
          fired += 1;
        }
        job.lastError =
          result.disposition === 'completed' ||
          result.disposition === 'already-recorded'
            ? undefined
            : result.error ?? `cron occurrence ${result.disposition}`;
      } catch (err) {
        job.lastError = cronErrorMessage(err);
      }
      changed = true;
    } else if (decision.stale) {
      console.warn(`[cron] job "${job.name}" pulado (atraso > stale)`);
      changed = true;
    }
    // Reavança para o próximo horário futuro (mesmo após skip/fire).
    if (job.nextFireAt != null && now >= job.nextFireAt) {
      const next = nextCronAfter(fields, new Date(now));
      job.nextFireAt = next?.getTime();
      job.updatedAt = now;
      changed = true;
    }
  }

  if (changed) deps.save(jobs);
  return fired;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Inicia o loop de tick (idempotente). */
export function startCronLoop(deps: CronRuntimeDeps = defaultCronDeps): void {
  if (timer) return;
  timer = setInterval(() => {
    void runCronTick(deps).catch((err) =>
      console.warn('[cron] tick falhou:', err),
    );
  }, CRON_TICK_MS);
  timer.unref?.();
}

export function stopCronLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ── CRUD helpers para as MCP tools / IPC ─────────────────────────────────────

export function listCronJobs(scope: ProjectExecutionScope): CronJob[] {
  const jobs = loadCronJobs();
  return jobs.filter((job) => jobMatchesScope(job, scope));
}

function jobMatchesScope(job: CronJob, scope: ProjectExecutionScope): boolean {
  if (job.projectId !== undefined || job.checkoutId !== undefined) {
    return (
      job.projectId === scope.projectId && job.checkoutId === scope.checkoutId
    );
  }
  if (!job.workspacePath) return false;
  try {
    const legacyScope = resolveProjectExecutionScope(
      job.workspacePath,
      scope.installationId,
    );
    return (
      legacyScope.projectId === scope.projectId &&
      legacyScope.checkoutId === scope.checkoutId
    );
  } catch {
    return false;
  }
}

export async function addCronJob(input: {
  name: string;
  schedule: string;
  brief: string;
  workspacePath?: string;
  executionMode?: 'shared' | 'local';
  agentName?: string;
  squadId?: string;
}, scope: ProjectExecutionScope): Promise<CronJob> {
  const fields = parseCronExpr(input.schedule); // valida
  // O job fica preso ao workspace ativo canônico. Nunca deixe o PTY cair para
  // HOME quando o chamador omite ou fornece um caminho inválido.
  const resolvedCwd = resolveCwdForScope(scope, input.workspacePath);
  const executionMode = input.executionMode ?? 'shared';
  if (executionMode === 'shared') {
    if (!configuredPortableSchedules) {
      throw new Error(
        'shared cron backend is not configured; choose local explicitly or configure the remote control plane',
      );
    }
    return configuredPortableSchedules.create(
      {
        name: input.name,
        schedule: input.schedule,
        brief: input.brief,
        workingDirectory:
          resolvedCwd === scope.rootRealPath ? undefined : resolvedCwd,
        agentName: input.agentName,
        squadId: input.squadId,
      },
      scope,
    );
  }
  const workspacePath = scope.rootRealPath;
  const now = Date.now();
  const job: CronJob = {
    id: `cron-${randomUUID().slice(0, 8)}`,
    name: input.name.slice(0, 120),
    schedule: input.schedule,
    brief: input.brief,
    status: 'active',
    executionMode: 'local',
    workspacePath,
    workingDirectory: resolvedCwd !== scope.rootRealPath ? resolvedCwd : undefined,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    agentName: input.agentName,
    squadId: input.squadId,
    createdAt: now,
    updatedAt: now,
    nextFireAt: nextCronAfter(fields, new Date(now))?.getTime(),
  };
  const jobs = loadCronJobs();
  jobs.push(job);
  saveCronJobs(jobs);
  return job;
}

export async function deleteCronJob(
  id: string,
  scope: ProjectExecutionScope,
): Promise<boolean> {
  const jobs = loadCronJobs();
  const target = jobs.find(
    (job) => job.id === id && jobMatchesScope(job, scope),
  );
  if (!target) return false;
  if (target.executionMode !== 'local') {
    if (!configuredPortableSchedules) {
      throw new Error('shared cron backend is not configured');
    }
    return configuredPortableSchedules.delete(id, scope);
  }
  let didDelete = false;
  const next = jobs.filter((job) => {
    if (job.id !== id || !jobMatchesScope(job, scope)) return true;
    didDelete = true;
    return false;
  });
  if (!didDelete) return false;
  saveCronJobs(next);
  return true;
}

export async function updateCronJob(
  id: string,
  patch: PortableCronUpdateInput & { workspacePath?: string },
  scope: ProjectExecutionScope,
): Promise<CronJob> {
  const jobs = loadCronJobs();
  const index = jobs.findIndex(
    (job) => job.id === id && jobMatchesScope(job, scope),
  );
  if (index < 0) throw new Error('cron job was not found in scope');
  const current = jobs[index];
  const resolvedWorkingDirectory =
    patch.workspacePath !== undefined
      ? resolveCwdForScope(scope, patch.workspacePath)
      : undefined;
  if (current.executionMode !== 'local') {
    if (!configuredPortableSchedules) {
      throw new Error('shared cron backend is not configured');
    }
    const { workspacePath: _workspacePath, ...portablePatch } = patch;
    return configuredPortableSchedules.update(
      id,
      {
        ...portablePatch,
        ...(patch.workspacePath !== undefined
          ? {
              workingDirectory:
                resolvedWorkingDirectory === scope.rootRealPath
                  ? null
                  : resolvedWorkingDirectory,
            }
          : {}),
      },
      scope,
    );
  }
  if (patch.agentName && patch.squadId) {
    throw new Error('cron target update is ambiguous');
  }
  const schedule = patch.schedule ?? current.schedule;
  const fields = parseCronExpr(schedule);
  const now = Date.now();
  const updated: CronJob = {
    ...current,
    ...(patch.name !== undefined ? { name: patch.name.slice(0, 120) } : {}),
    schedule,
    ...(patch.brief !== undefined ? { brief: patch.brief } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.workspacePath !== undefined
      ? {
          workingDirectory:
            resolvedWorkingDirectory === scope.rootRealPath
              ? undefined
              : resolvedWorkingDirectory,
        }
      : {}),
    ...(patch.agentName !== undefined
      ? { agentName: patch.agentName, squadId: undefined }
      : {}),
    ...(patch.squadId !== undefined
      ? { squadId: patch.squadId, agentName: undefined }
      : {}),
    updatedAt: now,
    ...(patch.schedule !== undefined
      ? { nextFireAt: nextCronAfter(fields, new Date(now))?.getTime() }
      : {}),
  };
  const next = [...jobs];
  next[index] = updated;
  saveCronJobs(next);
  return updated;
}
