import type { Handoff } from '../../shared/orch-types';
import type { StandardMissionTopology } from '../../shared/mission-topology';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  getSessionState,
  orchWriteSession,
  tapSessionExit,
  tapSessionState,
} from '../pty/pty-manager';
import {
  getRendererWorkspaceScope,
  onRendererWorkspaceScopeChange,
} from '../persistence/renderer-workspace-scope';
import {
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
} from './project-domain-store-registry';
import {
  getPaneRuntimeAuthorityBySession,
  type PaneRuntimeAuthority,
} from './pane-registry';
import { requireMissionLeaderSession } from './mission-leader-gate';
import type { HandoffDeliveryAttempt } from './handoff-store';
import { sameProjectScope } from './project-scoped-broadcast';
import {
  completePetStudioHandoff,
  type PetStudioCompletionResult,
} from './pet-studio-completion';
import { maybeCompleteFastLaneOnDelivery, startCivilianDeliveryCompletion, stopCivilianDeliveryCompletion } from './civilian-delivery-completion';
import { hasCurrentCompletionRequest } from './operator-tab-completion';
import {
  HANDOFF_DELIVERY_RETRY_BACKOFF_MS,
  MAX_HANDOFF_DELIVERY_ATTEMPTS,
  handoffDeliveryEligible,
} from './handoff-delivery-policy';
import { emitAppEvent } from '../connectors/app-events';
import { emitMissionEvent } from './mission-event-emit';
import { trace } from '../observability/main-trace';
import {
  PASTE_INGEST_GRACE_MS,
  pasteIngestPlanForSession,
  watchPasteIngest,
} from './paste-ingest';

const announcedHandoffSubmits = new Set<string>();

/** Re-exportados para testes e políticas de re-arm calendarem pela mesma regra. */
export { HANDOFF_DELIVERY_RETRY_BACKOFF_MS, handoffDeliveryEligible };
import {
  getAgentSemanticStatusBySession,
  getAgentTurnStartSequence,
  isSessionInjectableIdle,
  tapAgentSemanticStatus,
  tapAgentTurnStart,
} from './agent-status';

/**
 * Automatic handoff delivery: when a worker submits a
 * handoff, the orchestrator session receives it as an injected message — but
 * only once that session is IDLE, so we never type into the middle of a
 * running response. Non-idle deliveries queue and flush on the next idle
 * transition.
 */

interface QueuedHandoff {
  handoff: Handoff;
  authority: DeliveryAuthority;
}

interface DurableDeliveryAuthority {
  readonly sessionId: string;
  readonly missionId: string;
  readonly scope: ProjectExecutionScope;
}

interface DeliveryAuthority extends DurableDeliveryAuthority {
  readonly owner: PaneRuntimeAuthority['owner'];
  readonly paneId: string;
}

export interface HandoffDeliveryRuntimeRecoveryRequest
  extends DurableDeliveryAuthority {
  readonly paneId: string;
  readonly handoffId: string;
}

export type HandoffDeliveryRuntimeRecovery = (
  request: HandoffDeliveryRuntimeRecoveryRequest,
) => boolean | Promise<boolean>;

interface PendingItem {
  readonly handoffId: string;
  readonly attemptId: string;
  readonly attemptNo: number;
}

interface PendingEnter extends PendingItem {
  readonly authority: DeliveryAuthority;
  /**
   * F-1006: todos os handoffs colados na MESMA transação de editor (o
   * primeiro é o próprio PendingEnter). Um CR submete todos; a prova de
   * aceite desse CR aceita cada tentativa pelo seu próprio CAS.
   */
  readonly batch: readonly PendingItem[];
  settleTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  acceptanceTimer?: ReturnType<typeof setTimeout>;
  /** F-735: desarma a espera pela ingestão da colagem (Codex). */
  cancelIngest?: () => void;
  submitStarted?: boolean;
  submitTurnSequence?: number;
  submitStartedAt?: number;
}

interface PendingDeliveryStart {
  readonly authority: DeliveryAuthority;
  /** F-1006: a rajada que chega na janela de estabilidade entra na mesma colagem. */
  readonly handoffs: Handoff[];
  readonly timer: ReturnType<typeof setTimeout>;
}

const queues = new Map<string, QueuedHandoff[]>();
const pendingEnters = new Set<PendingEnter>();
const pendingDeliveryStarts = new Set<PendingDeliveryStart>();
const ownerKeys = new WeakMap<NonNullable<PaneRuntimeAuthority['owner']>, number>();
let nextOwnerKey = 1;
let untapState: (() => void) | null = null;
let untapExit: (() => void) | null = null;
let untapSemanticStatus: (() => void) | null = null;
let untapTurnStart: (() => void) | null = null;
let unsubscribeScopeChanges: (() => void) | null = null;
let recoverDefectiveRuntime: HandoffDeliveryRuntimeRecovery | null = null;
const runtimeRecoveryAttempts = new Map<
  string,
  {
    attempts: number;
    nextAttemptAt: number;
    inFlight: boolean;
    retryTimer?: ReturnType<typeof setTimeout>;
  }
>();

const MAX_DELIVERY_SUMMARY = 4000;
/**
 * Após o CR de submit, a sessão tem esta janela para virar busy (prova de que
 * o TUI aceitou o handoff). Sem essa prova o handoff NÃO é marcado como
 * submitted: um modal que engoliu o paste deixava o handoff entregue para
 * sempre (markSubmitted é durável e o replay só olha não-entregues).
 */
export const SUBMIT_ACCEPTANCE_WINDOW_MS = 12_000;
/** Idle must hold this long before paste — a one-frame idle flicker is not injectable. */
export const DELIVERY_IDLE_STABILITY_MS = 150;
/**
 * Same bound as `injectPrompt` in tool-util.ts. Claude/Codex swallow the first
 * CR while the editor is still ingesting a large paste; sending Enter in the
 * same JS turn as the paste leaves the handoff sitting in the composer.
 */
export const HANDOFF_PROMPT_SETTLE_MS = 500;
/** Second CR if the session is still injectable-idle after the first submit. */
export const HANDOFF_ENTER_RETRY_MS = 400;
/**
 * F-1006: rajada de entregas ao MESMO Maestro vai numa colagem só (um CR,
 * um turno). Uma por borda ociosa custava ~1,6 s por handoff no E2E e um
 * turno inteiro de modelo por handoff na vida real: a 6ª entrega de uma
 * rajada chegava 9 s depois. O teto de caracteres mantém a colagem num
 * tamanho que os TUIs ingerem sem picotar.
 */
export const MAX_DELIVERY_BATCH = 8;
export const MAX_DELIVERY_BATCH_CHARS = 16_000;
const MAX_DELIVERY_ATTEMPTS = MAX_HANDOFF_DELIVERY_ATTEMPTS;
const RUNTIME_RECOVERY_RETRY_BASE_MS = 5_000;
const RUNTIME_RECOVERY_RETRY_MAX_MS = 60_000;
/**
 * F-925 (revisão de 793aa40ca): depois de liberar o orçamento contra um
 * Maestro VIVO ocioso, a recolagem espera uma janela que dobra a cada
 * rodada falha DESTA sessão neste handoff até o teto — sem ela o outbox
 * de 1 s recolava a cada ~13 s para sempre (546 colagens e 2184 Enters em
 * 119 min contra um Maestro parado no prompt). Uma borda busy→idle real
 * encurta a espera até a base — nunca abaixo dela.
 */
export const IDLE_RELEASE_RETRY_BASE_MS = 60_000;
export const IDLE_RELEASE_RETRY_MAX_MS = 15 * 60_000;
/**
 * F-925 (revisão de 899138577): teto de rodadas liberadas por handoff+sessão.
 * Cada tentativa além do orçamento por sessão é uma rodada reaberta por
 * `releaseFailedDeliveryAttempts`. Sem teto o re-drive ficava ~4 colagens/h
 * para sempre contra um Maestro que não aceita. Na sexta rodada a entrega
 * ESTACIONA: o handoff segue `queued` e `delivery-needs-operator` avisa o
 * operador. Uma borda busy→idle real retoma na hora; sem ela, o sweep do
 * supervisor reavalia depois de IDLE_RELEASE_RETRY_MAX_MS. Sem kill/rebind.
 */
export const IDLE_RELEASE_PARK_ROUNDS = 6;

export function configureHandoffDeliveryRuntimeRecovery(
  recovery: HandoffDeliveryRuntimeRecovery | null,
): void {
  for (const state of runtimeRecoveryAttempts.values()) {
    if (state.retryTimer) clearTimeout(state.retryTimer);
  }
  recoverDefectiveRuntime = recovery;
  runtimeRecoveryAttempts.clear();
}

function runtimeRecoveryKey(authority: DeliveryAuthority): string {
  return JSON.stringify([
    authority.scope.installationId,
    authority.scope.projectId,
    authority.scope.checkoutId,
    authority.scope.rootRealPath,
    authority.missionId,
    authority.sessionId,
  ]);
}

function runtimeRecoveryDelay(attempts: number): number {
  return Math.min(
    RUNTIME_RECOVERY_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    RUNTIME_RECOVERY_RETRY_MAX_MS,
  );
}

function clearRuntimeRecoveryAttempt(key: string): void {
  const current = runtimeRecoveryAttempts.get(key);
  if (current?.retryTimer) clearTimeout(current.retryTimer);
  runtimeRecoveryAttempts.delete(key);
}

function runtimeRecoveryIsStillRequired(
  authority: DeliveryAuthority,
  handoffId: string,
): boolean {
  try {
    const stores = getProjectDomainStores(authority.scope);
    const mission = stores.missions.get(authority.missionId);
    if (
      mission?.status !== 'running' ||
      !requireMissionLeaderSession(authority.scope, authority.missionId, {
        sessionId: authority.sessionId,
      }).ok
    ) {
      return false;
    }
    const handoff = stores.handoffs.get(handoffId);
    if (
      !handoff ||
      handoff.missionId !== authority.missionId ||
      handoff.delivered ||
      handoff.deliveryState !== 'queued'
    ) {
      return false;
    }
    const runtime = getPaneRuntimeAuthorityBySession(authority.sessionId);
    return (
      !runtime ||
      (runtime.sessionId === authority.sessionId &&
        runtime.paneId === authority.paneId &&
        runtime.missionId === authority.missionId &&
        runtime.role === 'orchestrator' &&
        Boolean(runtime.scope) &&
        sameProjectScope(runtime.scope!, authority.scope))
    );
  } catch {
    // A transient store read must not turn a recoverable delivery into a
    // permanent wedge. The concrete recovery path repeats this proof before
    // touching a physical process.
    return true;
  }
}

function scheduleRuntimeRecoveryRetry(
  key: string,
  authority: DeliveryAuthority,
  handoffId: string,
  state: {
    attempts: number;
    nextAttemptAt: number;
    inFlight: boolean;
    retryTimer?: ReturnType<typeof setTimeout>;
  },
  delay: number,
): void {
  if (state.retryTimer) clearTimeout(state.retryTimer);
  const boundedDelay = Math.max(1, delay);
  const retryTimer = setTimeout(
    () => requestRuntimeRecovery(authority, handoffId),
    boundedDelay,
  );
  runtimeRecoveryAttempts.set(key, { ...state, retryTimer });
}

function requestRuntimeRecovery(
  authority: DeliveryAuthority,
  handoffId: string,
): void {
  const recovery = recoverDefectiveRuntime;
  if (!recovery) return;
  const key = runtimeRecoveryKey(authority);
  const now = Date.now();
  const previous = runtimeRecoveryAttempts.get(key);
  if (previous?.inFlight) return;
  if (previous?.nextAttemptAt === Number.POSITIVE_INFINITY) return;
  if ((previous?.nextAttemptAt ?? 0) > now) {
    scheduleRuntimeRecoveryRetry(
      key,
      authority,
      handoffId,
      previous!,
      previous!.nextAttemptAt - now,
    );
    return;
  }
  if (!runtimeRecoveryIsStillRequired(authority, handoffId)) {
    clearRuntimeRecoveryAttempt(key);
    return;
  }
  const attempts = (previous?.attempts ?? 0) + 1;
  if (previous?.retryTimer) clearTimeout(previous.retryTimer);
  const inFlightState = {
    attempts,
    nextAttemptAt: now + runtimeRecoveryDelay(attempts),
    inFlight: true,
  };
  runtimeRecoveryAttempts.set(key, inFlightState);
  const request = Object.freeze({
    sessionId: authority.sessionId,
    missionId: authority.missionId,
    paneId: authority.paneId,
    handoffId,
    scope: Object.freeze({ ...authority.scope }),
  });
  void Promise.resolve(recovery(request))
    .then((recovered) => {
      if (
        recoverDefectiveRuntime !== recovery ||
        runtimeRecoveryAttempts.get(key) !== inFlightState
      ) {
        return;
      }
      if (recovered) {
        runtimeRecoveryAttempts.set(key, {
          attempts,
          nextAttemptAt: Number.POSITIVE_INFINITY,
          inFlight: false,
        });
        return;
      }
      if (!runtimeRecoveryIsStillRequired(authority, handoffId)) {
        clearRuntimeRecoveryAttempt(key);
        return;
      }
      const delay = runtimeRecoveryDelay(attempts);
      scheduleRuntimeRecoveryRetry(key, authority, handoffId, {
        attempts,
        nextAttemptAt: Date.now() + delay,
        inFlight: false,
      }, delay);
    })
    .catch((error) => {
      if (
        recoverDefectiveRuntime !== recovery ||
        runtimeRecoveryAttempts.get(key) !== inFlightState
      ) {
        return;
      }
      if (!runtimeRecoveryIsStillRequired(authority, handoffId)) {
        clearRuntimeRecoveryAttempt(key);
        return;
      }
      const delay = runtimeRecoveryDelay(attempts);
      scheduleRuntimeRecoveryRetry(key, authority, handoffId, {
        attempts,
        nextAttemptAt: Date.now() + delay,
        inFlight: false,
      }, delay);
      console.warn('[idle-delivery] automatic Maestro recovery failed:', error);
    });
}

function ownerKey(owner: PaneRuntimeAuthority['owner']): number {
  if (!owner) return 0;
  const existing = ownerKeys.get(owner);
  if (existing) return existing;
  const key = nextOwnerKey++;
  ownerKeys.set(owner, key);
  return key;
}

/**
 * A worker controls its own handoff `summary`; it is injected into the
 * orchestrator's PTY, so raw CR/LF or control bytes would let a lower-trust
 * worker forge extra input lines / auto-submit in the orchestrator (terminal
 * injection). Strip control chars, collapse newlines to spaces, and cap length
 * BEFORE it ever reaches the terminal. (artifacts are JSON.stringify'd, safe.)
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

function sanitizeForTerminal(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(CONTROL_CHARS, '').trim();
}

/** System recovery agent — not a worker; delivery must not look adversarial. */
export const SYSTEM_HANDOFF_AGENTS = new Set(['nexus-delegation-supervisor']);

function extractContextDagSummary(artifacts: readonly unknown[]): string {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return '';
  const parts: string[] = [];
  for (const item of artifacts) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (rec.kind === 'context.accomplished' && rec.payload) {
      const val = Array.isArray(rec.payload) ? rec.payload.join('; ') : String(rec.payload);
      parts.push(`accomplished="${sanitizeForTerminal(val)}"`);
    } else if (rec.kind === 'context.blockers' && rec.payload) {
      const val = Array.isArray(rec.payload) ? rec.payload.join('; ') : String(rec.payload);
      parts.push(`blockers="${sanitizeForTerminal(val)}"`);
    } else if (rec.kind === 'context.nextSteps' && rec.payload) {
      const val = Array.isArray(rec.payload) ? rec.payload.join('; ') : String(rec.payload);
      parts.push(`next_steps="${sanitizeForTerminal(val)}"`);
    }
  }
  return parts.length > 0 ? ` context_dag=[${parts.join(' ')}]` : '';
}

/**
 * Format a handoff for orchestrator PTY injection. Worker handoffs stay
 * untrusted; system supervisor handoffs are labeled so the orchestrator does
 * not treat recovery as injection/spam.
 */
export function formatDelivery(
  handoff: Handoff,
  schedulerTopology?: StandardMissionTopology | null,
): string {
  const from = sanitizeForTerminal(handoff.fromAgent ?? 'worker').slice(0, 128);
  const summary = sanitizeForTerminal(handoff.summary).slice(
    0,
    MAX_DELIVERY_SUMMARY,
  );
  const contextDagThread = extractContextDagSummary(handoff.artifacts);
  const artifacts =
    handoff.artifacts.length > 0
      ? ` artifacts: ${sanitizeForTerminal(
          JSON.stringify(handoff.artifacts),
        ).slice(0, MAX_DELIVERY_SUMMARY)}`
      : '';
  const evidenceIds = sanitizeForTerminal(
    JSON.stringify(handoff.evidenceIds),
  );
  const evidence =
    handoff.evidenceTrust === 'nexus-trusted'
      ? `nexus-trusted evidence_ids=${evidenceIds}`
      : handoff.evidenceTrust === 'stale'
        ? `stale evidence_ids=${evidenceIds}`
        : 'unverified';
  const isSystem = SYSTEM_HANDOFF_AGENTS.has(handoff.fromAgent ?? '');
  const claimTrust = isSystem ? 'system' : 'untrusted';
  const evidenceLabel = isSystem ? 'nexus_system' : evidence;
  const acknowledgementAuthority =
    schedulerTopology === 'delivery' || schedulerTopology === 'wave-pack'
      ? `scheduler_owned=true topology=${schedulerTopology} no_manual_ack_required=true`
      : schedulerTopology === 'team-read-only-fanout'
        ? 'scheduler_owned=true topology=team-read-only-fanout ' +
          'consume_with=nexus_handoff_ack'
        : schedulerTopology === null
          ? 'scheduler_owned=true topology=invalid ' +
            'consume_with=nexus_handoff_ack'
          : 'consume_with=nexus_handoff_ack';
  return (
    `[nexus handoff delivery_metadata] from=${from} ` +
    `handoff_id=${handoff.id} ${acknowledgementAuthority} ` +
    `reported_status=${handoff.status} claim_trust=${claimTrust} ` +
    `evidence=${evidenceLabel} does_not_complete_mission=true ` +
    `summary: ${summary}${contextDagThread}${artifacts}`
  );
}

function authorityKey(authority: DeliveryAuthority): string {
  return JSON.stringify([
    ownerKey(authority.owner),
    authority.scope.installationId,
    authority.scope.projectId,
    authority.scope.checkoutId,
    authority.scope.rootRealPath,
    authority.missionId,
    authority.paneId,
    authority.sessionId,
  ]);
}

function isCurrentAuthority(authority: DeliveryAuthority): boolean {
  if (authority.owner) {
    const rendererScope = getRendererWorkspaceScope(authority.owner);
    if (!rendererScope || !sameProjectScope(rendererScope, authority.scope)) {
      return false;
    }
  }
  if (
    !requireMissionLeaderSession(authority.scope, authority.missionId, {
      sessionId: authority.sessionId,
    }).ok
  ) {
    return false;
  }
  const pane = getPaneRuntimeAuthorityBySession(authority.sessionId);
  return Boolean(
    pane &&
      pane.owner === authority.owner &&
      pane.paneId === authority.paneId &&
      pane.sessionId === authority.sessionId &&
      pane.kind === 'cli-agent' &&
      pane.role === 'orchestrator' &&
      pane.missionId === authority.missionId &&
      pane.scope &&
      sameProjectScope(pane.scope, authority.scope),
  );
}

function clearPendingEnter(pending: PendingEnter): void {
  pending.cancelIngest?.();
  pending.cancelIngest = undefined;
  if (pending.settleTimer) clearTimeout(pending.settleTimer);
  if (pending.retryTimer) clearTimeout(pending.retryTimer);
  if (pending.acceptanceTimer) clearTimeout(pending.acceptanceTimer);
  pendingEnters.delete(pending);
}

function clearPendingDeliveryStart(pending: PendingDeliveryStart): void {
  clearTimeout(pending.timer);
  pendingDeliveryStarts.delete(pending);
}

/**
 * Cola no PTY idle do Maestro. O PTY é a prova; semantic `working` é aviso
 * (hook preso no meio de um pane_ask longo — DEV 1+1: 34s queued com o
 * compositor já no prompt). `awaiting-input` é latch real: nunca escrever
 * num diálogo de permissão. A estabilidade de 150ms + requeue no pulso
 * working ainda evita flicker de um frame.
 */
function canPasteHandoff(sessionId: string): boolean {
  if (isSessionInjectableIdle(sessionId)) return true;
  if (getSessionState(sessionId) !== 'idle') return false;
  return (
    getAgentSemanticStatusBySession(sessionId)?.status !== 'awaiting-input'
  );
}

function hasPendingDelivery(
  authority: DeliveryAuthority,
  handoffId: string,
): boolean {
  const key = authorityKey(authority);
  if (
    [...pendingEnters].some(
      (pending) => authorityKey(pending.authority) === key,
    ) ||
    [...pendingDeliveryStarts].some(
      (pending) => authorityKey(pending.authority) === key,
    )
  ) {
    return true;
  }
  // F-925 (revisão de 899138577): a espera represada segura SÓ o próprio
  // handoff. Antes o prefixo `key::` represava a fila inteira atrás da
  // escada de A — B do mesmo Maestro nunca era tentado (sonda: 20 min).
  // A taxa total da sessão fica a cargo de `sessionPasteGateOpen`.
  return retryBackoffPending.has(`${key}::${handoffId}`);
}

// Backoff de retry (F-112): tentativas que falharam aguardam esta janela
// antes de recolar; enquanto espera, conta como entrega pendente para o
// re-arm do supervisor não duplicar a colagem.
const retryBackoffTimers = new Set<ReturnType<typeof setTimeout>>();
interface RetryBackoffWait {
  readonly authority: DeliveryAuthority;
  readonly sessionId: string;
  /** Ausente na espera estacionada, reavaliada pelo sweep do supervisor. */
  readonly timer?: ReturnType<typeof setTimeout>;
  readonly redeliver: () => void;
  readonly earliestFireAt: number;
  readonly parkedAt?: number;
  sawBusy: boolean;
}
const retryBackoffPending = new Map<string, RetryBackoffWait>();

function trackRetryBackoff(
  authority: DeliveryAuthority,
  handoffId: string,
  backoffMs: number,
  redeliver: () => void,
): void {
  const key = `${authorityKey(authority)}::${handoffId}`;
  const previous = retryBackoffPending.get(key);
  if (previous?.timer) {
    clearTimeout(previous.timer);
    retryBackoffTimers.delete(previous.timer);
  }
  const timer = setTimeout(() => {
    retryBackoffTimers.delete(timer);
    retryBackoffPending.delete(key);
    redeliver();
  }, backoffMs);
  retryBackoffPending.set(key, {
    authority,
    sessionId: authority.sessionId,
    timer,
    redeliver,
    // Uma borda busy→idle prova que o PTY mudou e pode encurtar a espera —
    // nunca abaixo desta base, senão um TUI que repinta em loop viraria de
    // novo colagem a cada ciclo de saída.
    earliestFireAt:
      Date.now() + Math.min(backoffMs, IDLE_RELEASE_RETRY_BASE_MS),
    sawBusy: false,
  });
  retryBackoffTimers.add(timer);
}

/**
 * F-925 (revisão de 899138577): espera ESTACIONADA — sem timer próprio. Depois
 * de IDLE_RELEASE_PARK_ROUNDS rodadas liberadas sem aceite o handoff para de
 * consumir a janela do PTY. A borda busy→idle real dispara na hora; sem ela,
 * o sweep do supervisor reabre a entrega depois do TTL do parque.
 */
function parkRetryBackoff(
  authority: DeliveryAuthority,
  handoffId: string,
  redeliver: () => void,
): void {
  const key = `${authorityKey(authority)}::${handoffId}`;
  const previous = retryBackoffPending.get(key);
  if (previous?.timer) {
    clearTimeout(previous.timer);
    retryBackoffTimers.delete(previous.timer);
  }
  retryBackoffPending.set(key, {
    authority,
    sessionId: authority.sessionId,
    timer: undefined,
    redeliver,
    earliestFireAt: 0,
    parkedAt: Date.now(),
    sawBusy: false,
  });
}

function requeueExpiredParkedHandoffs(
  scope: ProjectExecutionScope,
  missionId: string,
): void {
  const now = Date.now();
  for (const [key, wait] of [...retryBackoffPending]) {
    if (
      wait.timer ||
      wait.parkedAt === undefined ||
      now - wait.parkedAt < IDLE_RELEASE_RETRY_MAX_MS ||
      wait.authority.missionId !== missionId ||
      !sameProjectScope(wait.authority.scope, scope)
    ) continue;
    retryBackoffPending.delete(key);
    wait.redeliver();
  }
}

/**
 * F-925 (revisão de 899138577): taxa total de colagens por sessão. Enquanto
 * existir QUALQUER re-drive represado nesta sessão (escada crescente, F-112
 * ou espera estacionada), nenhuma colagem nova entra antes da janela base a
 * partir da última — somando todos os handoffs. Sem espera represada a
 * entrega segue o ritmo normal das bordas idle. A colagem de B não toca a
 * escada de A: os timers são por handoff e o gate só atrasa a entrada.
 */
const lastSessionPasteAt = new Map<string, number>();

function sessionPasteGateOpen(sessionId: string): boolean {
  for (const wait of retryBackoffPending.values()) {
    if (wait.sessionId !== sessionId) continue;
    return (
      Date.now() - (lastSessionPasteAt.get(sessionId) ?? 0) >=
      IDLE_RELEASE_RETRY_BASE_MS
    );
  }
  return true;
}

/**
 * Borda busy→idle real é prova de mudança no PTY (modal soltou, um turno
 * rodou): os re-drives represados em backoff da sessão disparam na hora em
 * vez de esperar a janela crescente inteira — mas só depois da base da
 * rodada, e só quem viu 'busy' depois de armado (re-publicar 'idle' não é
 * borda: publishSessionActivityState dispara o tap mesmo sem sessão
 * rastreada).
 */
function noteRetryBackoffBusyEdge(sessionId: string): void {
  for (const wait of retryBackoffPending.values()) {
    if (wait.sessionId === sessionId) wait.sawBusy = true;
  }
}

function fireRetryBackoffsAtIdleEdge(sessionId: string): void {
  const now = Date.now();
  for (const [key, wait] of [...retryBackoffPending]) {
    if (
      wait.sessionId !== sessionId ||
      !wait.sawBusy ||
      now < wait.earliestFireAt
    ) continue;
    retryBackoffPending.delete(key);
    if (wait.timer) {
      retryBackoffTimers.delete(wait.timer);
      clearTimeout(wait.timer);
    }
    wait.redeliver();
  }
}

function dropRetryBackoffsForSession(sessionId: string): void {
  for (const [key, wait] of [...retryBackoffPending]) {
    if (wait.sessionId !== sessionId) continue;
    retryBackoffPending.delete(key);
    if (wait.timer) {
      retryBackoffTimers.delete(wait.timer);
      clearTimeout(wait.timer);
    }
  }
}

const INJECTABLE_WAKE_MS = 500;
const injectableWakeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearInjectableWake(sessionId: string): void {
  const timer = injectableWakeTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  injectableWakeTimers.delete(sessionId);
}

function armInjectableWake(sessionId: string): void {
  if (injectableWakeTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    injectableWakeTimers.delete(sessionId);
    if (canPasteHandoff(sessionId)) {
      drainDurableMailbox(sessionId);
      flushQueue(sessionId);
      return;
    }
    if (getSessionState(sessionId) === 'idle') {
      armInjectableWake(sessionId);
    }
  }, INJECTABLE_WAKE_MS);
  injectableWakeTimers.set(sessionId, timer);
}

function enqueueHandoff(authority: DeliveryAuthority, handoff: Handoff): void {
  const key = authorityKey(authority);
  const queue = queues.get(key) ?? [];
  if (
    queue.some((item) => item.handoff.id === handoff.id) ||
    // Handoff com espera represada (escada/F-112/estacionada) não entra na
    // fila em memória: o re-drive dele é o único caminho, senão a entrada
    // duplicada colava por cima da própria espera quando a fila andasse.
    retryBackoffPending.has(`${key}::${handoff.id}`) ||
    [...pendingEnters].some((pending) =>
      pending.batch.some((item) => item.handoffId === handoff.id) &&
      authorityKey(pending.authority) === key,
    ) ||
    [...pendingDeliveryStarts].some(
      (pending) =>
        pending.handoffs.some((item) => item.id === handoff.id) &&
        authorityKey(pending.authority) === key,
    )
  ) return;
  queue.push({ handoff, authority });
  queues.set(key, queue);
  // Já idle: flushQueue só corre na BORDA idle. Sem este wake o queued
  // fica para sempre se o Maestro já estava no prompt.
  if (getSessionState(authority.sessionId) === 'idle') {
    armInjectableWake(authority.sessionId);
  }
}

/** Caminho único de entrada: entrega estável imediata ou fila em memória. */
function routeOrEnqueue(
  authority: DeliveryAuthority,
  handoff: Handoff,
): void {
  if (joinPendingDeliveryStart(authority, handoff)) return;
  if (
    canPasteHandoff(authority.sessionId) &&
    !hasPendingDelivery(authority, handoff.id) &&
    sessionPasteGateOpen(authority.sessionId)
  ) {
    scheduleStableDelivery(authority, [handoff]);
    return;
  }
  enqueueHandoff(authority, handoff);
}

function batchChars(handoffs: readonly Handoff[]): number {
  return handoffs.reduce((total, item) => total + formatDelivery(item).length + 1, 0);
}

/**
 * F-1006: handoff que chega enquanto a colagem deste Maestro ainda espera a
 * janela de estabilidade entra NELA (mesmo CR), em vez de esperar a próxima
 * borda ociosa. Handoff em espera represada (F-112/F-925) não pega carona:
 * o re-drive dele é o único caminho.
 */
function joinPendingDeliveryStart(
  authority: DeliveryAuthority,
  handoff: Handoff,
): boolean {
  const key = authorityKey(authority);
  if (retryBackoffPending.has(`${key}::${handoff.id}`)) return false;
  for (const pending of pendingDeliveryStarts) {
    if (authorityKey(pending.authority) !== key) continue;
    if (pending.handoffs.some((item) => item.id === handoff.id)) return true;
    if (
      pending.handoffs.length >= MAX_DELIVERY_BATCH ||
      batchChars([...pending.handoffs, handoff]) > MAX_DELIVERY_BATCH_CHARS
    ) return false;
    pending.handoffs.push(handoff);
    return true;
  }
  return false;
}

/**
 * Re-drive de um handoff que continuou `queued` depois de uma espera
 * represada (escada crescente, F-112 ou estacionada). Revalida a autoridade
 * e o estado durable antes de roteá-lo de novo pelo caminho normal.
 */
function redriveQueuedHandoff(
  authority: DeliveryAuthority,
  handoffId: string,
): void {
  if (!isCurrentAuthority(authority)) return;
  const handoff = getProjectDomainStores(authority.scope).handoffs.get(
    handoffId,
  );
  if (handoff?.deliveryState === 'queued') {
    routeOrEnqueue(authority, handoff);
  }
}

function requeuePendingDeliveryStarts(sessionId: string): void {
  for (const pending of [...pendingDeliveryStarts]) {
    if (pending.authority.sessionId !== sessionId) continue;
    clearPendingDeliveryStart(pending);
    if (isCurrentAuthority(pending.authority)) {
      for (const handoff of pending.handoffs) enqueueHandoff(pending.authority, handoff);
    }
  }
}

function acceptPendingEnters(sessionId: string): void {
  for (const pending of [...pendingEnters]) {
    if (pending.authority.sessionId !== sessionId) continue;
    // A busy edge before the delayed Enter belongs to other session activity;
    // it is not proof that this handoff was submitted.
    if (!pending.submitStarted) continue;
    if (!isCurrentAuthority(pending.authority)) {
      clearPendingEnter(pending);
      continue;
    }
    // F-1006: a borda prova o CR — que submeteu a colagem inteira. Cada
    // tentativa é aceita pelo próprio CAS; a que perdeu (o Maestro já deu
    // ACK, ou outro caminho entregou) é resolvida pelo ledger, nunca lança
    // de dentro do tap do PTY.
    const stores = getProjectDomainStores(pending.authority.scope);
    const rejected = pending.batch.filter((item) => !tryAcceptAttempt(stores, item));
    if (rejected.length === 0) clearPendingEnter(pending);
    else handleSubmitNotAccepted(pending, 'acceptance_cas_lost', rejected);
    // One busy edge is authority for one head-of-line submit only.
    break;
  }
}

/**
 * F-925 (revisão de 899138577): sinal de atenção da missão quando a entrega
 * estaciona no teto de rodadas. Vai pelo journal durável de eventos da
 * missão — o canal existente que o renderer/operador lê. A chave por
 * handoff+sessão deduplica os re-parques do sweep, sem esconder o aviso
 * quando uma sessão nova encontra o mesmo problema.
 */
function emitDeliveryNeedsOperator(
  authority: DeliveryAuthority,
  handoffId: string,
  sessionAttempts: number,
): void {
  try {
    emitMissionEvent(authority.scope, {
      missionId: authority.missionId,
      runId: 'idle-delivery',
      type: 'custom',
      origin: 'system',
      idempotencyKey:
        `delivery_needs_operator:${handoffId.slice(0, 40)}:` +
        authority.sessionId.slice(0, 40),
      payload: {
        kind: 'delivery-needs-operator',
        handoffId,
        paneId: authority.paneId,
        sessionId: authority.sessionId,
        releasedRounds: sessionAttempts - MAX_DELIVERY_ATTEMPTS,
        reason:
          'Maestro idle não aceitou a entrega depois das rodadas ' +
          'liberadas — entrega estacionada; o supervisor reavalia após ' +
          'o TTL, e uma borda busy→idle retoma na hora',
      },
    });
  } catch (error) {
    console.warn(
      '[idle-delivery] falha ao emitir delivery-needs-operator:',
      error instanceof Error ? error.message : error,
    );
  }
}

function blockDeliveryFailure(
  authority: DeliveryAuthority,
  handoffId: string,
  attempts: number,
): void {
  // Doutrina Overclock (print do operador 2026-08-16 HiperGO): falha de
  // ENTREGA é problema de transporte, nunca da missão. O worker fez a parte
  // dele (handoff commitado); se o Maestro não aceitou a tempo, a resposta é
  // recuperação de runtime + outbox — jamais bloquear a missão, jamais
  // escrever marcador de "handoff não entregue" (o toast que mente).
  // Idle PTY after CR is a TUI modal (Codex PreToolUse hooks, DEV 25/08
  // 2x2): killing that Maestro dropped orchestratorSessionId. Keep queued
  // until a real busy→idle edge.
  if (getSessionState(authority.sessionId) === 'idle') {
    // F-925: modal não é wedge terminal. O orçamento por sessão existe para
    // parar de colar num PTY morto — contra um Maestro VIVO no prompt ele
    // só criava silêncio: o re-drive periódico (outbox 1s, caixa durável,
    // re-arm) reservava attempt novo, batia em `budget exhausted` e caía
    // exatamente aqui de novo, para sempre (campo 05/10: 119 min parada,
    // workers mortos). Liberar as falhas desta sessão reabre o orçamento
    // para a próxima rodada sem matar nem rebindar o Maestro; a auditoria
    // preserva a causa sob o prefixo `released:`.
    let sessionAttempts = attempts;
    try {
      // A espera cresce com as rodadas JÁ gastas por esta sessão neste
      // handoff — vem do histórico durável, então um restart não reinicia
      // a escada e uma sessão nova não herda a espera da anterior. Linhas
      // `released:` contam: elas provam que a rodada aconteceu.
      sessionAttempts = getProjectDomainStores(authority.scope).handoffs
        .listDeliveryAttempts(handoffId)
        .filter(
          (attempt) => attempt.orchestratorSessionId === authority.sessionId,
        ).length;
    } catch (error) {
      console.warn(
        '[idle-delivery] falha ao ler tentativas de entrega da sessão ' +
          `(handoff=${handoffId}):`,
        error instanceof Error ? error.message : error,
      );
    }
    // F-925 (revisão de 899138577): cada tentativa além do orçamento por
    // sessão só existe porque uma liberação a reabriu — `sessionAttempts -
    // MAX` conta as rodadas já liberadas. Na sexta sem aceite a entrega
    // ESTACIONA sem timer próprio: a borda busy→idle real retoma na hora;
    // sem ela, o sweep do supervisor reabre depois do TTL do parque. O
    // handoff segue `queued`, nunca é descartado, e o operador recebe
    // `delivery-needs-operator` no journal. Sem kill e sem rebind do Maestro.
    if (
      sessionAttempts - MAX_DELIVERY_ATTEMPTS >=
      IDLE_RELEASE_PARK_ROUNDS
    ) {
      parkRetryBackoff(authority, handoffId, () => {
        if (!isCurrentAuthority(authority)) return;
        try {
          getProjectDomainStores(authority.scope).handoffs
            .releaseFailedDeliveryAttempts({
              handoffId,
              orchestratorSessionId: authority.sessionId,
            });
        } catch (error) {
          console.warn(
            '[idle-delivery] falha ao liberar tentativas de entrega ' +
              `estacionadas (handoff=${handoffId}):`,
            error instanceof Error ? error.message : error,
          );
        }
        redriveQueuedHandoff(authority, handoffId);
      });
      emitDeliveryNeedsOperator(authority, handoffId, sessionAttempts);
      console.warn(
        '[idle-delivery] entrega estacionada: Maestro idle não aceitou ' +
          `depois de ${IDLE_RELEASE_PARK_ROUNDS} rodadas liberadas ` +
          '(handoff segue queued; sweep reavalia após o TTL e borda ' +
          `busy→idle retoma na hora; mission=${authority.missionId}, ` +
          `handoff=${handoffId}, session=${authority.sessionId}, ` +
          `attempts=${sessionAttempts})`,
      );
      return;
    }
    try {
      getProjectDomainStores(authority.scope).handoffs
        .releaseFailedDeliveryAttempts({
          handoffId,
          orchestratorSessionId: authority.sessionId,
        });
    } catch (error) {
      console.warn(
        '[idle-delivery] falha ao liberar tentativas de entrega esgotadas ' +
          `(handoff=${handoffId}):`,
        error instanceof Error ? error.message : error,
      );
    }
    // F-925 (revisão de 793aa40ca): a liberação sem espera virava laço de
    // ~13 s — o attempt_no é global e já passa do limite depois da primeira
    // liberação, então retryOrBlockDelivery pulava o backoff F-112 e o
    // outbox de 1 s recolava na hora (546 colagens em 119 min). A espera
    // crescente por handoff+sessão (base × 2^rodada até o teto) usa
    // trackRetryBackoff: conta como entrega pendente e segura o outbox, a
    // caixa durável e o re-arm durante a janela.
    trackRetryBackoff(
      authority,
      handoffId,
      Math.min(
        IDLE_RELEASE_RETRY_BASE_MS *
          2 ** Math.max(0, sessionAttempts - MAX_DELIVERY_ATTEMPTS),
        IDLE_RELEASE_RETRY_MAX_MS,
      ),
      () => redriveQueuedHandoff(authority, handoffId),
    );
    // Uma linha por handoff (o else loga na mesma chave — não duplicar).
    if (!blockedDeliveryWarned.has(handoffId)) {
      blockedDeliveryWarned.add(handoffId);
      console.warn(
        '[idle-delivery] Maestro idle não aceitou a entrega (modal de TUI?); ' +
          'tentativas falhas liberadas e o handoff segue queued para o ' +
          `re-drive periódico (mission=${authority.missionId}, ` +
          `handoff=${handoffId}, session=${authority.sessionId}, ` +
          `attempts=${attempts})`,
      );
    }
    return;
  }
  requestRuntimeRecovery(authority, handoffId);
  // O ciclo re-arma a cada janela — o MESMO handoff repetia esta linha 63×
  // no voo do gate 0.62 e afogava o diagnóstico real. Uma linha por handoff.
  if (!blockedDeliveryWarned.has(handoffId)) {
    blockedDeliveryWarned.add(handoffId);
    console.warn(
      '[idle-delivery] Maestro não aceitou a entrega após retry limitado; ' +
        'recuperação física foi solicitada e a missão permanece em curso ' +
        `(mission=${authority.missionId}, ` +
        `handoff=${handoffId}, session=${authority.sessionId}, ` +
        `attempts=${attempts})`,
    );
  }
}

const blockedDeliveryWarned = new Set<string>();

function tryAcceptAttempt(
  stores: ProjectDomainStoreSuite,
  item: PendingItem,
): boolean {
  try {
    return stores.handoffs.acceptDeliveryAttempt({
      attemptId: item.attemptId,
      handoffId: item.handoffId,
    });
  } catch (error) {
    // CAS perdido (o handoff saiu de `queued` por outro caminho): quem decide
    // é o ledger, em settleUnacceptedItem. Lançar daqui matava o tap do PTY e
    // prendia a entrega em memória até o prazo de aceite.
    console.warn(
      '[idle-delivery] aceite da tentativa perdeu o CAS; o ledger decide ' +
        `(handoff=${item.handoffId}):`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

function handleSubmitNotAccepted(
  pending: PendingEnter,
  failureCode = 'accept_timeout',
  items: readonly PendingItem[] = pending.batch,
): void {
  const stores = getProjectDomainStores(pending.authority.scope);
  // F-113: Prova de aceite alternativa — se o observador de turnos registrou
  // novo turn-start após a submissão, OU se o status semântico passou a 'working'
  // após o submitStartedAt, o Maestro comprovadamente ingeriu o prompt.
  let hasTurnProgress = false;
  if (failureCode === 'accept_timeout') {
    const currentSeq = getAgentTurnStartSequence(pending.authority.sessionId);
    const semantic = getAgentSemanticStatusBySession(pending.authority.sessionId);
    hasTurnProgress =
      (pending.submitTurnSequence !== undefined && currentSeq > pending.submitTurnSequence) ||
      (semantic?.status === 'working' &&
        pending.submitStartedAt !== undefined &&
        semantic.updatedAt >= pending.submitStartedAt);
  }
  const retry: PendingItem[] = [];
  for (const item of items) {
    // O busy edge do TUI não é a ÚNICA prova de aceite. Se o handoff já saiu
    // de `queued` — list-ack de `nexus_handoff_list`, `nexus_handoff_ack` ou
    // consumo — o Maestro comprovadamente recebeu, e o único registro possível
    // é sucesso. Campo 20/08: a única tentativa de entrega da história do
    // banco morreu de `accept_timeout` porque o heurístico de busy não pintou
    // dentro dos 12 s, apesar do texto ter sido colado e submetido. F-1006:
    // vale para qualquer causa (CAS perdido incluído), não só o prazo.
    const current = stores.handoffs.get(item.handoffId);
    if (current && current.deliveryState !== 'queued') {
      if (!tryAcceptAttempt(stores, item)) {
        stores.handoffs.failDeliveryAttempt({
          attemptId: item.attemptId,
          handoffId: item.handoffId,
          failureCode: 'accept_superseded',
        });
      }
      // Entregue de qualquer forma: nunca redigitar o que ele já leu.
      continue;
    }
    if (hasTurnProgress && tryAcceptAttempt(stores, item)) continue;
    stores.handoffs.failDeliveryAttempt({
      attemptId: item.attemptId,
      handoffId: item.handoffId,
      failureCode,
    });
    retry.push(item);
  }
  clearPendingEnter(pending);
  for (const item of retry) {
    retryOrBlockDelivery(pending.authority, item.handoffId, item.attemptNo);
  }
}

function retryOrBlockDelivery(
  authority: DeliveryAuthority,
  handoffId: string,
  attemptNo: number,
): void {
  if (!isCurrentAuthority(authority)) return;
  // F-925 (revisão de 899138577): o `attempt_no` é GLOBAL ao handoff — depois
  // da primeira liberação ele já passou do limite e uma SESSÃO NOVA (rebind
  // do Maestro) herdava a escada de 60 s em vez do backoff F-112. A decisão
  // conta só as tentativas DESTA sessão; linhas `released:` continuam
  // contando para a MESMA sessão não reiniciar a escada a cada liberação.
  let sessionAttemptCount = attemptNo;
  try {
    sessionAttemptCount = getProjectDomainStores(authority.scope).handoffs
      .listDeliveryAttempts(handoffId)
      .filter(
        (attempt) => attempt.orchestratorSessionId === authority.sessionId,
      ).length;
  } catch (error) {
    console.warn(
      '[idle-delivery] contagem de tentativas da sessão falhou; usando ' +
        `attempt_no global (handoff=${handoffId}):`,
      error instanceof Error ? error.message : error,
    );
  }
  if (sessionAttemptCount >= MAX_DELIVERY_ATTEMPTS) {
    blockDeliveryFailure(authority, handoffId, sessionAttemptCount);
    return;
  }
  const handoff = getProjectDomainStores(authority.scope).handoffs.get(handoffId);
  if (handoff?.deliveryState !== 'queued') return;
  // Backoff entre tentativas (F-112): retry no mesmo segundo re-colava no
  // mesmo PTY que acabou de recusar o write. Um coordenador renascendo só
  // volta a aceitar depois do boot da CLI; a janela cresce com a tentativa.
  const backoffMs =
    HANDOFF_DELIVERY_RETRY_BACKOFF_MS * Math.max(1, sessionAttemptCount);
  trackRetryBackoff(authority, handoffId, backoffMs, () =>
    redriveQueuedHandoff(authority, handoffId),
  );
}

function submitDelivery(
  authority: DeliveryAuthority,
  pending: PendingEnter,
): void {
  if (!pendingEnters.has(pending) || pending.submitStarted) return;
  // Linearize before write(): a fake/test transport may publish busy
  // synchronously from the CR, and that edge is the acceptance proof.
  pending.submitStarted = true;
  pending.submitStartedAt = Date.now();
  pending.submitTurnSequence = getAgentTurnStartSequence(authority.sessionId);
  const submitted = orchWriteSession(authority.sessionId, '\r', {
    markInputBusy: false,
  });
  if (!submitted) {
    handleSubmitNotAccepted(pending, 'submit_write_failed');
    return;
  }
  // A test/fake transport may publish busy synchronously from write().
  // The busy tap already finalized and removed this pending delivery.
  if (!pendingEnters.has(pending)) return;
  pending.acceptanceTimer = setTimeout(
    () => handleSubmitNotAccepted(pending),
    SUBMIT_ACCEPTANCE_WINDOW_MS,
  );
  // Some interactive CLIs consume the first CR while leaving the pasted
  // prompt in their editor (notably after resume/modal transitions). A
  // bounded second CR is safe only while the exact session is still
  // idle; once it became busy the first submit is proven and we stop.
  const retryDelays = [HANDOFF_ENTER_RETRY_MS, 600, 1200];
  let retryIdx = 0;
  function scheduleDeliveryRetry(): void {
    if (retryIdx >= retryDelays.length) return;
    const delayMs = retryDelays[retryIdx++];
    pending.retryTimer = setTimeout(() => {
      if (
        isCurrentAuthority(authority) &&
        canPasteHandoff(authority.sessionId) &&
        pendingEnters.has(pending)
      ) {
        const enterKey = retryIdx >= 2 ? '\r\n' : '\r';
        orchWriteSession(authority.sessionId, enterKey, {
          markInputBusy: false,
        });
        scheduleDeliveryRetry();
      }
    }, delayMs);
  }
  scheduleDeliveryRetry();
}

function deliverNow(authority: DeliveryAuthority, handoffs: readonly Handoff[]): boolean {
  if (
    !isCurrentAuthority(authority) ||
    !canPasteHandoff(authority.sessionId)
  ) return false;
  // F-925 (revisão de 899138577): última verificação da taxa por sessão —
  // o timer de estabilidade pode ter cruzado uma espera represada armada
  // depois do agendamento. Fechado, o handoff volta para a fila e o wake
  // ocioso o reoferece quando a janela abrir.
  if (!sessionPasteGateOpen(authority.sessionId)) {
    for (const handoff of handoffs) enqueueHandoff(authority, handoff);
    return true;
  }
  const stores = getProjectDomainStores(authority.scope);
  // F-1006: cada handoff da colagem tem a PRÓPRIA tentativa durável
  // (reservada, colada e aceita pelo seu CAS) — juntar não muda o
  // exatamente-uma-vez de nenhum deles.
  const reserved: Array<{ readonly handoff: Handoff; readonly attempt: HandoffDeliveryAttempt }> = [];
  for (const handoff of handoffs) {
    const current = stores.handoffs.get(handoff.id);
    if (!current) continue;
    // List-ack (0.64): o Maestro pode ter LISTADO este handoff enquanto a
    // entrega esperava na fila — digitar de novo o que ele já leu era o
    // "mesmo handoff antigo sendo redelivered" do gate. Só 'queued' digita.
    if (current.deliveryState !== 'queued') continue;
    try {
      reserved.push({
        handoff: current,
        attempt: stores.handoffs.reserveDeliveryAttempt({
          handoffId: current.id,
          missionId: authority.missionId,
          orchestratorSessionId: authority.sessionId,
          maxAttempts: MAX_DELIVERY_ATTEMPTS,
        }),
      });
    } catch (error) {
      if (error instanceof Error && /budget exhausted/i.test(error.message)) {
        blockDeliveryFailure(authority, current.id, MAX_DELIVERY_ATTEMPTS);
      }
    }
  }
  if (reserved.length === 0) return false;
  const failReserved = (failureCode: string) => {
    for (const { handoff, attempt } of reserved) {
      stores.handoffs.failDeliveryAttempt({
        attemptId: attempt.id,
        handoffId: handoff.id,
        failureCode,
      });
    }
    for (const { handoff, attempt } of reserved) {
      retryOrBlockDelivery(authority, handoff.id, attempt.attemptNo);
    }
  };
  // Uma linha, segmentos começando pelo marcador de entrega: os TUIs
  // recebem um único texto sem quebra (nenhum LF vira Enter fora do
  // bracketed paste) e o Maestro lê cada handoff_id.
  const payload = reserved.map(({ handoff }) => formatDelivery(handoff)).join(' ');
  // F-735: o Codex no Windows leva segundos para ingerir a colagem; o CR só
  // sai depois do marcador `[Pasted Content N chars]`. Armado antes da escrita.
  const ingestPlan = pasteIngestPlanForSession(authority.sessionId, payload);
  const ingest = ingestPlan ? watchPasteIngest(authority.sessionId, ingestPlan) : null;
  // Bracketed paste: one editor transaction, matching `injectPrompt` /
  // Overclock pane_write. A raw dump of a 4k summary can repaint the TUI
  // line-by-line and eat the CR that used to follow in the same turn.
  const ok = orchWriteSession(
    authority.sessionId,
    `\x1b[200~${payload}\x1b[201~`,
    {
      markInputBusy: false,
    },
  );
  if (!ok) {
    ingest?.cancel();
    failReserved('paste_write_failed');
    return true;
  }
  const pastedAt = Date.now();
  lastSessionPasteAt.set(authority.sessionId, pastedAt);
  try {
    for (const { handoff, attempt } of reserved) {
      stores.handoffs.markDeliveryAttemptPasted({
        attemptId: attempt.id,
        handoffId: handoff.id,
        // A janela de aceite conta a partir do CR, que espera a ingestão.
        acceptDeadlineAt:
          pastedAt + (ingestPlan?.capMs ?? 0) + SUBMIT_ACCEPTANCE_WINDOW_MS,
      });
    }
  } catch {
    ingest?.cancel();
    failReserved('mark_pasted_failed');
    return true;
  }
  const batch = reserved.map(({ handoff, attempt }) => Object.freeze({
    handoffId: handoff.id,
    attemptId: attempt.id,
    attemptNo: attempt.attemptNo,
  }));
  const pending: PendingEnter = {
    authority,
    ...batch[0]!,
    batch,
    submitStarted: false,
  };
  pendingEnters.add(pending);
  const scheduleSubmit = (delayMs: number) => {
    pending.settleTimer = setTimeout(() => {
      pending.settleTimer = undefined;
      if (!pendingEnters.has(pending)) return;
      if (!isCurrentAuthority(authority)) {
        clearPendingEnter(pending);
        return;
      }
      submitDelivery(authority, pending);
    }, delayMs);
  };
  if (!ingest) {
    scheduleSubmit(HANDOFF_PROMPT_SETTLE_MS);
    return true;
  }
  pending.cancelIngest = ingest.cancel;
  void ingest.done.then((outcome) => {
    pending.cancelIngest = undefined;
    // Sessão que saiu fica com o tap de saída; teto vencido tenta assim mesmo.
    if (outcome === 'exit' || !pendingEnters.has(pending)) return;
    if (outcome === 'interrupted') {
      // F-1536: a TUI aceitou só uma fração da colagem — o CR viraria quebra de
      // linha dentro de um texto picotado. Sem CR: a tentativa falha por
      // 'paste_interrupted' e a escada de reentrega cola a entrega de novo.
      clearPendingEnter(pending);
      failReserved('paste_interrupted');
      return;
    }
    scheduleSubmit(
      Math.max(
        outcome === 'marker' ? PASTE_INGEST_GRACE_MS : 0,
        HANDOFF_PROMPT_SETTLE_MS - (Date.now() - pastedAt),
      ),
    );
  });
  return true;
}

function scheduleStableDelivery(
  authority: DeliveryAuthority,
  handoffs: readonly Handoff[],
): boolean {
  if (
    !isCurrentAuthority(authority) ||
    !canPasteHandoff(authority.sessionId)
  ) return false;
  // Gate de taxa por sessão (F-925 revisão): com espera represada nesta
  // sessão a colagem só entra depois da janela base desde a última. A fila
  // em memória segura o handoff e o wake ocioso o reoferece.
  if (!sessionPasteGateOpen(authority.sessionId)) {
    for (const handoff of handoffs) enqueueHandoff(authority, handoff);
    return true;
  }
  let pending: PendingDeliveryStart;
  const timer = setTimeout(() => {
    clearPendingDeliveryStart(pending);
    if (!isCurrentAuthority(authority)) return;
    if (!canPasteHandoff(authority.sessionId)) {
      for (const handoff of pending.handoffs) enqueueHandoff(authority, handoff);
      return;
    }
    deliverNow(authority, pending.handoffs);
  }, DELIVERY_IDLE_STABILITY_MS);
  pending = { authority, handoffs: [...handoffs], timer };
  pendingDeliveryStarts.add(pending);
  return true;
}

function recoverQueuedAuthorities(
  reason: string,
  targets: Iterable<DeliveryAuthority & { readonly handoffId: string }>,
): void {
  const recovery = recoverDefectiveRuntime;
  if (!recovery) return;
  for (const target of targets) {
    const request = Object.freeze({
      sessionId: target.sessionId,
      missionId: target.missionId,
      paneId: target.paneId,
      handoffId: target.handoffId,
      scope: Object.freeze({ ...target.scope }),
    });
    void Promise.resolve(recovery(request)).catch((error) => {
      console.warn(`[idle-delivery] recovery after ${reason} failed:`, error);
    });
  }
}

function flushQueue(sessionId: string): void {
  if (!canPasteHandoff(sessionId)) return;
  const matches = [...queues.entries()].filter(
    ([, queue]) => queue[0]?.authority.sessionId === sessionId,
  );
  if (matches.length === 0) return;
  if (matches.length !== 1) {
    const recoveryTargets = new Map<
      string,
      DeliveryAuthority & { handoffId: string }
    >();
    for (const [, queue] of matches) {
      const head = queue[0];
      if (!head) continue;
      const key = runtimeRecoveryKey(head.authority);
      if (!recoveryTargets.has(key)) {
        recoveryTargets.set(key, {
          ...head.authority,
          handoffId: head.handoff.id,
        });
      }
    }
    for (const [key] of matches) queues.delete(key);
    console.warn(
      `[idle-delivery] ambiguous queue ownership for session ${sessionId}; ` +
        `retiring ${matches.length} in-memory queues and scheduling recovery`,
    );
    recoverQueuedAuthorities('ambiguous session rebind', recoveryTargets.values());
    return;
  }
  const [key, queue] = matches[0];
  // F-925 (revisão de 899138577): a espera represada segura SÓ o próprio
  // handoff — a fila anda para o primeiro que não está esperando (B entra
  // enquanto A aguarda a escada). A colagem EM VOO de outro handoff da
  // mesma autoridade ainda segura tudo: o composer do PTY é um só.
  // F-1006: uma COLAGEM por borda ociosa — com todos os handoffs prontos
  // da fila (até o teto), não um por borda. O Maestro processa a rajada num
  // turno; a entrega seguinte só sai na próxima borda, como antes.
  const picked: QueuedHandoff[] = [];
  for (let index = 0; index < queue.length && picked.length < MAX_DELIVERY_BATCH;) {
    const item = queue[index]!;
    if (
      hasPendingDelivery(item.authority, item.handoff.id) ||
      (picked.length > 0 && batchChars([...picked.map((entry) => entry.handoff), item.handoff]) > MAX_DELIVERY_BATCH_CHARS)
    ) {
      index++;
      continue;
    }
    picked.push(queue.splice(index, 1)[0]!);
  }
  if (picked.length === 0) return;
  if (queue.length === 0) queues.delete(key);
  if (!scheduleStableDelivery(picked[0]!.authority, picked.map((entry) => entry.handoff))) {
    // Session died — drop the rest of its queue.
    queues.delete(key);
  }
}

export function initIdleDelivery(): void {
  if (untapState) return;
  startCivilianDeliveryCompletion();
  untapState = tapSessionState((sessionId, state) => {
    if (state === 'busy') {
      acceptPendingEnters(sessionId);
      noteRetryBackoffBusyEdge(sessionId);
    }
    if (state !== 'idle') requeuePendingDeliveryStarts(sessionId);
    if (state === 'idle') {
      // Uma borda busy→idle real dispara os re-drives represados pelo
      // backoff crescente (F-925) antes da janela inteira vencer.
      fireRetryBackoffsAtIdleEdge(sessionId);
      // Drain first: mailbox enqueue used to land AFTER flushQueue, so a
      // queued SQLite row never left the Maestro's already-idle prompt.
      drainDurableMailbox(sessionId);
      flushQueue(sessionId);
      scheduleFastLaneDeliveryCheck(sessionId);
    }
  });
  untapSemanticStatus = tapAgentSemanticStatus((entry) => {
    if (entry.status === 'working') {
      acceptPendingEnters(entry.sessionId);
    }
    if (
      (entry.status === 'idle' || entry.status === 'completed') &&
      canPasteHandoff(entry.sessionId)
    ) {
      drainDurableMailbox(entry.sessionId);
      flushQueue(entry.sessionId);
    } else {
      requeuePendingDeliveryStarts(entry.sessionId);
    }
  });
  untapTurnStart = tapAgentTurnStart((entry) => {
    acceptPendingEnters(entry.sessionId);
  });
  untapExit = tapSessionExit((sessionId) => {
    lastMailboxDrainAt.delete(sessionId);
    lastSessionPasteAt.delete(sessionId);
    clearInjectableWake(sessionId);
    dropRetryBackoffsForSession(sessionId);
    scheduleFastLaneDeliveryCheck(sessionId);
    // Capture durable recovery targets BEFORE dropping the in-memory queue.
    // SQLite keeps handoffs as `queued`; without this the Maestro exit would
    // strand reviewer/QA deliveries with zero attempts until an operator CTA.
    const recoveryTargets = new Map<
      string,
      DeliveryAuthority & { handoffId: string }
    >();
    for (const [, queue] of queues) {
      const head = queue[0];
      if (!head || head.authority.sessionId !== sessionId) continue;
      const key = runtimeRecoveryKey(head.authority);
      if (!recoveryTargets.has(key)) {
        recoveryTargets.set(key, {
          ...head.authority,
          handoffId: head.handoff.id,
        });
      }
    }
    for (const pending of pendingDeliveryStarts) {
      if (pending.authority.sessionId !== sessionId) continue;
      const key = runtimeRecoveryKey(pending.authority);
      if (!recoveryTargets.has(key) && pending.handoffs[0]) {
        recoveryTargets.set(key, {
          ...pending.authority,
          handoffId: pending.handoffs[0].id,
        });
      }
    }
    for (const [key, queue] of [...queues]) {
      if (queue[0]?.authority.sessionId === sessionId) queues.delete(key);
    }
    for (const pending of [...pendingEnters]) {
      if (pending.authority.sessionId !== sessionId) continue;
      for (const item of pending.batch) {
        getProjectDomainStores(pending.authority.scope).handoffs.failDeliveryAttempt({
          attemptId: item.attemptId,
          handoffId: item.handoffId,
          failureCode: 'orchestrator_session_exited',
        });
      }
      clearPendingEnter(pending);
      const recoveryKey = runtimeRecoveryKey(pending.authority);
      if (!recoveryTargets.has(recoveryKey)) {
        recoveryTargets.set(recoveryKey, {
          ...pending.authority,
          handoffId: pending.handoffId,
        });
      }
    }
    for (const pending of [...pendingDeliveryStarts]) {
      if (pending.authority.sessionId !== sessionId) continue;
      clearPendingDeliveryStart(pending);
    }
    // Exit-triggered recovery must not depend on a second store proof of the
    // in-memory head: the durable row is still `queued`, but the session that
    // owned the queue is already gone. Invoke the recovery hook directly.
    recoverQueuedAuthorities('Maestro exit', recoveryTargets.values());
  });
  unsubscribeScopeChanges = onRendererWorkspaceScopeChange(
    (owner, previous) => {
      if (!previous) return;
      for (const [key, queue] of [...queues]) {
        const authority = queue[0]?.authority;
        if (
          authority?.owner?.id === owner.id &&
          sameProjectScope(authority.scope, previous)
        ) {
          queues.delete(key);
        }
      }
      for (const pending of [...pendingEnters]) {
        if (
          pending.authority.owner?.id !== owner.id ||
          !sameProjectScope(pending.authority.scope, previous)
        ) {
          continue;
        }
        for (const item of pending.batch) {
          getProjectDomainStores(pending.authority.scope).handoffs.failDeliveryAttempt({
            attemptId: item.attemptId,
            handoffId: item.handoffId,
            failureCode: 'renderer_scope_changed',
          });
        }
        clearPendingEnter(pending);
      }
      for (const pending of [...pendingDeliveryStarts]) {
        if (
          pending.authority.owner?.id !== owner.id ||
          !sameProjectScope(pending.authority.scope, previous)
        ) {
          continue;
        }
        clearPendingDeliveryStart(pending);
      }
      // Esperas represadas (armadas ou estacionadas) do escopo antigo saem
      // junto para não segurar o gate de taxa da sessão nem chegar ao sweep
      // do supervisor com uma autoridade que já mudou de workspace.
      for (const [waitKey, wait] of [...retryBackoffPending]) {
        if (
          wait.authority.owner?.id !== owner.id ||
          !sameProjectScope(wait.authority.scope, previous)
        ) {
          continue;
        }
        retryBackoffPending.delete(waitKey);
        if (wait.timer) {
          retryBackoffTimers.delete(wait.timer);
          clearTimeout(wait.timer);
        }
      }
    },
  );
}

export function shutdownIdleDelivery(): Promise<void> {
  const drain = stopCivilianDeliveryCompletion();
  untapState?.();
  untapExit?.();
  untapSemanticStatus?.();
  untapTurnStart?.();
  unsubscribeScopeChanges?.();
  untapState = null;
  untapExit = null;
  untapSemanticStatus = null;
  untapTurnStart = null;
  unsubscribeScopeChanges = null;
  queues.clear();
  lastMailboxDrainAt.clear();
  lastSessionPasteAt.clear();
  for (const sessionId of [...injectableWakeTimers.keys()]) {
    clearInjectableWake(sessionId);
  }
  configureHandoffDeliveryRuntimeRecovery(null);
  for (const pending of [...pendingEnters]) clearPendingEnter(pending);
  for (const pending of [...pendingDeliveryStarts]) {
    clearPendingDeliveryStart(pending);
  }
  for (const timer of retryBackoffTimers) clearTimeout(timer);
  retryBackoffTimers.clear();
  retryBackoffPending.clear();
  return drain;
}

/** Resolve the exact owner/scope/mission authority for the orchestrator. */
/**
 * Entrega pulada NUNCA é silêncio (gate 0.62, 19/08): o re-arm repetia a
 * cada 45s e ninguém dizia POR QUÊ o handoff não descia. Um warn por
 * missão+motivo (dedup até o motivo mudar) nomeia a próxima trava.
 */
const deliverySkipReasonByMission = new Map<string, string>();

function noteDeliverySkip(missionId: string, reason: string): null {
  if (deliverySkipReasonByMission.get(missionId) !== reason) {
    deliverySkipReasonByMission.set(missionId, reason);
    console.warn(
      `[idle-delivery] entrega pendente sem alvo (mission=${missionId}): ${reason}`,
    );
  }
  return null;
}

function targetAuthority(
  handoff: Handoff,
  scope: ProjectExecutionScope,
): DeliveryAuthority | null {
  if (!handoff.missionId) return null;
  const missionId = handoff.missionId;
  const leader = requireMissionLeaderSession(scope, missionId, {});
  if (!leader.ok) {
    return noteDeliverySkip(missionId, `líder da missão não resolvido (${leader.code}): ${leader.hint}`);
  }
  const sessionId = leader.leader.sessionId;
  const pane = getPaneRuntimeAuthorityBySession(sessionId);
  const rendererScope = pane?.owner
    ? getRendererWorkspaceScope(pane.owner)
    : null;
  if (!pane || pane.sessionId !== sessionId) {
    return noteDeliverySkip(
      missionId,
      `orchestratorSessionId=${sessionId} não tem pane runtime vivo (Maestro morto/respawn sem rebind?)`,
    );
  }
  if (
    pane.kind !== 'cli-agent' ||
    pane.role !== 'orchestrator' ||
    pane.missionId !== missionId ||
    !pane.scope ||
    !sameProjectScope(pane.scope, scope)
  ) {
    return noteDeliverySkip(
      missionId,
      `pane do Maestro não confere (kind=${pane.kind} role=${pane.role} mission=${pane.missionId ?? 'none'})`,
    );
  }
  if (
    pane.owner !== null &&
    (!rendererScope || !sameProjectScope(rendererScope, scope))
  ) {
    return noteDeliverySkip(
      missionId,
      'workspace do renderer difere do escopo da missão (operador olhando outro projeto?)',
    );
  }
  deliverySkipReasonByMission.delete(missionId);
  return Object.freeze({
    owner: pane.owner,
    paneId: pane.paneId,
    sessionId,
    missionId,
    scope: Object.freeze({ ...scope }),
  });
}

/**
 * Caixa postal durável do Maestro.
 *
 * `flushQueue` drena apenas a fila EM MEMÓRIA. Quando o handoff é submetido
 * sem alvo vivo (`targetAuthority` → null: Maestro ainda não vinculado, morto
 * ou em respawn), NADA é enfileirado — a linha fica `queued` no SQLite e
 * nenhum idle posterior a relê. Só respawn/recovery/resume chamavam
 * `redeliverPendingHandoffs`, e nenhum deles dispara no caso comum de um
 * Maestro vivo que simplesmente ficou ocioso depois.
 *
 * Campo 20/08 (missão "quanto é 1+1"): 4 de 5 handoffs do banco morreram
 * exatamente assim — `delivery_state=queued` com ZERO linha em
 * `handoff_delivery_attempts`. Ao ficar idle, o Maestro agora puxa a própria
 * caixa: o SQLite é a fonte da verdade, a fila em memória é só atalho.
 */
const MAILBOX_DRAIN_THROTTLE_MS = 3_000;
const lastMailboxDrainAt = new Map<string, number>();

function drainDurableMailbox(sessionId: string): void {
  const pane = getPaneRuntimeAuthorityBySession(sessionId);
  if (!pane || pane.kind !== 'cli-agent' || pane.role !== 'orchestrator') {
    return;
  }
  const missionId = pane.missionId;
  const scope = pane.scope;
  if (!missionId || !scope) return;
  // Uma entrega já em voo nesta sessão é dona da vez: reenfileirar por cima
  // duplicaria o mesmo handoff na fila em memória.
  for (const inflight of pendingEnters) {
    if (inflight.authority.sessionId === sessionId) return;
  }
  const now = Date.now();
  if (now - (lastMailboxDrainAt.get(sessionId) ?? 0) < MAILBOX_DRAIN_THROTTLE_MS) {
    return;
  }
  lastMailboxDrainAt.set(sessionId, now);
  try {
    const drained = redeliverPendingHandoffs(scope, missionId);
    if (drained > 0) {
      console.info(
        `[idle-delivery] caixa durável drenada no idle do Maestro: ` +
          `${drained} handoff(s) (mission=${missionId}, session=${sessionId})`,
      );
    }
  } catch (error) {
    console.warn(
      '[idle-delivery] dreno da caixa durável falhou:',
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * F-1007: o idle do Maestro só reverifica a conclusão depois de ELE ter pedido
 * done (o pedido chega com ele ocupado e volta "aguarde"). Sem o pedido, o
 * idle do Maestro continua sem fechar a missão no meio da delegação.
 */
function orchestratorRequestedCompletion(scope: ProjectExecutionScope, missionId: string, sessionId: string): boolean {
  try {
    const mission = getProjectDomainStores(scope).missions.get(missionId);
    return Boolean(mission && mission.status === 'running' && mission.orchestratorSessionId === sessionId &&
      hasCurrentCompletionRequest(scope, mission));
  } catch {
    return false;
  }
}

function scheduleFastLaneDeliveryCheck(sessionId: string): void {
  const pane = getPaneRuntimeAuthorityBySession(sessionId);
  const missionId = pane?.missionId;
  // F-1006: a conclusão da missão lê os stores do escopo de COORDENAÇÃO e
  // deriva a execução da própria missão (missionExecutionScope). Passar a
  // worktree do writer aqui batia na guarda de identidade do registro.
  const deliveryScope = pane?.scope;
  if (!missionId || !deliveryScope) return;
  if (pane.role === 'orchestrator' && !orchestratorRequestedCompletion(deliveryScope, missionId, sessionId)) return;
  void maybeCompleteFastLaneOnDelivery(deliveryScope, missionId).then((result) => {
    trace({ kind: 'civilian-delivery-check', sessionId, missionId, reason: result.reason ?? result.action });
  }, (error) => {
    const message = error instanceof Error ? error.message : String(error);
    trace({ kind: 'civilian-delivery-check', sessionId, missionId, reason: 'error', error: message });
    console.warn('[civilian-delivery] reconcile após pane idle/exit falhou:', message);
  });
}

/** Called by nexus_handoff_submit (and the legacy stream parser). */
export function onHandoffSubmitted(
  handoff: Handoff,
  scope: ProjectExecutionScope,
  overrideStores?: ProjectDomainStoreSuite,
): PetStudioCompletionResult | null {
  const petCompletion = completePetStudioHandoff(
    handoff,
    scope,
    overrideStores ? { getStores: () => overrideStores } : {},
  );
  // Pet Studio has no worker/orchestrator loop: its sole Codex session submits
  // its own validated result. Never queue that message back into the same PTY.
  if (petCompletion) return petCompletion;
  if (handoff.status === 'success' && handoff.missionId) {
    // Via Rápida civil: handoff, pane idle/exit ou evidência no disco fecha
    // Pronto. Fail-closed (zero arquivos / DESIGN.md / fail-closed) nunca pinta verde.
    // Fire-and-forget: idle-delivery é síncrono; o watcher cobre o timeout.
    void maybeCompleteFastLaneOnDelivery(
      scope,
      handoff.missionId,
      overrideStores ? { getStores: () => overrideStores } : {},
    ).catch((error) => {
      console.warn(
        '[civilian-delivery] reconcile após handoff falhou:',
        error instanceof Error ? error.message : error,
      );
    });
  }
  if (!handoffDeliveryEligible(handoff)) return null;
  // Um evento por handoff: onHandoffSubmitted também roda a cada re-arm da
  // entrega (F-112) e o feed Arms ficava repetindo o mesmo submit 17×.
  if (!announcedHandoffSubmits.has(handoff.id)) {
    announcedHandoffSubmits.add(handoff.id);
    if (announcedHandoffSubmits.size > 512) {
      const oldestAnnounced = announcedHandoffSubmits.values().next().value;
      if (oldestAnnounced !== undefined) announcedHandoffSubmits.delete(oldestAnnounced);
    }
    emitAppEvent('handoff.submitted', {
      handoffId: handoff.id.slice(0, 128),
      ...(handoff.missionId ? { missionId: handoff.missionId.slice(0, 128) } : {}),
      status: handoff.status,
    });
  }
  const authority = targetAuthority(handoff, scope);
  if (!authority) return null; // No trusted orchestrator — stays listed as pending.
  // Maestro's own submit must not paste back into the same PTY.
  if (handoff.sessionId && handoff.sessionId === authority.sessionId) {
    return null;
  }
  routeOrEnqueue(authority, handoff);
  return null;
}

/**
 * Replays durable, still-undelivered handoffs after an orchestrator session is
 * rebound. The in-memory queue is an optimization only; SQLite is the source
 * of truth across renderer/main/PTY restarts.
 */
export function redeliverPendingHandoffs(
  scope: ProjectExecutionScope,
  missionId: string,
  overrideStores?: ProjectDomainStoreSuite,
  options: { requeueExpiredParks?: boolean } = {},
): number {
  if (options.requeueExpiredParks) {
    requeueExpiredParkedHandoffs(scope, missionId);
  }
  const stores = overrideStores ?? getProjectDomainStores(scope);
  const pending = stores.handoffs.list({
    missionId,
    includeDelivered: false,
  });
  for (const handoff of pending) onHandoffSubmitted(handoff, scope, stores);
  return pending.length;
}
