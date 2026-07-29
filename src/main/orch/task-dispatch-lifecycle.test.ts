import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';

const mocks = vi.hoisted(() => ({
  dataTap: null as null | ((sessionId: string, data: string) => void),
  stateTap: null as null | ((sessionId: string, state: string) => void),
  exitTap: null as null | ((sessionId: string) => void),
  heartbeat: vi.fn(),
  blockExpired: vi.fn(),
  requeueMissingRuntime: vi.fn(),
  blockSessionExit: vi.fn(),
  refineBootstrapSessionExitBlock: vi.fn(),
  list: vi.fn(),
  getDispatch: vi.fn(),
  getContextBySession: vi.fn(),
  getAgentSessionInfo: vi.fn(),
  getExternalWorkerSessionInfo: vi.fn(),
  onScope: vi.fn(),
  onChange: vi.fn(),
  closeWorker: vi.fn(async () => true),
}));

vi.mock('../pty/pty-manager', () => ({
  tapSessionData: (tap: typeof mocks.dataTap) => {
    mocks.dataTap = tap;
    return () => { mocks.dataTap = null; };
  },
  tapSessionState: (tap: typeof mocks.stateTap) => {
    mocks.stateTap = tap;
    return () => { mocks.stateTap = null; };
  },
  tapSessionExit: (tap: typeof mocks.exitTap) => {
    mocks.exitTap = tap;
    return () => { mocks.exitTap = null; };
  },
  getAgentSessionInfo: mocks.getAgentSessionInfo,
}));

vi.mock('./gate', () => ({
  getContextBySession: mocks.getContextBySession,
}));
vi.mock('./external-worker-session-registry', () => ({
  getExternalWorkerSessionInfo: mocks.getExternalWorkerSessionInfo,
}));

vi.mock('./project-domain-store-registry', () => ({
  requireProjectDomainStoreRegistry: () => ({
    onScope: mocks.onScope,
    onChange: mocks.onChange,
  }),
}));
vi.mock('./pane-registry', () => ({
  requestMissionWorkerPaneRetirement: mocks.closeWorker,
}));

import {
  prepareTaskDispatchLifecycle,
  reconcileTaskDispatchLifecycle,
  shutdownTaskDispatchLifecycle,
  TASK_DISPATCH_ACTIVITY_THROTTLE_MS,
  TASK_DISPATCH_SESSION_EXIT_REASON,
} from './task-dispatch-lifecycle';

const scope = testProjectScope();
const suite = {
  scope,
  taskDispatches: {
    heartbeat: mocks.heartbeat,
    blockExpired: mocks.blockExpired,
    requeueMissingRuntime: mocks.requeueMissingRuntime,
    blockSessionExit: mocks.blockSessionExit,
    refineBootstrapSessionExitBlock: mocks.refineBootstrapSessionExitBlock,
    list: mocks.list,
    get: mocks.getDispatch,
  },
};

describe('main-owned task dispatch lifecycle', () => {
  let now = 1_000;

  beforeEach(() => {
    shutdownTaskDispatchLifecycle();
    vi.clearAllMocks();
    now = 1_000;
    mocks.onScope.mockImplementation((listener) => {
      listener(scope, suite);
      return vi.fn();
    });
    mocks.onChange.mockReturnValue(vi.fn());
    mocks.getContextBySession.mockReturnValue({
      role: 'worker', missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-a', scope,
    });
    mocks.heartbeat.mockReturnValue({ taskId: 'task-a', missionId: 'mission-a' });
    mocks.blockSessionExit.mockReturnValue({ taskId: 'task-a', state: 'blocked' });
    mocks.list.mockReturnValue([]);
    mocks.getDispatch.mockReturnValue(null);
    mocks.getAgentSessionInfo.mockReturnValue(null);
    mocks.getExternalWorkerSessionInfo.mockReturnValue(null);
    prepareTaskDispatchLifecycle({ now: () => now });
  });

  it('renews automatically from fenced PTY activity without write-amplification', () => {
    mocks.dataTap?.('session-a', 'first output');
    mocks.dataTap?.('session-a', 'same burst');
    expect(mocks.heartbeat).toHaveBeenCalledTimes(1);
    expect(mocks.heartbeat).toHaveBeenCalledWith({
      sessionId: 'session-a',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-a',
      leaseMs: 10 * 60_000,
    });

    now += TASK_DISPATCH_ACTIVITY_THROTTLE_MS + 1;
    mocks.stateTap?.('session-a', 'busy');
    expect(mocks.heartbeat).toHaveBeenCalledTimes(2);
  });

  it('renews external worker activity through the same incarnation fence', () => {
    mocks.getContextBySession.mockReturnValue(null);
    mocks.getExternalWorkerSessionInfo.mockReturnValue({
      sessionId: 'external-session',
      role: 'worker',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-external',
      scope,
    });

    mocks.dataTap?.('external-session', 'protocol text delta');

    expect(mocks.heartbeat).toHaveBeenCalledWith({
      sessionId: 'external-session',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-external',
      leaseMs: 10 * 60_000,
    });
  });

  it('blocks the exact worker exit immediately and idempotently', () => {
    mocks.exitTap?.('session-a');
    expect(mocks.blockSessionExit).toHaveBeenCalledWith({
      sessionId: 'session-a',
      workerIncarnationId: 'worker-incarnation-a',
      reason: TASK_DISPATCH_SESSION_EXIT_REASON,
    });
    expect(mocks.refineBootstrapSessionExitBlock).not.toHaveBeenCalled();
  });

  it('does not bypass the exit fence when the real-mission harness is enabled', () => {
    const previous = process.env.NEXUS_REAL_MISSION_E2E;
    process.env.NEXUS_REAL_MISSION_E2E = '1';
    try {
      mocks.exitTap?.('session-a');
      expect(mocks.blockSessionExit).toHaveBeenCalledWith({
        sessionId: 'session-a',
        workerIncarnationId: 'worker-incarnation-a',
        reason: TASK_DISPATCH_SESSION_EXIT_REASON,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.NEXUS_REAL_MISSION_E2E;
      } else {
        process.env.NEXUS_REAL_MISSION_E2E = previous;
      }
    }
  });

  it('resolves the external worker scope on exit after the gate is released', () => {
    mocks.getContextBySession.mockReturnValue(null);
    mocks.getExternalWorkerSessionInfo.mockReturnValue({
      sessionId: 'external-session',
      role: 'worker',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-external',
      scope,
    });

    mocks.exitTap?.('external-session');

    expect(mocks.blockSessionExit).toHaveBeenCalledWith({
      sessionId: 'external-session',
      workerIncarnationId: 'worker-incarnation-external',
      reason: TASK_DISPATCH_SESSION_EXIT_REASON,
    });
  });

  it('adopts a live exact session after restart and requeues an expired unknown effect', async () => {
    mocks.list.mockReturnValue([
      {
        taskId: 'task-live', missionId: 'mission-a', revision: 3,
        state: 'running', sessionId: 'session-live', leaseExpiresAt: 900,
        workerIncarnationId: 'worker-incarnation-live',
      },
      {
        taskId: 'task-unknown', missionId: 'mission-a', revision: 2,
        state: 'spawning', leaseExpiresAt: 900,
      },
    ]);
    mocks.getAgentSessionInfo.mockImplementation((sessionId: string) =>
      sessionId === 'session-live'
        ? {
            sessionId, role: 'worker', missionId: 'mission-a',
            workerIncarnationId: 'worker-incarnation-live', scope,
          }
        : null,
    );

    await reconcileTaskDispatchLifecycle(now);

    expect(mocks.heartbeat).toHaveBeenCalledWith({
      sessionId: 'session-live',
      missionId: 'mission-a',
      dispatchId: undefined,
      workerIncarnationId: 'worker-incarnation-live',
      leaseMs: 10 * 60_000,
    });
    expect(mocks.requeueMissingRuntime).toHaveBeenCalledWith({
      taskId: 'task-unknown',
      revision: 2,
    });
    expect(mocks.blockExpired).not.toHaveBeenCalled();
  });

  it('adopts a live external session by the same durable identity', async () => {
    mocks.list.mockReturnValue([{
      id: 'dispatch-external',
      taskId: 'task-external',
      missionId: 'mission-a',
      revision: 4,
      state: 'running',
      sessionId: 'external-session',
      leaseExpiresAt: 900,
      workerIncarnationId: 'worker-incarnation-external',
    }]);
    mocks.getExternalWorkerSessionInfo.mockReturnValue({
      sessionId: 'external-session',
      role: 'worker',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-external',
      scope,
    });

    await reconcileTaskDispatchLifecycle(now);

    expect(mocks.heartbeat).toHaveBeenCalledWith({
      sessionId: 'external-session',
      missionId: 'mission-a',
      dispatchId: 'dispatch-external',
      workerIncarnationId: 'worker-incarnation-external',
      leaseMs: 10 * 60_000,
    });
    expect(mocks.requeueMissingRuntime).not.toHaveBeenCalled();
  });

  it('never requeues a physically live worker when heartbeat persistence fails', async () => {
    mocks.list.mockReturnValue([{
      id: 'dispatch-live-db-error',
      taskId: 'task-live-db-error',
      missionId: 'mission-a',
      revision: 5,
      state: 'running',
      sessionId: 'session-live-db-error',
      leaseExpiresAt: 900,
      workerIncarnationId: 'worker-incarnation-live-db-error',
    }]);
    mocks.getAgentSessionInfo.mockReturnValue({
      sessionId: 'session-live-db-error',
      role: 'worker',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-live-db-error',
      scope,
    });
    mocks.heartbeat.mockImplementationOnce(() => {
      throw new Error('database temporarily busy');
    });

    await reconcileTaskDispatchLifecycle(now);

    expect(mocks.heartbeat).toHaveBeenCalledOnce();
    expect(mocks.requeueMissingRuntime).not.toHaveBeenCalled();
  });

  it('does not adopt a live session from a previous worker incarnation', async () => {
    mocks.list.mockReturnValue([{
      id: 'dispatch-current',
      taskId: 'task-current',
      missionId: 'mission-a',
      revision: 4,
      state: 'running',
      sessionId: 'reused-session',
      leaseExpiresAt: 900,
      workerIncarnationId: 'worker-incarnation-current',
    }]);
    mocks.getAgentSessionInfo.mockReturnValue({
      sessionId: 'reused-session',
      role: 'worker',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-stale',
      scope,
    });

    await reconcileTaskDispatchLifecycle(now);

    expect(mocks.heartbeat).not.toHaveBeenCalled();
    expect(mocks.requeueMissingRuntime).toHaveBeenCalledWith({
      taskId: 'task-current',
      revision: 4,
    });
    expect(mocks.blockExpired).not.toHaveBeenCalled();
  });

  it('requeues a bound worker immediately when its exact runtime is missing', async () => {
    mocks.list.mockReturnValue([{
      id: 'dispatch-missing',
      taskId: 'task-missing',
      missionId: 'mission-a',
      revision: 6,
      state: 'running',
      sessionId: 'session-missing',
      leaseExpiresAt: now + 60_000,
      workerIncarnationId: 'worker-incarnation-missing',
    }]);

    await reconcileTaskDispatchLifecycle(now);

    expect(mocks.requeueMissingRuntime).toHaveBeenCalledWith({
      taskId: 'task-missing',
      revision: 6,
    });
    expect(mocks.blockExpired).not.toHaveBeenCalled();
  });

  it('retires a terminal dispatch through its exact physical identity', async () => {
    const terminal = {
      id: 'dispatch-terminal',
      taskId: 'task-terminal',
      missionId: 'mission-a',
      revision: 5,
      state: 'completed',
      paneId: 'pane-terminal',
      sessionId: 'session-terminal',
      workerIncarnationId: 'worker-incarnation-terminal',
      leaseExpiresAt: 10_000,
    };
    mocks.list.mockReturnValue([terminal]);
    mocks.getDispatch.mockReturnValue(terminal);

    await reconcileTaskDispatchLifecycle(now);

    expect(mocks.closeWorker).toHaveBeenCalledWith({
      paneId: 'pane-terminal',
      sessionId: 'session-terminal',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-terminal',
      scope,
    });
  });
});
