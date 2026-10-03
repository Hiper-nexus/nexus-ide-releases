import { sameProjectScope } from './project-scoped-broadcast';
import { runPeriodicTask, stopPeriodicTask, type PeriodicTaskContext } from '../observability/periodic-task';
import type {
  Handoff,
  Mission,
  PaneRuntimeState,
  PaneSnapshot,
} from '../../shared/orch-types';
import { wasUpdatedBeforeThisProcess } from '../../shared/session-restore-liveness';
import { wasMissionApprovedByOperator } from '../../shared/mission-recovery-policy';
import {
  hasCurrentApprovedDispatchContract,
  isRecoveryEligibleIntentState,
  recoveryHandoffIdempotencyKey,
  resolveDispatchAuthorizedAt,
  resolveEffectiveIntentState,
} from '../../shared/mission-intent';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';
import {
  getProjectDomainStores,
  requireProjectDomainStoreRegistry,
} from './project-domain-store-registry';
import { onHandoffSubmitted, redeliverPendingHandoffs } from './idle-delivery';
import { getSquad } from './squad-store';
import {
  abandonPendingOrchSpawn,
  listPaneSnapshots,
  pendingSpawnAttemptSession,
  requestPaneClose,
  readSessionOutput,
  tapPendingSpawnStartFailure,
} from './pane-registry';
import {
  getAgentSessionInfo,
  getRequestedTerminationOrigin,
  getSessionSpawnedAtMs,
  getSessionState,
  tapSessionTermination,
} from '../pty/pty-manager';
import { adapterCircuitBreakers } from './circuit-breaker';
import { getPtyAnalysisLimitEvidence } from '../pty/pty-analysis-runtime';
import { WORKSPACE_HANDOFF_DELIVERY_PREFIX } from './workspace-handoff-delivery';
import {
  CREDENTIAL_REJECTED_OPEN_MS,
  decideStartAction,
  finishPaneStartWatch,
  listPaneStartWatches,
  notePaneSessionEnded,
  notePaneStartFailure,
  notePaneTurnEnded,
  notStartedCause,
  paneStartNoticeSummary,
  paneStartProgress,
  paneStartWatchForSession,
  setPaneStartKick,
  shortStartError,
  startFailureBreakerAction,
  MODEL_REJECTION_HANDOFF_MS,
  START_SETTLE_MS,
  START_WATCH_TTL_MS,
  type PaneStartOutcome,
  type PaneStartProgress,
  type PaneStartWatch,
  type ProviderRejectedCause,
} from './pane-start-watchdog';
import { emitMissionIntentEvent } from './mission-intent-events';
import {
  emitChefIdleAwaitingWorkers,
  emitMissionEvent,
} from './mission-event-emit';
import { missionEngineForScope } from './mission-engine-registry';
import {
  decideZeroDeliveryWatchdog,
  zeroDeliveryEscalateSummary,
  zeroDeliveryPokeSummary,
} from './zero-delivery-watchdog';
import { flushAllNexusTaskFailClosedRetries } from './nexus-task-fail-closed-recovery';
import { decideMomentumNudge, momentumNudgeSummary } from './mission-momentum-watchdog';
import {
  getAgentLastTurnEnd,
  getAgentSemanticStatusBySession,
  getAgentToolActivityCount,
  getAgentTurnStartSequence,
  SEMANTIC_WORKING_VETO_MS,
  tapAgentTurnEnd,
} from './agent-status';
import { trace } from '../observability/main-trace';
import { sanitizePaneBootOutput } from './pane-boot-output';
import {
  persistLeftoverIsolation,
  shouldSkipLeftoverRemount,
  isFreshIniciarKickoff,
} from '../../shared/mission-leftover-isolation';

/** Estado do watchdog chef-idle por missão (mesma vida do supervisor). */
interface ChefIdleTracker {
  sinceMs: number;
  workerCount: number;
}
const chefIdleTrackers = new Map<string, ChefIdleTracker>();

/** Esteira (F-714): desde quando a missão está sem worker e o último lembrete. */
const momentumSoloSince = new Map<string, number>();
const momentumNudgedAt = new Map<string, number>();

/**
 * F-242: worker `working` sem ferramenta/saída por 20 min com o PTY parado =
 * travado no meio do turno (API/CLI pendurada). O supervisor avisa o Maestro
 * via handoff `stalled` [travado]; o relógio renotifica a cada 60 min enquanto
 * o pane seguir travado. Não bloqueia a missão — o Maestro acordado destrava
 * ou fecha o pane, e o chef-idle reseta sozinho quando o estado muda.
 */
export const WORKER_HUNG_AFTER_MS = 20 * 60_000;
export const WORKER_HUNG_RENOTIFY_MS = 60 * 60_000;

/**
 * Último aviso por sessão de worker, POR suite (mesma vida do supervisor).
 * F-725: o supervisor varre várias suites (um projeto aberto cada) e a limpeza
 * de uma usa só as sessões vivas DELA — num mapa global, varrer o projeto B
 * apagava o aviso do worker travado do projeto A, que voltava a ser "novo" e
 * era avisado a cada 15 s.
 */
const hungWorkerNotifiedAt = new Map<string, Map<string, number>>();

function hungWorkerNotifiedAtFor(
  suite: ProjectDomainStoreSuite,
): Map<string, number> {
  const key = scopeKey(suite);
  let notified = hungWorkerNotifiedAt.get(key);
  if (!notified) {
    notified = new Map();
    hungWorkerNotifiedAt.set(key, notified);
  }
  return notified;
}

export function decideWorkerHung(input: {
  readonly semanticStatus: string | undefined;
  readonly semanticUpdatedAt: number | undefined;
  readonly paneState: PaneRuntimeState | undefined;
  readonly notifiedAt: number | null;
  readonly now: number;
}): 'none' | 'notify' | 'renotify' {
  if (input.semanticStatus !== 'working') return 'none';
  if (input.semanticUpdatedAt === undefined) return 'none';
  // PTY ocupado/spawnando pode estar produzindo saída que o status não viu
  // ainda; morto/estacionado já é coberto por outros watchdogs.
  if (
    input.paneState === 'busy' ||
    input.paneState === 'spawning' ||
    input.paneState === 'exited' ||
    input.paneState === 'parked' ||
    input.paneState === 'hibernated'
  ) {
    return 'none';
  }
  if (input.now - input.semanticUpdatedAt < WORKER_HUNG_AFTER_MS) {
    return 'none';
  }
  if (input.notifiedAt === null) return 'notify';
  return input.now - input.notifiedAt >= WORKER_HUNG_RENOTIFY_MS
    ? 'renotify'
    : 'none';
}

/** Zero-entrega: Maestro dormiu esperando handoff com disco vazio. */
const zeroDeliveryPoked = new Set<string>();
const zeroDeliveryEscalated = new Set<string>();
const leftoverSkipLogged = new Set<string>();

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
      // F-244: o marcador nomeia a causa no Quadro (mission-block-cause);
      // builds antigas gravaram só o texto sem marcador.
      description:
        `[NEXUS_CHEF_IDLE] Orquestrador ocioso aguardando ` +
        `${workerPaneCount} worker(s) por ` +
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
export const DELEGATION_SLA_MS = 5 * 60_000;
/** Recovery handoff stuck in queued longer than this no longer blocks stages. */
export const RECOVERY_QUEUED_TTL_MS = 15 * 60_000;
export const DELEGATION_RETRY_MS = 30_000;
export const DELEGATION_SCAN_MS = 15_000;
export const DELEGATION_SUPERVISOR_AGENT = 'nexus-delegation-supervisor';

/**
 * Teto do chef-idle (2026-08-17): orquestrador idle com workers presentes e
 * NENHUMA mudança por meia hora é missão parada no tempo — o caso real ficou
 * 33h soltando chef_idle_awaiting_workers no journal sem ninguém escalar.
 * Bloquear com motivo visível entrega o Retomar ao operador; silêncio eterno
 * não é estado de missão.
 */
export const CHEF_IDLE_BLOCK_AFTER_MS = 60 * 60_000;

/**
 * Re-arm de entrega parada (18/08): handoff durable queued com ZERO tentativas
 * enquanto o journal dizia chef_idle todo minuto. Fila em memória é
 * otimização — perde na troca de workspace, authority nulo no submit, semantic
 * travado. SQLite é a verdade; re-submeter é idempotente (enqueue deduplica,
 * deliverNow só dispara sem entrega em voo). Janela de throttle por missão.
 */
export const HANDOFF_REARM_THROTTLE_MS = 60_000;

export function shouldRearmHandoffDelivery(input: {
  readonly orchestratorPaneState: string | undefined;
  readonly missionStatus: string;
  readonly missionAwaitingOperatorReview: boolean;
  readonly pendingDeliverableHandoffs: number;
  readonly lastRearmAt: number;
  readonly now: number;
  readonly orchestratorStaleBusy?: boolean;
}): boolean {
  if (input.pendingDeliverableHandoffs <= 0) return false;
  // Workers vivos NÃO são requisito: o TTL pós-handoff fecha o pane do
  // worker (~30s) e o caso clássico de fila perdida é Maestro idle +
  // handoff durable queued com ZERO workers. Exigir workerPaneCount>0
  // (8c3580c1) deixava o re-arm morto exatamente depois da entrega limpa.
  // F-113: tolerante a stale-busy (semantic status idle/completed ou timeout do working)
  const isOrchIdleOrStale =
    input.orchestratorPaneState === 'idle' ||
    (input.orchestratorPaneState === 'busy' && Boolean(input.orchestratorStaleBusy));
  if (!isOrchIdleOrStale) return false;
  // F-112: o fast lane marca done no MESMO segundo do handoff; se a entrega
  // ao Maestro falhar depois disso, o gate de pending/running matava o
  // re-arm para sempre. `done` aguardando revisão do operador re-arma;
  // aprovada pelo operador, não.
  const statusEligible =
    input.missionStatus === 'pending' ||
    input.missionStatus === 'running' ||
    (input.missionStatus === 'done' && input.missionAwaitingOperatorReview);
  if (!statusEligible) return false;
  return input.now - input.lastRearmAt >= HANDOFF_REARM_THROTTLE_MS;
}

const handoffRearmLastRun = new Map<string, number>();

function rearmStuckHandoffDelivery(
  suite: ProjectDomainStoreSuite,
  mission: Mission,
  orchestratorPaneState: string | undefined,
  now: number,
  orchestratorStaleBusy = false,
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
      orchestratorPaneState,
      missionStatus: mission.status,
      missionAwaitingOperatorReview: !wasMissionApprovedByOperator(mission),
      pendingDeliverableHandoffs: pendingDeliverable,
      lastRearmAt: handoffRearmLastRun.get(mission.id) ?? 0,
      now,
      orchestratorStaleBusy,
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
        `para o Maestro idle (mission=${mission.id}${orchestratorStaleBusy ? ', stale-busy' : ''}) — a fila em memória tinha ` +
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

/**
 * F-680: atividade real na missão que o relógio do chef-idle não pode
 * ignorar. O `state` do pane vem da saída do terminal — um comando longo e
 * silencioso (o Maestro esperando um ensaio no WSL, 29/09 00:15) deixa o pane
 * `idle` com o turno aberto; e worker trabalhando sem handoff (um Claude
 * produzindo até 1,5 min antes, 29/09 10:21) é progresso, não missão parada.
 * Nos dois casos o bloqueio derrubava todos os agentes da missão.
 */
export interface ChefIdleAgentActivity {
  /** Maestro com turno aberto (status semântico `working` recente). */
  readonly orchestratorInTurn: boolean;
  /** Algum worker da missão ocupado ou com turno aberto recente. */
  readonly workerActive: boolean;
}

export function chefIdleAgentActivity(input: {
  readonly orchestratorSessionId?: string | null;
  readonly workers: ReadonlyArray<{
    readonly sessionId?: string | null;
    readonly state: PaneRuntimeState;
  }>;
  readonly now: number;
  readonly semanticStatus: (
    sessionId: string,
  ) => { readonly status: string; readonly updatedAt: number } | null;
  readonly windowMs?: number;
}): ChefIdleAgentActivity {
  const windowMs = input.windowMs ?? CHEF_IDLE_BLOCK_AFTER_MS;
  const inTurn = (sessionId: string | null | undefined): boolean => {
    if (!sessionId) return false;
    const entry = input.semanticStatus(sessionId);
    return entry?.status === 'working' && input.now - entry.updatedAt < windowMs;
  };
  return {
    orchestratorInTurn: inTurn(input.orchestratorSessionId),
    workerActive: input.workers.some(
      (worker) => worker.state === 'busy' || inTurn(worker.sessionId),
    ),
  };
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
 * Leftover running rows from a previous process must not enter recovery
 * (stage-1 poke or stage-2 fast-lane remount). Snapshot already projects
 * them as Parou. A Maestro that is actually busy/spawning in THIS process
 * is not leftover.
 */
export function shouldSkipLeftoverDelegationRecovery(input: {
  readonly updatedAt: number;
  readonly processStartedAt?: number;
  readonly orchestratorState?: PaneRuntimeState;
}): boolean {
  if (
    input.orchestratorState === 'busy' ||
    input.orchestratorState === 'spawning'
  ) {
    return false;
  }
  return wasUpdatedBeforeThisProcess(
    input.updatedAt,
    input.processStartedAt,
  );
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
  // Queued recovery that never left the outbox used to freeze the supervisor
  // forever (hello-file leftover). Only a FRESH queued row blocks; stale ones
  // are ignored so stage-2 / re-arm can proceed.
  const freshQueued = progress.recoveries.some(
    (item) =>
      item.deliveryState === 'queued' &&
      now - item.createdAt < RECOVERY_QUEUED_TTL_MS,
  );
  if (freshQueued) return 0;
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

async function notifyHungWorkerPanes(
  suite: ProjectDomainStoreSuite,
  mission: Mission,
  panes: readonly PaneSnapshot[],
  now: number,
  context: PeriodicTaskContext,
  current: () => boolean,
): Promise<void> {
  const notifiedAt = hungWorkerNotifiedAtFor(suite);
  for (const hint of panes) {
    await context.checkpoint();
    if (!current()) return;
    const pane = listPaneSnapshots().find((live) => live.paneId === hint.paneId &&
      live.sessionId === hint.sessionId && live.missionId === mission.id);
    if (!pane) continue;
    if (pane.role !== 'worker' || !pane.sessionId) continue;
    const semantic = getAgentSemanticStatusBySession(pane.sessionId);
    const decision = decideWorkerHung({
      semanticStatus: semantic?.status,
      semanticUpdatedAt: semantic?.updatedAt,
      paneState: pane.state,
      notifiedAt: notifiedAt.get(pane.sessionId) ?? null,
      now,
    });
    if (decision === 'none') continue;
    notifiedAt.set(pane.sessionId, now);
    const updatedAt = semantic!.updatedAt!;
    const hungMinutes = Math.max(1, Math.floor((now - updatedAt) / 60_000));
    const last = new Date(updatedAt);
    const hhmm =
      `${String(last.getHours()).padStart(2, '0')}:` +
      `${String(last.getMinutes()).padStart(2, '0')}`;
    trace({
      kind: 'worker-hung',
      missionId: mission.id,
      paneId: pane.paneId,
      adapterId: pane.adapterId ?? 'unknown',
      hungMinutes,
    });
    try {
      const handoff = suite.handoffs.submit({
        missionId: mission.id,
        status: 'stalled',
        summary:
          `[travado] worker "${pane.agentName ?? pane.title}" ` +
          `(${pane.paneId}, ${pane.adapterId}) está há ${hungMinutes} min ` +
          `no meio do turno sem ferramenta nem saída (última atividade ` +
          `${hhmm}). Leia o pane (nexus_pane_read) antes de decidir: comando ` +
          `longo e silencioso (suíte, validador) não é travamento. Travado de ` +
          `fato: destrave com nexus_pane_write (Esc, depois Enter) ou feche ` +
          `(nexus_pane_close) e re-despache — a missão não espera pane travado.`,
        fromAgent: DELEGATION_SUPERVISOR_AGENT,
      });
      onHandoffSubmitted(handoff, suite.scope);
    } catch (error) {
      console.warn(
        `[delegation-supervisor] falha ao avisar worker travado ` +
          `${pane.paneId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/**
 * F-723: o Nexus solta um pane e confere se ele começou a tarefa. A ficha de
 * cada spawn pendente com briefing (worker de missão ou helper do operador)
 * vem do `nexus_pane_spawn`; aqui moram os efeitos. Evidência de turno: turno
 * aberto (UserPromptSubmit), status semântico de trabalho ou entrega do brief
 * comprovada.
 */
function hasTurnEvidence(watch: PaneStartWatch, sessionId: string): boolean {
  if (watch.accepted) return true;
  if (getAgentTurnStartSequence(sessionId) > 0) return true;
  const semantic = getAgentSemanticStatusBySession(sessionId);
  return (
    semantic?.status === 'working' ||
    semantic?.status === 'completed' ||
    semantic?.status === 'error'
  );
}

/** Handoff desta sessão, entregue ou não (prova de trabalho). */
function sessionHasHandoff(watch: PaneStartWatch, sessionId: string): boolean {
  try {
    return (
      suiteForScope(watch.scope).handoffs.list({
        sessionIds: [sessionId],
        includeDelivered: true,
      }).length > 0
    );
  } catch {
    return false;
  }
}

/** F-723: turno aberto ou handoff — a sessão saiu do boot. */
function hasPaneStartEvidence(watch: PaneStartWatch, sessionId: string): boolean {
  return hasTurnEvidence(watch, sessionId) || sessionHasHandoff(watch, sessionId);
}

/**
 * F-765: o PTY da sessão mostra a recusa do modelo pela CLI DA FICHA — a frase
 * do Codex citada no pane de outra CLI não é recusa deste pane.
 */
function sessionShowsModelRejection(watch: PaneStartWatch, sessionId: string): boolean | null {
  const evidence = getPtyAnalysisLimitEvidence(sessionId);
  if (evidence.status !== 'accepted' || evidence.binding.paneId !== watch.paneId || evidence.binding.adapterId !== watch.adapterId) return null;
  const hit = evidence.hit;
  return hit?.kind === 'model' && (!hit.adapterId || hit.adapterId === watch.adapterId);
}

/**
 * F-734: na família Claude o turno aberto ainda não prova o início — provam o
 * trabalho (ferramenta, handoff) ou um Stop normal. StopFailure de
 * configuração sem trabalho é recusa do provedor (`rejected`). F-765: em
 * qualquer CLI, a recusa do modelo no PTY sem trabalho segura a ficha para o
 * failover; fora da família Claude o turno aberto assenta antes do veredito.
 */
function paneStartProgressFor(
  watch: PaneStartWatch,
  sessionId: string | null,
  now: number,
): PaneStartProgress {
  const settling = (): boolean =>
    watch.turnOpenedAt !== null && now - watch.turnOpenedAt < START_SETTLE_MS;
  if (sessionId === null) {
    if (watch.turnOutcome !== null) return { kind: watch.turnOutcome };
    return paneStartProgress({
      turnProof: watch.turnProof,
      turnOpened: watch.accepted,
      worked: false,
      settling: settling(),
      lastTurnEnd: null,
    });
  }
  const handoff = sessionHasHandoff(watch, sessionId);
  const worked = handoff || getAgentToolActivityCount(sessionId) > 0;
  const modelRejection = worked ? false : sessionShowsModelRejection(watch, sessionId);
  // Unknown analysis is not a no-limit verdict. Existing content-free hook
  // evidence and explicit turn outcomes remain independently authoritative.
  if (!worked && modelRejection === true) {
    // A recuperação é do failover: a ficha fica, sem sucesso no disjuntor e
    // sem abrir outra recuperação — até MODEL_REJECTION_HANDOFF_MS.
    watch.modelRejectedAt ??= now;
    return { kind: 'turn-open' };
  }
  // O desfecho do turno do brief, visto pelo tap, vale sobre o último turno.
  if (watch.turnOutcome !== null) return { kind: watch.turnOutcome };
  const turnOpened = handoff || hasTurnEvidence(watch, sessionId);
  if (turnOpened) watch.turnOpenedAt ??= now;
  return paneStartProgress({
    turnProof: watch.turnProof,
    turnOpened,
    worked,
    settling: settling(),
    lastTurnEnd: getAgentLastTurnEnd(sessionId),
  });
}

/** F-734: a recusa do provedor foi anotada na ficha (só ids e a categoria). */
function tracePaneStartRejected(
  watch: PaneStartWatch,
  cause: ProviderRejectedCause,
): void {
  trace({
    kind: 'pane-start-rejected',
    paneId: watch.paneId,
    adapterId: watch.adapterId,
    missionId: watch.missionId ?? null,
    role: watch.role,
    cause,
  });
}

/**
 * Aviso a quem pediu, pelo caminho de handoff do supervisor (F-242/F-714):
 * worker de missão → Maestro (`onHandoffSubmitted`); helper sem missão → linha
 * de workspace (F-565) entregue ao pane pai pelo mesmo `injectPrompt`. Status
 * `progress`: `stalled` é diagnóstico e não chega ao PTY do Maestro.
 */
async function notifyPaneStartCaller(watch: PaneStartWatch, summary: string, context?: PeriodicTaskContext): Promise<void> {
  context?.assertCurrent();
  const suite = suiteForScope(watch.scope);
  if (watch.missionId) {
    const handoff = suite.handoffs.submit({
      missionId: watch.missionId,
      status: 'progress',
      summary,
      fromAgent: DELEGATION_SUPERVISOR_AGENT,
    });
    onHandoffSubmitted(handoff, suite.scope);
    return;
  }
  const handoff = suite.handoffs.submit({
    status: 'progress',
    summary,
    fromAgent: DELEGATION_SUPERVISOR_AGENT,
  });
  const parentSessionId = watch.callerSessionId;
  const parent = getAgentSessionInfo(parentSessionId);
  if (!parent || getSessionState(parentSessionId) === null || !sameProjectScope(parent.scope, watch.scope)) return;
  const assertParentCurrent = () => {
    context?.assertCurrent();
    const live = getAgentSessionInfo(parentSessionId);
    if (!live || getSessionState(parentSessionId) === null || !sameProjectScope(live.scope, watch.scope) ||
      live.paneId !== parent.paneId || live.workerIncarnationId !== parent.workerIncarnationId ||
      live.adapterId !== parent.adapterId || live.accountId !== parent.accountId || live.cwd !== parent.cwd) {
      throw new Error('pane start notice parent authority changed');
    }
  };
  await import('./tool-util')
    .then(({ injectPrompt }) =>
      injectPrompt(
        parentSessionId,
        `${WORKSPACE_HANDOFF_DELIVERY_PREFIX} de ${watch.paneId} (sistema Nexus): ${summary}\n`,
        { signal: context?.signal, assertCurrentAuthority: assertParentCurrent },
        'supervisor',
      ),
    )
    .then(() => { assertParentCurrent(); return suite.handoffs.markSubmitted(handoff.id); })
    .catch((error) => {
      // A linha durável fica `queued`: o operador ainda a lista.
      console.warn(
        `[delegation-supervisor] aviso de pane que não iniciou não entregue ao pai ` +
          `(pane=${watch.paneId}): ${shortStartError(error)}`,
      );
    });
}

/** Passo 1 — "corrigir ali": a mesma entrega comprovada do spawn, uma vez. */
async function redeliverPaneStartBrief(
  watch: PaneStartWatch,
  now: number,
): Promise<void> {
  watch.redeliveredAt = now;
  watch.redelivering = true;
  trace({
    kind: 'pane-start-redeliver',
    paneId: watch.paneId,
    adapterId: watch.adapterId,
    missionId: watch.missionId ?? null,
  });
  try {
    if (watch.redeliver && (await watch.redeliver())) watch.accepted = true;
  } catch (error) {
    console.warn(
      `[delegation-supervisor] reenvio do briefing falhou (pane=${watch.paneId}, ` +
        `${watch.adapterId}): ${shortStartError(error)}`,
    );
  } finally {
    watch.redelivering = false;
  }
}

/** Pane morto sai da grade, desde que ninguém tenha outra sessão viva nele. */
async function closeNotStartedPane(watch: PaneStartWatch): Promise<void> {
  const snapshot = listPaneSnapshots().find((pane) => pane.paneId === watch.paneId);
  if (!snapshot) return;
  const current = snapshot.sessionId ?? undefined;
  if (current && current !== watch.sessionId) return;
  try {
    await requestPaneClose(watch.paneId, current);
  } catch {
    // Fechar é limpeza; o aviso e o reenvio importam mais.
  }
}

/**
 * Passo 2 — "mandar para outro": revoga a tentativa sem sessão, fecha o pane
 * morto (nunca o do operador, F-231), conta a falha no disjuntor do adapter,
 * reabre a tarefa em outra CLI pela rota do spawn (um reenvio por pedido) e
 * avisa quem pediu em todos os desfechos.
 */
async function handlePaneNotStarted(
  watch: PaneStartWatch,
  action: 'reroute' | 'notify-only',
  context?: PeriodicTaskContext,
): Promise<void> {
  watch.phase = 'acting';
  const cause = notStartedCause({
    failure: watch.failure?.cause ?? null,
    hasSession: watch.sessionId !== null,
  });
  // F-788/F-789: a cauda do PTY é lida antes de fechar/rerotear (o ring da
  // sessão morta some depois) e vai só para o trace local, já sanitizada.
  const outputTail = watch.sessionId !== null
    ? sanitizePaneBootOutput(readSessionOutput(watch.sessionId, Number.MAX_SAFE_INTEGER))
    : null;
  if (watch.sessionId === null) {
    // Um PTY atrasado desta tentativa não pode nascer depois do reenvio.
    abandonPendingOrchSpawn(watch.requestId, 'pane did not start within the start window');
  }
  let breaker: 'trip' | 'count' | 'skipped' = 'skipped';
  if (!watch.operatorOpened) {
    // F-734: o escopo da credencial é lido antes de fechar (a sessão some).
    const accountBound =
      watch.sessionId !== null &&
      Boolean(getAgentSessionInfo(watch.sessionId)?.accountId);
    await closeNotStartedPane(watch);
    breaker = startFailureBreakerAction({ cause, accountBound });
    if (breaker === 'trip') {
      adapterCircuitBreakers.trip(watch.adapterId, CREDENTIAL_REJECTED_OPEN_MS);
    } else {
      adapterCircuitBreakers.recordFailure(watch.adapterId);
    }
  }
  let outcome: PaneStartOutcome;
  if (action === 'reroute' && watch.reroute) {
    try {
      const next = await watch.reroute([watch.adapterId]);
      outcome = { kind: 'rerouted', paneId: next.paneId, adapterId: next.adapterId };
    } catch (error) {
      outcome = { kind: 'reroute-failed', error: shortStartError(error) };
    }
  } else {
    outcome = {
      kind: 'not-rerouted',
      why: watch.operatorOpened
        ? 'operator'
        : watch.rerouted
          ? 'second-attempt'
          : watch.pinnedRuntime
            ? 'pinned'
            : 'no-alternative',
    };
  }
  const summary = paneStartNoticeSummary({
    paneId: watch.paneId,
    adapterId: watch.adapterId,
    cause,
    outcome,
  });
  trace({
    kind: 'pane-not-started',
    paneId: watch.paneId,
    adapterId: watch.adapterId,
    missionId: watch.missionId ?? null,
    role: watch.role,
    cause,
    outcome: outcome.kind,
    breaker,
    ...(outputTail !== null ? { outputTail } : {}),
    ...(outcome.kind === 'rerouted'
      ? { nextPaneId: outcome.paneId, nextAdapterId: outcome.adapterId }
      : {}),
  });
  console.warn(`[delegation-supervisor] ${summary}`);
  try {
    await notifyPaneStartCaller(watch, summary, context);
  } catch (error) {
    console.warn(
      `[delegation-supervisor] aviso de pane que não iniciou falhou ` +
        `(pane=${watch.paneId}): ${shortStartError(error)}`,
    );
  } finally {
    finishPaneStartWatch(watch);
  }
}

async function checkPaneStart(watch: PaneStartWatch, now: number, context?: PeriodicTaskContext): Promise<void> {
  context?.assertCurrent();
  // Varredura e chute imediato podem se cruzar: um efeito por ficha por vez.
  if (watch.phase !== 'watching' || watch.redelivering) return;
  if (watch.sessionId === null) {
    const bound = pendingSpawnAttemptSession(watch.requestId);
    if (bound.state === 'bound') {
      watch.sessionId = bound.sessionId;
      watch.sessionSpawnedAt = getSessionSpawnedAtMs(bound.sessionId);
    } else if (bound.state === 'gone' && !watch.failure && !watch.accepted) {
      // Tentativa liquidada sem falha de início (chamador revogado, janela
      // fechada, troca de workspace): não foi a CLI que falhou.
      finishPaneStartWatch(watch);
      return;
    }
  }
  const sessionId = watch.sessionId;
  const state = sessionId !== null ? getSessionState(sessionId) : null;
  if (!watch.failure) {
    const progress = paneStartProgressFor(watch, sessionId, now);
    if (progress.kind === 'started') {
      adapterCircuitBreakers.recordSuccess(watch.adapterId);
      finishPaneStartWatch(watch);
      return;
    }
    if (progress.kind === 'not-ours') {
      // F-734: limite de uso ou erro transitório encerrou o turno — isso é do
      // failover de conta (F-249/F-718), não deste watchdog.
      finishPaneStartWatch(watch);
      return;
    }
    if (progress.kind === 'rejected') {
      // Rede de segurança do tap de fim de turno: a recusa vale igual.
      watch.failure = { cause: progress.cause, at: now };
      tracePaneStartRejected(watch, progress.cause);
    } else if (
      watch.sessionEnded ||
      (sessionId !== null && state === null) ||
      now - watch.createdAt >= START_WATCH_TTL_MS
    ) {
      // Encerramento pedido, one-shot que terminou, morte tardia ou CLI sem
      // prova de turno: o veredito é do F-242 e da mortalidade de worker.
      finishPaneStartWatch(watch);
      return;
    } else if (progress.kind === 'turn-open') {
      // F-734: turno aberto na família Claude, sem trabalho nem fim ainda —
      // o veredito é do desfecho dele (ferramenta, Stop ou StopFailure).
      // F-765: recusa do modelo que o failover não assumiu no prazo vira
      // falha de início (pedido recusado) e segue o reenvio/aviso do F-723.
      if (
        watch.modelRejectedAt === null ||
        now - watch.modelRejectedAt < MODEL_REJECTION_HANDOFF_MS
      ) {
        return;
      }
      watch.failure = { cause: 'provider-request', at: now };
      tracePaneStartRejected(watch, 'provider-request');
    }
  }
  const action = decideStartAction({
    role: watch.role,
    operatorOpened: watch.operatorOpened === true,
    started: false,
    failed: watch.failure !== null,
    session:
      sessionId === null
        ? 'none'
        : state === 'busy' || state === 'spawning'
          ? 'busy'
          : 'idle',
    canJudgeLiveSession: watch.turnProof,
    spawnedAt: sessionId === null ? watch.createdAt : watch.sessionSpawnedAt ?? watch.createdAt,
    redeliveredAt: watch.redeliveredAt,
    rerouted: watch.rerouted,
    pinnedRuntime: watch.pinnedRuntime,
    hasAlternative: watch.hasAlternative?.() ?? false,
    now,
  });
  if (action === 'none') return;
  if (action === 'redeliver') {
    await redeliverPaneStartBrief(watch, now);
    return;
  }
  await handlePaneNotStarted(watch, action, context);
}

/** Uma passada do watchdog de início (varredura de 15 s ou falha provada). */
export function checkPaneStarts(now: number = Date.now(), parentContext?: PeriodicTaskContext): Promise<void> {
  return runPeriodicTask('pane-start-check', async (context) => {
    for (const watch of listPaneStartWatches()) {
      await context.checkpoint();
      if (watch.phase !== 'watching' || watch.redelivering) continue;
      try { await context.wait(checkPaneStart(watch, now, context)); }
      catch (error) {
        context.assertCurrent();
        console.warn(`[delegation-supervisor] verificação de início falhou (pane=${watch.paneId}): ${shortStartError(error)}`);
      }
    }
  }, { signal: parentContext?.signal, cadenceMs: DELEGATION_SCAN_MS });
}

let disposePaneStartTaps: (() => void) | null = null;

function installPaneStartTaps(): void {
  if (disposePaneStartTaps) return;
  const untapFailure = tapPendingSpawnStartFailure((failure) => {
    console.warn(
      `[delegation-supervisor] spawn pendente não subiu (pane=${failure.paneId}, ` +
        `${failure.adapterId ?? '?'}): ${shortStartError(failure.error)}`,
    );
    notePaneStartFailure(failure.paneId, 'spawn-refused');
  });
  const untapTermination = tapSessionTermination((sessionId, agent, rootExit) => {
    const watch = paneStartWatchForSession(sessionId, agent?.paneId);
    if (!watch || (agent && agent.adapterId !== watch.adapterId)) return;
    notePaneSessionEnded(watch, {
      sessionId,
      requested: getRequestedTerminationOrigin(sessionId) !== null,
      oneShot: agent?.oneShot === true,
      // F-792: one-shot com código de erro morreu; com 0, terminou.
      exit: rootExit,
      spawnedAt: getSessionSpawnedAtMs(sessionId),
      started: hasPaneStartEvidence(watch, sessionId),
      now: Date.now(),
    });
  });
  // F-734: o turno do brief que o provedor recusou (StopFailure de
  // configuração, sem trabalho) é falha provada — não espera a varredura.
  const untapTurnEnd = tapAgentTurnEnd((entry) => {
    const watch = paneStartWatchForSession(entry.sessionId, entry.paneId);
    if (!watch) return;
    const agent = getAgentSessionInfo(entry.sessionId);
    if (agent && agent.adapterId !== watch.adapterId) return;
    const cause = notePaneTurnEnded(watch, {
      sessionId: entry.sessionId,
      outcome: entry.outcome,
      ...(entry.stopFailure ? { stopFailure: entry.stopFailure } : {}),
      modelRejected: !entry.worked && sessionShowsModelRejection(watch, entry.sessionId) === true,
      worked:
        entry.worked ||
        (entry.stopFailure !== undefined && sessionHasHandoff(watch, entry.sessionId)),
      now: entry.observedAt,
    });
    if (cause) tracePaneStartRejected(watch, cause);
  });
  setPaneStartKick(() => {
    void checkPaneStarts(Date.now());
  });
  disposePaneStartTaps = () => {
    untapFailure();
    untapTermination();
    untapTurnEnd();
    setPaneStartKick(null);
  };
}

async function scanSuite(suite: ProjectDomainStoreSuite, now: number, context: PeriodicTaskContext): Promise<void> {
  const liveStates = new Set<PaneRuntimeState>([
    'spawning', 'busy', 'idle', 'unknown',
  ]);
  const liveSessionIds = new Set<string>();
  missions: for (const hint of suite.missions.list()) {
    await context.checkpoint();
    const mission = suite.missions.get(hint.id);
    if (!mission) continue;
    const revision = JSON.stringify([mission.status, mission.intentVersion, mission.intentState, mission.updatedAt, mission.orchestratorSessionId]);
    const paneStamp = () => JSON.stringify(listPaneSnapshots().filter((pane) => pane.missionId === mission.id)
      .map((pane) => [pane.paneId, pane.sessionId, pane.state, pane.role]));
    const initialPaneStamp = paneStamp();
    const current = () => {
      context.assertCurrent();
      const live = suite.missions.get(mission.id);
      return suites.get(scopeKey(suite)) === suite && !!live &&
        JSON.stringify([live.status, live.intentVersion, live.intentState, live.updatedAt, live.orchestratorSessionId]) === revision &&
        paneStamp() === initialPaneStamp;
    };
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
    for (const pane of panes) {
      await context.checkpoint();
      if (!current()) continue missions;
      if (pane.sessionId) liveSessionIds.add(pane.sessionId);
    }
    let recoveries = suite.handoffs
      .list({ missionId: mission.id, includeDelivered: true })
      .filter((handoff) => handoff.fromAgent === DELEGATION_SUPERVISOR_AGENT)
      .sort((left, right) => left.createdAt - right.createdAt);
    // Expire leftover queued recoveries (hello-file / prior mission) so they
    // stop freezing the supervisor and stop idle-delivery spam forever.
    let expiredStale = false;
    for (const hint of recoveries) {
      await context.checkpoint();
      if (!current()) continue missions;
      const recovery = suite.handoffs.list({ missionId: mission.id, includeDelivered: true }).find((live) => live.id === hint.id);
      if (!recovery) continue;
      if (
        recovery.deliveryState === 'queued' &&
        now - recovery.createdAt >= RECOVERY_QUEUED_TTL_MS
      ) {
        try {
          suite.handoffs.markSubmitted(recovery.id);
          expiredStale = true;
        } catch (error) {
          console.warn(
            `[delegation-supervisor] falha ao expirar recovery enfileirado ` +
              `${recovery.id}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
    if (expiredStale) {
      recoveries = suite.handoffs
        .list({ missionId: mission.id, includeDelivered: true })
        .filter((handoff) => handoff.fromAgent === DELEGATION_SUPERVISOR_AGENT)
        .sort((left, right) => left.createdAt - right.createdAt);
    }
    const hasBoundOrchestrator = Boolean(
      mission.orchestratorSessionId ||
        panes.some((pane) => pane.role === 'orchestrator'),
    );
    const workerPaneCount = panes.filter((pane) => pane.role === 'worker').length;
    const orchestratorPaneState = panes.find(
      (pane) => pane.role === 'orchestrator',
    )?.state;

    if (mission.status === 'pending' || mission.status === 'running') {
      flushAllNexusTaskFailClosedRetries(suite.scope, mission.id);
      await notifyHungWorkerPanes(suite, mission, panes, now, context, current);
      if (!current()) continue;
    }

    // Re-arm de handoff: Maestro idle + pendente durable, COM OU SEM workers.
    // F-113: tolerante a stale-busy (semantic status idle/completed ou timeout do working).
    const orchSessionId = mission.orchestratorSessionId;
    const orchSemantic = orchSessionId ? getAgentSemanticStatusBySession(orchSessionId) : null;
    const orchestratorStaleBusy =
      orchestratorPaneState === 'busy' &&
      (orchSemantic?.status === 'idle' ||
        orchSemantic?.status === 'completed' ||
        (orchSemantic?.status === 'working' &&
          now - orchSemantic.updatedAt > SEMANTIC_WORKING_VETO_MS));
    const isOrchIdleOrStale = orchestratorPaneState === 'idle' || orchestratorStaleBusy;

    const rearmStatusEligible =
      mission.status === 'pending' ||
      mission.status === 'running' ||
      (mission.status === 'done' && !wasMissionApprovedByOperator(mission));

    if (isOrchIdleOrStale && rearmStatusEligible) {
      rearmStuckHandoffDelivery(suite, mission, orchestratorPaneState, now, orchestratorStaleBusy);
    }

    // Chef-idle: orchestrator is idle while workers are present. This state is
    // indistinguishable from a stall without an explicit marker — emit one so
    // the presenter and telemetry can surface it instead of showing silence.
    const chefActivity = chefIdleAgentActivity({
      orchestratorSessionId:
        orchSessionId ??
        panes.find((pane) => pane.role === 'orchestrator')?.sessionId,
      workers: panes.filter((pane) => pane.role === 'worker'),
      now,
      semanticStatus: getAgentSemanticStatusBySession,
    });
    if (
      workerPaneCount > 0 &&
      orchestratorPaneState === 'idle' &&
      !chefActivity.orchestratorInTurn &&
      (mission.status === 'pending' || mission.status === 'running')
    ) {
      emitChefIdleAwaitingWorkers(suite.scope, mission.id, workerPaneCount);
      // F-680: worker trabalhando é progresso — o relógio do bloqueio recomeça.
      if (chefActivity.workerActive) {
        chefIdleTrackers.delete(mission.id);
      } else {
        trackChefIdleEscalation(suite, mission, workerPaneCount, now);
      }
    } else {
      chefIdleTrackers.delete(mission.id);
    }

    // Zero-entrega: workers vivos, 0 handoffs de worker, Maestro não busy —
    // o caso saas-waitlist (pull-model deadlock). Poke curto; escalate depois.
    {
      let workerHandoffCount = 0;
      try {
        workerHandoffCount = suite.handoffs
          .list({ missionId: mission.id, includeDelivered: true })
          .filter(
            (handoff) =>
              handoff.fromAgent !== DELEGATION_SUPERVISOR_AGENT &&
              !String(handoff.fromAgent ?? '').startsWith('nexus-'),
          ).length;
      } catch {
        workerHandoffCount = 0;
      }
      if (workerHandoffCount > 0) {
        zeroDeliveryPoked.delete(mission.id);
        zeroDeliveryEscalated.delete(mission.id);
      }
      const executingSinceMs = resolveDispatchAuthorizedAt(mission);
      const zd = decideZeroDeliveryWatchdog({
        missionStatus: mission.status,
        lane: lane ?? null,
        workerPanes: workerPaneCount,
        workerHandoffCount,
        orchestratorState: orchestratorPaneState,
        executingSinceMs,
        now,
        alreadyPoked: zeroDeliveryPoked.has(mission.id),
      });
      if (zd.action === 'poke' && !zeroDeliveryPoked.has(mission.id)) {
        zeroDeliveryPoked.add(mission.id);
        try {
          const handoff = suite.handoffs.submit({
            missionId: mission.id,
            status: 'progress',
            summary: zeroDeliveryPokeSummary(mission.id, zd.sinceMs),
            fromAgent: DELEGATION_SUPERVISOR_AGENT,
          });
          onHandoffSubmitted(handoff, suite.scope);
          console.warn(
            `[delegation-supervisor] zero-delivery poke for ${mission.id}`,
          );
        } catch (error) {
          console.warn(
            `[delegation-supervisor] zero-delivery poke falhou:`,
            error instanceof Error ? error.message : error,
          );
        }
      } else if (
        zd.action === 'escalate' &&
        !zeroDeliveryEscalated.has(mission.id)
      ) {
        zeroDeliveryEscalated.add(mission.id);
        try {
          const handoff = suite.handoffs.submit({
            missionId: mission.id,
            status: 'stalled',
            summary: zeroDeliveryEscalateSummary(mission.id),
            fromAgent: DELEGATION_SUPERVISOR_AGENT,
          });
          onHandoffSubmitted(handoff, suite.scope);
          console.warn(
            `[delegation-supervisor] zero-delivery escalate for ${mission.id}`,
          );
        } catch (error) {
          console.warn(
            `[delegation-supervisor] zero-delivery escalate falhou:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }

    // Esteira (F-714): Maestro vivo, nenhum worker há muito tempo.
    {
      if (workerPaneCount > 0) momentumSoloSince.delete(mission.id);
      else if (!momentumSoloSince.has(mission.id)) momentumSoloSince.set(mission.id, now);
      const momentum = decideMomentumNudge({
        missionStatus: mission.status,
        lane: lane ?? null,
        maxWorkers: mission.intentContract?.budgets?.maxWorkers ?? null,
        workerPanes: workerPaneCount,
        orchestratorAlive:
          orchestratorPaneState !== undefined &&
          orchestratorPaneState !== 'exited' &&
          orchestratorPaneState !== 'parked' &&
          orchestratorPaneState !== 'hibernated',
        soloSinceMs: momentumSoloSince.get(mission.id) ?? null,
        lastNudgeAtMs: momentumNudgedAt.get(mission.id) ?? null,
        now,
      });
      if (momentum.action === 'nudge') {
        momentumNudgedAt.set(mission.id, now);
        try {
          const handoff = suite.handoffs.submit({
            missionId: mission.id,
            status: 'progress',
            summary: momentumNudgeSummary(mission.id, momentum.soloForMs),
            fromAgent: DELEGATION_SUPERVISOR_AGENT,
          });
          onHandoffSubmitted(handoff, suite.scope);
          console.warn(`[delegation-supervisor] momentum nudge for ${mission.id}`);
        } catch (error) {
          console.warn(
            `[delegation-supervisor] momentum nudge falhou:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }

    if (
      shouldSkipLeftoverDelegationRecovery({
        updatedAt: mission.updatedAt,
        orchestratorState: orchestratorPaneState,
      })
    ) {
      if (!leftoverSkipLogged.has(mission.id)) {
        leftoverSkipLogged.add(mission.id);
        console.warn(
          `[delegation-supervisor] leftover ${mission.id} skipped — Parou (no live Maestro)`,
        );
      }
      continue;
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
      // Leftover running no disco sem Maestro deste processo NÃO remonta.
      // Persist isolamento e deixa o card na rail — o orçamento focused
      // fica para a missão viva deste processo.
      const leftoverLiveMaestro =
        orchestratorPaneState === 'busy' || orchestratorPaneState === 'spawning'
          ? mission.orchestratorSessionId ?? 'this-process-live'
          : null;
      if (
        shouldSkipLeftoverRemount({
          mission,
          liveMaestroSessionId: leftoverLiveMaestro,
          remountKind: 'automatic',
          isFreshKickoff: isFreshIniciarKickoff({
            status: mission.status,
            createdAt: mission.createdAt,
            updatedAt: mission.updatedAt,
            sealedCount: suite.tasks.list(mission.id).length,
            paneCount: panes.length,
            hasLiveMaestro: leftoverLiveMaestro != null,
          }),
        })
      ) {
        persistLeftoverIsolation(suite.missions, mission.id, 'leftover');
        console.warn(
          `[delegation-supervisor] leftover ${mission.id} isolado — remount skip`,
        );
        continue;
      }
      // Acorda a Via Rápida: o orquestrador morreu, spawna um novo.
      // Antes ficava parado esperando "Mission Driver recovery" que nunca vinha.
      const { resumeFastLaneMission } = await context.wait(import('./mission-fast-lane'));
      if (!current()) continue;
      await context.wait(resumeFastLaneMission(suite.scope, mission.id, { remountKind: 'automatic' })
        .catch((error) => console.warn('[delegation-supervisor] resume falhou:', error)));
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
  // Sessão de worker saiu do inventário DESTA suite: o aviso pendente não é
  // mais dela. Os avisos das outras suites ficam com elas (F-725).
  const notifiedAt = hungWorkerNotifiedAt.get(scopeKey(suite));
  if (notifiedAt) {
    for (const sessionId of [...notifiedAt.keys()]) {
      await context.checkpoint();
      if (!liveSessionIds.has(sessionId)) notifiedAt.delete(sessionId);
    }
  }
}

const suites = new Map<string, ProjectDomainStoreSuite>();
let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribeScopes: (() => void) | null = null;

function scopeKeyOf(scope: ProjectDomainStoreSuite['scope']): string {
  return [
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
  ].join('\0');
}

function scopeKey(suite: ProjectDomainStoreSuite): string {
  return scopeKeyOf(suite.scope);
}

/** Suite do escopo de coordenação de um pane vigiado (F-723). */
function suiteForScope(
  scope: ProjectDomainStoreSuite['scope'],
): ProjectDomainStoreSuite {
  return suites.get(scopeKeyOf(scope)) ?? getProjectDomainStores(scope);
}

export function initDelegationSupervisor(): void {
  if (timer) return;
  prepareDelegationSupervisor();
  timer = setInterval(() => { void reconcileDelegationSupervisor().catch((error) => console.warn('[delegation-supervisor] scan failed:', error)); }, DELEGATION_SCAN_MS);
  timer.unref?.();
}

/** Install store discovery without creating a supervisor timer. */
export function prepareDelegationSupervisor(): void {
  installPaneStartTaps();
  if (unsubscribeScopes) return;
  unsubscribeScopes = requireProjectDomainStoreRegistry().onScope((_scope, suite) => {
    suites.set(scopeKey(suite), suite);
  });
}

/** One main-coordinator scan, error-isolated per project scope. */
export function reconcileDelegationSupervisor(now: number = Date.now(), context?: PeriodicTaskContext): Promise<void> {
  const reconcile = async (budget: PeriodicTaskContext) => {
    for (const suite of [...suites.values()]) {
      await budget.checkpoint();
      if (suites.get(scopeKey(suite)) !== suite) continue;
      try { await budget.wait(scanSuite(suite, now, budget)); }
      catch (error) {
        budget.assertCurrent();
        console.warn('[delegation-supervisor] scan failed:', error);
      }
    }
    await budget.wait(checkPaneStarts(now, budget));
  };
  return context ? reconcile(context) : runPeriodicTask('delegation-supervisor:legacy', reconcile, { cadenceMs: DELEGATION_SCAN_MS });
}

export async function shutdownDelegationSupervisor(): Promise<void> {
  const settling = Promise.all([stopPeriodicTask('delegation-supervisor:legacy'), stopPeriodicTask('pane-start-check')]);
  if (timer) clearInterval(timer);
  timer = null;
  unsubscribeScopes?.();
  unsubscribeScopes = null;
  disposePaneStartTaps?.();
  disposePaneStartTaps = null;
  await settling;
  suites.clear();
  chefIdleTrackers.clear();
  zeroDeliveryPoked.clear();
  zeroDeliveryEscalated.clear();
  handoffRearmLastRun.clear();
  hungWorkerNotifiedAt.clear();
  momentumSoloSince.clear();
  momentumNudgedAt.clear();
}
