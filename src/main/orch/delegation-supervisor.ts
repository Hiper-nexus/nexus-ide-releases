import { iteratePeriodicMissionIds } from './mission-store';
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
  hasCurrentDispatchAuthority,
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
import {
  handoffDeliveryEligible,
  onHandoffSubmitted,
  redeliverPendingHandoffs,
} from './idle-delivery';
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
  executionProofGraceMs,
  finishPaneStartWatch,
  forgetConfirmedPaneLimit,
  LIMIT_HANDOFF_MS,
  listConfirmedPaneLimits,
  listPaneStartWatches,
  notePaneSessionEnded,
  notePaneStartFailure,
  notePaneTurnEnded,
  notStartedCause,
  paneLimitNoticeSummary,
  paneStartNoticeSummary,
  paneStartProgress,
  paneStartWatchForSession,
  releasePaneStartWatch,
  setPaneStartKick,
  shortStartError,
  startFailureBreakerAction,
  startRerouteChainExhausted,
  MODEL_REJECTION_HANDOFF_MS,
  START_GRACE_MS,
  START_SETTLE_MS,
  START_WATCH_TTL_MS,
  type PaneNotStartedCause,
  type PaneStartOutcome,
  type PaneStartProgress,
  type PaneStartWatch,
  type ProviderRejectedCause,
} from './pane-start-watchdog';
import { emitMissionIntentEvent } from './mission-intent-events';
import {
  emitChefIdleAwaitingWorkers,
} from './mission-event-emit';
import {
  decideZeroDeliveryWatchdog,
  zeroDeliveryEscalateSummary,
  zeroDeliveryPokeSummary,
  zeroDeliveryWorkerActivity,
  type ZeroDeliverySeen,
} from './zero-delivery-watchdog';
import { flushAllNexusTaskFailClosedRetries } from './nexus-task-fail-closed-recovery';
import { decideMomentumNudge, momentumNudgeSummary, momentumReadyBacklog } from './mission-momentum-watchdog';
import { judgeMissionMomentum, momentumNudgeFromJudgment } from './jev-mission-momentum';
import {
  getAgentLastTurnEnd,
  getAgentSemanticStatusBySession,
  getAgentToolActivityCount,
  getAgentTurnStartSequence,
  SEMANTIC_WORKING_VETO_MS,
  tapAgentSemanticStatus,
  tapAgentTurnEnd,
  tapAgentTurnStart,
} from './agent-status';
import {
  forgetPaneTaskReroute,
  getPaneTaskReroute,
  paneTaskRerouteBlocker,
} from './pane-task-reroute';
import { trace } from '../observability/main-trace';
import { sanitizePaneBootOutput } from './pane-boot-output';
import { diagnosePaneBoot } from './pane-boot-diagnosis';
import { parsePaneAdmissionRefusal } from './pane-admission';
import {
  currentModelQuarantineScope,
  MODEL_ACCESS_QUARANTINE_MS,
  quarantineRejectedModel,
} from './model-access-quarantine';
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
const momentumNudgedAt = new Map<string, { at: number; backlogKey?: string }>();
const momentumReadySince = new Map<string, number>();

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

/**
 * F-1380: última varredura que viu o PTY do worker com saída (busy/spawning),
 * POR suite (F-725). O `working` semântico sozinho congela no começo do turno
 * — a tela só publica na transição e CLI sem hook por ferramenta (muse, devin)
 * não o renova — e a varredura que caía entre dois quadros do spinner via o
 * PTY idle: turno longo com saída virava "travado".
 */
const hungWorkerOutputSeenAt = new Map<string, Map<string, number>>();

/** Última atividade do worker: o status semântico ou a última saída vista. */
export function workerLastActivityAt(
  semanticUpdatedAt: number,
  outputSeenAt: number | undefined,
): number {
  return Math.max(semanticUpdatedAt, outputSeenAt ?? semanticUpdatedAt);
}

export function decideWorkerHung(input: {
  readonly semanticStatus: string | undefined;
  readonly semanticUpdatedAt: number | undefined;
  /** F-1380: última varredura que viu saída do PTY deste worker. */
  readonly outputSeenAt?: number;
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
  if (
    input.now - workerLastActivityAt(input.semanticUpdatedAt, input.outputSeenAt) <
    WORKER_HUNG_AFTER_MS
  ) {
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
/**
 * F-986: última atividade vista por sessão de worker, POR suite (mesmo
 * motivo do F-725: a poda de uma suite usa só as sessões vivas dela).
 */
const zeroDeliverySeen = new Map<string, Map<string, ZeroDeliverySeen>>();
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
  // Idle is an observation, never revocation of the operator's dispatch.
  // Blocking here made the authority reconciler terminate every live pane.
  const minutes = Math.round((now - decision.sinceMs) / 60_000);
  try {
    const handoff = suite.handoffs.submit({
      missionId: mission.id,
      status: 'stalled',
      fromAgent: DELEGATION_SUPERVISOR_AGENT,
      summary:
        `[chef-idle:${mission.id}:${decision.sinceMs}] Orquestrador aguardando ` +
        `${workerPaneCount} worker(s) por ${minutes}min sem progresso observado. ` +
        'Confira os panes e os handoffs pendentes e retome o trabalho autorizado. ' +
        'A missão e os processos continuam ativos; este aviso não autoriza encerrar a missão.',
    });
    onHandoffSubmitted(handoff, suite.scope);
    chefIdleTrackers.set(mission.id, { sinceMs: now, workerCount: workerPaneCount });
  } catch (error) {
    console.warn(
      `[delegation-supervisor] chef-idle aviso falhou para ${mission.id}:`,
      error instanceof Error ? error.message : error,
    );
  }
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
 * O aviso acorda o coordenador sem revogar o despacho nem matar os panes.
 */
export const CHEF_IDLE_NOTIFY_AFTER_MS = 60 * 60_000;

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

/**
 * F-925: re-arm conta o que a entrega realmente colaria, não só
 * success/blocked. O aviso "Esteira parada" (progress do supervisor), o
 * handoff sintético de worker morto (failed, handoff-enforcement) e
 * qualquer partial/progress ficavam queued para sempre sem re-arm — o
 * incidente de 05/10 (119 min, workers mortos, Maestro no prompt). O
 * predicado vem de idle-delivery para que diagnóstico que nunca chega ao
 * PTY (stalled de worker, mission-driver) também não segure o re-arm.
 */
export function pendingDeliverableHandoffs(
  handoffs: readonly Handoff[],
): number {
  return handoffs.filter(handoffDeliveryEligible).length;
}

function rearmStuckHandoffDelivery(
  suite: ProjectDomainStoreSuite,
  mission: Mission,
  orchestratorPaneState: string | undefined,
  now: number,
  orchestratorStaleBusy = false,
): void {
  let pendingDeliverable = 0;
  try {
    pendingDeliverable = pendingDeliverableHandoffs(
      suite.handoffs.list({ missionId: mission.id, includeDelivered: false }),
    );
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
  const windowMs = input.windowMs ?? CHEF_IDLE_NOTIFY_AFTER_MS;
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
  | { readonly action: 'notify'; readonly sinceMs: number };

/**
 * Decisão pura do watchdog chef-idle.
 * - reset: sai do estado idle (ou missão deixou de ser running) — rastreador
 *   zera; contagem de workers MUDOU também reseta (episódio novo, relógio
 *   novo arma no próximo scan).
 * - watch: dentro do teto — mantém/rearma o rastreador (caller grava now
 *   quando ainda não havia).
 * - notify: cruzou o teto sem mudança — caller avisa sem revogar a missão
 *   e rearma o relógio para limitar a frequência dos avisos.
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
  const thresholdMs = input.thresholdMs ?? CHEF_IDLE_NOTIFY_AFTER_MS;
  if (input.now - input.trackedSince >= thresholdMs) {
    return { action: 'notify', sinceMs: input.trackedSince };
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
  const outputSeenAt = hungWorkerOutputSeenAt.get(scopeKey(suite)) ?? new Map<string, number>();
  hungWorkerOutputSeenAt.set(scopeKey(suite), outputSeenAt);
  for (const hint of panes) {
    await context.checkpoint();
    if (!current()) return;
    const pane = listPaneSnapshots().find((live) => live.paneId === hint.paneId &&
      live.sessionId === hint.sessionId && live.missionId === mission.id);
    if (!pane) continue;
    if (pane.role !== 'worker' || !pane.sessionId) continue;
    if (pane.state === 'busy' || pane.state === 'spawning') outputSeenAt.set(pane.sessionId, now);
    const semantic = getAgentSemanticStatusBySession(pane.sessionId);
    const decision = decideWorkerHung({
      semanticStatus: semantic?.status,
      semanticUpdatedAt: semantic?.updatedAt,
      outputSeenAt: outputSeenAt.get(pane.sessionId),
      paneState: pane.state,
      notifiedAt: notifiedAt.get(pane.sessionId) ?? null,
      now,
    });
    if (decision === 'none') continue;
    notifiedAt.set(pane.sessionId, now);
    const updatedAt = workerLastActivityAt(semantic!.updatedAt!, outputSeenAt.get(pane.sessionId));
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
 * F-1414: prova de EXECUÇÃO — o 1º turno começou de verdade. Diferente do
 * F-723, a entrega do brief (ACK da colagem, argv no grant) não conta: o Kimi
 * ficou com o brief parado no composer e a ficha já o dava por iniciado.
 */
function hasExecutionProof(watch: PaneStartWatch, sessionId: string | null): boolean {
  if (watch.executionSeenAt !== null || watch.turnOutcome !== null) return true;
  if (sessionId === null) return false;
  if (getAgentTurnStartSequence(sessionId) > 0) return true;
  if (getAgentToolActivityCount(sessionId) > 0) return true;
  const semantic = getAgentSemanticStatusBySession(sessionId);
  if (
    semantic?.status === 'working' ||
    semantic?.status === 'completed' ||
    semantic?.status === 'error'
  ) {
    return true;
  }
  return sessionHasHandoff(watch, sessionId);
}

/**
 * F-1414: a CLI desta sessão publica status (hook ou tela do manifesto), então
 * a falta de turno é observável. CLI sem telemetria nenhuma (agy, MiMo e afins
 * que trabalham calados, F-765) continua sem esse veredito: ociosa ≠ parada.
 */
function executionObservable(sessionId: string): boolean {
  return (
    getAgentSemanticStatusBySession(sessionId) !== null ||
    getAgentTurnStartSequence(sessionId) > 0
  );
}

/** F-1414: o guardian estacionou o pane desta ficha (CLI encerrada, pane fica). */
function paneParkedForWatch(watch: PaneStartWatch): boolean {
  const snapshot = listPaneSnapshots().find((pane) => pane.paneId === watch.paneId);
  if (snapshot?.state !== 'parked') return false;
  return !snapshot.sessionId || watch.sessionId === null || snapshot.sessionId === watch.sessionId;
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
async function notifyPaneStartCaller(
  watch: Pick<PaneStartWatch, 'scope' | 'missionId' | 'callerSessionId' | 'paneId'>,
  summary: string,
  context?: PeriodicTaskContext,
  // F-1414: teto de reenvios atingido — a tarefa fica `blocked` com o motivo.
  status: 'progress' | 'blocked' = 'progress',
): Promise<void> {
  context?.assertCurrent();
  const suite = suiteForScope(watch.scope);
  if (watch.missionId) {
    const handoff = suite.handoffs.submit({
      missionId: watch.missionId,
      status,
      summary,
      fromAgent: DELEGATION_SUPERVISOR_AGENT,
    });
    onHandoffSubmitted(handoff, suite.scope);
    return;
  }
  const handoff = suite.handoffs.submit({
    status,
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
  const failureCause = notStartedCause({
    failure: watch.failure?.cause ?? null,
    hasSession: watch.sessionId !== null,
  });
  // F-788/F-789: a cauda do PTY é lida antes de fechar/rerotear (o ring da
  // sessão morta some depois) e vai só para o trace local, já sanitizada.
  // F-953: diagnóstico nunca pede uma varredura ilimitada antes da recuperação.
  const outputTail = watch.sessionId !== null
    ? sanitizePaneBootOutput(readSessionOutput(watch.sessionId, 100))
    : null;
  // F-984: motivo legível (frase fixa, modelo, código de saída) para o aviso.
  // A CLI que recusou o modelo ao nascer tira o modelo das rotas dela: a
  // quarentena é da INSTALAÇÃO (some quando a CLI muda, isto é, quando o
  // catálogo é revalidado) ou, sem instalação provada, da conta.
  const diagnosis = diagnosePaneBoot(outputTail, watch.failure?.exitCode ?? null);
  // Só a saída no boot vira recusa de modelo: a recusa do provedor no turno
  // (`provider-request`, F-765) já tem causa e é do failover.
  const cause: PaneNotStartedCause =
    diagnosis.modelRejected && failureCause === 'boot-exit' ? 'model-rejected' : failureCause;
  // F-1270: recusa de capacidade (teto/memória) é CLI-agnóstica — não é falha
  // da CLI nem do modelo. Não reroteia (outra CLI esbarra no mesmo teto), não
  // conta no disjuntor e devolve a mensagem real a quem pediu.
  const capacityRefused = cause === 'capacity-refused';
  if (cause === 'model-rejected') {
    const session = watch.sessionId !== null ? getAgentSessionInfo(watch.sessionId) : null;
    const model = diagnosis.rejectedModel ?? session?.model ?? null;
    if (model) {
      const scope = currentModelQuarantineScope(watch.adapterId, {
        accountId: session?.accountId ?? null,
      });
      quarantineRejectedModel(
        watch.adapterId,
        model,
        diagnosis.detail ?? 'modelo recusado no nascimento',
        Date.now(),
        MODEL_ACCESS_QUARANTINE_MS,
        { ...scope, kind: scope.installationId ? 'installation' : 'access' },
      );
    }
  }
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
    if (!capacityRefused) {
      // Recusa de capacidade não é falha da CLI: fecha o pane morto, mas não
      // conta no disjuntor do adapter.
      breaker = startFailureBreakerAction({ cause, accountBound });
      if (breaker === 'trip') {
        adapterCircuitBreakers.trip(watch.adapterId, CREDENTIAL_REJECTED_OPEN_MS);
      } else if (breaker === 'count') {
        adapterCircuitBreakers.recordFailure(watch.adapterId);
      }
    }
  }
  let outcome: PaneStartOutcome;
  if (capacityRefused) {
    outcome = { kind: 'not-rerouted', why: 'capacity' };
  } else if (action === 'reroute' && watch.reroute) {
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
        : startRerouteChainExhausted(watch)
          ? 'chain-limit'
          : watch.pinnedRuntime
            ? 'pinned'
            : 'no-alternative',
    };
  }
  // F-1270: o motivo da recusa de capacidade viaja em `failure.detail` (o
  // diagnóstico do boot só existe com sessão; aqui o spawn foi recusado antes).
  const detail = diagnosis.detail ?? watch.failure?.detail ?? null;
  const summary = paneStartNoticeSummary({
    paneId: watch.paneId,
    adapterId: watch.adapterId,
    cause,
    outcome,
    detail,
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
    ...(watch.failure?.exitCode !== undefined ? { exitCode: watch.failure.exitCode } : {}),
    ...(detail ? { detail } : {}),
    ...(watch.failure?.error ? { error: watch.failure.error } : {}),
    ...(outputTail !== null ? { outputTail } : {}),
    ...(outcome.kind === 'rerouted'
      ? { nextPaneId: outcome.paneId, nextAdapterId: outcome.adapterId }
      : {}),
  });
  console.warn(`[delegation-supervisor] ${summary}`);
  try {
    await notifyPaneStartCaller(
      watch,
      summary,
      context,
      outcome.kind === 'not-rerouted' && outcome.why === 'chain-limit' ? 'blocked' : 'progress',
    );
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
  // F-1414: a admissão de memória estacionou o pane antes do 1º turno (a
  // retomada depois falhou com resume_context_unavailable e a tarefa ficou sem
  // dono). Encerramento pedido, mas a tarefa não foi feita: reenvia.
  if (!watch.failure && paneParkedForWatch(watch) && !hasExecutionProof(watch, sessionId)) {
    watch.failure = { cause: 'parked-before-start', at: now };
  }
  // F-1414: CLI observável ainda sem prova de execução (só a entrega do brief).
  let awaitingExecution = false;
  if (!watch.failure) {
    const progress = paneStartProgressFor(watch, sessionId, now);
    if (sessionId !== null && hasExecutionProof(watch, sessionId)) {
      watch.executionSeenAt ??= now;
    } else {
      awaitingExecution = sessionId !== null && executionObservable(sessionId);
    }
    if (progress.kind === 'started' && !awaitingExecution) {
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
      if (watch.modelRejectedAt !== null) {
        if (now - watch.modelRejectedAt < MODEL_REJECTION_HANDOFF_MS) return;
        watch.failure = { cause: 'provider-request', at: now };
        tracePaneStartRejected(watch, 'provider-request');
      } else if (!awaitingExecution) {
        return;
      }
    }
  }
  // F-984: sessão viva que não escreveu NENHUM byte (ainda 'spawning') depois
  // da graça não está "ocupada": a CLI travou antes de pintar — o MiMo ficou
  // 158 s mudo esperando a fila de pesados. Vale para qualquer CLI, com ou sem
  // prova de turno; sem isto a ficha só caía no TTL de 30 min, em silêncio.
  if (
    !watch.failure &&
    sessionId !== null &&
    state === 'spawning' &&
    now - (watch.sessionSpawnedAt ?? watch.createdAt) >= START_GRACE_MS
  ) {
    watch.failure = { cause: 'boot-silent', at: now };
  }
  // F-1414: brief entregue (ou no argv) e CLI observável sem 1º turno: depois
  // do prazo, ociosa, é tarefa que não começou — reenvia para outra CLI. PTY
  // ocupado segue sem veredito (manifesto que não reconhece o trabalho não
  // derruba quem trabalha). Família Claude sem ACK segue o passo 1 do F-723.
  const executionJudged = awaitingExecution && (watch.accepted || !watch.turnProof);
  if (
    !watch.failure &&
    executionJudged &&
    state === 'idle' &&
    now - (watch.turnOpenedAt ?? watch.sessionSpawnedAt ?? watch.createdAt) >=
      executionProofGraceMs(watch.adapterId)
  ) {
    watch.failure = { cause: 'turn-not-started', at: now };
  }
  // Sem veredito ainda: nunca reenvia por cima de um brief já entregue.
  if (!watch.failure && executionJudged) return;
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
    rerouted: startRerouteChainExhausted(watch),
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

/**
 * F-1414: limite de uso CONFIRMADO pelo failover num pane de tarefa que ainda
 * não entregou (Muse: "Usage limit reached" e a tarefa parada). O failover tem
 * LIMIT_HANDOFF_MS para trocar de conta ou reabrir a tarefa; se depois disso o
 * pane segue na mesma sessão, sem handoff e sem voltar a trabalhar, o
 * supervisor fecha o pane, reabre a MESMA tarefa noutra CLI (a esgotada fora
 * da rota, na mesma worktree do writer isolado) e avisa quem pediu. Teto de
 * reaberturas do pedido (MAX_PANE_TASK_REROUTES) → `blocked` com o motivo.
 */
export async function checkLimitedTaskPanes(
  now: number = Date.now(),
  context?: PeriodicTaskContext,
): Promise<void> {
  for (const limit of listConfirmedPaneLimits()) {
    context?.assertCurrent();
    if (now - limit.at < LIMIT_HANDOFF_MS) continue;
    forgetConfirmedPaneLimit(limit.paneId);
    const pane = listPaneSnapshots().find((live) => live.paneId === limit.paneId);
    // O failover já agiu (sessão nova no pane, pane fechado) ou o pane morreu.
    if (!pane?.scope || pane.sessionId !== limit.sessionId) continue;
    if (getSessionState(limit.sessionId) === null) continue;
    const handle = getPaneTaskReroute(limit.paneId, now);
    // Só tarefa delegada pelo nexus_pane_spawn tem o pedido para reabrir.
    if (!handle || handle.adapterId !== limit.adapterId) continue;
    const suite = suiteForScope(pane.scope);
    try {
      // Entregou: o limite veio depois do trabalho.
      if (suite.handoffs.list({ sessionIds: [limit.sessionId], includeDelivered: true }).length > 0) {
        continue;
      }
    } catch {
      continue; // sem leitura confiável não decide
    }
    // Voltou a trabalhar sozinho (janela curta que passou).
    const semantic = getAgentSemanticStatusBySession(limit.sessionId);
    if (semantic?.status === 'working' && semantic.updatedAt > limit.at) continue;
    const blocker = paneTaskRerouteBlocker(handle);
    let outcome: Parameters<typeof paneLimitNoticeSummary>[0]['outcome'];
    if (blocker === 'operator' || blocker === 'pinned' || blocker === 'chain-limit') {
      outcome = { kind: 'not-rerouted', why: blocker };
    } else if (blocker === 'no-request') {
      outcome = { kind: 'not-rerouted', why: 'not-reopenable' };
    } else if (!handle.hasAlternative([limit.adapterId])) {
      outcome = { kind: 'not-rerouted', why: 'no-alternative' };
    } else {
      // A ficha de início (se ainda viva) não reabre a mesma tarefa de novo.
      releasePaneStartWatch(limit.paneId);
      const closed = await requestPaneClose(limit.paneId, limit.sessionId).catch(() => false);
      if (!closed) {
        outcome = { kind: 'reroute-failed', error: 'o pane parado não fechou; nada foi reaberto' };
      } else {
        forgetPaneTaskReroute(limit.paneId);
        try {
          const next = await handle.reroute({
            excludeAdapterIds: [limit.adapterId],
            worktreeFromPaneId: limit.paneId,
          });
          outcome = { kind: 'rerouted', paneId: next.paneId, adapterId: next.adapterId };
        } catch (error) {
          outcome = { kind: 'reroute-failed', error: shortStartError(error) };
        }
      }
    }
    const summary = paneLimitNoticeSummary({
      paneId: limit.paneId,
      adapterId: limit.adapterId,
      reason: limit.reason,
      outcome,
    });
    trace({
      kind: 'pane-limit-reroute',
      paneId: limit.paneId,
      adapterId: limit.adapterId,
      missionId: handle.missionId ?? null,
      role: handle.role,
      outcome: outcome.kind,
      ...(outcome.kind === 'rerouted'
        ? { nextPaneId: outcome.paneId, nextAdapterId: outcome.adapterId }
        : outcome.kind === 'not-rerouted' ? { why: outcome.why } : {}),
    });
    console.warn(`[delegation-supervisor] ${summary}`);
    try {
      await notifyPaneStartCaller(
        {
          scope: pane.scope,
          ...(handle.missionId ? { missionId: handle.missionId } : {}),
          callerSessionId: handle.callerSessionId,
          paneId: limit.paneId,
        },
        summary,
        context,
        outcome.kind === 'not-rerouted' && outcome.why === 'chain-limit' ? 'blocked' : 'progress',
      );
    } catch (error) {
      console.warn(
        `[delegation-supervisor] aviso de limite falhou (pane=${limit.paneId}): ${shortStartError(error)}`,
      );
    }
  }
}

let disposePaneStartTaps: (() => void) | null = null;

function installPaneStartTaps(): void {
  if (disposePaneStartTaps) return;
  const untapFailure = tapPendingSpawnStartFailure((failure) => {
    console.warn(
      `[delegation-supervisor] spawn pendente não subiu (pane=${failure.paneId}, ` +
        `${failure.adapterId ?? '?'}): ${shortStartError(failure.error)}`,
    );
    // F-1270: recusa de capacidade (teto/memória) é CLI-agnóstica — guarda a
    // mensagem real e marca `capacity-refused` (não reroteia); o resto é recusa
    // da CLI e segue o reenvio de sempre.
    const refusal = parsePaneAdmissionRefusal(failure.error);
    // F-1410: a recusa de CLI leva a 1ª linha saneada do erro para o trace
    // local — sem isso a causa só ia ao console e o diagnóstico se perdia
    // (dois spawns do Muse de 12/10 recusados sem motivo em lugar nenhum).
    notePaneStartFailure(
      failure.paneId,
      refusal ? 'capacity-refused' : 'spawn-refused',
      Date.now(),
      refusal?.message,
      refusal ? undefined : shortStartError(failure.error),
    );
  });
  const untapTermination = tapSessionTermination((sessionId, agent, rootExit) => {
    const watch = paneStartWatchForSession(sessionId, agent?.paneId);
    if (!watch || (agent && agent.adapterId !== watch.adapterId)) return;
    // F-1414: a prova de execução fica na ficha antes de a sessão sumir.
    if (watch.sessionId === sessionId && hasExecutionProof(watch, sessionId)) {
      watch.executionSeenAt ??= Date.now();
    }
    notePaneSessionEnded(watch, {
      sessionId,
      requested: getRequestedTerminationOrigin(sessionId) !== null,
      oneShot: agent?.oneShot === true,
      // F-792: one-shot com código de erro morreu; com 0, terminou.
      exit: rootExit,
      spawnedAt: getSessionSpawnedAtMs(sessionId),
      // F-984: trabalho provado (ferramenta) também é início — a saída com
      // erro de quem já trabalhou não é "não iniciou".
      started:
        hasPaneStartEvidence(watch, sessionId) || getAgentToolActivityCount(sessionId) > 0,
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
  // F-1414: turno curto entre duas varreduras (working → idle) ainda é prova
  // de execução — a ficha guarda o instante em que a viu.
  const noteExecution = (sessionId: string, paneId: string, at: number): void => {
    const watch = paneStartWatchForSession(sessionId, paneId);
    if (!watch || (watch.sessionId !== null && watch.sessionId !== sessionId)) return;
    const agent = getAgentSessionInfo(sessionId);
    if (agent && agent.adapterId !== watch.adapterId) return;
    watch.executionSeenAt ??= at;
  };
  const untapStatus = tapAgentSemanticStatus((entry) => {
    if (entry.status === 'working' || entry.status === 'completed' || entry.status === 'error') {
      noteExecution(entry.sessionId, entry.paneId, entry.updatedAt);
    }
  });
  const untapTurnStart = tapAgentTurnStart((entry) => {
    noteExecution(entry.sessionId, entry.paneId, entry.observedAt);
  });
  setPaneStartKick(() => {
    void checkPaneStarts(Date.now());
  });
  disposePaneStartTaps = () => {
    untapFailure();
    untapTermination();
    untapTurnEnd();
    untapStatus();
    untapTurnStart();
    setPaneStartKick(null);
  };
}

async function scanSuite(suite: ProjectDomainStoreSuite, now: number, context: PeriodicTaskContext): Promise<void> {
  const liveStates = new Set<PaneRuntimeState>([
    'spawning', 'busy', 'idle', 'unknown',
  ]);
  const liveSessionIds = new Set<string>();
  missions: for await (const missionId of iteratePeriodicMissionIds(suite.missions, context)) {
    await context.checkpoint();
    const mission = suite.missions.get(missionId);
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
      // F-680: worker trabalhando é progresso — o relógio do aviso recomeça.
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
      // F-986: o sinal é a atividade real do pane (saída, turno, ferramenta),
      // não o disco — estudo somente leitura nunca grava arquivo.
      const seenKey = scopeKey(suite);
      let seenBySession = zeroDeliverySeen.get(seenKey);
      if (!seenBySession) {
        seenBySession = new Map();
        zeroDeliverySeen.set(seenKey, seenBySession);
      }
      const activity = zeroDeliveryWorkerActivity({
        workers: panes.filter((pane) => pane.role === 'worker'),
        now,
        semanticStatus: getAgentSemanticStatusBySession,
        toolActivityCount: getAgentToolActivityCount,
        previous: (sessionId) => seenBySession.get(sessionId),
      });
      for (const [sessionId, seen] of activity.seen) {
        seenBySession.set(sessionId, seen);
      }
      const zd = decideZeroDeliveryWatchdog({
        missionStatus: mission.status,
        lane: lane ?? null,
        workerPanes: workerPaneCount,
        workerHandoffCount,
        orchestratorState: orchestratorPaneState,
        executingSinceMs,
        now,
        alreadyPoked: zeroDeliveryPoked.has(mission.id),
        workerActivity: activity,
      });
      if (zd.action === 'poke' && !zeroDeliveryPoked.has(mission.id)) {
        zeroDeliveryPoked.add(mission.id);
        try {
          const handoff = suite.handoffs.submit({
            missionId: mission.id,
            status: 'progress',
            summary: zeroDeliveryPokeSummary(mission.id, zd.sinceMs, {
              readOnly: zd.readOnly,
              quietMs: zd.quietMs,
            }),
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
            summary: zeroDeliveryEscalateSummary(mission.id, {
              readOnly: zd.readOnly,
              quietMs: zd.quietMs,
            }),
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

    // Registered ready work and vacant physical slots cannot hide behind idle
    // helpers or a long gate. This advises the exact leader; it never spawns.
    {
      const key = `${scopeKey(suite)}\0${mission.id}`;
      const leader = panes.find(pane => pane.role === 'orchestrator' &&
        pane.sessionId === mission.orchestratorSessionId && pane.scope && sameProjectScope(pane.scope, suite.scope));
      const physicalLeaderState = leader?.sessionId ? getSessionState(leader.sessionId) : null;
      const orchestratorAlive = physicalLeaderState === 'busy' || physicalLeaderState === 'spawning' || physicalLeaderState === 'idle';
      const authorized = orchestratorAlive && leader?.readOnly !== true &&
        lane !== 'plan' && lane !== 'consult' &&
        hasCurrentDispatchAuthority(mission, { workerPaneCount });
      let readyTaskIds: readonly string[] = [];
      let backlogKey: string | undefined;
      const cap = mission.intentContract?.budgets?.maxWorkers ?? 0;
      // Match the spawn gate's durable pre-bind reservations as well as visible
      // workers. An unbound spawn is not a free slot; old exited rows are.
      const snapshotStates = new Map(listPaneSnapshots().map(pane => [pane.paneId, pane.state]));
      const reservedWorkers = authorized ? suite.missionPanes.list(mission.id).filter(row => row.role === 'worker' &&
        (!row.paneId || (snapshotStates.has(row.paneId) && snapshotStates.get(row.paneId) !== 'exited'))).length : 0;
      const availableSlots = Math.max(0, cap - Math.max(workerPaneCount, reservedWorkers));
      if (authorized && availableSlots > 0) {
        // The current sealed receipt supplies immutable dependency metadata. An
        // absent receipt is acceptable only for already-approved free execution.
        const receipt = suite.tasks.getPlanReceipt(mission.id, mission.intentVersion!);
        if (receipt || mission.intentContract?.freeAgentChoice === true) {
          const backlog = momentumReadyBacklog({
            tasks: suite.tasks.list(mission.id), sealedTasks: receipt?.tasks,
            dispatches: suite.taskDispatches.list(mission.id).filter(row => row.intentVersion === mission.intentVersion),
            intentVersion: mission.intentVersion,
          });
          readyTaskIds = backlog.readyTaskIds; backlogKey = backlog.backlogKey;
        }
      }
      if (readyTaskIds.length && availableSlots > 0) {
        if (!momentumReadySince.has(key)) momentumReadySince.set(key, now);
      } else momentumReadySince.delete(key);
      const usefulWorkingWorkers = panes.filter(pane => {
        if (pane.role !== 'worker' || !pane.sessionId) return false;
        const physical = getSessionState(pane.sessionId);
        if (physical !== 'busy' && physical !== 'spawning' && physical !== 'idle') return false;
        const semantic = getAgentSemanticStatusBySession(pane.sessionId);
        if (semantic) return semantic.status === 'working' && (physical === 'busy' || physical === 'spawning' || now - semantic.updatedAt < WORKER_HUNG_AFTER_MS);
        return physical === 'busy' || physical === 'spawning';
      }).length;
      if (workerPaneCount > 0) momentumSoloSince.delete(key);
      else if (!momentumSoloSince.has(key)) momentumSoloSince.set(key, now);
      const persisted = recoveries.filter(row => row.summary.startsWith(`[momentum:${mission.id}]`)).at(-1);
      const remembered = momentumNudgedAt.get(key);
      const lastNotice = remembered && (!persisted || remembered.at >= persisted.createdAt)
        ? remembered : persisted ? { at: persisted.createdAt, backlogKey: persisted.summary.match(/\[momentum-ready:([a-f0-9]{64})\]/u)?.[1] } : null;
      const momentum = decideMomentumNudge({
        missionStatus: mission.status, lane: lane ?? null, maxWorkers: cap,
        workerPanes: workerPaneCount, orchestratorAlive, dispatchAuthorized: authorized,
        readOnly: leader?.readOnly === true, readyTaskIds, availableSlots, usefulWorkingWorkers,
        readySinceMs: momentumReadySince.get(key) ?? null,
        soloSinceMs: momentumSoloSince.get(key) ?? null,
        lastNudgeAtMs: lastNotice?.at ?? null, backlogKey, lastBacklogKey: lastNotice?.backlogKey,
        now,
      });
      if (momentum.action === 'nudge' && current()) {
        // Task/dispatch/reservation changes do not necessarily update the
        // mission row or physical pane list while the model is answering.
        const workStamp = () => JSON.stringify([
          suite.tasks.list(mission.id).map(row => [row.id, row.status, row.detail, row.providerWaiverReason]),
          suite.taskDispatches.list(mission.id).map(row => [row.taskId, row.intentVersion, row.state, row.revision, row.attempt]),
          suite.missionPanes.list(mission.id).map(row => [row.paneId, row.role]),
        ]);
        const initialWorkStamp = workStamp();
        try {
          // Jev (06/10): o watchdog mecânico detetou o candidato; o Jev
          // refina (preso vs gate longo vs recuperando). Fail-open: sem
          // resposta o texto mecânico vale. Só roda quando a regra dispara,
          // nunca a cada tick.
          const mechanicalText = momentumNudgeSummary(mission.id, momentum.soloForMs, momentum);
          let nudgeText = mechanicalText;
          try {
            const judgment = await context.wait(judgeMissionMomentum({
              missionId: mission.id,
              missionStatus: mission.status,
              workerPanes: workerPaneCount,
              readyTaskIds,
              availableSlots: momentum.availableSlots ?? 0,
              soloForMs: momentum.soloForMs,
              readyForMs: momentum.readyTaskIds?.length ? (now - (momentumReadySince.get(key) ?? now)) : null,
              heavyCommandsActive: null,
              recentHandoffs: null,
              orchestratorAlive,
            }, { signal: context.signal }));
            // Durable dependency/slot proof wins over a model's suggestion
            // to wait. The judgment refines uncertain solo work only.
            nudgeText = momentum.readyTaskIds?.length
              ? mechanicalText
              : momentumNudgeFromJudgment(judgment, mechanicalText);
          } catch {
            // Jev indisponível: decisão mecânica vale.
          }
          if (!current() || workStamp() !== initialWorkStamp) continue missions;
          const handoff = suite.handoffs.submit({
            missionId: mission.id, status: 'progress',
            summary: nudgeText,
            fromAgent: DELEGATION_SUPERVISOR_AGENT,
          });
          // Failed submission cannot consume the only opportunity to resume work.
          momentumNudgedAt.set(key, { at: now, backlogKey: momentum.backlogKey });
          onHandoffSubmitted(handoff, suite.scope);
          console.warn(`[delegation-supervisor] momentum nudge for ${mission.id}`);
        } catch (error) {
          context.assertCurrent();
          console.warn('[delegation-supervisor] momentum nudge falhou:', error instanceof Error ? error.message : error);
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
  const seenBySession = zeroDeliverySeen.get(scopeKey(suite));
  if (seenBySession) {
    for (const sessionId of [...seenBySession.keys()]) {
      if (!liveSessionIds.has(sessionId)) seenBySession.delete(sessionId);
    }
  }
  const outputSeenAt = hungWorkerOutputSeenAt.get(scopeKey(suite));
  if (outputSeenAt) {
    for (const sessionId of [...outputSeenAt.keys()]) {
      if (!liveSessionIds.has(sessionId)) outputSeenAt.delete(sessionId);
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
    await budget.wait(checkLimitedTaskPanes(now, budget));
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
  zeroDeliverySeen.clear();
  handoffRearmLastRun.clear();
  hungWorkerNotifiedAt.clear();
  hungWorkerOutputSeenAt.clear();
  momentumSoloSince.clear();
  momentumNudgedAt.clear();
  momentumReadySince.clear();
}
