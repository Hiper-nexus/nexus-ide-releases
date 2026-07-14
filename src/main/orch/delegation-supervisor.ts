import type { Handoff, Mission, PaneRuntimeState } from '../../shared/orch-types';
import {
  hasCurrentApprovedDispatchContract,
  isRecoveryEligibleIntentState,
  recoveryHandoffIdempotencyKey,
  resolveDispatchAuthorizedAt,
  resolveEffectiveIntentState,
} from '../../shared/mission-intent';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';
import { requireProjectDomainStoreRegistry } from './project-domain-store-registry';
import { onHandoffSubmitted } from './idle-delivery';
import { getSquad } from './squad-store';
import { listPaneSnapshots } from './pane-registry';
import { emitMissionIntentEvent } from './mission-intent-events';

/**
 * The worker stall watchdog cannot see the more fundamental failure where an
 * orchestrator never creates a task or worker at all. This supervisor closes
 * that gap. It does not bypass PREVC or spawn a privileged worker itself: it
 * records a durable incident and submits one bounded recovery instruction to
 * the exact orchestrator session. A second incident is the only retry.
 *
 * Intent-first: human-wait states (awaiting_goal, awaiting_approval, …) are
 * never stalls. Recovery only runs after work is actually dispatched.
 * SLA clocks use approvedAt/dispatchedAt — never arm/createdAt.
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
  readonly orchestratorState?: PaneRuntimeState;
  /** True when an orchestrator session is bound to the mission. */
  readonly hasBoundOrchestrator?: boolean;
}

/**
 * Only missions with real dispatch authorization enter recovery. Empty squad
 * selection (no goal, no tasks, no workers) is a normal wait, not an incident.
 * Requires a bound orchestrator — recovery cannot invent a pane.
 */
export function isDelegationSupervisable(progress: DelegationProgress): boolean {
  if (progress.expectedWorkers === 0) return false;
  if (!['pending', 'running'].includes(progress.mission.status)) return false;
  if (progress.hasBoundOrchestrator === false) return false;
  const intentState = resolveEffectiveIntentState({
    mission: progress.mission,
    taskCount: progress.tasks,
    workerPaneCount: progress.workerPanes,
  });
  if (!isRecoveryEligibleIntentState(intentState)) return false;
  // Prefer approved contract; recovery-eligible state alone is not enough
  // without authorization metadata when a contract exists.
  if (
    progress.mission.intentContract &&
    !hasCurrentApprovedDispatchContract(progress.mission) &&
    progress.mission.intentState !== 'legacy'
  ) {
    return false;
  }
  return true;
}

/**
 * SLA anchor: last recovery time, else dispatch authorization time.
 * Never mission.createdAt (arm time) — that caused instant stage-1 after start.
 */
export function resolveDelegationSlaAnchor(
  progress: DelegationProgress,
  lastRecoveryCreatedAt: number | undefined,
): number | null {
  if (lastRecoveryCreatedAt !== undefined) return lastRecoveryCreatedAt;
  return resolveDispatchAuthorizedAt(progress.mission);
}

export function delegationRecoveryStage(
  progress: DelegationProgress,
  now: number,
): 0 | 1 | 2 {
  if (!isDelegationSupervisable(progress)) return 0;
  if (
    progress.orchestratorState === 'busy' ||
    progress.orchestratorState === 'spawning'
  ) return 0;
  // After dispatch authorization, zero tasks/workers for SLA is the signal.
  // Pre-dispatch emptiness is already filtered by isDelegationSupervisable.
  if (progress.workerPanes > 0 || progress.tasks > 0) return 0;
  if (progress.recoveries.some((item) => item.deliveryState === 'queued')) return 0;
  const deliveredRecoveries = progress.recoveries.filter(
    (item) => item.deliveryState !== 'queued',
  );
  if (deliveredRecoveries.length >= 2) return 0;

  // Idempotency: if stage key already present in summaries, do not re-fire.
  const stage1Key = recoveryHandoffIdempotencyKey(progress.mission.id, 1);
  const stage2Key = recoveryHandoffIdempotencyKey(progress.mission.id, 2);
  const hasStage1 = deliveredRecoveries.some((h) =>
    h.summary.includes(stage1Key),
  );
  const hasStage2 = deliveredRecoveries.some((h) =>
    h.summary.includes(stage2Key),
  );
  if (hasStage2) return 0;

  const lastRecovery = deliveredRecoveries.at(-1);
  const since = resolveDelegationSlaAnchor(progress, lastRecovery?.createdAt);
  if (since === null) return 0; // no dispatch anchor yet
  const threshold = lastRecovery || hasStage1 ? DELEGATION_RETRY_MS : DELEGATION_SLA_MS;
  if (now - since < threshold) return 0;
  if (hasStage1 || lastRecovery) return 2;
  return 1;
}

function recoverySummary(missionId: string, stage: 1 | 2): string {
  const key = recoveryHandoffIdempotencyKey(missionId, stage);
  if (stage === 1) {
    return (
      `incidente de orquestração: a missão ${missionId} já foi despachada e ` +
      'excedeu o prazo sem registrar tarefas nem colocar especialistas para ' +
      'trabalhar. Retome o plano já aprovado: registre as tarefas pendentes e ' +
      'delegue as independentes. Só use nexus_context_doctor se o contrato ' +
      'permitir e o mapa estiver frio. Não invente objetivo novo, não contorne ' +
      `PREVC e não execute o trabalho no orquestrador. [${key}]`
    );
  }
  return (
    `recuperação final de orquestração: a missão ${missionId} continua sem ` +
    'tarefas ou especialistas após a primeira recuperação. Leia o resultado ' +
    'estruturado do último tool call, tente somente o próximo passo determinístico ' +
    'uma vez e, se ainda falhar, preserve a missão e marque-a blocked com o erro ' +
    `exato. Não peça ao usuário para liberar shell nem repita o ciclo. [${key}]`
  );
}

function scanSuite(suite: ProjectDomainStoreSuite, now: number): void {
  const liveStates = new Set<PaneRuntimeState>([
    'spawning', 'busy', 'idle', 'unknown',
  ]);
  for (const mission of suite.missions.list()) {
    const squad = mission.squadId ? getSquad(mission.squadId) : null;
    const expectedWorkers = squad?.agents.filter(
      (agent) => agent.category !== 'orchestrator',
    ).length ?? 0;
    const panes = listPaneSnapshots().filter(
      (pane) => pane.missionId === mission.id && liveStates.has(pane.state),
    );
    const recoveries = suite.handoffs
      .list({ missionId: mission.id, includeDelivered: true })
      .filter((handoff) => handoff.fromAgent === DELEGATION_SUPERVISOR_AGENT)
      .sort((left, right) => left.createdAt - right.createdAt);
    const hasBoundOrchestrator = Boolean(
      mission.orchestratorSessionId ||
        panes.some((pane) => pane.role === 'orchestrator'),
    );
    const stage = delegationRecoveryStage({
      mission,
      expectedWorkers,
      workerPanes: panes.filter((pane) => pane.role === 'worker').length,
      tasks: suite.tasks.list(mission.id).length,
      recoveries,
      orchestratorState: panes.find((pane) => pane.role === 'orchestrator')?.state,
      hasBoundOrchestrator,
    }, now);
    if (stage === 0) continue;

    // Idempotent: skip if this stage key already submitted.
    const stageKey = recoveryHandoffIdempotencyKey(mission.id, stage);
    if (recoveries.some((h) => h.summary.includes(stageKey))) continue;

    if (mission.status === 'pending') suite.missions.setStatus(mission.id, 'running');
    const handoff = suite.handoffs.submit({
      missionId: mission.id,
      status: stage === 1 ? 'progress' : 'stalled',
      summary: recoverySummary(mission.id, stage),
      fromAgent: DELEGATION_SUPERVISOR_AGENT,
    });
    onHandoffSubmitted(handoff, suite.scope);
    emitMissionIntentEvent({
      name: 'automatic_recovery',
      missionId: mission.id,
      squadId: mission.squadId,
      intentState: resolveEffectiveIntentState({
        mission,
        taskCount: suite.tasks.list(mission.id).length,
        workerPaneCount: panes.filter((pane) => pane.role === 'worker').length,
      }),
      intentVersion: mission.intentVersion,
      reason: `delegation_supervisor_stage_${stage}`,
      meta: { stage },
    });
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
