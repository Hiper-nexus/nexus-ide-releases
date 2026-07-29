import type { ProjectExecutionScope } from '../../shared/types';
import {
  getAgentSessionInfo,
  tapSessionData,
  tapSessionExit,
  tapSessionState,
} from '../pty/pty-manager';
import { getContextBySession } from './gate';
import { ensureGuidedGitBaselineForWorktreeAsync } from '../runtime/guided-greenfield-baseline';
import { getExternalWorkerSessionInfo } from './external-worker-session-registry';
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

export { TASK_DISPATCH_SESSION_EXIT_REASON };
export const TASK_DISPATCH_ACTIVITY_THROTTLE_MS = 60_000;
export const TASK_DISPATCH_HEARTBEAT_LEASE_MS = 10 * 60_000;
export const TASK_DISPATCH_RECONCILE_MS = 30_000;
export const TASK_DISPATCH_STALLED_REASON =
  'O worker ficou sem atividade e sem heartbeat por 10 minutos (stalled).';

interface TaskDispatchLifecycleOptions {
  readonly now?: () => number;
}

const suites = new Map<string, ProjectDomainStoreSuite>();
const lastActivityRefresh = new Map<string, number>();
const pendingExitReasons = new Map<string, string>();
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

function suiteForSession(sessionId: string): ProjectDomainStoreSuite | null {
  const context = sessionAuthority(sessionId);
  if (!context || context.role !== 'worker' || !context.missionId) return null;
  return suites.get(scopeKey(context.scope)) ?? null;
}

function sessionAuthority(sessionId: string) {
  return getContextBySession(sessionId) ??
    getExternalWorkerSessionInfo(sessionId);
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
  const suite = suites.get(scopeKey(context.scope));
  if (!suite) return;
  try {
    const dispatch = suite.taskDispatches.heartbeat({
      sessionId,
      missionId: context.missionId,
      workerIncarnationId: context.workerIncarnationId,
      leaseMs: TASK_DISPATCH_HEARTBEAT_LEASE_MS,
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
  const authority = authorityHint ?? sessionAuthority(sessionId);
  // No generation proof means the exit may be a delayed event from a replaced
  // process. Leave the durable lease to expire instead of blocking a newer
  // incarnation that happens to share transport coordinates.
  if (!authority?.workerIncarnationId) return;
  const workerKey = physicalWorkerKey(
    sessionId,
    authority.workerIncarnationId,
  );
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
    tapSessionData((sessionId) => renewFromActivity(sessionId)),
    tapSessionState((sessionId, state) => {
      if (state === 'busy') renewFromActivity(sessionId);
    }),
    tapSessionExit((sessionId, authority) =>
      blockExitedSession(sessionId, authority),
    ),
  ];
}

/**
 * Boot/tick recovery. Process existence prevents a duplicate spawn, but never
 * renews a worker lease by itself: only PTY activity or an explicit worker
 * heartbeat proves progress. An expired exact worker is retired first and
 * then requeued through the same physical-exit fence as a natural exit.
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
      const live = ptyLive ?? externalLive;
      const hasExactLiveRuntime =
        live &&
        live.role === 'worker' &&
        live.missionId === dispatch.missionId &&
        Boolean(dispatch.workerIncarnationId) &&
        live.workerIncarnationId === dispatch.workerIncarnationId &&
        sameCoordinates(live.scope, suite.scope);
      if (hasExactLiveRuntime) {
        if (dispatch.leaseExpiresAt >= at) continue;
        if (!ptyLive) {
          // External transports need their own close-and-exit proof. There is
          // no production registrar today; keeping the row fenced is safer
          // than pretending a PTY pane retirement closed an external worker.
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
  for (const handle of retirementPasses.values()) clearImmediate(handle);
  retirementPasses.clear();
  productionTaskDispatchWorkerRetirement.reset();
  suites.clear();
  lastActivityRefresh.clear();
  pendingExitReasons.clear();
  now = Date.now;
}
