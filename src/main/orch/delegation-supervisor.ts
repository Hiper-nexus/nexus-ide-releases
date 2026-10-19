import { AsyncProcessGitRunner, assertSafeLocalGitConfigAsync } from '../runtime/git-command';
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
import { setCooldown } from '../persistence/account-store';
import { getPtyAnalysisLimitEvidence } from '../pty/pty-analysis-runtime';
import { WORKSPACE_HANDOFF_DELIVERY_PREFIX } from './workspace-handoff-delivery';
import {
  applyStartFailureBreaker,
  decideStartAction,
  executionProofGraceMs,
  finishPaneStartWatch,
  forgetConfirmedPaneLimit,
  LIMIT_HANDOFF_MS,
  LOGIN_SCREEN_ACCOUNT_PAUSE_MS,
  loginScreenAccountPauseReason,
  listConfirmedPaneLimits,
  listPaneStartWatches,
  notePaneSessionEnded,
  notePaneStartFailure,
  notePaneStartPressure,
  notePaneTurnEnded,
  notStartedCause,
  paneLimitNoticeSummary,
  paneStartNoticeSummary,
  paneStartProgress,
  paneStartWatchForSession,
  providerLoginDetail,
  providerLoginScreen,
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
  emitMissionEvent,
} from './mission-event-emit';
import {
  decideZeroDeliveryWatchdog,
  zeroDeliveryEscalateSummary,
  zeroDeliveryPokeSummary,
  zeroDeliveryWorkerActivity,
  type ZeroDeliverySeen,
} from './zero-delivery-watchdog';
import { flushAllNexusTaskFailClosedRetries } from './nexus-task-fail-closed-recovery';
import {
  MOMENTUM_OPERATOR_WAIT_CEILING_MS,
  awaitingOperatorDecision,
  decideMomentumNudge,
  momentumNudgeSummary,
  momentumReadyBacklog,
} from './mission-momentum-watchdog';
import { hasOpenClarifyQuestion } from './mission-open-question';
import { hasCurrentCompletionRequest } from './operator-tab-completion';
import { getContextBySession } from './gate';
import { judgeMissionMomentum, momentumNudgeFromJudgment } from './jev-mission-momentum';
import {
  getAgentLastTurnEnd,
  getAgentSemanticStatusBySession,
  getAgentToolActivityCount,
  getAgentTurnStartSequence,
  isAgentAwaitingOperator,
  SEMANTIC_WORKING_VETO_MS,
  tapAgentSemanticStatus,
  tapAgentTurnEnd,
  tapAgentTurnStart,
} from './agent-status';
import {
  forgetPaneTaskReroute,
  getPaneTaskReroute,
  MAX_PANE_TASK_REROUTES,
  paneTaskRerouteBlocker,
  registerPaneTaskReroute,
} from './pane-task-reroute';
import { trace } from '../observability/main-trace';
import {
  failoverReopensTask,
  hasPendingFailoverRecovery,
  reportPaneMeasuredExhaustion,
} from './failover';
import { noteMissionCliFailure } from './mission-cli-failures';
import { sanitizePaneBootOutput } from './pane-boot-output';
import { paneSessionLastOutputAt } from './pane-session-output';
import { diagnosePaneBoot } from './pane-boot-diagnosis';
import {
  mainPressureNow,
  parsePaneAdmissionRefusal,
  parseMainPressureRefusal,
} from './pane-admission';
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
/** Chaves já semeadas do ledger: semear só uma vez por processo, senão uma onda nova herda o carimbo antigo. */
const momentumReadySeeded = new Set<string>();
/** Espera de decisão humana: relógio do episódio e lembrete já emitido. */
const operatorWaitSince = new Map<string, number>();
const operatorWaitReminded = new Set<string>();

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

/**
 * Silêncio por sessão de worker SEM status semântico (CLI sem hook), POR suite
 * (mesmo motivo do F-725). `silentSince` é a primeira varredura que a viu sem
 * ferramenta e sem saída; ferramenta nova ou PTY produzindo recomeça o relógio.
 */
const hungWorkerSilentSeenAt = new Map<
  string,
  Map<string, { readonly silentSince: number; readonly toolCount: number }>
>();

/** Última atividade do worker: o status semântico ou a última saída vista. */
export function workerLastActivityAt(
  semanticUpdatedAt: number,
  outputSeenAt: number | undefined,
): number {
  return Math.max(semanticUpdatedAt, outputSeenAt ?? semanticUpdatedAt);
}

/**
 * Worker SEM telemetria (CLI sem hook de status): a única datação possível é o
 * relógio de silêncio que o supervisor mede entre varreduras — a primeira
 * leitura que o viu sem ferramenta e sem saída. Mesma regra do caminho com
 * status, outra fonte de prova.
 */
function silentWorkerLastActivityAt(
  silentSince: number,
  outputSeenAt: number | undefined,
): number {
  return Math.max(silentSince, outputSeenAt ?? silentSince);
}

export function decideWorkerHung(input: {
  readonly semanticStatus: string | undefined;
  readonly semanticUpdatedAt: number | undefined;
  /** F-1380: última varredura que viu saída do PTY deste worker. */
  readonly outputSeenAt?: number;
  readonly paneState: PaneRuntimeState | undefined;
  readonly notifiedAt: number | null;
  readonly now: number;
  /**
   * CLI sem status semântico: desde quando esta sessão está sem ferramenta e
   * sem saída. Ausente = ainda sem prova de silêncio (primeira varredura).
   */
  readonly silentSince?: number;
}): 'none' | 'notify' | 'renotify' {
  // CLI sem hook não publica `working`: sem este caminho o worker calado
  // nunca era marcado como travado e a task esperava umPane morto.
  const telemetryLess = input.semanticStatus === undefined;
  if (!telemetryLess && input.semanticStatus !== 'working') return 'none';
  if (!telemetryLess && input.semanticUpdatedAt === undefined) return 'none';
  if (telemetryLess && input.silentSince === undefined) return 'none';
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
  const lastActivityAt = telemetryLess
    ? silentWorkerLastActivityAt(input.silentSince!, input.outputSeenAt)
    : workerLastActivityAt(input.semanticUpdatedAt!, input.outputSeenAt);
  if (input.now - lastActivityAt < WORKER_HUNG_AFTER_MS) {
    return 'none';
  }
  if (input.notifiedAt === null) return 'notify';
  return input.now - input.notifiedAt >= WORKER_HUNG_RENOTIFY_MS
    ? 'renotify'
    : 'none';
}

/** Ocioso sem commit nem handoff: cutuca aos 8 min e reabre aos 16. */
export const IDLE_WORKER_NUDGE_AFTER_MS = 8 * 60_000;
export const IDLE_WORKER_REOPEN_AFTER_MS = 16 * 60_000;

/**
 * Pin que impede cutucar e reabrir. `operatorPinned: false` é retomada e
 * não prende. Ausente: o `pinnedRuntime` antigo continua prendendo.
 */
export function idleWorkerPinBlocks(input: {
  readonly operatorPinned?: boolean;
  readonly pinnedRuntime: boolean;
}): boolean {
  if (input.operatorPinned === true) return true;
  if (input.operatorPinned === false) return false;
  return input.pinnedRuntime;
}

/** Decisão pura. O relógio e o git ficam no supervisor. */
export function decideIdleWorkerRecovery(input: {
  readonly role: string | undefined;
  readonly operatorOpened: boolean;
  readonly pinBlocked: boolean;
  readonly paneState: string | undefined;
  readonly idleForMs: number | null;
  readonly hasCommit: boolean;
  readonly hasHandoff: boolean;
  readonly nudged: boolean;
  readonly sinceNudgeMs: number | null;
  readonly reopened: boolean;
  readonly hasAlternative: boolean;
}): 'none' | 'nudge' | 'reopen' {
  if (input.role !== 'worker' || input.operatorOpened || input.pinBlocked) return 'none';
  if (input.paneState !== 'idle' || input.idleForMs === null) return 'none';
  if (input.hasCommit || input.hasHandoff) return 'none';
  if (!input.nudged) return input.idleForMs >= IDLE_WORKER_NUDGE_AFTER_MS ? 'nudge' : 'none';
  if (
    !input.reopened &&
    input.hasAlternative &&
    input.sinceNudgeMs !== null &&
    input.sinceNudgeMs >= IDLE_WORKER_NUDGE_AFTER_MS &&
    input.idleForMs >= IDLE_WORKER_REOPEN_AFTER_MS
  ) {
    return 'reopen';
  }
  return 'none';
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
  handoffs: readonly Handoff[],
  orchestratorStaleBusy = false,
): void {
  let pendingDeliverable = 0;
  try {
    pendingDeliverable = pendingDeliverableHandoffs(handoffs.filter(row => !row.delivered));
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
    const rearmed = redeliverPendingHandoffs(
      suite.scope,
      mission.id,
      undefined,
      { requeueExpiredParks: true },
    );
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
  // Idempotency: if stage key already present in summaries, do not re-fire.
  const stage1Key = recoveryHandoffIdempotencyKey(progress.mission.id, 1);
  const stage2Key = recoveryHandoffIdempotencyKey(progress.mission.id, 2);
  // The budget counts only handoffs that carried a bounded recovery
  // instruction. The queued-TTL expiry marks stale rows 'submitted' without
  // any PTY delivery — counting every non-queued row let two expired rows
  // (a stale stage-1 plus a momentum nudge) exhaust the two-attempt budget
  // and the real stage-2 remount never fired.
  const deliveredRecoveries = progress.recoveries.filter(
    (item) =>
      item.deliveryState !== 'queued' &&
      (item.summary.includes(stage1Key) || item.summary.includes(stage2Key)),
  );
  if (deliveredRecoveries.length >= 2) return 0;
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
  const silentSeenAt = hungWorkerSilentSeenAt.get(scopeKey(suite)) ?? new Map();
  hungWorkerSilentSeenAt.set(scopeKey(suite), silentSeenAt);
  for (const hint of panes) {
    await context.checkpoint();
    if (!current()) return;
    const pane = listPaneSnapshots().find((live) => live.paneId === hint.paneId &&
      live.sessionId === hint.sessionId && live.missionId === mission.id);
    if (!pane) continue;
    if (pane.role !== 'worker' || !pane.sessionId) continue;
    const producing = pane.state === 'busy' || pane.state === 'spawning';
    if (producing) outputSeenAt.set(pane.sessionId, now);
    const semantic = getAgentSemanticStatusBySession(pane.sessionId);
    // Sem status semântico: mede-se o silêncio entre varreduras. Ferramenta
    // nova ou PTY produzindo é trabalho e recomeça o relógio.
    let silentSince: number | undefined;
    if (!semantic) {
      const toolCount = getAgentToolActivityCount(pane.sessionId);
      const seen = silentSeenAt.get(pane.sessionId);
      silentSince = !seen || producing || toolCount > seen.toolCount ? now : seen.silentSince;
      silentSeenAt.set(pane.sessionId, { silentSince, toolCount });
    }
    const decision = decideWorkerHung({
      semanticStatus: semantic?.status,
      semanticUpdatedAt: semantic?.updatedAt,
      outputSeenAt: outputSeenAt.get(pane.sessionId),
      paneState: pane.state,
      notifiedAt: notifiedAt.get(pane.sessionId) ?? null,
      now,
      ...(silentSince !== undefined ? { silentSince } : {}),
    });
    if (decision === 'none') continue;
    notifiedAt.set(pane.sessionId, now);
    const updatedAt = silentSince !== undefined
      ? silentWorkerLastActivityAt(silentSince, outputSeenAt.get(pane.sessionId))
      : workerLastActivityAt(semantic!.updatedAt!, outputSeenAt.get(pane.sessionId));
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

/**
 * Pane morto sai da grade, desde que ninguém tenha outra sessão viva nele.
 * Devolve `true` só quando ele SAIU — `requestPaneClose` responde `true`
 * apenas quando removeu o pane do registro, então o retorno é a prova.
 */
async function closeNotStartedPane(watch: PaneStartWatch): Promise<boolean> {
  const snapshot = listPaneSnapshots().find((pane) => pane.paneId === watch.paneId);
  if (!snapshot) return true;
  const current = snapshot.sessionId ?? undefined;
  if (current && current !== watch.sessionId) return false;
  try {
    // Revisão Fable (F-1414): pane parked não tem sessão viva — fechar pela
    // sessão morta devolve false e deixa um zumbi no layout. Fecha pelo pane.
    return await requestPaneClose(
      watch.paneId,
      snapshot.state === 'parked' ? undefined : current,
    );
  } catch {
    // Fechar é limpeza; o aviso e o reenvio importam mais.
    return false;
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
  // F-1477: CLI viva, sem turno, parada na tela de login do provedor (Grok com
  // OAuth vencido) é credencial recusada: o disjuntor abre e a rota para de
  // mandar trabalho a uma CLI que morreria igual em todo pane novo.
  const loginScreen = failureCause === 'turn-not-started' && providerLoginScreen(outputTail);
  // Só a saída no boot vira recusa de modelo: a recusa do provedor no turno
  // (`provider-request`, F-765) já tem causa e é do failover.
  const cause: PaneNotStartedCause =
    diagnosis.modelRejected && failureCause === 'boot-exit'
      ? 'model-rejected'
      : loginScreen
        ? 'provider-auth'
        : failureCause;
  // F-1270: recusa de capacidade (teto/memória) é CLI-agnóstica — não é falha
  // da CLI nem do modelo. Não reroteia (outra CLI esbarra no mesmo teto), não
  // conta no disjuntor e devolve a mensagem real a quem pediu.
  // F-1534: recusa por CARGA da máquina (descritores, memória do SO, Main
  // encerrando PTYs, licença) entra na mesmaFamily: trocar de CLI não resolve.
  const capacityRefused = cause === 'capacity-refused' || cause === 'main-pressure-refused';
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
  // Revisão Grok (F-1414): o worker pode entregar enquanto este passo roda
  // (os awaits de fechar e de rerotear). Entrega vista = a tarefa foi feita:
  // nada de fechar, contar no disjuntor, reabrir noutra CLI nem avisar.
  const deliveredMeanwhile = (): boolean => {
    if (watch.sessionId === null || !sessionHasHandoff(watch, watch.sessionId)) return false;
    console.warn(`[delegation-supervisor] pane ${watch.paneId} entregou durante a recuperação; nada reaberto`);
    finishPaneStartWatch(watch);
    return true;
  };
  if (deliveredMeanwhile()) return;
  let breaker: 'trip' | 'count' | 'skipped' = 'skipped';
  // F-734: o escopo da credencial é lido antes de fechar (a sessão some).
  const session = watch.sessionId !== null ? getAgentSessionInfo(watch.sessionId) : null;
  const accountBound = Boolean(session?.accountId);
  // F-1534: o pane original precisa ter SAÍDO antes do sucessor abrir. Campo
  // 14/10: em um caso ele ficou com o brief e o sucessor nasceu em paralelo.
  let paneClosed = watch.operatorOpened === true;
  if (!watch.operatorOpened) {
    paneClosed = await closeNotStartedPane(watch);
    if (deliveredMeanwhile()) return;
    if (!capacityRefused) {
      // Recusa de capacidade não é falha da CLI: fecha o pane morto, mas não
      // conta no disjuntor do adapter.
      breaker = startFailureBreakerAction({ cause, accountBound });
      applyStartFailureBreaker(adapterCircuitBreakers, watch.adapterId, breaker);
      // F-1477: conta gerenciada na tela de login é estado DESSA credencial —
      // sai da escolha automática sem derrubar as outras contas da CLI (e o
      // sucesso de outra conta não a libera). Login nativo é a chave global:
      // o disjuntor do adapter acima.
      if (loginScreen && session?.accountId) {
        try {
          setCooldown(
            session.accountId,
            Date.now() + LOGIN_SCREEN_ACCOUNT_PAUSE_MS,
            loginScreenAccountPauseReason(watch.adapterId),
          );
        } catch (error) {
          console.warn(`[delegation-supervisor] pausa da conta sem login falhou: ${shortStartError(error)}`);
        }
      }
      // F-1427: a tarefa saiu desta CLI sem prova de execução — falha dela
      // nesta missão (o exclude do Maestro vale e o sucesso 14d registra).
      if (watch.missionId) {
        noteMissionCliFailure({
          missionId: watch.missionId,
          adapterId: watch.adapterId,
          ...(session?.model ? { model: session.model } : {}),
          cause: 'no-execution-proof',
          attemptKey: watch.sessionId ?? watch.requestId,
        });
      }
    }
  }
  let outcome: PaneStartOutcome;
  if (capacityRefused) {
    outcome = {
      kind: 'not-rerouted',
      why: cause === 'main-pressure-refused' ? 'pressure' : 'capacity',
    };
  } else if (action === 'reroute' && watch.reroute) {
    if (deliveredMeanwhile()) return;
    // F-1534: só reabre com o pane original fora da grade. Duas instâncias
    // com o mesmo brief é pior do que a tarefa esperar.
    if (!paneClosed) {
      outcome = {
        kind: 'reroute-failed',
        error: 'o pane original não saiu da grade; feche-o antes de reenviar',
      };
    } else {
      try {
        const next = await watch.reroute([watch.adapterId]);
        outcome = { kind: 'rerouted', paneId: next.paneId, adapterId: next.adapterId };
      } catch (error) {
        outcome = { kind: 'reroute-failed', error: shortStartError(error) };
      }
    }
  } else {
    outcome = {
      kind: 'not-rerouted',
      why: watch.operatorOpened
        ? 'operator'
        : startRerouteChainExhausted(watch)
          ? 'chain-limit'
          : (watch.failure?.cause !== 'brief-rejected' || watch.operatorPinned !== false) && watch.pinnedRuntime
            ? 'pinned'
            : watch.operatorPinned === true
              ? 'pinned'
              : 'no-alternative',
    };
  }
  // F-1270: o motivo da recusa de capacidade viaja em `failure.detail` (o
  // diagnóstico do boot só existe com sessão; aqui o spawn foi recusado antes).
  const detail = loginScreen
    ? providerLoginDetail(watch.adapterId, accountBound)
    : diagnosis.detail ?? watch.failure?.detail ?? null;
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
  // F-1534: a máquina/Main no limite agora. Veredito por PRAZO espera a
  // pressão assentar (MAIN_PRESSURE_SETTLE_MS); falha PROVADA não espera.
  const mainPressure = mainPressureNow();
  if (mainPressure) notePaneStartPressure(watch, now);
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
    operatorPinned: watch.operatorPinned,
    failureCause: watch.failure?.cause ?? null,
    generation: watch.generation ?? (watch.rerouted ? 1 : 0),
    hasAlternative: watch.hasAlternative?.() ?? false,
    mainPressure,
    pressureSince: watch.pressureSince,
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
      // F-1473: substituto ainda sob a prova da retomada — a recuperação dele
      // é do failover (uma por tarefa), não desta ficha.
      if (hasPendingFailoverRecovery(watch.paneId, watch.sessionId ?? '')) continue;
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
const IDLE_NUDGE =
  'Você está ocioso sem commit nem nexus_handoff_submit. Entregue o que já fez, ou diga o bloqueio. Sem isso o Nexus reabre a tarefa em outra CLI.';

interface IdleWorkerRow {
  since: number;
  nudgedAt: number | null;
  reopened: boolean;
}

const idleWorkerRows = new Map<string, IdleWorkerRow>();

/** true = commit no intervalo; null = git não respondeu (não decide). */
export function gitCommitSince(root: string, sinceMs: number): Promise<boolean | null> {
  const git = new AsyncProcessGitRunner();
  return (async () => {
    // Mesmo envelope do resto do Main: config local executável recusada antes
    // do log, flags seguras do runner e `log.showSignature` desligado (o
    // format %H é o único dado que interessa aqui).
    await assertSafeLocalGitConfigAsync(git, root);
    const result = await git.run(root, [
      '-c', 'log.showSignature=false',
      'log', '-1', '--format=%H', `--since=${new Date(sinceMs).toISOString()}`,
    ], { allowFailure: true, timeoutMs: 2000 });
    if (result.status !== 0) return null;
    return /^[0-9a-f]{7,64}$/i.test(String(result.stdout ?? '').trim());
  })().catch(() => null);
}

async function recoverIdleWorkers(
  suite: ProjectDomainStoreSuite,
  panes: readonly PaneSnapshot[],
  now: number,
  current: () => boolean,
): Promise<void> {
  for (const pane of panes) {
    if (!pane.sessionId || pane.role !== 'worker' || pane.state !== 'idle') {
      if (pane.sessionId) idleWorkerRows.delete(pane.sessionId);
      continue;
    }
    const sessionId = pane.sessionId;
    let row = idleWorkerRows.get(sessionId);
    if (!row) {
      row = { since: now, nudgedAt: null, reopened: false };
      idleWorkerRows.set(sessionId, row);
      if (idleWorkerRows.size > 256) {
        const oldest = idleWorkerRows.keys().next().value;
        if (oldest !== undefined && oldest !== sessionId) idleWorkerRows.delete(oldest);
      }
    }
    if (now - row.since < IDLE_WORKER_NUDGE_AFTER_MS) continue;
    if (!current()) return;
    const handle = getPaneTaskReroute(pane.paneId, now);
    const pinBlocked = idleWorkerPinBlocks({
      operatorPinned: handle?.operatorPinned,
      pinnedRuntime: handle?.pinnedRuntime === true,
    });
    let hasHandoff = true;
    try {
      hasHandoff = suite.handoffs.list({ sessionIds: [sessionId], includeDelivered: true })
        .some((handoff) => handoff.sessionId === sessionId && handoff.fromAgent !== DELEGATION_SUPERVISOR_AGENT);
    } catch {
      continue;
    }
    let hasCommit = false;
    const root = pane.executionScope?.rootRealPath;
    if (root) {
      const committed = await gitCommitSince(root, row.since);
      if (!current()) return;
      if (committed === null) continue;
      hasCommit = committed;
    }
    const chainBlocked = (handle?.generation ?? 0) >= MAX_PANE_TASK_REROUTES;
    const hasAlternative = Boolean(
      handle && !chainBlocked && !mainPressureNow() && handle.hasAlternative([handle.adapterId]),
    );
    const decision = decideIdleWorkerRecovery({
      role: pane.role,
      operatorOpened: pane.operatorOpened === true || handle?.operatorOpened === true,
      pinBlocked,
      paneState: pane.state,
      idleForMs: now - row.since,
      hasCommit,
      hasHandoff,
      nudged: row.nudgedAt !== null,
      sinceNudgeMs: row.nudgedAt === null ? null : now - row.nudgedAt,
      reopened: row.reopened,
      hasAlternative,
    });
    if (decision === 'none') continue;
    if (decision === 'nudge') {
      row.nudgedAt = now;
      try {
        const { injectPrompt } = await import('./tool-util');
        await injectPrompt(sessionId, IDLE_NUDGE);
      } catch (error) {
        console.warn(`[delegation-supervisor] cutucão ocioso falhou (pane=${pane.paneId}): ${shortStartError(error)}`);
      }
      continue;
    }
    if (!handle || handle.operatorOpened) continue;
    row.reopened = true;
    releasePaneStartWatch(pane.paneId);
    forgetPaneTaskReroute(pane.paneId);
    const closed = await requestPaneClose(pane.paneId, sessionId).catch(() => false);
    if (!current()) return;
    if (!closed) {
      registerPaneTaskReroute(handle);
      console.warn(`[delegation-supervisor] worker ocioso ${pane.paneId} não fechou; nada foi reaberto`);
      continue;
    }
    if (pane.missionId) {
      noteMissionCliFailure({
        missionId: pane.missionId,
        adapterId: handle.adapterId,
        ...(pane.model ? { model: pane.model } : {}),
        cause: 'idle-without-delivery',
        attemptKey: sessionId,
      });
    }
    try {
      const next = await handle.reroute({
        excludeAdapterIds: [handle.adapterId],
        worktreeFromPaneId: pane.paneId,
      });
      console.warn(`[delegation-supervisor] worker ocioso ${pane.paneId} reaberto em ${next.adapterId} (${next.paneId})`);
    } catch (error) {
      console.warn(`[delegation-supervisor] reabertura ociosa falhou (pane=${pane.paneId}): ${shortStartError(error)}`);
    }
  }
}

export async function checkLimitedTaskPanes(
  now: number = Date.now(),
  context?: PeriodicTaskContext,
): Promise<void> {
  for (const limit of listConfirmedPaneLimits()) {
    context?.assertCurrent();
    // F-1427: o erro de provedor que já gastou o retry chega pronto (`readyAt`).
    if (now < (limit.readyAt ?? limit.at + LIMIT_HANDOFF_MS)) continue;
    const pane = listPaneSnapshots().find((live) => live.paneId === limit.paneId);
    const physical = getSessionState(limit.sessionId);
    // Revisão Fable M2: a mesma regra do checkPaneStart — PTY ocupado não
    // recebe veredito (o Muse refaz sozinho depois do limite e volta a
    // imprimir, sem status semântico). Só adia: a ficha fica para a próxima.
    if (pane?.sessionId === limit.sessionId && (physical === 'busy' || physical === 'spawning')) continue;
    // F-1471: o failover ainda cuida do pane (espera-pela-irmã agendada ou
    // troca de conta em curso): reabrir noutra CLI agora daria dois workers.
    // Só adia — a ficha fica para a próxima passada.
    if (hasPendingFailoverRecovery(limit.paneId, limit.sessionId)) continue;
    forgetConfirmedPaneLimit(limit.paneId);
    // O failover já agiu (sessão nova no pane, pane fechado) ou o pane morreu.
    if (!pane?.scope || pane.sessionId !== limit.sessionId) continue;
    if (physical === null) continue;
    // Saída nova depois do limite (fora do redesenho logo após ele): voltou.
    const lastOutputAt = paneSessionLastOutputAt(limit.sessionId);
    if (lastOutputAt !== undefined && lastOutputAt > limit.at + START_SETTLE_MS) continue;
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
    // F-1427: a tarefa não saiu deste pane — falha da CLI nesta missão, com
    // ou sem reabertura (teto, operador e pin também não fazem a tarefa andar).
    if (handle.missionId && handle.role === 'worker' && !handle.operatorOpened) {
      noteMissionCliFailure({
        missionId: handle.missionId,
        adapterId: limit.adapterId,
        ...(limit.model ? { model: limit.model } : {}),
        cause: limit.kind === 'provider-error' ? 'provider-error' : 'usage-limit',
        attemptKey: limit.sessionId,
      });
    }
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
      // F-1486: o pedido sai do registro ANTES do primeiro await — uma troca
      // de conta que comece durante o fechamento não o acha nem reabre a
      // mesma tarefa em paralelo. Pane que não fechou devolve o pedido.
      forgetPaneTaskReroute(limit.paneId);
      const closed = await requestPaneClose(limit.paneId, limit.sessionId).catch(() => false);
      if (!closed) {
        registerPaneTaskReroute(handle);
        outcome = { kind: 'reroute-failed', error: 'o pane parado não fechou; nada foi reaberto' };
      } else if (failoverReopensTask(limit.paneId)) {
        // O failover assumiu a tarefa durante o fechamento: o pedido é dele.
        registerPaneTaskReroute(handle);
        continue;
      } else {
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
      ...(limit.kind ? { kind: limit.kind } : {}),
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
    // F-1534: campo 14/10 — com o Main sob carga, recusa por CARGA (descritores,
    // memória do SO, Main encerrando PTYs, teto da licença) chegava como
    // `spawn-refused`: contava no disjuntor da CLI (F-736) e mandava a tarefa
    // para outra CLI. Trocar de CLI não resolve falta de recurso da máquina,
    // então isso é CLI-agnóstico como a capacidade.
    const pressure = refusal ? null : parseMainPressureRefusal(failure.error);
    // F-1410: a recusa de CLI leva a 1ª linha saneada do erro para o trace
    // local — sem isso a causa só ia ao console e o diagnóstico se perdia
    // (dois spawns do Muse de 12/10 recusados sem motivo em lugar nenhum).
    notePaneStartFailure(
      failure.paneId,
      refusal ? 'capacity-refused' : pressure ? 'main-pressure-refused' : 'spawn-refused',
      Date.now(),
      refusal?.message ?? pressure?.message,
      refusal || pressure ? undefined : shortStartError(failure.error),
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
    const handoffs = suite.handoffs.list({ missionId: mission.id, includeDelivered: true });
    const recoveries = handoffs
      .filter((handoff) => handoff.fromAgent === DELEGATION_SUPERVISOR_AGENT)
      .sort((left, right) => left.createdAt - right.createdAt);
    // Expire leftover queued recoveries (hello-file / prior mission) so they
    // stop freezing the supervisor and stop idle-delivery spam forever.
    for (const recovery of recoveries) {
      await context.checkpoint();
      if (!current()) continue missions;
      if (
        recovery.deliveryState === 'queued' &&
        now - recovery.createdAt >= RECOVERY_QUEUED_TTL_MS
      ) {
        try {
          // The conditional UPDATE revalidates queued state after checkpoints.
          // Reflect our write in this tick's snapshot; other writes appear next tick.
          if (suite.handoffs.markSubmitted(recovery.id)) {
            recovery.delivered = true;
            recovery.deliveryState = 'submitted';
          }
        } catch (error) {
          console.warn(
            `[delegation-supervisor] falha ao expirar recovery enfileirado ` +
              `${recovery.id}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
    const hasBoundOrchestrator = Boolean(
      mission.orchestratorSessionId ||
        panes.some((pane) => pane.role === 'orchestrator'),
    );
    // Restart seeding: zero-delivery dedups and the momentum ready clock live
    // only in memory — after a boot the poke/escalate repeated and the ready
    // nudge lost its dwell reference. The ledger is the truth: seed the maps
    // from the durable markers this supervisor itself wrote (same pattern as
    // the [momentum:]/lastNudgeAt seed below). Escalation implies the poke.
    // The zero-delivery seed only applies while the worker-handoff reset
    // cannot have fired: once a worker delivers, the watchdog starts a fresh
    // cycle and an old ledger marker must not resurrect the closed one.
    let workerHandoffCount = 0;
    try {
      workerHandoffCount = handoffs
        .filter(
          (handoff) =>
            handoff.fromAgent !== DELEGATION_SUPERVISOR_AGENT &&
            !String(handoff.fromAgent ?? '').startsWith('nexus-'),
        ).length;
    } catch {
      workerHandoffCount = 0;
    }
    {
      let sawZeroDeliveryPoke = false;
      let sawZeroDeliveryEscalate = false;
      let lastReadyNudge: Handoff | undefined;
      for (const row of recoveries) {
        if (row.summary.includes(`[zero-delivery-escalate:${mission.id}]`)) {
          sawZeroDeliveryEscalate = true;
          sawZeroDeliveryPoke = true;
        } else if (row.summary.includes(`[zero-delivery:${mission.id}]`)) {
          sawZeroDeliveryPoke = true;
        }
        if (row.summary.includes('[momentum-ready:')) lastReadyNudge = row;
      }
      if (workerHandoffCount === 0) {
        if (sawZeroDeliveryPoke) zeroDeliveryPoked.add(mission.id);
        if (sawZeroDeliveryEscalate) zeroDeliveryEscalated.add(mission.id);
      }
      if (lastReadyNudge) {
        const momentumKey = `${scopeKey(suite)}\0${mission.id}`;
        if (!momentumReadySeeded.has(momentumKey)) {
          momentumReadySeeded.add(momentumKey);
          if (!momentumReadySince.has(momentumKey)) {
            momentumReadySince.set(momentumKey, lastReadyNudge.createdAt);
          }
        }
      }
    }
    const workerPaneCount = panes.filter((pane) => pane.role === 'worker').length;
    const orchestratorPaneState = panes.find(
      (pane) => pane.role === 'orchestrator',
    )?.state;

    if (mission.status === 'pending' || mission.status === 'running') {
      flushAllNexusTaskFailClosedRetries(suite.scope, mission.id);
      await notifyHungWorkerPanes(suite, mission, panes, now, context, current);
      if (!current()) continue;
      await recoverIdleWorkers(suite, panes, now, current);
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
      rearmStuckHandoffDelivery(suite, mission, orchestratorPaneState, now, handoffs, orchestratorStaleBusy);
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
      // Bug7: missão livre/adotada não ganha suite.tasks dos pedidos de
      // chat, então o backlog confirmado é sempre [] e o ramo solo do
      // F-714 nunca disparava. Registrar cada pedido como task mexeria em
      // sealedCount/taskCount (intent state, recovery, quadro) — em vez
      // disso, só livre/promovida com zero workers cai no solo de 20 min.
      const leaderCtx = leader?.sessionId ? getContextBySession(leader.sessionId) : undefined;
      const soloNudgeWhenNoBacklog =
        mission.intentContract?.freeAgentChoice === true ||
        (leaderCtx?.promotedFromUserSession === true &&
          leaderCtx.role === 'orchestrator' &&
          leaderCtx.missionId === mission.id);
      // O Maestro perguntou e parou: o "Esteira parada" reinjetado a cada
      // hora é ruído no turno dele. Recalculado a cada scan — respondeu o
      // operador ou saiu o latch, o nudge volta sozinho.
      const waitingOperator = awaitingOperatorDecision({
        missionStatus: mission.status,
        intentState: mission.intentState ?? null,
        pendingClarify: hasOpenClarifyQuestion(mission.id, handoffs),
        orchestratorAwaiting: Boolean(
          orchSessionId && isAgentAwaitingOperator(orchSessionId),
        ),
      });
      if (waitingOperator) {
        const waitSince = operatorWaitSince.get(key) ?? now;
        operatorWaitSince.set(key, waitSince);
        // Teto longo: UM lembrete ao OPERADOR, pelo jornal de eventos — que é
        // a superfície dele no inspector. Nada de handoff, que o idle-delivery
        // colaria no PTY do Maestro.
        if (
          now - waitSince >= MOMENTUM_OPERATOR_WAIT_CEILING_MS &&
          !operatorWaitReminded.has(key)
        ) {
          operatorWaitReminded.add(key);
          emitMissionEvent(suite.scope, {
            missionId: mission.id,
            runId: 'delegation-supervisor',
            type: 'custom',
            origin: 'main',
            idempotencyKey: `momentum-awaiting-operator:${mission.id}:${waitSince}`,
            payload: {
              kind: 'momentum-awaiting-operator',
              waitingMinutes: Math.max(1, Math.round((now - waitSince) / 60_000)),
            },
          });
          console.warn(
            `[delegation-supervisor] operator-wait reminder for ${mission.id}`,
          );
        }
      } else {
        operatorWaitSince.delete(key);
        operatorWaitReminded.delete(key);
      }
      const momentum = decideMomentumNudge({
        missionStatus: mission.status, lane: lane ?? null, maxWorkers: cap,
        workerPanes: workerPaneCount, orchestratorAlive, dispatchAuthorized: authorized,
        readOnly: leader?.readOnly === true, readyTaskIds, availableSlots, usefulWorkingWorkers,
        soloNudgeWhenNoBacklog,
        awaitingOperatorDecision: waitingOperator,
        completionRequested: hasCurrentCompletionRequest(suite.scope, mission),
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
          if (!current() || workStamp() !== initialWorkStamp ||
            hasCurrentCompletionRequest(suite.scope, mission)) continue missions;
          const handoff = suite.handoffs.submit({
            missionId: mission.id, status: 'progress',
            summary: nudgeText,
            fromAgent: DELEGATION_SUPERVISOR_AGENT,
          });
          // Failed submission cannot consume the only opportunity to resume work.
          momentumNudgedAt.set(key, { at: now, backlogKey: momentum.backlogKey });
          onHandoffSubmitted(handoff, suite.scope);
          emitMissionEvent(suite.scope, {
            missionId: mission.id,
            runId: 'delegation-supervisor',
            type: 'custom',
            origin: 'main',
            idempotencyKey: `momentum-stalled:${handoff.id}`,
            payload: {
              kind: 'momentum-stalled',
              idleMinutes: Math.max(1, Math.round(momentum.soloForMs / 60_000)),
            },
          });
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
  const silentSeenAt = hungWorkerSilentSeenAt.get(scopeKey(suite));
  if (silentSeenAt) {
    for (const sessionId of [...silentSeenAt.keys()]) {
      if (!liveSessionIds.has(sessionId)) silentSeenAt.delete(sessionId);
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
/**
 * Camada 3.2: pane de tarefa delegada que PAROU em silêncio e cuja conta a
 * medição mostra esgotada. A CLI do AGY não imprime erro reconhecível, então
 * sem isto o pane fica parado para sempre — o relato do cliente.
 *
 * Três guardas, nesta ordem: o pane tem de estar parado (quem trabalha não
 * precisa de resgate), tem de ser tarefa delegada com entrega pendente (pane
 * que TERMINOU nunca recebe pacote de continuidade) e o failover não pode já
 * estar cuidando dele. A decisão final é de `reportPaneMeasuredExhaustion`,
 * que exige leitura `provider-api` fresca e respeita o teto por pane.
 */
export async function checkMeasuredExhaustion(
  now: number = Date.now(),
  context?: PeriodicTaskContext,
): Promise<void> {
  for (const pane of listPaneSnapshots()) {
    context?.assertCurrent();
    if (pane.kind !== 'cli-agent' || !pane.adapterId || !pane.scope || !pane.sessionId) continue;
    const physical = getSessionState(pane.sessionId);
    if (physical === null || physical === 'busy' || physical === 'spawning') continue;
    if (hasPendingFailoverRecovery(pane.paneId, pane.sessionId)) continue;
    // Só tarefa delegada pelo nexus_pane_spawn: o pane do operador nunca é
    // religado por medição de cota.
    const handle = getPaneTaskReroute(pane.paneId, now);
    if (!handle || handle.adapterId !== pane.adapterId) continue;
    let delivered = true;
    try {
      delivered = suiteForScope(pane.scope).handoffs.list({
        sessionIds: [pane.sessionId],
        includeDelivered: true,
      }).length > 0;
    } catch {
      continue; // sem leitura confiável não decide
    }
    if (delivered) continue;
    reportPaneMeasuredExhaustion({ sessionId: pane.sessionId, hasPendingWork: true, now });
  }
}

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
    await budget.wait(checkMeasuredExhaustion(now, budget));
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
  hungWorkerSilentSeenAt.clear();
  momentumSoloSince.clear();
  momentumNudgedAt.clear();
  momentumReadySince.clear();
  momentumReadySeeded.clear();
  operatorWaitSince.clear();
  operatorWaitReminded.clear();
}
