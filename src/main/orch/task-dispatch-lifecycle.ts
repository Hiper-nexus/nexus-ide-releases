import type { ProjectExecutionScope } from '../../shared/types';
import {
  getAgentSessionInfo,
  getSessionState,
  tapSessionData,
  tapSessionExit,
  tapSessionState,
} from '../pty/pty-manager';
import {
  getAgentSemanticStatusBySession,
  tapAgentSemanticStatus,
  type AgentSemanticStatus,
} from './agent-status';
import { getContextBySession, MAX_STOP_ATTEMPTS } from './gate';
import { ensureGuidedGitBaselineForWorktreeAsync } from '../runtime/guided-greenfield-baseline';
import { getExternalWorkerSessionInfo } from './external-worker-session-registry';
import {
  getAcpDriverSemanticStatus,
  getAcpDriverSession,
} from '../acp/acp-harness-driver';
import {
  requireProjectDomainStoreRegistry,
  type ProjectDomainStoreSuite,
} from './project-domain-store-registry';
import { requestMissionWorkerPaneRetirement } from './pane-registry';
import { TASK_DISPATCH_SESSION_EXIT_REASON } from './task-dispatch-persistence';
import {
  LEGACY_GUIDED_DIRTY_CHECKOUT_TERMINAL_REASON,
  TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS,
} from './task-dispatch-store';
import { productionTaskDispatchWorkerRetirement } from './task-dispatch-worker-retirement';
import { sameProjectScope } from './project-scoped-broadcast';
import { submitPendingAgentPrompt } from './tool-util';

export { TASK_DISPATCH_SESSION_EXIT_REASON };
export const TASK_DISPATCH_ACTIVITY_THROTTLE_MS = 60_000;
export const TASK_DISPATCH_HEARTBEAT_LEASE_MS = 10 * 60_000;
export const TASK_DISPATCH_UNVERIFIED_ACTIVITY_MAX_MS = 30 * 60_000;
export const TASK_DISPATCH_RECONCILE_MS = 30_000;
export const TASK_DISPATCH_TERMINAL_GRACE_MS = 2_000;
export const TASK_DISPATCH_STOP_GATE_GRACE_MS = 60_000;
export const TASK_DISPATCH_STALLED_REASON =
  'O worker ficou sem atividade e sem heartbeat por 10 minutos (stalled).';
export const TASK_DISPATCH_TURN_ENDED_REASON =
  'O worker terminou o turno sem submeter handoff; a task será retomada automaticamente.';

interface TaskDispatchLifecycleOptions {
  readonly now?: () => number;
}

const suites = new Map<string, ProjectDomainStoreSuite>();
const lastActivityRefresh = new Map<string, number>();
/**
 * Repaint probe: a stalled TUI redraws the identical frame over and over
 * (the placeholder handoff block echoed from the kickoff prompt, a frozen
 * screen) — bytes that carry no new information. Same cheap rule as the
 * LegacyHandoffDedupe repaint detection, kept to the immediately-previous
 * chunk so no fingerprint engine is needed: an identical repeat is not
 * progress and must not renew the durable worker lease. A repaint-only
 * worker is then retired by the ordinary stall path when its lease
 * expires, instead of being kept alive indefinitely by its own repaints.
 */
const activityChunkProbe = new Map<
  string,
  { readonly chunk: string; readonly repeat: boolean }
>();
const pendingExitReasons = new Map<string, string>();
const terminalRecoveryTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
const terminalRecoveriesInFlight = new Set<string>();
const terminalRecoveryAttempts = new Map<string, number>();
const unverifiedActivityDeadlines = new Map<string, number>();
let now: () => number = Date.now;
let disposers: Array<() => void> = [];
const retirementPasses = new Map<
  string,
  ReturnType<typeof setImmediate>
>();

function scopeKey(scope: ProjectExecutionScope): string {
  return `${scope.installationId}\0${scope.projectId}\0${scope.checkoutId}`;
}

function sameCoordinates(
  left: Pick<ProjectExecutionScope, 'installationId' | 'projectId' | 'checkoutId'>,
  right: Pick<ProjectExecutionScope, 'installationId' | 'projectId' | 'checkoutId'>,
): boolean {
  return left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId;
}

function physicalWorkerKey(
  sessionId: string,
  workerIncarnationId: string,
): string {
  return `${sessionId}\0${workerIncarnationId}`;
}

function isTerminalTurnStatus(status: AgentSemanticStatus): boolean {
  return status === 'completed' || status === 'error';
}

function clearTerminalRecovery(
  sessionId: string,
  workerIncarnationId?: string,
): void {
  const exactKey = workerIncarnationId
    ? physicalWorkerKey(sessionId, workerIncarnationId)
    : null;
  for (const [key, handle] of terminalRecoveryTimers) {
    if (exactKey ? key !== exactKey : !key.startsWith(`${sessionId}\0`)) {
      continue;
    }
    clearTimeout(handle);
    terminalRecoveryTimers.delete(key);
  }
}

function suiteForSession(sessionId: string): ProjectDomainStoreSuite | null {
  const context = sessionAuthority(sessionId);
  if (!context || context.role !== 'worker' || !context.missionId) return null;
  return suites.get(scopeKey(context.scope)) ?? null;
}

function sessionAuthority(sessionId: string) {
  return getContextBySession(sessionId) ??
    getExternalWorkerSessionInfo(sessionId) ??
    getAcpDriverSession(sessionId)?.agent ??
    null;
}

interface TerminalRecoveryTarget {
  readonly suite: ProjectDomainStoreSuite;
  readonly dispatchId: string;
  readonly taskId: string;
  readonly missionId: string;
  readonly intentVersion: number;
  readonly adapterId?: string;
  readonly paneId: string;
  readonly sessionId: string;
  readonly workerIncarnationId: string;
  readonly terminalObservedAt: number;
}

function hasCurrentTerminalRecoveryAuthority(
  target: TerminalRecoveryTarget,
): boolean {
  if (suites.get(scopeKey(target.suite.scope)) !== target.suite) return false;
  const context = getContextBySession(target.sessionId);
  if (
    !context ||
    context.role !== 'worker' ||
    context.missionId !== target.missionId ||
    context.workerIncarnationId !== target.workerIncarnationId ||
    !sameProjectScope(context.scope, target.suite.scope)
  ) {
    return false;
  }
  let current;
  try {
    current = target.suite.taskDispatches.assertLifecycleAuthority({
      taskId: target.taskId,
      missionId: target.missionId,
      intentVersion: target.intentVersion,
      expectedStates: ['running'],
    });
  } catch {
    return false;
  }
  if (
    current.id !== target.dispatchId ||
    current.state !== 'running' ||
    current.missionId !== target.missionId ||
    current.intentVersion !== target.intentVersion ||
    current.adapterId !== target.adapterId ||
    current.sessionId !== target.sessionId ||
    current.workerIncarnationId !== target.workerIncarnationId ||
    current.handoffId ||
    current.handoffAcceptedAt ||
    current.integrationReceipt ||
    current.completedAt
  ) {
    return false;
  }
  const live = getAgentSessionInfo(target.sessionId);
  const executionScope = context.executionScope ?? context.scope;
  return Boolean(
    live &&
    live.role === 'worker' &&
    live.missionId === target.missionId &&
    live.workerIncarnationId === target.workerIncarnationId &&
    live.paneId === target.paneId &&
    (current.paneId ?? live.paneId) === target.paneId &&
    sameProjectScope(live.scope, executionScope),
  );
}

function remainingTerminalRecoveryGraceMs(
  target: TerminalRecoveryTarget,
): number {
  const requiredGrace = terminalRecoveryGraceMs(target.sessionId);
  const elapsed = Math.max(0, Date.now() - target.terminalObservedAt);
  return Math.max(0, requiredGrace - elapsed);
}

async function retireTerminalTurnWorkerOnce(
  target: TerminalRecoveryTarget,
): Promise<void> {
  if (remainingTerminalRecoveryGraceMs(target) > 0) {
    scheduleTerminalTurnRecovery(target);
    return;
  }
  const semantic = getAgentSemanticStatusBySession(target.sessionId);
  if (
    !semantic ||
    !isTerminalTurnStatus(semantic.status) ||
    !hasCurrentTerminalRecoveryAuthority(target)
  ) {
    return;
  }

  const workerKey = physicalWorkerKey(
    target.sessionId,
    target.workerIncarnationId,
  );
  const recoveryAttempt = terminalRecoveryAttempts.get(workerKey) ?? 0;
  if (
    recoveryAttempt === 0 &&
    getSessionState(target.sessionId) === 'idle'
  ) {
    terminalRecoveryAttempts.set(workerKey, 1);
    try {
      const resumed = await submitPendingAgentPrompt(
        target.sessionId,
        {
          assertCurrentAuthority: () => {
            if (!hasCurrentTerminalRecoveryAuthority(target)) {
              throw new Error('terminal-turn recovery authority was revoked');
            }
          },
        },
        {
          adapterId: target.adapterId,
          canSubmit: () =>
            remainingTerminalRecoveryGraceMs(target) === 0 &&
            isTerminalTurnStatus(
              getAgentSemanticStatusBySession(target.sessionId)?.status ??
                'idle',
            ) &&
            hasCurrentTerminalRecoveryAuthority(target),
        },
      );
      if (resumed) return;
    } catch (error) {
      if (!hasCurrentTerminalRecoveryAuthority(target)) return;
      console.warn(
        '[task-dispatch-lifecycle] restored prompt resume failed:',
        error,
      );
    }
    if (remainingTerminalRecoveryGraceMs(target) > 0) {
      scheduleTerminalTurnRecovery(target);
      return;
    }
    const currentSemantic = getAgentSemanticStatusBySession(target.sessionId);
    if (
      !currentSemantic ||
      !isTerminalTurnStatus(currentSemantic.status) ||
      !hasCurrentTerminalRecoveryAuthority(target)
    ) {
      return;
    }
  }

  pendingExitReasons.set(workerKey, TASK_DISPATCH_TURN_ENDED_REASON);
  let retired = false;
  try {
    retired = await requestMissionWorkerPaneRetirement({
      paneId: target.paneId,
      sessionId: target.sessionId,
      missionId: target.missionId,
      workerIncarnationId: target.workerIncarnationId,
      scope: target.suite.scope,
    });
  } catch (error) {
    console.warn(
      '[task-dispatch-lifecycle] terminal-turn worker retirement failed:',
      error,
    );
  }
  if (!retired) {
    pendingExitReasons.delete(workerKey);
    console.warn(
      '[task-dispatch-lifecycle] terminal-turn worker exit not proven:',
      `${target.missionId}/${target.taskId}`,
    );
    return;
  }

  lastActivityRefresh.delete(target.sessionId);
  activityChunkProbe.delete(target.sessionId);
  try {
    target.suite.taskDispatches.blockSessionExit({
      sessionId: target.sessionId,
      workerIncarnationId: target.workerIncarnationId,
      reason: TASK_DISPATCH_TURN_ENDED_REASON,
    });
  } finally {
    pendingExitReasons.delete(workerKey);
  }
}

async function retireTerminalTurnWorker(
  target: TerminalRecoveryTarget,
): Promise<void> {
  const workerKey = physicalWorkerKey(
    target.sessionId,
    target.workerIncarnationId,
  );
  if (terminalRecoveriesInFlight.has(workerKey)) return;
  terminalRecoveriesInFlight.add(workerKey);
  try {
    await retireTerminalTurnWorkerOnce(target);
  } finally {
    terminalRecoveriesInFlight.delete(workerKey);
  }
}

function scheduleTerminalTurnRecovery(
  target: TerminalRecoveryTarget,
): void {
  const workerKey = physicalWorkerKey(
    target.sessionId,
    target.workerIncarnationId,
  );
  if (terminalRecoveryTimers.has(workerKey)) return;
  const handle = setTimeout(() => {
    terminalRecoveryTimers.delete(workerKey);
    void retireTerminalTurnWorker(target).catch((error) => {
      console.warn(
        '[task-dispatch-lifecycle] terminal-turn recovery deferred:',
        error,
      );
    });
  }, remainingTerminalRecoveryGraceMs(target));
  handle.unref?.();
  terminalRecoveryTimers.set(workerKey, handle);
}

function terminalRecoveryGraceMs(sessionId: string): number {
  const context = getContextBySession(sessionId);
  const isRejectedStop =
    context?.role === 'worker' &&
    context.handoffSubmitted === false &&
    context.stopAttempts > 0 &&
    context.stopAttempts < MAX_STOP_ATTEMPTS;
  return isRejectedStop
    ? TASK_DISPATCH_STOP_GATE_GRACE_MS
    : TASK_DISPATCH_TERMINAL_GRACE_MS;
}

function scheduleTerminalTurnRecoveryForSession(sessionId: string): void {
  const semantic = getAgentSemanticStatusBySession(sessionId);
  if (!semantic || !isTerminalTurnStatus(semantic.status)) {
    clearTerminalRecovery(sessionId);
    return;
  }
  const authority = sessionAuthority(sessionId);
  const live = getAgentSessionInfo(sessionId);
  if (
    !authority ||
    authority.role !== 'worker' ||
    !authority.missionId ||
    !authority.workerIncarnationId ||
    !live ||
    live.role !== 'worker' ||
    live.missionId !== authority.missionId ||
    live.workerIncarnationId !== authority.workerIncarnationId ||
    !sameCoordinates(live.scope, authority.scope)
  ) {
    return;
  }
  const suite = suites.get(scopeKey(authority.scope));
  if (!suite) return;
  const dispatch = suite.taskDispatches.list().find(
    (candidate) =>
      candidate.state === 'running' &&
      candidate.missionId === authority.missionId &&
      candidate.sessionId === sessionId &&
      candidate.workerIncarnationId === authority.workerIncarnationId,
  );
  const paneId = dispatch?.paneId ?? live.paneId;
  if (!dispatch || !paneId) return;
  scheduleTerminalTurnRecovery({
    suite,
    dispatchId: dispatch.id,
    taskId: dispatch.taskId,
    missionId: dispatch.missionId,
    intentVersion: dispatch.intentVersion,
    adapterId: dispatch.adapterId,
    paneId,
    sessionId,
    workerIncarnationId: authority.workerIncarnationId,
    terminalObservedAt: Date.now(),
  });
}

async function retireTerminalWorkers(
  suite: ProjectDomainStoreSuite,
): Promise<void> {
  const dispatches = suite.taskDispatches.list();
  const missionIds = new Set(dispatches.map((dispatch) => dispatch.missionId));
  for (const missionId of missionIds) {
    await productionTaskDispatchWorkerRetirement.retireMissionWorkers({
      scope: suite.scope,
      missionId,
      dispatches,
      deps: {
        getDispatch: (taskId) => suite.taskDispatches.get(taskId),
        closeWorker: ({
          paneId,
          sessionId,
          missionId: workerMissionId,
          workerIncarnationId,
          scope,
        }) =>
          requestMissionWorkerPaneRetirement({
            paneId,
            sessionId,
            missionId: workerMissionId,
            workerIncarnationId,
            scope,
          }),
      },
    });
  }
}

function scheduleTerminalWorkerRetirement(
  suite: ProjectDomainStoreSuite,
): void {
  const key = scopeKey(suite.scope);
  if (retirementPasses.has(key)) return;
  const handle = setImmediate(() => {
    retirementPasses.delete(key);
    void retireTerminalWorkers(suite).catch((error) => {
      console.warn(
        '[task-dispatch-lifecycle] worker retirement deferred:',
        error,
      );
    });
  });
  retirementPasses.set(key, handle);
}

export async function reconcileLegacyGuidedDirtyCheckoutBootstrap(
  suite: ProjectDomainStoreSuite,
): Promise<void> {
  const legacyBlocks = suite.taskDispatches.list().filter(
    (dispatch) =>
      dispatch.state === 'blocked' &&
      dispatch.attempt === TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS &&
      dispatch.lastError ===
        LEGACY_GUIDED_DIRTY_CHECKOUT_TERMINAL_REASON,
  );
  if (legacyBlocks.length === 0) return;
  try {
    const hasRecoverableBlock = legacyBlocks.some((dispatch) =>
      suite.taskDispatches.canRecoverLegacyGuidedDirtyCheckoutBootstrap(
        dispatch.taskId,
      ),
    );
    if (!hasRecoverableBlock) return;

    // Prove durable mission/task/intent eligibility before touching Git. The
    // store repeats the complete CAS after the checkpoint, so a replan racing
    // this pass can only turn the recovery into a no-op.
    await ensureGuidedGitBaselineForWorktreeAsync(suite.scope);
    for (const dispatch of legacyBlocks) {
      suite.taskDispatches.recoverLegacyGuidedDirtyCheckoutBootstrap(
        dispatch.taskId,
      );
    }
  } catch (error) {
    console.warn(
      '[task-dispatch-lifecycle] legacy dirty-checkout recovery deferred:',
      error,
    );
  }
}

function renewFromActivity(sessionId: string): void {
  const at = now();
  const previous = lastActivityRefresh.get(sessionId);
  if (previous !== undefined && at - previous < TASK_DISPATCH_ACTIVITY_THROTTLE_MS) {
    return;
  }
  const context = sessionAuthority(sessionId);
  if (
    !context ||
    context.role !== 'worker' ||
    !context.missionId ||
    !context.workerIncarnationId
  ) return;
  const pty = getAgentSessionInfo(sessionId);
  const semantic = getAgentSemanticStatusBySession(sessionId);
  let leaseMs = TASK_DISPATCH_HEARTBEAT_LEASE_MS;
  const hasFreshWorkingSemantic =
    semantic?.status === 'working' &&
    at - Math.min(at, semantic.updatedAt) <
      TASK_DISPATCH_UNVERIFIED_ACTIVITY_MAX_MS;
  if (pty && hasFreshWorkingSemantic) {
    const semanticDeadline =
      Math.min(at, semantic.updatedAt) +
      TASK_DISPATCH_UNVERIFIED_ACTIVITY_MAX_MS;
    leaseMs = Math.min(leaseMs, semanticDeadline - at);
    unverifiedActivityDeadlines.delete(
      physicalWorkerKey(sessionId, context.workerIncarnationId),
    );
  } else if (pty) {
    if (semantic && semantic.status !== 'working') return;
    const workerKey = physicalWorkerKey(
      sessionId,
      context.workerIncarnationId,
    );
    const semanticDeadline =
      semantic?.status === 'working'
        ? Math.min(at, semantic.updatedAt) +
          TASK_DISPATCH_UNVERIFIED_ACTIVITY_MAX_MS
        : null;
    const deadline =
      unverifiedActivityDeadlines.get(workerKey) ??
      semanticDeadline ??
      at + TASK_DISPATCH_UNVERIFIED_ACTIVITY_MAX_MS;
    unverifiedActivityDeadlines.set(workerKey, deadline);
    const remaining = deadline - at;
    if (remaining <= 0) return;
    leaseMs = Math.min(leaseMs, remaining);
  }
  const suite = suites.get(scopeKey(context.scope));
  if (!suite) return;
  try {
    const dispatch = suite.taskDispatches.heartbeat({
      sessionId,
      missionId: context.missionId,
      workerIncarnationId: context.workerIncarnationId,
      leaseMs,
    });
    if (dispatch.missionId !== context.missionId) {
      throw new Error('heartbeat retornou dispatch de outra missão');
    }
    lastActivityRefresh.set(sessionId, at);
  } catch {
    // Ordinary user/orchestrator panes and pre-bind worker output have no
    // dispatch yet. They are intentionally ignored; reconciliation remains
    // fail-closed for an expired durable row.
  }
}

function blockExitedSession(
  sessionId: string,
  authorityHint?: {
    readonly role: string;
    readonly missionId?: string;
    readonly workerIncarnationId?: string;
    readonly scope: ProjectExecutionScope;
  } | null,
): void {
  lastActivityRefresh.delete(sessionId);
  activityChunkProbe.delete(sessionId);
  const authority = authorityHint ?? sessionAuthority(sessionId);
  // No generation proof means the exit may be a delayed event from a replaced
  // process. Leave the durable lease to expire instead of blocking a newer
  // incarnation that happens to share transport coordinates.
  if (!authority?.workerIncarnationId) return;
  const workerKey = physicalWorkerKey(
    sessionId,
    authority.workerIncarnationId,
  );
  clearTerminalRecovery(sessionId, authority.workerIncarnationId);
  terminalRecoveryAttempts.delete(workerKey);
  unverifiedActivityDeadlines.delete(workerKey);
  const reason =
    pendingExitReasons.get(workerKey) ?? TASK_DISPATCH_SESSION_EXIT_REASON;
  const preferred = suiteForSession(sessionId);
  const candidates = preferred ? [preferred] : [...suites.values()];

  for (const suite of candidates) {
    try {
      const blocked = suite.taskDispatches.blockSessionExit({
        sessionId,
        workerIncarnationId: authority.workerIncarnationId,
        reason,
      });
      if (blocked) {
        pendingExitReasons.delete(workerKey);
        return;
      }
    } catch (error) {
      console.warn('[task-dispatch-lifecycle] failed to persist worker exit:', error);
      // The preferred scope normally makes this a single candidate. During
      // teardown, if authority already vanished, do not let one unavailable
      // store prevent the exact session lookup in another mounted scope.
      continue;
    }
  }
  pendingExitReasons.delete(workerKey);
}

export function prepareTaskDispatchLifecycle(
  options: TaskDispatchLifecycleOptions = {},
): void {
  shutdownTaskDispatchLifecycle();
  now = options.now ?? Date.now;
  const registry = requireProjectDomainStoreRegistry();
  disposers = [
    registry.onScope((scope, suite) => {
      suites.set(scopeKey(scope), suite);
      scheduleTerminalWorkerRetirement(suite);
    }),
    registry.onChange((scope, store) => {
      if (store !== 'task-dispatches') return;
      const suite = suites.get(scopeKey(scope));
      if (suite) scheduleTerminalWorkerRetirement(suite);
    }),
    tapSessionData((sessionId, data) => {
      const previous = activityChunkProbe.get(sessionId);
      const repeat = previous?.chunk === data;
      activityChunkProbe.set(sessionId, { chunk: data, repeat });
      if (repeat) return;
      renewFromActivity(sessionId);
    }),
    tapSessionState((sessionId, state) => {
      if (state !== 'busy') return;
      // An idle→busy transition caused by a pure repaint carries no new
      // output either — the data tap for those same bytes was suppressed.
      if (activityChunkProbe.get(sessionId)?.repeat) return;
      renewFromActivity(sessionId);
    }),
    tapAgentSemanticStatus((entry) => {
      if (isTerminalTurnStatus(entry.status)) {
        scheduleTerminalTurnRecoveryForSession(entry.sessionId);
      } else {
        clearTerminalRecovery(entry.sessionId);
      }
    }),
    tapSessionExit((sessionId, authority) =>
      blockExitedSession(sessionId, authority),
    ),
  ];
}

/**
 * Boot/tick recovery. Process existence prevents a duplicate spawn, but never
 * renews a worker lease by itself: only fresh provider-semantic `working`
 * activity or an explicit nexus_worker_heartbeat proves PTY progress. A
 * working hook has an absolute freshness limit; hookless CLIs receive the same
 * bounded compatibility window and must use the explicit heartbeat for longer
 * turns. Pure TUI repaints (the chunk is byte-identical to the previous one)
 * are filtered before any of this and never renew the lease. Thus an idle TUI
 * repaint cannot keep a task alive forever. An expired
 * exact worker is retired first and then requeued through the same
 * physical-exit fence as a natural exit.
 * Missing runtimes and expired ambiguous pre-bind effects also return to the
 * scheduler with bounded backoff; none of these technical failures blocks the
 * mission.
 */
export async function reconcileTaskDispatchLifecycle(
  at = now(),
): Promise<void> {
  for (const suite of suites.values()) {
    await reconcileLegacyGuidedDirtyCheckoutBootstrap(suite);
    const dispatches = suite.taskDispatches.list();
    const active = dispatches.filter((dispatch) =>
      ['claimed', 'routed', 'spawning', 'running'].includes(dispatch.state),
    );
    for (const dispatch of active) {
      const ptyLive = dispatch.sessionId
        ? getAgentSessionInfo(dispatch.sessionId)
        : null;
      const externalLive =
        dispatch.sessionId && !ptyLive
          ? getExternalWorkerSessionInfo(dispatch.sessionId)
          : null;
      const acpLive =
        dispatch.sessionId && !ptyLive && !externalLive
          ? getAcpDriverSession(dispatch.sessionId)
          : null;
      const live = ptyLive ?? externalLive ?? acpLive?.agent ?? null;
      const hasExactLiveRuntime =
        live &&
        live.role === 'worker' &&
        live.missionId === dispatch.missionId &&
        Boolean(dispatch.workerIncarnationId) &&
        live.workerIncarnationId === dispatch.workerIncarnationId &&
        sameCoordinates(live.scope, suite.scope);
      if (hasExactLiveRuntime) {
        const semantic = dispatch.sessionId
          ? getAgentSemanticStatusBySession(dispatch.sessionId)
          : null;
        const acpSemantic = dispatch.sessionId
          ? getAcpDriverSemanticStatus(dispatch.sessionId)
          : null;
        if (
          ptyLive &&
          semantic &&
          isTerminalTurnStatus(semantic.status) &&
          dispatch.state === 'running'
        ) {
          const paneId = dispatch.paneId ?? ptyLive.paneId;
          if (paneId) {
            scheduleTerminalTurnRecovery({
              suite,
              dispatchId: dispatch.id,
              taskId: dispatch.taskId,
              missionId: dispatch.missionId,
              intentVersion: dispatch.intentVersion,
              adapterId: dispatch.adapterId,
              paneId,
              sessionId: dispatch.sessionId!,
              workerIncarnationId: dispatch.workerIncarnationId!,
              terminalObservedAt: Date.now(),
            });
          }
          continue;
        }
        if (semantic?.status === 'awaiting-input' || acpSemantic === 'awaiting-input') continue;
        if (dispatch.leaseExpiresAt >= at) continue;
        if (!ptyLive && acpLive) {
          const workerKey = physicalWorkerKey(
            dispatch.sessionId!,
            dispatch.workerIncarnationId!,
          );
          pendingExitReasons.set(workerKey, TASK_DISPATCH_STALLED_REASON);
          let retired = false;
          try {
            retired = await acpLive.shutdown().then(
              () => getAcpDriverSession(dispatch.sessionId!) === null,
            );
          } catch (error) {
            console.warn(
              '[task-dispatch-lifecycle] stalled ACP worker shutdown failed:',
              error,
            );
          }
          if (retired) {
            lastActivityRefresh.delete(dispatch.sessionId!);
            activityChunkProbe.delete(dispatch.sessionId!);
            suite.taskDispatches.blockSessionExit({
              sessionId: dispatch.sessionId!,
              workerIncarnationId: dispatch.workerIncarnationId!,
              reason: TASK_DISPATCH_STALLED_REASON,
            });
          }
          pendingExitReasons.delete(workerKey);
          continue;
        }
        if (!ptyLive) {
          // A non-ACP external transport has no close authority in this
          // process. Keep its row fenced rather than claiming a false exit.
          console.warn(
            '[task-dispatch-lifecycle] expired external worker lacks close authority:',
            `${dispatch.missionId}/${dispatch.taskId}`,
          );
          continue;
        }
        const paneId = dispatch.paneId ?? ptyLive.paneId;
        if (!paneId) {
          console.warn(
            '[task-dispatch-lifecycle] expired live worker has no pane identity:',
            dispatch.taskId,
          );
          continue;
        }
        const workerKey = physicalWorkerKey(
          dispatch.sessionId!,
          dispatch.workerIncarnationId!,
        );
        pendingExitReasons.set(workerKey, TASK_DISPATCH_STALLED_REASON);
        let retired = false;
        try {
          retired = await requestMissionWorkerPaneRetirement({
            paneId,
            sessionId: dispatch.sessionId!,
            missionId: dispatch.missionId,
            workerIncarnationId: dispatch.workerIncarnationId!,
            scope: suite.scope,
          });
        } catch (error) {
          console.warn(
            '[task-dispatch-lifecycle] stalled worker retirement failed:',
            error,
          );
        }
        if (!retired) {
          pendingExitReasons.delete(workerKey);
          // Keep the expired row fenced while a physical process may still
          // exist. The next coordinator pass retries exact retirement; it
          // never starts a duplicate worker.
          console.warn(
            '[task-dispatch-lifecycle] stalled worker exit not proven:',
            `${dispatch.missionId}/${dispatch.taskId}`,
          );
          continue;
        }
        lastActivityRefresh.delete(dispatch.sessionId!);
        activityChunkProbe.delete(dispatch.sessionId!);
        suite.taskDispatches.blockSessionExit({
          sessionId: dispatch.sessionId!,
          workerIncarnationId: dispatch.workerIncarnationId!,
          reason: TASK_DISPATCH_STALLED_REASON,
        });
        pendingExitReasons.delete(workerKey);
        continue;
      }
      const hasMissingBoundRuntime =
        dispatch.state === 'running' &&
        Boolean(dispatch.sessionId) &&
        !hasExactLiveRuntime;
      const hasExpiredAmbiguousEffect = dispatch.leaseExpiresAt < at;
      if (!hasMissingBoundRuntime && !hasExpiredAmbiguousEffect) continue;
      try {
        suite.taskDispatches.requeueMissingRuntime({
          taskId: dispatch.taskId,
          revision: dispatch.revision,
        });
      } catch (error) {
        console.warn(
          '[task-dispatch-lifecycle] missing runtime reconcile failed:',
          error,
        );
      }
    }
    await retireTerminalWorkers(suite);
  }
}

export function shutdownTaskDispatchLifecycle(): void {
  for (const dispose of disposers.splice(0)) dispose();
  for (const handle of terminalRecoveryTimers.values()) clearTimeout(handle);
  terminalRecoveryTimers.clear();
  terminalRecoveryAttempts.clear();
  unverifiedActivityDeadlines.clear();
  for (const handle of retirementPasses.values()) clearImmediate(handle);
  retirementPasses.clear();
  productionTaskDispatchWorkerRetirement.reset();
  suites.clear();
  lastActivityRefresh.clear();
  activityChunkProbe.clear();
  pendingExitReasons.clear();
  now = Date.now;
}
