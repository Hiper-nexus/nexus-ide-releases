import type { Handoff, Mission } from '../../shared/orch-types';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';
import { requireProjectDomainStoreRegistry } from './project-domain-store-registry';
import { onHandoffSubmitted } from './idle-delivery';
import { getSquad } from './squad-store';

/**
 * The worker stall watchdog cannot see the more fundamental failure where an
 * orchestrator never creates a task or worker at all. This supervisor closes
 * that gap. It does not bypass PREVC or spawn a privileged worker itself: it
 * records a durable incident and submits one bounded recovery instruction to
 * the exact orchestrator session. A second incident is the only retry.
 */
export const DELEGATION_SLA_MS = 90_000;
export const DELEGATION_RETRY_MS = 90_000;
export const DELEGATION_SCAN_MS = 15_000;
export const DELEGATION_SUPERVISOR_AGENT = 'nexus-delegation-supervisor';

export interface DelegationProgress {
  readonly mission: Mission;
  readonly expectedWorkers: number;
  readonly workerPanes: number;
  readonly tasks: number;
  readonly recoveries: readonly Handoff[];
}

export function delegationRecoveryStage(
  progress: DelegationProgress,
  now: number,
): 0 | 1 | 2 {
  if (progress.expectedWorkers === 0) return 0;
  if (!['pending', 'running'].includes(progress.mission.status)) return 0;
  if (progress.workerPanes > 0 || progress.tasks > 0) return 0;
  if (progress.recoveries.length >= 2) return 0;

  const lastRecovery = progress.recoveries.at(-1);
  const since = lastRecovery?.createdAt ?? progress.mission.createdAt;
  const threshold = lastRecovery ? DELEGATION_RETRY_MS : DELEGATION_SLA_MS;
  if (now - since < threshold) return 0;
  return lastRecovery ? 2 : 1;
}

function recoverySummary(missionId: string, stage: 1 | 2): string {
  if (stage === 1) {
    return (
      `incidente de orquestração: a missão ${missionId} excedeu o prazo sem ` +
      'registrar tarefas nem colocar especialistas para trabalhar. Retome agora ' +
      'sem pedir ação ao usuário: rode nexus_context_doctor; se houver drafts ' +
      'propostos, use nexus_context_draft_list e prossiga com review/commit; ' +
      'congele o contrato, registre as tarefas e delegue as independentes em ' +
      'paralelo. Não contorne PREVC e não execute o trabalho no orquestrador.'
    );
  }
  return (
    `recuperação final de orquestração: a missão ${missionId} continua sem ` +
    'tarefas ou especialistas após a primeira recuperação. Leia o resultado ' +
    'estruturado do último tool call, tente somente o próximo passo determinístico ' +
    'uma vez e, se ainda falhar, preserve a missão e marque-a blocked com o erro ' +
    'exato. Não peça ao usuário para liberar shell nem repita o ciclo.'
  );
}

function scanSuite(suite: ProjectDomainStoreSuite, now: number): void {
  for (const mission of suite.missions.list()) {
    const squad = mission.squadId ? getSquad(mission.squadId) : null;
    const expectedWorkers = squad?.agents.filter(
      (agent) => agent.category !== 'orchestrator',
    ).length ?? 0;
    const panes = suite.missionPanes.list(mission.id);
    const recoveries = suite.handoffs
      .list({ missionId: mission.id, includeDelivered: true })
      .filter((handoff) => handoff.fromAgent === DELEGATION_SUPERVISOR_AGENT)
      .sort((left, right) => left.createdAt - right.createdAt);
    const stage = delegationRecoveryStage({
      mission,
      expectedWorkers,
      workerPanes: panes.filter((pane) => pane.role === 'worker').length,
      tasks: suite.tasks.list(mission.id).length,
      recoveries,
    }, now);
    if (stage === 0) continue;

    if (mission.status === 'pending') suite.missions.setStatus(mission.id, 'running');
    const handoff = suite.handoffs.submit({
      missionId: mission.id,
      status: 'stalled',
      summary: recoverySummary(mission.id, stage),
      fromAgent: DELEGATION_SUPERVISOR_AGENT,
    });
    onHandoffSubmitted(handoff, suite.scope);
    console.warn(
      `[delegation-supervisor] recovery ${stage}/2 submitted for ${mission.id}`,
    );
  }
}

const suites = new Map<string, ProjectDomainStoreSuite>();
let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribeScopes: (() => void) | null = null;

function scopeKey(suite: ProjectDomainStoreSuite): string {
  return [
    suite.scope.installationId,
    suite.scope.projectId,
    suite.scope.checkoutId,
    suite.scope.rootRealPath,
  ].join('\0');
}

export function initDelegationSupervisor(): void {
  if (timer) return;
  unsubscribeScopes = requireProjectDomainStoreRegistry().onScope((_scope, suite) => {
    suites.set(scopeKey(suite), suite);
  });
  timer = setInterval(() => {
    for (const suite of suites.values()) {
      try {
        scanSuite(suite, Date.now());
      } catch (error) {
        console.warn('[delegation-supervisor] scan failed:', error);
      }
    }
  }, DELEGATION_SCAN_MS);
  timer.unref?.();
}

export function shutdownDelegationSupervisor(): void {
  if (timer) clearInterval(timer);
  timer = null;
  unsubscribeScopes?.();
  unsubscribeScopes = null;
  suites.clear();
}
