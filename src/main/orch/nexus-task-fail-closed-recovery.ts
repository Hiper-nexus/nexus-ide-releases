import type { Mission, SquadAgent } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { missionAwaitsAdjustment } from '../../shared/mission-recovery-policy';
import { listPaneSnapshots, requestPaneSpawn } from './pane-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import { getSquad } from './squad-store';
import { registerSameCheckoutClaim } from './same-checkout-fanout';
import {
  civilianSpawnFailMessage,
  isLikelyBootSpawnFailure,
  selectSpawnFailSuccessor,
  type QuotaWorstRatioByCli,
  type SpawnFailRosterAgent,
} from './spawn-fail-reroute';
import { requireQuotaService } from '../quota/quota-service';
import { entryWorstRatio } from '../quota/quota-policy';
import { emitWorkerSpawnFailed } from './spawn-fail-events';
import {
  decideNexusTaskFailClosed,
  inferRoleOwnershipFiles,
  plannedRolesFromNexusTaskArgs,
  type PlannedFanoutRole,
} from './nexus-task-fail-closed';

export interface QueuedRoleSpawnRequest {
  readonly roleId: string;
  readonly roleName: string;
  readonly category?: string;
  readonly adapterId: string;
  readonly model?: string;
  readonly effort?: string;
  readonly files: readonly string[];
  readonly prompt: string;
}

export interface QueuedRoleSpawnResult {
  readonly ok: boolean;
  readonly paneId?: string;
  readonly error?: string;
}

export interface AttemptQueuedRoleSpawnsResult {
  readonly attemptedRoleIds: readonly string[];
  readonly spawnedRoleIds: readonly string[];
  readonly queuedWithoutSpawn: readonly string[];
  readonly rerouteNote?: string;
}

interface PendingFanoutRetry {
  readonly missionId: string;
  readonly roles: readonly PlannedFanoutRole[];
  readonly objective?: string;
  readonly at: number;
}

const pendingByMission = new Map<string, PendingFanoutRetry>();
const inFlight = new Set<string>();

/**
 * Pior janela de quota por CLI a partir do último fleet snapshot (undefined
 * em boot race — o reroute cai no comportamento sem quota, como failover.ts).
 */
function quotaWorstRatioByCli(): QuotaWorstRatioByCli | undefined {
  try {
    const snap = requireQuotaService().lastSnapshot();
    if (!snap) return undefined;
    const byCli: Record<string, number | null> = {};
    for (const entry of snap.entries) {
      const worst = entryWorstRatio(entry);
      const key = entry.adapterId.toLowerCase();
      const prev = byCli[key];
      if (prev === undefined) {
        byCli[key] = worst;
      } else if (worst !== null && (prev === null || worst > prev)) {
        byCli[key] = worst;
      }
    }
    return byCli;
  } catch {
    /* quota service optional at boot race */
    return undefined;
  }
}

export function resetNexusTaskFailClosedForTests(): void {
  pendingByMission.clear();
  inFlight.clear();
}

function mergePlannedRoles(
  left: readonly PlannedFanoutRole[],
  right: readonly PlannedFanoutRole[],
): PlannedFanoutRole[] {
  const out: PlannedFanoutRole[] = [];
  const seen = new Set<string>();
  for (const role of [...left, ...right]) {
    const key = `${role.roleId.trim().toLowerCase()}::${role.roleName.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(role);
  }
  return out;
}

function rosterAgentsOf(agents: readonly SquadAgent[]): SpawnFailRosterAgent[] {
  return agents.map((agent) => ({
    id: agent.id,
    agentName: agent.agentName,
    category: agent.category,
    cli: agent.cli,
    model: agent.model,
    effort: agent.effort,
  }));
}

function resolveRosterAgent(
  role: PlannedFanoutRole,
  roster: readonly SpawnFailRosterAgent[],
): SpawnFailRosterAgent | null {
  const id = role.roleId.trim().toLowerCase();
  const name = role.roleName.trim().toLowerCase();
  return (
    roster.find((agent) => agent.id.toLowerCase() === id) ??
    roster.find((agent) => agent.agentName.toLowerCase() === name) ??
    roster.find((agent) => agent.agentName.toLowerCase().includes(name)) ??
    null
  );
}

export async function attemptQueuedRoleSpawns(input: {
  readonly roles: readonly PlannedFanoutRole[];
  readonly roster: readonly SpawnFailRosterAgent[];
  readonly spawn: (role: QueuedRoleSpawnRequest) => Promise<QueuedRoleSpawnResult>;
  readonly objective?: string;
  readonly promptFor?: (role: PlannedFanoutRole, agent: SpawnFailRosterAgent) => string;
}): Promise<AttemptQueuedRoleSpawnsResult> {
  const attemptedRoleIds: string[] = [];
  const spawnedRoleIds: string[] = [];
  const queuedWithoutSpawn: string[] = [];
  let rerouteNote: string | undefined;

  for (const role of input.roles) {
    const agent = resolveRosterAgent(role, input.roster);
    if (!agent) {
      queuedWithoutSpawn.push(role.roleId);
      continue;
    }
    const files = inferRoleOwnershipFiles({
      roleName: role.roleName,
      category: role.category ?? agent.category,
      objective: input.objective,
      explicitFiles: role.files,
    });
    const prompt =
      input.promptFor?.(role, agent) ??
      `Você é ${role.roleName}. Entregue os arquivos ${files.join(', ') || 'do seu papel'} e faça handoff.`;
    attemptedRoleIds.push(role.roleId);
    const first = await input.spawn({
      roleId: role.roleId,
      roleName: role.roleName,
      category: role.category ?? agent.category,
      adapterId: agent.cli,
      model: agent.model,
      effort: agent.effort,
      files,
      prompt,
    });
    if (first.ok) {
      spawnedRoleIds.push(role.roleId);
      continue;
    }
    if (!isLikelyBootSpawnFailure(first.error)) {
      queuedWithoutSpawn.push(role.roleId);
      continue;
    }
    const successor = selectSpawnFailSuccessor({
      deadAdapterId: agent.cli,
      preferredCategory: role.category ?? agent.category,
      roster: input.roster,
      quotaWorstRatioByCli: quotaWorstRatioByCli(),
    });
    rerouteNote = civilianSpawnFailMessage({
      deadAdapterId: agent.cli,
      deadLabel: role.roleName,
      successorCli: successor?.cli,
      successorName: successor?.agentName,
    });
    if (!successor) {
      queuedWithoutSpawn.push(role.roleId);
      continue;
    }
    const retry = await input.spawn({
      roleId: role.roleId,
      roleName: successor.agentName,
      category: successor.category,
      adapterId: successor.cli,
      model: successor.model,
      effort: successor.effort,
      files,
      prompt,
    });
    if (retry.ok) {
      spawnedRoleIds.push(role.roleId);
    } else {
      queuedWithoutSpawn.push(role.roleId);
    }
  }

  return {
    attemptedRoleIds,
    spawnedRoleIds,
    queuedWithoutSpawn,
    ...(rerouteNote ? { rerouteNote } : {}),
  };
}

function liveSpawnedWorkers(missionId: string): {
  ids: string[];
  names: string[];
} {
  const ids: string[] = [];
  const names: string[] = [];
  for (const pane of listPaneSnapshots()) {
    if (pane.missionId !== missionId || pane.role !== 'worker') continue;
    if (pane.state === 'exited') continue;
    if (pane.agentName) {
      names.push(pane.agentName);
      ids.push(pane.agentName);
    }
    if (pane.title) ids.push(pane.title);
  }
  return { ids, names };
}

function queuedRolePrompt(
  role: PlannedFanoutRole,
  files: readonly string[],
  objective: string,
): string {
  return [
    `Você é ${role.roleName} (trabalhador).`,
    objective ? `Objetivo: ${objective}` : '',
    files.length > 0
      ? `Arquivos deste papel (só estes): ${files.join(', ')}.`
      : '',
    'Não pergunte cor, fonte ou preferência — decida e entregue arquivos.',
    'Ao terminar, entregue handoff com os arquivos tocados.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function noteNexusTaskFailure(input: {
  readonly missionId: string;
  readonly missionStatus: string;
  readonly args: Record<string, unknown>;
  readonly plannedRoles?: readonly PlannedFanoutRole[];
  readonly objective?: string;
}): ReturnType<typeof decideNexusTaskFailClosed> {
  const fromArgs =
    input.plannedRoles ?? plannedRolesFromNexusTaskArgs(input.args);
  const pending = pendingByMission.get(input.missionId);
  const planned = mergePlannedRoles(fromArgs, pending?.roles ?? []);
  const live = liveSpawnedWorkers(input.missionId);
  const decision = decideNexusTaskFailClosed({
    missionStatus: input.missionStatus,
    nexusTaskFailed: true,
    plannedRoles: planned,
    spawnedRoleIds: live.ids,
    spawnedRoleNames: live.names,
  });
  if (decision.action === 'retry-unspawned') {
    pendingByMission.set(input.missionId, {
      missionId: input.missionId,
      roles: decision.unspawned,
      objective: input.objective,
      at: Date.now(),
    });
  }
  return decision;
}

export function noteFailedSpawnAttempt(input: {
  readonly missionId: string;
  readonly roleId?: string;
  readonly roleName: string;
  readonly category?: string;
  readonly files?: readonly string[];
  readonly objective?: string;
}): void {
  const role: PlannedFanoutRole = {
    roleId: input.roleId?.trim() || input.roleName,
    roleName: input.roleName,
    ...(input.category ? { category: input.category } : {}),
    files: input.files ?? [],
  };
  const existing = pendingByMission.get(input.missionId);
  const roles = existing
    ? [...existing.roles.filter((item) => item.roleId !== role.roleId), role]
    : [role];
  pendingByMission.set(input.missionId, {
    missionId: input.missionId,
    roles,
    objective: input.objective ?? existing?.objective,
    at: Date.now(),
  });
}

function emitTaskFailToast(
  scope: ProjectExecutionScope,
  missionId: string,
  toast: string,
): void {
  try {
    emitWorkerSpawnFailed({
      missionId,
      deadAdapterId: 'nexus_task',
      message: toast,
      title: 'Plano da equipe falhou',
      at: Date.now(),
      scope,
    });
  } catch {
    // toast best-effort
  }
}

async function spawnQueuedRoleOnPane(
  scope: ProjectExecutionScope,
  mission: Mission,
  request: QueuedRoleSpawnRequest,
): Promise<QueuedRoleSpawnResult> {
  const spawn = await requestPaneSpawn({
    adapterId: request.adapterId,
    model: request.model,
    effort: request.effort,
    cwd: scope.rootRealPath,
    title: request.roleName,
    missionId: mission.id,
    agentName: request.roleName,
    role: 'worker',
    scope,
    executionScope: scope,
    executionMode: 'same_checkout',
    initialPrompt: request.prompt,
  });
  if (!spawn.ok || !spawn.paneId) {
    return { ok: false, error: spawn.error ?? 'spawn falhou sem detalhe' };
  }
  if (request.files.length > 0) {
    registerSameCheckoutClaim(spawn.paneId, request.files);
  }
  const stores = getProjectDomainStores(scope);
  stores.missionPanes.record({
    missionId: mission.id,
    paneId: spawn.paneId,
    adapterId: request.adapterId,
    model: request.model,
    effort: request.effort,
    cwd: scope.rootRealPath,
    title: request.roleName,
    agentName: request.roleName,
    role: 'worker',
    readOnly: false,
    executionScope: scope,
  });
  return { ok: true, paneId: spawn.paneId };
}

export async function flushNexusTaskFailClosedRetry(
  scope: ProjectExecutionScope,
  missionId: string,
): Promise<AttemptQueuedRoleSpawnsResult | null> {
  const pending = pendingByMission.get(missionId);
  if (!pending || pending.roles.length === 0) return null;
  if (inFlight.has(missionId)) return null;
  inFlight.add(missionId);
  pendingByMission.delete(missionId);
  try {
    const stores = getProjectDomainStores(scope);
    const mission = stores.missions.get(missionId);
    if (!mission || (mission.status !== 'running' && mission.status !== 'pending')) {
      return null;
    }
    // "Pedir um ajuste": a missão reabriu para o operador DESCREVER o ajuste.
    // Descarregar retries enfileirados aqui seria o runtime spawnando sozinho
    // (worker duplicado refazendo trabalho já entregue) antes de saber o quê.
    if (missionAwaitsAdjustment(mission)) return null;
    const squad = mission.squadId ? getSquad(mission.squadId) : null;
    if (!squad) return null;
    const live = liveSpawnedWorkers(missionId);
    const stillQueued = pending.roles.filter((role) => {
      const id = role.roleId.toLowerCase();
      const name = role.roleName.toLowerCase();
      return (
        !live.ids.some((item) => item.toLowerCase() === id) &&
        !live.names.some((item) => item.toLowerCase() === name)
      );
    });
    if (stillQueued.length === 0) return { attemptedRoleIds: [], spawnedRoleIds: [], queuedWithoutSpawn: [] };

    const objective = pending.objective ?? mission.description ?? mission.title ?? '';
    const result = await attemptQueuedRoleSpawns({
      roles: stillQueued,
      roster: rosterAgentsOf(squad.agents),
      objective,
      promptFor: (role, agent) => {
        const files = inferRoleOwnershipFiles({
          roleName: role.roleName,
          category: role.category ?? agent.category,
          objective,
          explicitFiles: role.files,
        });
        return queuedRolePrompt(role, files, objective);
      },
      spawn: (request) => spawnQueuedRoleOnPane(scope, mission, request),
    });
    if (result.queuedWithoutSpawn.length > 0) {
      pendingByMission.set(missionId, {
        missionId,
        roles: stillQueued.filter((role) =>
          result.queuedWithoutSpawn.includes(role.roleId),
        ),
        objective: pending.objective,
        at: Date.now(),
      });
    }
    return result;
  } finally {
    inFlight.delete(missionId);
  }
}

export function reactToNexusTaskFailure(input: {
  readonly scope: ProjectExecutionScope;
  readonly missionId?: string;
  readonly args: Record<string, unknown>;
  readonly error: unknown;
}): void {
  const missionId = input.missionId;
  if (!missionId) return;
  try {
    const stores = getProjectDomainStores(input.scope);
    const mission = stores.missions.get(missionId);
    if (!mission) return;
    const decision = noteNexusTaskFailure({
      missionId,
      missionStatus: mission.status,
      args: input.args,
      objective: mission.description ?? mission.title,
    });
    if (decision.action !== 'retry-unspawned') return;
    emitTaskFailToast(input.scope, missionId, decision.toast);
    void flushNexusTaskFailClosedRetry(input.scope, missionId).catch((error) => {
      console.warn(
        '[nexus-task-fail-closed] retry de fan-out falhou:',
        error instanceof Error ? error.message : error,
      );
    });
  } catch (error) {
    console.warn(
      '[nexus-task-fail-closed] reação à falha de nexus_task falhou:',
      error instanceof Error ? error.message : error,
    );
  }
}

export function flushAllNexusTaskFailClosedRetries(
  scope: ProjectExecutionScope,
  missionId: string,
): void {
  if (!pendingByMission.has(missionId)) return;
  void flushNexusTaskFailClosedRetry(scope, missionId).catch((error) => {
    console.warn(
      '[nexus-task-fail-closed] flush do supervisor falhou:',
      error instanceof Error ? error.message : error,
    );
  });
}
