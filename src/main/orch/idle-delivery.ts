import type { Handoff } from '../../shared/orch-types';
import type { StandardMissionTopology } from '../../shared/mission-topology';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  orchWriteSession,
  tapSessionExit,
  tapSessionState,
} from '../pty/pty-manager';
import {
  getRendererWorkspaceScope,
  onRendererWorkspaceScopeChange,
} from '../persistence/renderer-workspace-scope';
import { getProjectDomainStores } from './project-domain-store-registry';
import {
  getPaneRuntimeAuthorityBySession,
  type PaneRuntimeAuthority,
} from './pane-registry';
import type { HandoffDeliveryAttempt } from './handoff-store';
import { sameProjectScope } from './project-scoped-broadcast';
import {
  completePetStudioHandoff,
  type PetStudioCompletionResult,
} from './pet-studio-completion';
import { MAX_HANDOFF_DELIVERY_ATTEMPTS } from './handoff-delivery-policy';
import {
  isSessionInjectableIdle,
  tapAgentSemanticStatus,
} from './agent-status';
import {
  findCurrentSchedulerOwnedHandoffDispatch,
  missionSchedulerCompletionTopology,
} from './mission-scheduler-authority';

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
  retryTimer?: ReturnType<typeof setTimeout>;
  acceptanceTimer?: ReturnType<typeof setTimeout>;
  submitStarted?: boolean;
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
const SUBMIT_ACCEPTANCE_WINDOW_MS = 12_000;
const DELIVERY_IDLE_STABILITY_MS = 150;
const MAX_DELIVERY_ATTEMPTS = MAX_HANDOFF_DELIVERY_ATTEMPTS;
const HANDOFF_DELIVERY_CTA =
  'Handoff não entregue. Clique em Reabrir para retomar o orquestrador e reenviar a entrega.';
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
      mission.orchestratorSessionId !== authority.sessionId
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
    `summary: ${summary}${artifacts}`
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
  const mission = getProjectDomainStores(authority.scope).missions.get(
    authority.missionId,
  );
  if (mission?.orchestratorSessionId !== authority.sessionId) return false;
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
  if (pending.retryTimer) clearTimeout(pending.retryTimer);
  if (pending.acceptanceTimer) clearTimeout(pending.acceptanceTimer);
  pendingEnters.delete(pending);
}

function clearPendingDeliveryStart(pending: PendingDeliveryStart): void {
  clearTimeout(pending.timer);
  pendingDeliveryStarts.delete(pending);
}

function hasPendingDelivery(authority: DeliveryAuthority): boolean {
  const key = authorityKey(authority);
  return (
    [...pendingEnters].some(
      (pending) => authorityKey(pending.authority) === key,
    ) ||
    [...pendingDeliveryStarts].some(
      (pending) => authorityKey(pending.authority) === key,
    )
  );
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

function schedulerDeliveryAuthority(
  handoff: Handoff,
  scope: ProjectExecutionScope,
): DurableDeliveryAuthority | null {
  if (!handoff.missionId) return null;
  try {
    const stores = getProjectDomainStores(scope);
    const mission = stores.missions.get(handoff.missionId);
    if (!mission?.orchestratorSessionId) return null;
    const dispatch = findCurrentSchedulerOwnedHandoffDispatch(
      mission,
      stores.missions.hasCurrentKickoffAcceptance(mission.id),
      handoff,
      stores.taskDispatches.list(mission.id),
    );
    if (!dispatch) return null;
    return Object.freeze({
      sessionId: mission.orchestratorSessionId,
      missionId: mission.id,
      scope: Object.freeze({ ...scope }),
    });
  } catch {
    return null;
  }
}

function schedulerDeliveryTopology(
  authority: DeliveryAuthority,
  handoff: Handoff,
): StandardMissionTopology | null | undefined {
  const schedulerAuthority = schedulerDeliveryAuthority(
    handoff,
    authority.scope,
  );
  if (
    schedulerAuthority?.missionId !== authority.missionId ||
    schedulerAuthority.sessionId !== authority.sessionId
  ) {
    return undefined;
  }
  const stores = getProjectDomainStores(authority.scope);
  const mission = stores.missions.get(authority.missionId);
  if (!mission) return null;
  return missionSchedulerCompletionTopology(
    mission,
    stores.taskDispatches.list(authority.missionId),
  );
}

function durableDispatchOwnsHandoff(
  authority: DurableDeliveryAuthority,
  handoffId: string,
): boolean {
  try {
    const handoff = getProjectDomainStores(authority.scope).handoffs.get(
      handoffId,
    );
    if (!handoff) return false;
    const current = schedulerDeliveryAuthority(handoff, authority.scope);
    return (
      current?.missionId === authority.missionId &&
      current.sessionId === authority.sessionId
    );
  } catch {
    return false;
  }
}

/**
 * Restart lane for an accepted scheduler-owned delivery whose explicit Maestro
 * ACK has not committed yet. Re-prove its durable authority, but deliberately
 * preserve `submitted`: accepting a PTY paste proves transport only. The exact
 * orchestrator must call `nexus_handoff_ack` after processing the result.
 */
export function recoverAcceptedSchedulerHandoffDelivery(
  handoff: Handoff,
  scope: ProjectExecutionScope,
): boolean {
  let current: Handoff | null;
  try {
    current = getProjectDomainStores(scope).handoffs.get(handoff.id);
  } catch {
    return false;
  }
  if (
    !current?.delivered ||
    (current.deliveryState !== 'submitted' &&
      current.deliveryState !== 'acknowledged')
  ) return false;
  const authority = schedulerDeliveryAuthority(current, scope);
  return authority !== null;
}

function missionDispatchesAlreadyTerminal(
  authority: DeliveryAuthority,
): boolean {
  try {
    const rows = getProjectDomainStores(authority.scope).taskDispatches.list(
      authority.missionId,
    );
    return (
      rows.length > 0 &&
      rows.every(
        (row) =>
          row.state === 'completed' ||
          row.state === 'failed' ||
          row.state === 'blocked' ||
          row.state === 'superseded',
      )
    );
  } catch {
    return false;
  }
}

function blockDeliveryFailure(
  authority: DeliveryAuthority,
  handoffId: string,
  attempts: number,
): void {
  const stores = getProjectDomainStores(authority.scope);
  const mission = stores.missions.get(authority.missionId);
  if (mission && mission.status !== 'done' && mission.status !== 'failed') {
    if (
      durableDispatchOwnsHandoff(authority, handoffId) ||
      missionDispatchesAlreadyTerminal(authority)
    ) {
      requestRuntimeRecovery(authority, handoffId);
      console.warn(
        '[idle-delivery] Maestro não aceitou a entrega após retry limitado; ' +
          `recuperação física foi solicitada e a missão permanece em curso ` +
          `(mission=${authority.missionId}, ` +
          `handoff=${handoffId}, session=${authority.sessionId}, ` +
          `attempts=${attempts})`,
      );
      return;
    }
    const marker = `<!-- nexus:handoff-delivery-failed:${handoffId} -->`;
    const description = mission.description.includes(marker)
      ? mission.description
      : [mission.description.trim(), `${marker}\n${HANDOFF_DELIVERY_CTA}`]
          .filter(Boolean)
          .join('\n\n')
          .slice(0, 65_536);
    if (mission.status !== 'blocked' || description !== mission.description) {
      stores.missions.update(authority.missionId, {
        status: 'blocked',
        description,
      });
    }
    console.warn(
      '[idle-delivery] handoff não aceito após requeue limitado ' +
        `(mission=${authority.missionId}, handoff=${handoffId}, ` +
        `session=${authority.sessionId}, attempts=${attempts})`,
    );
  }
}

function handleSubmitNotAccepted(
  pending: PendingEnter,
  failureCode = 'accept_timeout',
): void {
  getProjectDomainStores(pending.authority.scope).handoffs.failDeliveryAttempt({
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
  if (handoff?.deliveryState === 'queued') {
    onHandoffSubmitted(handoff, authority.scope);
  }
}

function submitDelivery(
  authority: DeliveryAuthority,
  handoffId: string,
  attempt: HandoffDeliveryAttempt,
): void {
  const pending: PendingEnter = {
    authority,
    handoffId,
    attemptId: attempt.id,
    attemptNo: attempt.attemptNo,
    submitStarted: true,
  };
  pendingEnters.add(pending);
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
  pending.retryTimer = setTimeout(() => {
    if (
      isCurrentAuthority(authority) &&
      isSessionInjectableIdle(authority.sessionId)
    ) {
      orchWriteSession(authority.sessionId, '\r', {
        markInputBusy: false,
      });
    }
  }, 400);
}

function deliverNow(authority: DeliveryAuthority, handoff: Handoff): boolean {
  if (
    !isCurrentAuthority(authority) ||
    !isSessionInjectableIdle(authority.sessionId)
  ) return false;
  const stores = getProjectDomainStores(authority.scope);
  const current = stores.handoffs.get(handoff.id);
  if (!current) return false;
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
  const ok = orchWriteSession(
    authority.sessionId,
    formatDelivery(
      current,
      schedulerDeliveryTopology(authority, current),
    ),
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
  // Paste, durable "pasted" transition and Enter share one JS turn. No other
  // agent activity can steal the 150 ms gap that previously existed here.
  submitDelivery(authority, current.id, attempt);
  return true;
}

function scheduleStableDelivery(
  authority: DeliveryAuthority,
  handoff: Handoff,
): boolean {
  if (
    !isCurrentAuthority(authority) ||
    !isSessionInjectableIdle(authority.sessionId)
  ) return false;
  let pending: PendingDeliveryStart;
  const timer = setTimeout(() => {
    clearPendingDeliveryStart(pending);
    if (!isCurrentAuthority(authority)) return;
    if (!isSessionInjectableIdle(authority.sessionId)) {
      enqueueHandoff(authority, handoff);
      return;
    }
    deliverNow(authority, handoff);
  }, DELIVERY_IDLE_STABILITY_MS);
  pending = { authority, handoff, timer };
  pendingDeliveryStarts.add(pending);
  return true;
}

function flushQueue(sessionId: string): void {
  if (!isSessionInjectableIdle(sessionId)) return;
  const matches = [...queues.entries()].filter(
    ([, queue]) => queue[0]?.authority.sessionId === sessionId,
  );
  if (matches.length === 0) return;
  if (matches.length !== 1) {
    for (const [key] of matches) queues.delete(key);
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
    if (state === 'idle') flushQueue(sessionId);
  });
  untapSemanticStatus = tapAgentSemanticStatus((entry) => {
    if (
      (entry.status === 'idle' || entry.status === 'completed') &&
      isSessionInjectableIdle(entry.sessionId)
    ) {
      flushQueue(entry.sessionId);
    } else {
      requeuePendingDeliveryStarts(entry.sessionId);
    }
  });
  untapExit = tapSessionExit((sessionId) => {
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
    }
    for (const pending of [...pendingDeliveryStarts]) {
      if (pending.authority.sessionId !== sessionId) continue;
      clearPendingDeliveryStart(pending);
    }
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
  unsubscribeScopeChanges?.();
  untapState = null;
  untapExit = null;
  untapSemanticStatus = null;
  unsubscribeScopeChanges = null;
  queues.clear();
  configureHandoffDeliveryRuntimeRecovery(null);
  for (const pending of [...pendingEnters]) clearPendingEnter(pending);
  for (const pending of [...pendingDeliveryStarts]) {
    clearPendingDeliveryStart(pending);
  }
}

/** Resolve the exact owner/scope/mission authority for the orchestrator. */
function targetAuthority(
  handoff: Handoff,
  scope: ProjectExecutionScope,
): DeliveryAuthority | null {
  if (!handoff.missionId) return null;
  const missionId = handoff.missionId;
  const sessionId = getProjectDomainStores(scope).missions.get(
    missionId,
  )?.orchestratorSessionId;
  if (!sessionId) return null;
  const pane = getPaneRuntimeAuthorityBySession(sessionId);
  const rendererScope = pane?.owner
    ? getRendererWorkspaceScope(pane.owner)
    : null;
  if (
    !pane ||
    pane.sessionId !== sessionId ||
    pane.kind !== 'cli-agent' ||
    pane.role !== 'orchestrator' ||
    pane.missionId !== missionId ||
    !pane.scope ||
    !sameProjectScope(pane.scope, scope) ||
    (pane.owner !== null &&
      (!rendererScope || !sameProjectScope(rendererScope, scope)))
  ) {
    return null;
  }
  return Object.freeze({
    owner: pane.owner,
    paneId: pane.paneId,
    sessionId,
    missionId,
    scope: Object.freeze({ ...scope }),
  });
}

/** Called by nexus_handoff_submit (and the legacy stream parser). */
export function onHandoffSubmitted(
  handoff: Handoff,
  scope: ProjectExecutionScope,
): PetStudioCompletionResult | null {
  const petCompletion = completePetStudioHandoff(handoff, scope);
  // Pet Studio has no worker/orchestrator loop: its sole Codex session submits
  // its own validated result. Never queue that message back into the same PTY.
  if (petCompletion) return petCompletion;
  if (isDiagnosticDriverHandoff(handoff)) return null;
  const authority = targetAuthority(handoff, scope);
  if (!authority) return null; // No trusted orchestrator — stays listed as pending.
  if (
    isSessionInjectableIdle(authority.sessionId) &&
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
): number {
  const stores = getProjectDomainStores(scope);
  const pending = stores.handoffs.list({
    missionId,
    includeDelivered: false,
  });
  for (const handoff of pending) onHandoffSubmitted(handoff, scope);
  return pending.length;
}
