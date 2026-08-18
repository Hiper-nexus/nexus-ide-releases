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
import { onHandoffSubmitted, redeliverPendingHandoffs } from './idle-delivery';
import { getSquad } from './squad-store';
import { listPaneSnapshots } from './pane-registry';
import { emitMissionIntentEvent } from './mission-intent-events';
import {
  emitChefIdleAwaitingWorkers,
  emitMissionEvent,
} from './mission-event-emit';
import { missionEngineForScope } from './mission-engine-registry';

/** Estado do watchdog chef-idle por missão (mesma vida do supervisor). */
interface ChefIdleTracker {
  sinceMs: number;
  workerCount: number;
}
const chefIdleTrackers = new Map<string, ChefIdleTracker>();

function trackChefIdleEscalation(
  suite: ProjectDomainStoreSuite,
  mission: Mission,
  workerPaneCount: number,
  now: number,
): void {
  const tracked = chefIdleTrackers.get(mission.id) ?? null;
  const decision = decideChefIdleEscalation({
    idle: true,
    workerCount: workerPaneCount,
    missionStatus: mission.status,
    trackedSince: tracked?.sinceMs ?? null,
    trackedWorkerCount: tracked?.workerCount ?? 0,
    now,
  });
  if (decision.action === 'watch') {
    if (!tracked) {
      chefIdleTrackers.set(mission.id, {
        sinceMs: now,
        workerCount: workerPaneCount,
      });
    }
    return;
  }
  if (decision.action === 'reset') {
    chefIdleTrackers.delete(mission.id);
    return;
  }
  // block: motivo acionável + estado visível no rail ("Precisa de reparo").
  // Sem intentState conhecido não há CAS válido — zera e deixa o próximo
  // episódio recomeçar em vez de jogar exceção no scan.
  if (!mission.intentState) {
    chefIdleTrackers.delete(mission.id);
    return;
  }
  const minutes = Math.round((now - decision.sinceMs) / 60_000);
  try {
    missionEngineForScope(suite.scope).blockTechnical(suite.scope, {
      missionId: mission.id,
      expectedStatus: mission.status,
      expectedIntentState: mission.intentState,
      expectedUpdatedAt: mission.updatedAt,
      expectedIntentVersion: mission.intentVersion ?? 0,
      description:
        `Orquestrador ocioso aguardando ${workerPaneCount} worker(s) por ` +
        `${minutes}min sem progresso. Use Retomar no rail (respawna o ` +
        `orquestrador com nota de continuidade) ou pare a missão.`,
    });
  } catch (error) {
    console.warn(
      `[delegation-supervisor] chef-idle block falhou para ${mission.id}:`,
      error instanceof Error ? error.message : error,
    );
  }
  try {
    emitMissionEvent(suite.scope, {
      missionId: mission.id,
      runId: `chef-idle-${mission.id}`,
      type: 'custom',
      origin: 'main',
      idempotencyKey: `chef_idle_blocked:${mission.id}:${decision.sinceMs}`,
      payload: {
        kind: 'chef_idle_escalated_blocked',
        workerCount: workerPaneCount,
        idleMinutes: minutes,
      },
    });
  } catch {
    // Journal é best-effort; o blocked_technical já é o sinal visível.
  }
  chefIdleTrackers.delete(mission.id);
}

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

/**
 * Teto do chef-idle (2026-08-17): orquestrador idle com workers presentes e
 * NENHUMA mudança por meia hora é missão parada no tempo — o caso real ficou
 * 33h soltando chef_idle_awaiting_workers no journal sem ninguém escalar.
 * Bloquear com motivo visível entrega o Retomar ao operador; silêncio eterno
 * não é estado de missão.
 */
export const CHEF_IDLE_BLOCK_AFTER_MS = 30 * 60_000;

/**
 * Re-arm de entrega parada (18/08): handoff durable queued com ZERO tentativas
 * enquanto o journal dizia chef_idle todo minuto. Fila em memória é
 * otimização — perde na troca de workspace, authority nulo no submit, semantic
 * travado. SQLite é a verdade; re-submeter é idempotente (enqueue deduplica,
 * deliverNow só dispara sem entrega em voo). Janela de throttle por missão.
 */
export const HANDOFF_REARM_THROTTLE_MS = 60_000;

export function shouldRearmHandoffDelivery(input: {
  readonly workerPaneCount: number;
  readonly orchestratorPaneState: string | undefined;
  readonly missionStatus: string;
  readonly pendingDeliverableHandoffs: number;
  readonly lastRearmAt: number;
  readonly now: number;
}): boolean {
  if (input.pendingDeliverableHandoffs <= 0) return false;
  if (input.workerPaneCount <= 0) return false;
  if (input.orchestratorPaneState !== 'idle') return false;
  if (input.missionStatus !== 'pending' && input.missionStatus !== 'running') {
    return false;
  }
  return input.now - input.lastRearmAt >= HANDOFF_REARM_THROTTLE_MS;
}

const handoffRearmLastRun = new Map<string, number>();

function rearmStuckHandoffDelivery(
  suite: ProjectDomainStoreSuite,
  mission: Mission,
  workerPaneCount: number,
  orchestratorPaneState: string | undefined,
  now: number,
): void {
  let pendingDeliverable = 0;
  try {
    pendingDeliverable = suite.handoffs
      .list({ missionId: mission.id, includeDelivered: false })
      .filter((handoff) => handoff.status === 'success' || handoff.status === 'blocked')
      .length;
  } catch {
    return; // sem leitura confiável não decide
  }
  if (
    !shouldRearmHandoffDelivery({
      workerPaneCount,
      orchestratorPaneState,
      missionStatus: mission.status,
      pendingDeliverableHandoffs: pendingDeliverable,
      lastRearmAt: handoffRearmLastRun.get(mission.id) ?? 0,
      now,
    })
  ) {
    return;
  }
  handoffRearmLastRun.set(mission.id, now);
  try {
    const rearmed = redeliverPendingHandoffs(suite.scope, mission.id);
    if (rearmed > 0) {
      console.warn(
        `[delegation-supervisor] re-arm de ${rearmed} handoff(s) pendente(s) ` +
        `para o Maestro idle (mission=${mission.id}) — a fila em memória tinha ` +
        'se perdido e o SQLite é a verdade',
      );
    }
  } catch (error) {
    console.warn(
      '[delegation-supervisor] re-arm de handoff falhou (segue na próxima janela):',
      error instanceof Error ? error.message : error,
    );
  }
}

export type ChefIdleEscalationDecision =
  | { readonly action: 'watch' }
  | { readonly action: 'reset' }
  | { readonly action: 'block'; readonly sinceMs: number };

/**
 * Decisão pura do watchdog chef-idle.
 * - reset: sai do estado idle (ou missão deixou de ser running) — rastreador
 *   zera; contagem de workers MUDOU também reseta (episódio novo, relógio
 *   novo arma no próximo scan).
 * - watch: dentro do teto — mantém/rearma o rastreador (caller grava now
 *   quando ainda não havia).
 * - block: cruzou o teto sem mudança — caller bloqueia blocked_technical
 *   com motivo acionável e zera o rastreador.
 */
export function decideChefIdleEscalation(input: {
  readonly idle: boolean;
  readonly workerCount: number;
  readonly missionStatus: Mission['status'];
  readonly trackedSince: number | null;
  readonly trackedWorkerCount: number;
  readonly now: number;
  readonly thresholdMs?: number;
}): ChefIdleEscalationDecision {
  if (
    !input.idle ||
    input.workerCount <= 0 ||
    input.missionStatus !== 'running'
  ) {
    return { action: 'reset' };
  }
  if (input.trackedSince === null) return { action: 'watch' };
  if (input.trackedWorkerCount !== input.workerCount) {
    return { action: 'reset' };
  }
  const thresholdMs = input.thresholdMs ?? CHEF_IDLE_BLOCK_AFTER_MS;
  if (input.now - input.trackedSince >= thresholdMs) {
    return { action: 'block', sinceMs: input.trackedSince };
  }
  return { action: 'watch' };
}

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
  // Consult / plan lanes are not multi-worker PREVC delivery — no worker
  // recovery SLA. (Squad roster size can still be > 0; lane wins.)
  if (progress.mission.intentContract?.lane === 'consult') return false;
  if (progress.mission.intentContract?.lane === 'plan') return false;
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
    // Keep short: long PREVC dumps make the orchestrator treat recovery as
    // injection and refuse. Role = plan + spawn workers only, never implement.
    return (
      `Recuperação de orquestração (sistema Nexus) [${key}]: missão ${missionId} ` +
      'despachada sem tasks/workers no prazo. Seu papel é SÓ orquestrar: registre ' +
      'as tarefas do objetivo já aprovado e despache specialists. Não implemente ' +
      'código no orquestrador. Não invente objetivo novo.'
    );
  }
  // Stage 2 is audit-only (no PTY inject) — summary stays durable for UI/board.
  return (
    `Missão ${missionId} continua em recuperação automática: ainda sem ` +
    `tasks/workers após uma tentativa, mas a execução permanece ativa para ` +
    `o Mission Driver retomar ou rerotear. [${key}]`
  );
}

function scanSuite(suite: ProjectDomainStoreSuite, now: number): void {
  const liveStates = new Set<PaneRuntimeState>([
    'spawning', 'busy', 'idle', 'unknown',
  ]);
  for (const mission of suite.missions.list()) {
    const squad = mission.squadId ? getSquad(mission.squadId) : null;
    const lane = mission.intentContract?.lane;
    const rosterWorkers =
      squad?.agents.filter((agent) => agent.category !== 'orchestrator')
        .length ?? 0;
    // Plan/consult never expect workers; other lanes respect budget cap.
    const budgetCap = mission.intentContract?.budgets?.maxWorkers;
    const expectedWorkers =
      lane === 'consult' || lane === 'plan'
        ? 0
        : budgetCap !== undefined
          ? Math.min(rosterWorkers, Math.max(0, budgetCap))
          : rosterWorkers;
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
    const workerPaneCount = panes.filter((pane) => pane.role === 'worker').length;
    const orchestratorPaneState = panes.find(
      (pane) => pane.role === 'orchestrator',
    )?.state;

    // Chef-idle: orchestrator is idle while workers are present. This state is
    // indistinguishable from a stall without an explicit marker — emit one so
    // the presenter and telemetry can surface it instead of showing silence.
    if (
      workerPaneCount > 0 &&
      orchestratorPaneState === 'idle' &&
      (mission.status === 'pending' || mission.status === 'running')
    ) {
      emitChefIdleAwaitingWorkers(suite.scope, mission.id, workerPaneCount);
      trackChefIdleEscalation(suite, mission, workerPaneCount, now);
      rearmStuckHandoffDelivery(suite, mission, workerPaneCount, orchestratorPaneState, now);
    } else {
      chefIdleTrackers.delete(mission.id);
    }

    const stage = delegationRecoveryStage({
      mission,
      expectedWorkers,
      workerPanes: workerPaneCount,
      tasks: suite.tasks.list(mission.id).length,
      recoveries,
      orchestratorState: orchestratorPaneState,
      hasBoundOrchestrator,
    }, now);
    if (stage === 0) continue;

    // Idempotent: skip if this stage key already submitted.
    const stageKey = recoveryHandoffIdempotencyKey(mission.id, stage);
    if (recoveries.some((h) => h.summary.includes(stageKey))) continue;

    if (mission.status === 'pending') suite.missions.setStatus(mission.id, 'running');

    // Stage 2: stop nagging the orchestrator PTY and leave an audit handoff
    // without idle-delivery injection. The mission deliberately remains
    // running: Mission Driver/failover owns context restart and reroute, while
    // `blocked` is reserved for operator/auth/destructive decisions.
    if (stage === 2) {
      // Audit-only handoff: mark submitted immediately so redeliverPendingHandoffs
      // after restart cannot re-inject a stage-2 recovery into the PTY.
      const stage2Handoff = suite.handoffs.submit({
        missionId: mission.id,
        status: 'stalled',
        summary: recoverySummary(mission.id, 2),
        fromAgent: DELEGATION_SUPERVISOR_AGENT,
      });
      suite.handoffs.markSubmitted(stage2Handoff.id);
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
        reason: 'delegation_supervisor_stage_2_recovery_active',
        meta: { stage: 2, deliveredToPty: false, deliveryState: 'submitted' },
      });
      // Acorda a Via Rápida: o orquestrador morreu, spawna um novo.
      // Antes ficava parado esperando "Mission Driver recovery" que nunca vinha.
      void import('./mission-fast-lane').then(({ resumeFastLaneMission }) =>
        resumeFastLaneMission(suite.scope, mission.id).catch((err) =>
          console.warn('[delegation-supervisor] resume falhou:', err),
        ),
      );
      console.warn(
        `[delegation-supervisor] stage 2 — mission ${mission.id} restart via fast-lane`,
      );
      continue;
    }

    const handoff = suite.handoffs.submit({
      missionId: mission.id,
      status: 'progress',
      summary: recoverySummary(mission.id, 1),
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
      reason: 'delegation_supervisor_stage_1',
      meta: { stage: 1, deliveredToPty: true },
    });
    console.warn(
      `[delegation-supervisor] recovery 1/2 submitted for ${mission.id}`,
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
  prepareDelegationSupervisor();
  timer = setInterval(() => reconcileDelegationSupervisor(), DELEGATION_SCAN_MS);
  timer.unref?.();
}

/** Install store discovery without creating a supervisor timer. */
export function prepareDelegationSupervisor(): void {
  if (unsubscribeScopes) return;
  unsubscribeScopes = requireProjectDomainStoreRegistry().onScope((_scope, suite) => {
    suites.set(scopeKey(suite), suite);
  });
}

/** One main-coordinator scan, error-isolated per project scope. */
export function reconcileDelegationSupervisor(now: number = Date.now()): void {
  for (const suite of suites.values()) {
    try {
      scanSuite(suite, now);
    } catch (error) {
      console.warn('[delegation-supervisor] scan failed:', error);
    }
  }
}

export function shutdownDelegationSupervisor(): void {
  if (timer) clearInterval(timer);
  timer = null;
  unsubscribeScopes?.();
  unsubscribeScopes = null;
  suites.clear();
}
