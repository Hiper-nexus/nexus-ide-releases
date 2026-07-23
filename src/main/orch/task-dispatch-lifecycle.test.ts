import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';

const mocks = vi.hoisted(() => ({
  dataTap: null as null | ((sessionId: string, data: string) => void),
  stateTap: null as null | ((sessionId: string, state: string) => void),
  exitTap: null as null | ((sessionId: string) => void),
  heartbeat: vi.fn(),
  blockExpired: vi.fn(),
  blockSessionExit: vi.fn(),
  list: vi.fn(),
  getContextBySession: vi.fn(),
  getAgentSessionInfo: vi.fn(),
  getExternalWorkerSessionInfo: vi.fn(),
  onScope: vi.fn(),
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
  requireProjectDomainStoreRegistry: () => ({ onScope: mocks.onScope }),
}));

import {
  prepareTaskDispatchLifecycle,
  reconcileTaskDispatchLifecycle,
  shutdownTaskDispatchLifecycle,
  TASK_DISPATCH_ACTIVITY_THROTTLE_MS,
} from './task-dispatch-lifecycle';

const scope = testProjectScope();
const suite = {
  scope,
  taskDispatches: {
    heartbeat: mocks.heartbeat,
    blockExpired: mocks.blockExpired,
    blockSessionExit: mocks.blockSessionExit,
    list: mocks.list,
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
    mocks.getContextBySession.mockReturnValue({
      role: 'worker', missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-a', scope,
    });
    mocks.heartbeat.mockReturnValue({ taskId: 'task-a', missionId: 'mission-a' });
    mocks.blockSessionExit.mockReturnValue({ taskId: 'task-a', state: 'blocked' });
    mocks.list.mockReturnValue([]);
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

  it('renews OMP RPC activity through the same incarnation fence', () => {
    mocks.getContextBySession.mockReturnValue(null);
    mocks.getExternalWorkerSessionInfo.mockReturnValue({
      sessionId: 'omp-session',
      role: 'worker',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-omp',
      scope,
    });

    mocks.dataTap?.('omp-session', 'protocol text delta');

    expect(mocks.heartbeat).toHaveBeenCalledWith({
      sessionId: 'omp-session',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-omp',
      leaseMs: 10 * 60_000,
    });
  });

  it('blocks the exact worker exit immediately and idempotently', () => {
    mocks.exitTap?.('session-a');
    expect(mocks.blockSessionExit).toHaveBeenCalledWith({
      sessionId: 'session-a',
      workerIncarnationId: 'worker-incarnation-a',
      reason: 'O worker encerrou sem entregar um handoff confiável.',
    });
  });

  it('resolve o scope OMP no exit mesmo se o gate já foi liberado', () => {
    mocks.getContextBySession.mockReturnValue(null);
    mocks.getExternalWorkerSessionInfo.mockReturnValue({
      sessionId: 'omp-session',
      role: 'worker',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-omp',
      scope,
    });

    mocks.exitTap?.('omp-session');

    expect(mocks.blockSessionExit).toHaveBeenCalledWith({
      sessionId: 'omp-session',
      workerIncarnationId: 'worker-incarnation-omp',
      reason: 'O worker encerrou sem entregar um handoff confiável.',
    });
  });

  it('adopts a live exact session after restart and blocks an expired unknown effect', async () => {
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
    expect(mocks.blockExpired).toHaveBeenCalledWith({
      taskId: 'task-unknown',
      revision: 2,
      reason: expect.stringMatching(/reiniciou.*provar.*pane/i),
    });
  });

  it('adota sessão OMP RPC viva pela mesma identidade durável', async () => {
    mocks.list.mockReturnValue([{
      id: 'dispatch-omp',
      taskId: 'task-omp',
      missionId: 'mission-a',
      revision: 4,
      state: 'running',
      sessionId: 'omp-session',
      leaseExpiresAt: 900,
      workerIncarnationId: 'worker-incarnation-omp',
    }]);
    mocks.getExternalWorkerSessionInfo.mockReturnValue({
      sessionId: 'omp-session',
      role: 'worker',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-omp',
      scope,
    });

    await reconcileTaskDispatchLifecycle(now);

    expect(mocks.heartbeat).toHaveBeenCalledWith({
      sessionId: 'omp-session',
      missionId: 'mission-a',
      dispatchId: 'dispatch-omp',
      workerIncarnationId: 'worker-incarnation-omp',
      leaseMs: 10 * 60_000,
    });
    expect(mocks.blockExpired).not.toHaveBeenCalled();
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
    expect(mocks.blockExpired).toHaveBeenCalledWith({
      taskId: 'task-current',
      revision: 4,
      reason: expect.stringMatching(/reiniciou.*provar.*pane/i),
    });
  });
});
