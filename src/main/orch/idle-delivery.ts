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
import { maybeCompleteFastLaneOnDelivery } from './civilian-delivery-completion';
import {
  HANDOFF_DELIVERY_RETRY_BACKOFF_MS,
  MAX_HANDOFF_DELIVERY_ATTEMPTS,
} from './handoff-delivery-policy';
import { emitAppEvent } from '../connectors/app-events';

const announcedHandoffSubmits = new Set<string>();

/** Re-exportado para testes e políticas de re-arm calendarem pelo mesmo valor. */
export { HANDOFF_DELIVERY_RETRY_BACKOFF_MS };
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

interface PendingEnter {
  readonly authority: DeliveryAuthority;
  readonly handoffId: string;
  readonly attemptId: string;
  readonly attemptNo: number;
  settleTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  acceptanceTimer?: ReturnType<typeof setTimeout>;
  submitStarted?: boolean;
  submitTurnSequence?: number;
  submitStartedAt?: number;
}

interface PendingDeliveryStart {
  readonly authority: DeliveryAuthority;
  readonly handoff: Handoff;
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
const MAX_DELIVERY_ATTEMPTS = MAX_HANDOFF_DELIVERY_ATTEMPTS;
const RUNTIME_RECOVERY_RETRY_BASE_MS = 5_000;
const RUNTIME_RECOVERY_RETRY_MAX_MS = 60_000;

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

function hasPendingDelivery(authority: DeliveryAuthority): boolean {
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
  for (const entryKey of retryBackoffPending.keys()) {
    if (entryKey.startsWith(`${key}::`)) return true;
  }
  return false;
}

// Backoff de retry (F-112): tentativas que falharam aguardam esta janela
// antes de recolar; enquanto espera, conta como entrega pendente para o
// re-arm do supervisor não duplicar a colagem.
const retryBackoffTimers = new Set<ReturnType<typeof setTimeout>>();
const retryBackoffPending = new Map<string, string>();

function trackRetryBackoff(
  authority: DeliveryAuthority,
  handoffId: string,
  backoffMs: number,
  redeliver: () => void,
): void {
  const key = `${authorityKey(authority)}::${handoffId}`;
  retryBackoffPending.set(key, handoffId);
  const timer = setTimeout(() => {
    retryBackoffTimers.delete(timer);
    retryBackoffPending.delete(key);
    redeliver();
  }, backoffMs);
  retryBackoffTimers.add(timer);
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
    [...pendingEnters].some((pending) =>
      pending.handoffId === handoff.id &&
      authorityKey(pending.authority) === key,
    ) ||
    [...pendingDeliveryStarts].some(
      (pending) =>
        pending.handoff.id === handoff.id &&
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

function requeuePendingDeliveryStarts(sessionId: string): void {
  for (const pending of [...pendingDeliveryStarts]) {
    if (pending.authority.sessionId !== sessionId) continue;
    clearPendingDeliveryStart(pending);
    if (isCurrentAuthority(pending.authority)) {
      enqueueHandoff(pending.authority, pending.handoff);
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
    const accepted = getProjectDomainStores(
      pending.authority.scope,
    ).handoffs.acceptDeliveryAttempt({
      attemptId: pending.attemptId,
      handoffId: pending.handoffId,
    });
    if (accepted) clearPendingEnter(pending);
    else handleSubmitNotAccepted(pending, 'acceptance_cas_lost');
    // One busy edge is authority for one head-of-line delivery only.
    break;
  }
}

function isDiagnosticDriverHandoff(handoff: Handoff): boolean {
  // mission-driver "stalled / no progress" signals are ledger/UI diagnostics.
  // Pasting them into a busy orchestrator and then demoting the mission to
  // blocked after two failed CR attempts can kill a fully completed guided
  // run (executor+reviewer+QA already done).
  return (
    handoff.status === 'stalled' ||
    handoff.fromAgent === 'nexus-mission-driver'
  );
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
  if (getSessionState(authority.sessionId) === 'idle') return;
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

function handleSubmitNotAccepted(
  pending: PendingEnter,
  failureCode = 'accept_timeout',
): void {
  const stores = getProjectDomainStores(pending.authority.scope);
  // O busy edge do TUI não é a ÚNICA prova de aceite. Se o handoff já saiu de
  // `queued` — list-ack de `nexus_handoff_list`, `nexus_handoff_ack` ou
  // consumo — o Maestro comprovadamente recebeu, e o único registro possível
  // é sucesso. Campo 20/08: a única tentativa de entrega da história do banco
  // morreu de `accept_timeout` porque o heurístico de busy não pintou dentro
  // dos 12 s, apesar do texto ter sido colado e submetido.
  if (failureCode === 'accept_timeout') {
    const current = stores.handoffs.get(pending.handoffId);
    if (current && current.deliveryState !== 'queued') {
      let accepted = false;
      try {
        accepted = stores.handoffs.acceptDeliveryAttempt({
          attemptId: pending.attemptId,
          handoffId: pending.handoffId,
        });
      } catch {
        accepted = false;
      }
      if (!accepted) {
        stores.handoffs.failDeliveryAttempt({
          attemptId: pending.attemptId,
          handoffId: pending.handoffId,
          failureCode: 'accept_superseded',
        });
      }
      // Entregue de qualquer forma: nunca redigitar o que ele já leu.
      clearPendingEnter(pending);
      return;
    }

    // F-113: Prova de aceite alternativa — se o observador de turnos registrou
    // novo turn-start após a submissão, OU se o status semântico passou a 'working'
    // após o submitStartedAt, o Maestro comprovadamente ingeriu o prompt.
    const currentSeq = getAgentTurnStartSequence(pending.authority.sessionId);
    const semantic = getAgentSemanticStatusBySession(pending.authority.sessionId);
    const hasTurnProgress =
      (pending.submitTurnSequence !== undefined && currentSeq > pending.submitTurnSequence) ||
      (semantic?.status === 'working' &&
        pending.submitStartedAt !== undefined &&
        semantic.updatedAt >= pending.submitStartedAt);

    if (hasTurnProgress) {
      let accepted = false;
      try {
        accepted = stores.handoffs.acceptDeliveryAttempt({
          attemptId: pending.attemptId,
          handoffId: pending.handoffId,
        });
      } catch {
        accepted = false;
      }
      if (accepted) {
        clearPendingEnter(pending);
        return;
      }
    }
  }
  stores.handoffs.failDeliveryAttempt({
    attemptId: pending.attemptId,
    handoffId: pending.handoffId,
    failureCode,
  });
  clearPendingEnter(pending);
  retryOrBlockDelivery(
    pending.authority,
    pending.handoffId,
    pending.attemptNo,
  );
}

function retryOrBlockDelivery(
  authority: DeliveryAuthority,
  handoffId: string,
  attemptNo: number,
): void {
  if (!isCurrentAuthority(authority)) return;
  if (attemptNo >= MAX_DELIVERY_ATTEMPTS) {
    blockDeliveryFailure(authority, handoffId, attemptNo);
    return;
  }
  const handoff = getProjectDomainStores(authority.scope).handoffs.get(handoffId);
  if (handoff?.deliveryState !== 'queued') return;
  // Backoff entre tentativas (F-112): retry no mesmo segundo re-colava no
  // mesmo PTY que acabou de recusar o write. Um coordenador renascendo só
  // volta a aceitar depois do boot da CLI; a janela cresce com a tentativa.
  const backoffMs =
    HANDOFF_DELIVERY_RETRY_BACKOFF_MS * Math.max(1, attemptNo);
  trackRetryBackoff(authority, handoffId, backoffMs, () => {
    if (!isCurrentAuthority(authority)) return;
    const retryHandoff =
      getProjectDomainStores(authority.scope).handoffs.get(handoffId);
    if (retryHandoff?.deliveryState === 'queued') {
      onHandoffSubmitted(retryHandoff, authority.scope);
    }
  });
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

function deliverNow(authority: DeliveryAuthority, handoff: Handoff): boolean {
  if (
    !isCurrentAuthority(authority) ||
    !canPasteHandoff(authority.sessionId)
  ) return false;
  const stores = getProjectDomainStores(authority.scope);
  const current = stores.handoffs.get(handoff.id);
  if (!current) return false;
  // List-ack (0.64): o Maestro pode ter LISTADO este handoff enquanto a
  // entrega esperava na fila — digitar de novo o que ele já leu era o
  // "mesmo handoff antigo sendo redelivered" do gate. Só 'queued' digita.
  if (current.deliveryState !== 'queued') return true;
  let attempt: HandoffDeliveryAttempt;
  try {
    attempt = stores.handoffs.reserveDeliveryAttempt({
      handoffId: current.id,
      missionId: authority.missionId,
      orchestratorSessionId: authority.sessionId,
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
    });
  } catch (error) {
    if (error instanceof Error && /budget exhausted/i.test(error.message)) {
      blockDeliveryFailure(authority, current.id, MAX_DELIVERY_ATTEMPTS);
    }
    return false;
  }
  const payload = formatDelivery(current);
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
    stores.handoffs.failDeliveryAttempt({
      attemptId: attempt.id,
      handoffId: current.id,
      failureCode: 'paste_write_failed',
    });
    retryOrBlockDelivery(authority, current.id, attempt.attemptNo);
    return true;
  }
  try {
    stores.handoffs.markDeliveryAttemptPasted({
      attemptId: attempt.id,
      handoffId: current.id,
      acceptDeadlineAt: Date.now() + SUBMIT_ACCEPTANCE_WINDOW_MS,
    });
  } catch {
    stores.handoffs.failDeliveryAttempt({
      attemptId: attempt.id,
      handoffId: current.id,
      failureCode: 'mark_pasted_failed',
    });
    retryOrBlockDelivery(authority, current.id, attempt.attemptNo);
    return true;
  }
  const pending: PendingEnter = {
    authority,
    handoffId: current.id,
    attemptId: attempt.id,
    attemptNo: attempt.attemptNo,
    submitStarted: false,
  };
  pendingEnters.add(pending);
  pending.settleTimer = setTimeout(() => {
    pending.settleTimer = undefined;
    if (!pendingEnters.has(pending)) return;
    if (!isCurrentAuthority(authority)) {
      clearPendingEnter(pending);
      return;
    }
    submitDelivery(authority, pending);
  }, HANDOFF_PROMPT_SETTLE_MS);
  return true;
}

function scheduleStableDelivery(
  authority: DeliveryAuthority,
  handoff: Handoff,
): boolean {
  if (
    !isCurrentAuthority(authority) ||
    !canPasteHandoff(authority.sessionId)
  ) return false;
  let pending: PendingDeliveryStart;
  const timer = setTimeout(() => {
    clearPendingDeliveryStart(pending);
    if (!isCurrentAuthority(authority)) return;
    if (!canPasteHandoff(authority.sessionId)) {
      enqueueHandoff(authority, handoff);
      return;
    }
    deliverNow(authority, handoff);
  }, DELIVERY_IDLE_STABILITY_MS);
  pending = { authority, handoff, timer };
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
  if (hasPendingDelivery(queue[0]!.authority)) return;
  // One handoff per idle transition: after delivery the orchestrator goes
  // busy processing it; remaining handoffs flush on subsequent idles.
  const next = queue.shift()!;
  if (queue.length === 0) queues.delete(key);
  if (!scheduleStableDelivery(next.authority, next.handoff)) {
    // Session died — drop the rest of its queue.
    queues.delete(key);
  }
}

export function initIdleDelivery(): void {
  if (untapState) return;
  untapState = tapSessionState((sessionId, state) => {
    if (state === 'busy') acceptPendingEnters(sessionId);
    if (state !== 'idle') requeuePendingDeliveryStarts(sessionId);
    if (state === 'idle') {
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
    clearInjectableWake(sessionId);
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
      if (!recoveryTargets.has(key)) {
        recoveryTargets.set(key, {
          ...pending.authority,
          handoffId: pending.handoff.id,
        });
      }
    }
    for (const [key, queue] of [...queues]) {
      if (queue[0]?.authority.sessionId === sessionId) queues.delete(key);
    }
    for (const pending of [...pendingEnters]) {
      if (pending.authority.sessionId !== sessionId) continue;
      getProjectDomainStores(pending.authority.scope).handoffs.failDeliveryAttempt({
        attemptId: pending.attemptId,
        handoffId: pending.handoffId,
        failureCode: 'orchestrator_session_exited',
      });
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
        getProjectDomainStores(pending.authority.scope).handoffs.failDeliveryAttempt({
          attemptId: pending.attemptId,
          handoffId: pending.handoffId,
          failureCode: 'renderer_scope_changed',
        });
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
    },
  );
}

export function shutdownIdleDelivery(): void {
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

function scheduleFastLaneDeliveryCheck(sessionId: string): void {
  const pane = getPaneRuntimeAuthorityBySession(sessionId);
  const missionId = pane?.missionId;
  const deliveryScope = pane?.executionScope ?? pane?.scope;
  if (!missionId || !deliveryScope || pane.role === 'orchestrator') return;
  void maybeCompleteFastLaneOnDelivery(deliveryScope, missionId).catch((error) => {
    console.warn(
      '[civilian-delivery] reconcile após pane idle/exit falhou:',
      error instanceof Error ? error.message : error,
    );
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
  if (isDiagnosticDriverHandoff(handoff)) return null;
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
  if (
    canPasteHandoff(authority.sessionId) &&
    !hasPendingDelivery(authority)
  ) {
    scheduleStableDelivery(authority, handoff);
    return null;
  }
  enqueueHandoff(authority, handoff);
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
): number {
  const stores = overrideStores ?? getProjectDomainStores(scope);
  const pending = stores.handoffs.list({
    missionId,
    includeDelivered: false,
  });
  for (const handoff of pending) onHandoffSubmitted(handoff, scope, stores);
  return pending.length;
}
