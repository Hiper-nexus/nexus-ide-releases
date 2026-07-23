import type { ProjectExecutionScope } from '../../shared/types';
import { isCurrentProcessRealMissionE2E } from '../../shared/real-mission-e2e';
import {
  getAgentSessionInfo,
  tapSessionData,
  tapSessionExit,
  tapSessionState,
} from '../pty/pty-manager';
import { advanceRealMissionE2EMainOwnedChain } from '../real-mission-e2e-main-owned';
import { getContextBySession } from './gate';
import { getExternalWorkerSessionInfo } from './external-worker-session-registry';
import {
  requireProjectDomainStoreRegistry,
  type ProjectDomainStoreSuite,
} from './project-domain-store-registry';

export const TASK_DISPATCH_ACTIVITY_THROTTLE_MS = 60_000;
export const TASK_DISPATCH_HEARTBEAT_LEASE_MS = 10 * 60_000;
export const TASK_DISPATCH_RECONCILE_MS = 30_000;

interface TaskDispatchLifecycleOptions {
  readonly now?: () => number;
}

const suites = new Map<string, ProjectDomainStoreSuite>();
const lastActivityRefresh = new Map<string, number>();
let now: () => number = Date.now;
let disposers: Array<() => void> = [];

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

function suiteForSession(sessionId: string): ProjectDomainStoreSuite | null {
  const context = sessionAuthority(sessionId);
  if (!context || context.role !== 'worker' || !context.missionId) return null;
  return suites.get(scopeKey(context.scope)) ?? null;
}

function sessionAuthority(sessionId: string) {
  return getContextBySession(sessionId) ??
    getExternalWorkerSessionInfo(sessionId);
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
  const preferred = suiteForSession(sessionId);
  const candidates = preferred ? [preferred] : [...suites.values()];

  // Release gate: CLIs do not orchestrate. If the worker PTY dies before the
  // LLM submits a handoff, finish the durable artifact path while the
  // dispatch is still `running` — before the exit fence blocks the mission.
  if (
    isCurrentProcessRealMissionE2E() &&
    authority.role === 'worker' &&
    authority.missionId
  ) {
    for (const suite of candidates) {
      try {
        const advanced = advanceRealMissionE2EMainOwnedChain(
          suite,
          authority.missionId,
          suite.scope,
        );
        if (advanced.advanced) {
          console.log(
            `[task-dispatch-lifecycle] real-mission main-owned on exit: ${advanced.reason}`,
          );
          // Handoff accepted → exit fence must not block a completed path.
          const current = suite.taskDispatches
            .list(authority.missionId)
            .find(
              (row) =>
                row.sessionId === sessionId &&
                row.workerIncarnationId === authority.workerIncarnationId,
            );
          if (
            current &&
            ['handoff_ready', 'merging', 'completed'].includes(current.state)
          ) {
            return;
          }
        }
      } catch (error) {
        console.warn(
          '[task-dispatch-lifecycle] real-mission main-owned on exit failed:',
          error,
        );
      }
    }
  }

  for (const suite of candidates) {
    try {
      const blocked = suite.taskDispatches.blockSessionExit({
        sessionId,
        workerIncarnationId: authority.workerIncarnationId,
        reason: 'O worker encerrou sem entregar um handoff confiável.',
      });
      if (blocked) return;
    } catch (error) {
      console.warn('[task-dispatch-lifecycle] failed to persist worker exit:', error);
      // The preferred scope normally makes this a single candidate. During
      // teardown, if authority already vanished, do not let one unavailable
      // store prevent the exact session lookup in another mounted scope.
      continue;
    }
  }
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
 * Boot/tick recovery. Exact live sessions are adopted by renewing their lease;
 * every expired ambiguous effect is blocked with one CTA and is never respawned.
 */
export async function reconcileTaskDispatchLifecycle(
  at = now(),
): Promise<void> {
  for (const suite of suites.values()) {
    const active = suite.taskDispatches.list().filter((dispatch) =>
      ['claimed', 'routed', 'spawning', 'running'].includes(dispatch.state) &&
      dispatch.leaseExpiresAt < at,
    );
    for (const dispatch of active) {
      const live = dispatch.sessionId
        ? getAgentSessionInfo(dispatch.sessionId) ??
          getExternalWorkerSessionInfo(dispatch.sessionId)
        : null;
      if (
        live &&
        live.role === 'worker' &&
        live.missionId === dispatch.missionId &&
        Boolean(dispatch.workerIncarnationId) &&
        live.workerIncarnationId === dispatch.workerIncarnationId &&
        sameCoordinates(live.scope, suite.scope)
      ) {
        try {
          suite.taskDispatches.heartbeat({
            sessionId: dispatch.sessionId!,
            missionId: dispatch.missionId,
            dispatchId: dispatch.id,
            workerIncarnationId: dispatch.workerIncarnationId!,
            leaseMs: TASK_DISPATCH_HEARTBEAT_LEASE_MS,
          });
          lastActivityRefresh.set(dispatch.sessionId!, at);
          continue;
        } catch (error) {
          console.warn('[task-dispatch-lifecycle] live adoption failed:', error);
        }
      }
      try {
        suite.taskDispatches.blockExpired({
          taskId: dispatch.taskId,
          revision: dispatch.revision,
          reason:
            'O Nexus reiniciou ou perdeu o worker antes de provar qual pane ' +
            'recebeu esta tarefa. Nenhum worker substituto foi criado.',
        });
      } catch (error) {
        console.warn('[task-dispatch-lifecycle] expired dispatch reconcile failed:', error);
      }
    }
  }
}

export function shutdownTaskDispatchLifecycle(): void {
  for (const dispose of disposers.splice(0)) dispose();
  suites.clear();
  lastActivityRefresh.clear();
  now = Date.now;
}
