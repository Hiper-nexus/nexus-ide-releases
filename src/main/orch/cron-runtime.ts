import { randomUUID } from 'node:crypto';
import type { MissionIntentContract } from '../../shared/mission-intent';
import type { ProjectExecutionScope } from '../../shared/types';
import type { LeaseBackend } from '../context/distributed-lease';
import { resolveProjectExecutionScope } from '../persistence/project-identity';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  CRON_STALE_MS,
  CRON_TICK_MS,
  loadCronJobs,
  matchesCron,
  nextCronAfter,
  parseCronExpr,
  saveCronJobs,
  shouldFire,
  withCronJobsMutationLock,
  type CronJob,
} from './cron-loop';
import {
  assertMcpInvocationCurrent,
  type McpToolInvocation,
} from './mcp-protocol';
import { resolveCwdForScope } from './workspace-path';
import {
  CronExecutionCoordinator,
  type CronOccurrenceExecutor,
} from './cron-execution-coordinator';
import {
  assertCronExecutionAuthority,
  issueCronExecutionAuthority,
  type CronExactUserConsent,
} from './cron-execution-authority';
import {
  CronPortableScheduleService,
  type PortableCronUpdateInput,
} from './cron-portable-schedule-service';
import { bootstrapMissionOrchestratorForScope } from './mission-engine-production';
import type { PortableCronScheduleBackend } from './portable-cron-definition';
import { getProjectDomainStores } from './project-domain-store-registry';

/**
 * Runtime do cron: tick de 60s no main, lease/fence de ocorrência,
 * skip-if-stale e avanço de nextFireAt. A instância default mantém o efeito
 * Uma ocorrência autorizada cria uma missão selada e entra exclusivamente no
 * bootstrap main-owned; jobs legados/alterados continuam fail-closed.
 */

export interface CronRuntimeDeps {
  load(): CronJob[];
  save(jobs: CronJob[]): void;
  fire(job: CronJob): Promise<void>;
  executeOccurrence: CronOccurrenceExecutor['execute'];
  syncSchedules?: () => Promise<void>;
  now(): number;
}

/**
 * Scheduled occurrence boundary. This function only materializes the approved
 * mission envelope; the existing main-owned bootstrap/scheduler own physical
 * spawn, kickoff proof, RouteReservation/sticky roster, handoff and terminal
 * state. Never reintroduce a raw pane spawn here.
 */
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
  resolveCwdForScope(scope, job.workingDirectory);
  const authority = assertCronExecutionAuthority(job, scope);
  // O selo de revisão da faixa automática é o próprio jobBindingHash: um
  // sha256 já verificado sobre job + contrato + recibo de consentimento exato.
  // Sem ele o MissionEngine.start recusa a partida ("review_required") e toda
  // ocorrência agendada morre — a agenda não passa pela revisão humana que
  // carimba approvalReviewSha256 via persistReviewFence.
  const contract: MissionIntentContract = {
    ...authority.contract,
    dispatchedAt: Date.now(),
    approvalReviewSha256: authority.jobBindingHash,
    acceptanceCriteria: [...authority.contract.acceptanceCriteria],
    budgets: { ...authority.contract.budgets },
    deniedTools: authority.contract.deniedTools
      ? [...authority.contract.deniedTools]
      : undefined,
    attachmentPaths: authority.contract.attachmentPaths
      ? [...authority.contract.attachmentPaths]
      : undefined,
    attachmentSnapshots: authority.contract.attachmentSnapshots
      ? authority.contract.attachmentSnapshots.map((snapshot) => ({
          ...snapshot,
        }))
      : undefined,
    orchestratorRuntime: authority.contract.orchestratorRuntime
      ? { ...authority.contract.orchestratorRuntime }
      : undefined,
  };
  const missions = getProjectDomainStores(scope).missions;
  const created = missions.create({
    title: `⏰ ${job.name}`.slice(0, 512),
    description: contract.goal,
    squadId: authority.squadId,
    milestones: contract.acceptanceCriteria,
    intentState: 'dispatched',
    intentVersion: contract.intentVersion,
    intentContract: contract,
  });
  const running = missions.update(created.id, { status: 'running' });
  if (!running) {
    missions.update(created.id, {
      status: 'failed',
      description:
        `${created.description}\n\n` +
        'Falha ao publicar a missão agendada. CTA: recrie a agenda e tente novamente.',
    });
    throw new Error(
      'cron_golden_path_failed: mission lifecycle could not enter running',
    );
  }
  const launched = await bootstrapMissionOrchestratorForScope(
    scope,
    running.id,
    authority.jobBindingHash,
  );
  if (!launched.ok) {
    throw new Error(
      `cron_golden_path_failed: ${launched.error} CTA: ${launched.cta}`,
    );
  }
  if (!launched.kickoff.accepted) {
    throw new Error(
      `cron_kickoff_not_accepted: ${launched.kickoff.detail} ` +
        `CTA: ${launched.kickoff.cta}`,
    );
  }
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
  const executor = new CronExecutionCoordinator({
    ...options,
    preflight: (job, scope) => {
      assertCronExecutionAuthority(job, scope);
    },
  });
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
  invocation?: McpToolInvocation,
): Promise<void> {
  assertMcpInvocationCurrent(invocation);
  if (!configuredPortableSchedules) return;
  const result = await configuredPortableSchedules.syncScope(scope, invocation);
  assertMcpInvocationCurrent(invocation);
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
async function runCronTickLocked(deps: CronRuntimeDeps): Promise<number> {
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
    if (job.nextFireAt != null) {
      const occurrenceAt = new Date(job.nextFireAt);
      if (
        occurrenceAt.getSeconds() !== 0 ||
        occurrenceAt.getMilliseconds() !== 0 ||
        !matchesCron(fields, occurrenceAt)
      ) {
        job.lastError =
          'cron_schedule_state_invalid: nextFireAt não pertence à expressão ' +
          'aprovada. CTA: Recrie a agenda para restaurar o estado.';
        job.nextFireAt = nextCronAfter(fields, new Date(now))?.getTime();
        job.updatedAt = now;
        changed = true;
        continue;
      }
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
          (result.disposition === 'already-recorded' && !result.error)
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

export async function runCronTick(deps: CronRuntimeDeps): Promise<number> {
  // Remote reconciliation owns the same mutex internally; run it first to
  // avoid nested-lock deadlock, then keep load/fire/save as one transaction.
  await deps.syncSchedules?.();
  return withCronJobsMutationLock(() => runCronTickLocked(deps));
}

let timer: ReturnType<typeof setInterval> | null = null;
let tickFlight: Promise<number> | null = null;

function requestCronTick(deps: CronRuntimeDeps): Promise<number> {
  if (tickFlight) return tickFlight;
  const flight = runCronTick(deps).finally(() => {
    if (tickFlight === flight) tickFlight = null;
  });
  tickFlight = flight;
  return flight;
}

/** Inicia o loop de tick (idempotente). */
export function startCronLoop(deps: CronRuntimeDeps = defaultCronDeps): void {
  if (timer) return;
  timer = setInterval(() => {
    void requestCronTick(deps).catch((err) =>
      console.warn('[cron] tick falhou:', err),
    );
  }, CRON_TICK_MS);
  timer.unref?.();
}

/**
 * Teto do quit: o tick em voo consulta backend remoto por escopo (syncScope,
 * até 32 escopos seriais sob mutex de mutação). Sem prazo, um backend ou lock
 * pendurado segura stopCronLoop — o PRIMEIRO passo do shutdown — e sozinho
 * estoura o teto de quit de 45s (incidente "ceiling-fired" de 13/09). O diário
 * de cron é persistido e reconcilia na próxima sessão; soltar o voo não perde
 * dado durável.
 */
const CRON_TICK_STOP_BUDGET_MS = 3_000;

export async function stopCronLoop(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  const active = tickFlight;
  if (!active) return;
  let budget: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      active.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        budget = setTimeout(resolve, CRON_TICK_STOP_BUDGET_MS);
        budget.unref?.();
      }),
    ]);
  } finally {
    if (budget) clearTimeout(budget);
  }
  if (active === tickFlight) {
    // Voo órfão: ninguém mais observa este promise — sem este observador, uma
    // rejeição tardia vira unhandled rejection no main já encerrando.
    active.catch(() => {});
  }
}

// ── CRUD helpers para as MCP tools / IPC ─────────────────────────────────────

export function listCronJobs(scope: ProjectExecutionScope): CronJob[] {
  const jobs = loadCronJobs();
  return jobs.filter((job) => jobMatchesScope(job, scope));
}

function requireExactCronConsent(
  invocation: McpToolInvocation | undefined,
  action: 'create' | 'update' | 'delete',
): CronExactUserConsent {
  assertMcpInvocationCurrent(invocation);
  const consent = invocation?.exactUserConsent;
  if (
    !consent ||
    consent.toolName.replace(/^nexus_/, '').toLowerCase() !== 'cron' ||
    consent.action !== action
  ) {
    throw new Error(
      'cron_exact_consent_required: criação/alteração exige consentimento ' +
        'exato para execuções futuras automáticas',
    );
  }
  return {
    toolName: consent.toolName,
    action,
    grantedAt: consent.grantedAt,
    receiptId: consent.receiptId,
  };
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

export async function addCronJob(
  input: {
    name: string;
    schedule: string;
    brief: string;
    workspacePath?: string;
    executionMode?: 'shared' | 'local';
    agentName?: string;
    squadId?: string;
  },
  scope: ProjectExecutionScope,
  invocation?: McpToolInvocation,
): Promise<CronJob> {
  assertMcpInvocationCurrent(invocation);
  const fields = parseCronExpr(input.schedule); // valida
  // O job fica preso ao workspace ativo canônico. Nunca deixe o PTY cair para
  // HOME quando o chamador omite ou fornece um caminho inválido.
  const resolvedCwd = resolveCwdForScope(scope, input.workspacePath);
  const executionMode = input.executionMode ?? 'shared';
  const portableSchedules = configuredPortableSchedules;
  if (executionMode === 'shared') {
    if (!portableSchedules) {
      throw new Error(
        'shared cron backend is not configured; choose local explicitly or configure the remote control plane',
      );
    }
  }
  const consent = requireExactCronConsent(invocation, 'create');
  const now = Date.now();
  const normalizedName = input.name.trim();
  if (!normalizedName || normalizedName.length > 120) {
    throw new Error('cron name must contain 1..120 characters');
  }
  if (input.brief.length > 64 * 1024) {
    throw new Error('cron brief exceeds 64 KiB');
  }
  if (executionMode === 'shared') {
    if (!portableSchedules) {
      throw new Error('shared cron backend became unavailable');
    }
    return portableSchedules.create(
      {
        name: normalizedName,
        schedule: input.schedule,
        brief: input.brief,
        workingDirectory:
          resolvedCwd === scope.rootRealPath ? undefined : resolvedCwd,
        agentName: input.agentName,
        squadId: input.squadId,
      },
      scope,
      invocation,
      (candidate) => issueCronExecutionAuthority(candidate, scope, consent),
    );
  }
  return withCronJobsMutationLock(() => {
    assertMcpInvocationCurrent(invocation);
    const workspacePath = scope.rootRealPath;
    const job: CronJob = {
      id: `cron-${randomUUID()}`,
      name: normalizedName,
      schedule: input.schedule,
      brief: input.brief,
      status: 'active',
      executionMode: 'local',
      workspacePath,
      workingDirectory:
        resolvedCwd !== scope.rootRealPath ? resolvedCwd : undefined,
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
      agentName: input.agentName,
      squadId: input.squadId,
      createdAt: now,
      updatedAt: now,
      nextFireAt: nextCronAfter(fields, new Date(now))?.getTime(),
    };
    job.executionAuthority = issueCronExecutionAuthority(job, scope, consent);
    const jobs = loadCronJobs();
    jobs.push(job);
    assertMcpInvocationCurrent(invocation);
    saveCronJobs(jobs);
    return job;
  }, invocation?.signal);
}

export async function deleteCronJob(
  id: string,
  scope: ProjectExecutionScope,
  invocation?: McpToolInvocation,
): Promise<boolean> {
  assertMcpInvocationCurrent(invocation);
  requireExactCronConsent(invocation, 'delete');
  const jobs = loadCronJobs();
  const target = jobs.find(
    (job) => job.id === id && jobMatchesScope(job, scope),
  );
  if (!target) return false;
  if (target.executionMode !== 'local') {
    if (!configuredPortableSchedules) {
      throw new Error('shared cron backend is not configured');
    }
    return configuredPortableSchedules.delete(id, scope, invocation);
  }
  return withCronJobsMutationLock(() => {
    assertMcpInvocationCurrent(invocation);
    const currentJobs = loadCronJobs();
    let didDelete = false;
    const next = currentJobs.filter((job) => {
      if (job.id !== id || !jobMatchesScope(job, scope)) return true;
      didDelete = true;
      return false;
    });
    if (!didDelete) return false;
    assertMcpInvocationCurrent(invocation);
    saveCronJobs(next);
    return true;
  }, invocation?.signal);
}

export async function updateCronJob(
  id: string,
  patch: PortableCronUpdateInput & { workspacePath?: string },
  scope: ProjectExecutionScope,
  invocation?: McpToolInvocation,
): Promise<CronJob> {
  assertMcpInvocationCurrent(invocation);
  const consent = requireExactCronConsent(invocation, 'update');
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
      invocation,
      (liveCurrent, candidate) => {
        try {
          assertCronExecutionAuthority(liveCurrent, scope);
        } catch (error) {
          throw new Error(
            'cron_reapproval_required: autoridade ausente ou stale; ' +
              'exclua e recrie a agenda para revisar a definição completa',
            { cause: error },
          );
        }
        return issueCronExecutionAuthority(candidate, scope, consent);
      },
    );
  }
  return withCronJobsMutationLock(() => {
    assertMcpInvocationCurrent(invocation);
    const currentJobs = loadCronJobs();
    const currentIndex = currentJobs.findIndex(
      (job) => job.id === id && jobMatchesScope(job, scope),
    );
    if (currentIndex < 0) throw new Error('cron job was not found in scope');
    const liveCurrent = currentJobs[currentIndex];
    if (liveCurrent.executionMode !== 'local') {
      throw new Error('cron execution mode changed while awaiting local update');
    }
    if (patch.agentName && patch.squadId) {
      throw new Error('cron target update is ambiguous');
    }
    const schedule = patch.schedule ?? liveCurrent.schedule;
    const fields = parseCronExpr(schedule);
    const now = Date.now();
    const updated: CronJob = {
      ...liveCurrent,
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
    try {
      assertCronExecutionAuthority(liveCurrent, scope);
    } catch (error) {
      throw new Error(
        'cron_reapproval_required: autoridade ausente ou stale; ' +
          'exclua e recrie a agenda para revisar a definição completa',
        { cause: error },
      );
    }
    updated.executionAuthority = issueCronExecutionAuthority(
      updated,
      scope,
      consent,
    );
    const next = [...currentJobs];
    next[currentIndex] = updated;
    assertMcpInvocationCurrent(invocation);
    saveCronJobs(next);
    return updated;
  }, invocation?.signal);
}
