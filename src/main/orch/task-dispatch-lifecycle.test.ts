import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { testProjectScope } from './__tests__/scope-fixture';

const mocks = vi.hoisted(() => ({
  dataTap: null as null | ((sessionId: string, data: string) => void),
  stateTap: null as null | ((sessionId: string, state: string) => void),
  semanticTap: null as null | ((entry: {
    status: 'working' | 'completed' | 'awaiting-input' | 'idle' | 'error';
    sessionId: string;
    paneId: string;
    updatedAt: number;
  }) => void),
  exitTap: null as null | ((
    sessionId: string,
    authority?: {
      role: string;
      missionId?: string;
      workerIncarnationId?: string;
      scope: ProjectExecutionScope;
    },
  ) => void),
  heartbeat: vi.fn(),
  blockExpired: vi.fn(),
  requeueMissingRuntime: vi.fn(),
  blockSessionExit: vi.fn(),
  refineBootstrapSessionExitBlock: vi.fn(),
  canRecoverLegacyGuidedDirtyCheckoutBootstrap: vi.fn(),
  recoverLegacyGuidedDirtyCheckoutBootstrap: vi.fn(),
  ensureGuidedGitBaselineForWorktreeAsync: vi.fn(async () => undefined),
  list: vi.fn(),
  getDispatch: vi.fn(),
  getContextBySession: vi.fn(),
  getAgentSessionInfo: vi.fn(),
  getSessionState: vi.fn(),
  getAgentSemanticStatusBySession: vi.fn(),
  getExternalWorkerSessionInfo: vi.fn(),
  submitPendingAgentPrompt: vi.fn(),
  assertLifecycleAuthority: vi.fn(),
  onScope: vi.fn(),
  onChange: vi.fn(),
  closeWorker: vi.fn<(
    input: {
      paneId: string;
      sessionId: string;
      missionId: string;
      workerIncarnationId: string;
      scope: ProjectExecutionScope;
    },
  ) => Promise<boolean>>(async () => true),
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
  getSessionState: mocks.getSessionState,
}));

vi.mock('./gate', () => ({
  getContextBySession: mocks.getContextBySession,
  MAX_STOP_ATTEMPTS: 3,
}));
vi.mock('./agent-status', () => ({
  tapAgentSemanticStatus: (tap: typeof mocks.semanticTap) => {
    mocks.semanticTap = tap;
    return () => { mocks.semanticTap = null; };
  },
  getAgentSemanticStatusBySession: mocks.getAgentSemanticStatusBySession,
}));
vi.mock('./external-worker-session-registry', () => ({
  getExternalWorkerSessionInfo: mocks.getExternalWorkerSessionInfo,
}));
vi.mock('../runtime/guided-greenfield-baseline', () => ({
  ensureGuidedGitBaselineForWorktreeAsync:
    mocks.ensureGuidedGitBaselineForWorktreeAsync,
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
vi.mock('./tool-util', () => ({
  submitPendingAgentPrompt: mocks.submitPendingAgentPrompt,
}));

import {
  prepareTaskDispatchLifecycle,
  reconcileTaskDispatchLifecycle,
  shutdownTaskDispatchLifecycle,
  TASK_DISPATCH_ACTIVITY_THROTTLE_MS,
  TASK_DISPATCH_SESSION_EXIT_REASON,
  TASK_DISPATCH_STOP_GATE_GRACE_MS,
  TASK_DISPATCH_TERMINAL_GRACE_MS,
  TASK_DISPATCH_UNVERIFIED_ACTIVITY_MAX_MS,
} from './task-dispatch-lifecycle';
import {
  LEGACY_GUIDED_DIRTY_CHECKOUT_TERMINAL_REASON,
  TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS,
} from './task-dispatch-store';

const scope = testProjectScope();
const suite = {
  scope,
  taskDispatches: {
    heartbeat: mocks.heartbeat,
    blockExpired: mocks.blockExpired,
    requeueMissingRuntime: mocks.requeueMissingRuntime,
    blockSessionExit: mocks.blockSessionExit,
    refineBootstrapSessionExitBlock: mocks.refineBootstrapSessionExitBlock,
    canRecoverLegacyGuidedDirtyCheckoutBootstrap:
      mocks.canRecoverLegacyGuidedDirtyCheckoutBootstrap,
    recoverLegacyGuidedDirtyCheckoutBootstrap:
      mocks.recoverLegacyGuidedDirtyCheckoutBootstrap,
    assertLifecycleAuthority: mocks.assertLifecycleAuthority,
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
    mocks.closeWorker.mockResolvedValue(true);
    mocks.canRecoverLegacyGuidedDirtyCheckoutBootstrap.mockReturnValue(true);
    mocks.list.mockReturnValue([]);
    mocks.getDispatch.mockReturnValue(null);
    mocks.getAgentSessionInfo.mockReturnValue(null);
    mocks.getSessionState.mockReturnValue('idle');
    mocks.getAgentSemanticStatusBySession.mockReturnValue(null);
    mocks.getExternalWorkerSessionInfo.mockReturnValue(null);
    mocks.submitPendingAgentPrompt.mockResolvedValue(false);
    mocks.assertLifecycleAuthority.mockImplementation(
      ({ taskId }: { taskId: string }) => {
        const dispatch = mocks.getDispatch(taskId);
        if (!dispatch) throw new Error('dispatch not found');
        return dispatch;
      },
    );
    prepareTaskDispatchLifecycle({ now: () => now });
  });

  it('renews automatically from fenced PTY activity without write-amplification', () => {
    mocks.getAgentSessionInfo.mockReturnValue({
      sessionId: 'session-a',
      paneId: 'pane-a',
      role: 'worker',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-a',
      scope,
    });
    mocks.getAgentSemanticStatusBySession.mockReturnValue({
      status: 'working',
      sessionId: 'session-a',
      paneId: 'pane-a',
      updatedAt: now,
    });
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

  it('only renews semantic PTY progress while the worker is working', () => {
    mocks.getAgentSessionInfo.mockReturnValue({
      sessionId: 'session-a',
      paneId: 'pane-a',
      role: 'worker',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-a',
      scope,
    });
    mocks.getAgentSemanticStatusBySession.mockReturnValue({
      status: 'completed',
      sessionId: 'session-a',
      paneId: 'pane-a',
      updatedAt: now,
    });

    mocks.dataTap?.('session-a', 'ready prompt repaint');

    expect(mocks.heartbeat).not.toHaveBeenCalled();

    mocks.getAgentSemanticStatusBySession.mockReturnValue({
      status: 'idle',
      sessionId: 'session-a',
      paneId: 'pane-a',
      updatedAt: now,
    });
    mocks.dataTap?.('session-a', 'idle notification repaint');
    expect(mocks.heartbeat).not.toHaveBeenCalled();

    mocks.getAgentSemanticStatusBySession.mockReturnValue({
      status: 'working',
      sessionId: 'session-a',
      paneId: 'pane-a',
      updatedAt: now,
    });
    mocks.dataTap?.('session-a', 'real worker output');
    expect(mocks.heartbeat).toHaveBeenCalledOnce();

    now += TASK_DISPATCH_ACTIVITY_THROTTLE_MS + 1;
    mocks.getAgentSemanticStatusBySession.mockReturnValue(null);
    mocks.dataTap?.('session-a', 'legacy cli output');
    mocks.stateTap?.('session-a', 'busy');

    expect(mocks.heartbeat).toHaveBeenCalledTimes(2);
    expect(mocks.heartbeat).toHaveBeenLastCalledWith({
      sessionId: 'session-a',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-a',
      leaseMs: 10 * 60_000,
    });
  });

  it('does not let one stale working hook renew repaint activity forever', () => {
    mocks.getAgentSessionInfo.mockReturnValue({
      sessionId: 'session-a',
      paneId: 'pane-a',
      role: 'worker',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-a',
      scope,
    });
    mocks.getAgentSemanticStatusBySession.mockReturnValue({
      status: 'working',
      sessionId: 'session-a',
      paneId: 'pane-a',
      updatedAt: now,
    });

    mocks.dataTap?.('session-a', 'real initial work');
    expect(mocks.heartbeat).toHaveBeenCalledOnce();

    now += TASK_DISPATCH_UNVERIFIED_ACTIVITY_MAX_MS + 1;
    mocks.dataTap?.('session-a', 'stale TUI repaint');
    mocks.stateTap?.('session-a', 'busy');

    expect(mocks.heartbeat).toHaveBeenCalledOnce();
  });

  it('retires and requeues an exact PTY turn that ended without handoff', async () => {
    vi.useFakeTimers();
    try {
      const running = {
        id: 'dispatch-terminal-turn',
        taskId: 'task-terminal-turn',
        missionId: 'mission-a',
        revision: 7,
        intentVersion: 1,
        attempt: 1,
        state: 'running',
        adapterId: 'kimi',
        paneId: 'pane-terminal-turn',
        sessionId: 'session-terminal-turn',
        workerIncarnationId: 'worker-incarnation-a',
        leaseExpiresAt: now + 10 * 60_000,
      };
      mocks.list.mockReturnValue([running]);
      mocks.getDispatch.mockReturnValue(running);
      mocks.getAgentSessionInfo.mockReturnValue({
        sessionId: running.sessionId,
        paneId: running.paneId,
        role: 'worker',
        missionId: running.missionId,
        workerIncarnationId: running.workerIncarnationId,
        scope,
      });
      mocks.getAgentSemanticStatusBySession.mockReturnValue({
        status: 'completed',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: now,
      });

      mocks.semanticTap?.({
        status: 'completed',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: now,
      });

      expect(mocks.closeWorker).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(TASK_DISPATCH_TERMINAL_GRACE_MS);

      expect(mocks.submitPendingAgentPrompt).toHaveBeenCalledWith(
        running.sessionId,
        expect.objectContaining({
          assertCurrentAuthority: expect.any(Function),
        }),
        expect.objectContaining({
          adapterId: running.adapterId,
          canSubmit: expect.any(Function),
        }),
      );
      expect(mocks.closeWorker).toHaveBeenCalledWith({
        paneId: running.paneId,
        sessionId: running.sessionId,
        missionId: running.missionId,
        workerIncarnationId: running.workerIncarnationId,
        scope,
      });
      expect(mocks.blockSessionExit).toHaveBeenCalledWith({
        sessionId: running.sessionId,
        workerIncarnationId: running.workerIncarnationId,
        reason: expect.stringMatching(/terminou.*sem.*handoff/i),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels terminal-turn recovery when a handoff wins during the grace period', async () => {
    vi.useFakeTimers();
    try {
      const running = {
        id: 'dispatch-handoff-race',
        taskId: 'task-handoff-race',
        missionId: 'mission-a',
        revision: 4,
        intentVersion: 1,
        attempt: 1,
        state: 'running',
        adapterId: 'kimi',
        paneId: 'pane-handoff-race',
        sessionId: 'session-handoff-race',
        workerIncarnationId: 'worker-incarnation-a',
        leaseExpiresAt: now + 10 * 60_000,
      };
      mocks.list.mockReturnValue([running]);
      mocks.getDispatch.mockReturnValue(running);
      mocks.getAgentSessionInfo.mockReturnValue({
        sessionId: running.sessionId,
        paneId: running.paneId,
        role: 'worker',
        missionId: running.missionId,
        workerIncarnationId: running.workerIncarnationId,
        scope,
      });
      mocks.getAgentSemanticStatusBySession.mockReturnValue({
        status: 'completed',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: now,
      });

      mocks.semanticTap?.({
        status: 'completed',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: now,
      });
      mocks.getDispatch.mockReturnValue({
        ...running,
        state: 'handoff_ready',
        handoffId: 'handoff-won-race',
      });
      await vi.advanceTimersByTimeAsync(TASK_DISPATCH_TERMINAL_GRACE_MS);

      expect(mocks.closeWorker).not.toHaveBeenCalled();
      expect(mocks.blockSessionExit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never retires a worker that is waiting for real user input', async () => {
    vi.useFakeTimers();
    try {
      mocks.semanticTap?.({
        status: 'awaiting-input',
        sessionId: 'session-a',
        paneId: 'pane-a',
        updatedAt: now,
      });

      await vi.advanceTimersByTimeAsync(TASK_DISPATCH_TERMINAL_GRACE_MS * 2);

      expect(mocks.closeWorker).not.toHaveBeenCalled();
      expect(mocks.blockSessionExit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the same physical worker when its restored prompt resumes', async () => {
    vi.useFakeTimers();
    try {
      const running = {
        id: 'dispatch-terminal-resumed',
        taskId: 'task-terminal-resumed',
        missionId: 'mission-a',
        intentVersion: 1,
        revision: 3,
        attempt: 1,
        state: 'running',
        adapterId: 'kimi',
        paneId: 'pane-terminal-resumed',
        sessionId: 'session-terminal-resumed',
        workerIncarnationId: 'worker-incarnation-a',
        leaseExpiresAt: now + 10 * 60_000,
      };
      mocks.list.mockReturnValue([running]);
      mocks.getDispatch.mockReturnValue(running);
      mocks.getAgentSessionInfo.mockReturnValue({
        sessionId: running.sessionId,
        paneId: running.paneId,
        role: 'worker',
        missionId: running.missionId,
        workerIncarnationId: running.workerIncarnationId,
        scope,
      });
      mocks.getAgentSemanticStatusBySession.mockReturnValue({
        status: 'completed',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: now,
      });
      mocks.submitPendingAgentPrompt.mockResolvedValueOnce(true);

      mocks.semanticTap?.({
        status: 'completed',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: now,
      });
      await vi.advanceTimersByTimeAsync(TASK_DISPATCH_TERMINAL_GRACE_MS);

      expect(mocks.submitPendingAgentPrompt).toHaveBeenCalledOnce();
      expect(mocks.closeWorker).not.toHaveBeenCalled();
      expect(mocks.blockSessionExit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces terminal recovery while prompt acceptance is still pending', async () => {
    vi.useFakeTimers();
    try {
      const running = {
        id: 'dispatch-terminal-single-flight',
        taskId: 'task-terminal-single-flight',
        missionId: 'mission-a',
        intentVersion: 1,
        revision: 3,
        attempt: 1,
        state: 'running',
        adapterId: 'kimi',
        paneId: 'pane-terminal-single-flight',
        sessionId: 'session-terminal-single-flight',
        workerIncarnationId: 'worker-incarnation-a',
        leaseExpiresAt: now + 10 * 60_000,
      };
      let resolveResume: ((accepted: boolean) => void) | undefined;
      mocks.list.mockReturnValue([running]);
      mocks.getDispatch.mockReturnValue(running);
      mocks.getAgentSessionInfo.mockReturnValue({
        sessionId: running.sessionId,
        paneId: running.paneId,
        role: 'worker',
        missionId: running.missionId,
        workerIncarnationId: running.workerIncarnationId,
        scope,
      });
      mocks.getAgentSemanticStatusBySession.mockReturnValue({
        status: 'completed',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: now,
      });
      mocks.submitPendingAgentPrompt.mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          resolveResume = resolve;
        }),
      );

      mocks.semanticTap?.({
        status: 'completed',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: now,
      });
      await vi.advanceTimersByTimeAsync(TASK_DISPATCH_TERMINAL_GRACE_MS);
      expect(mocks.submitPendingAgentPrompt).toHaveBeenCalledOnce();

      await reconcileTaskDispatchLifecycle(now);
      await vi.advanceTimersByTimeAsync(TASK_DISPATCH_TERMINAL_GRACE_MS * 2);

      expect(mocks.submitPendingAgentPrompt).toHaveBeenCalledOnce();
      expect(mocks.closeWorker).not.toHaveBeenCalled();

      shutdownTaskDispatchLifecycle();
      prepareTaskDispatchLifecycle({ now: () => now });
      mocks.semanticTap?.({
        status: 'completed',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: now,
      });
      await vi.advanceTimersByTimeAsync(TASK_DISPATCH_TERMINAL_GRACE_MS);

      expect(mocks.submitPendingAgentPrompt).toHaveBeenCalledOnce();
      expect(mocks.closeWorker).not.toHaveBeenCalled();

      resolveResume?.(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.closeWorker).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not interrupt a worker reacting to a rejected Stop gate', async () => {
    vi.useFakeTimers();
    try {
      const running = {
        id: 'dispatch-stop-denied',
        taskId: 'task-stop-denied',
        missionId: 'mission-a',
        intentVersion: 1,
        revision: 8,
        attempt: 1,
        state: 'running',
        adapterId: 'claude',
        paneId: 'pane-stop-denied',
        sessionId: 'session-stop-denied',
        workerIncarnationId: 'worker-incarnation-a',
        leaseExpiresAt: now + 10 * 60_000,
      };
      mocks.getContextBySession.mockReturnValue({
        role: 'worker',
        missionId: running.missionId,
        workerIncarnationId: running.workerIncarnationId,
        stopAttempts: 1,
        handoffSubmitted: false,
        scope,
      });
      mocks.list.mockReturnValue([running]);
      mocks.getDispatch.mockReturnValue(running);
      mocks.getAgentSessionInfo.mockReturnValue({
        sessionId: running.sessionId,
        paneId: running.paneId,
        role: 'worker',
        missionId: running.missionId,
        workerIncarnationId: running.workerIncarnationId,
        scope,
      });
      mocks.getAgentSemanticStatusBySession.mockReturnValue({
        status: 'completed',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: now,
      });

      mocks.semanticTap?.({
        status: 'completed',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: now,
      });
      await vi.advanceTimersByTimeAsync(TASK_DISPATCH_TERMINAL_GRACE_MS);

      expect(mocks.submitPendingAgentPrompt).not.toHaveBeenCalled();
      expect(mocks.closeWorker).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(
        TASK_DISPATCH_STOP_GATE_GRACE_MS -
          TASK_DISPATCH_TERMINAL_GRACE_MS,
      );

      expect(mocks.submitPendingAgentPrompt).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('extends recovery when the Stop gate rejection arrives after semantic Stop', async () => {
    vi.useFakeTimers();
    try {
      const running = {
        id: 'dispatch-stop-race',
        taskId: 'task-stop-race',
        missionId: 'mission-a',
        intentVersion: 1,
        revision: 8,
        attempt: 1,
        state: 'running',
        adapterId: 'claude',
        paneId: 'pane-stop-race',
        sessionId: 'session-stop-race',
        workerIncarnationId: 'worker-incarnation-a',
        leaseExpiresAt: now + 10 * 60_000,
      };
      const context = {
        role: 'worker',
        missionId: running.missionId,
        workerIncarnationId: running.workerIncarnationId,
        stopAttempts: 0,
        handoffSubmitted: false,
        scope,
      };
      mocks.getContextBySession.mockReturnValue(context);
      mocks.list.mockReturnValue([running]);
      mocks.getDispatch.mockReturnValue(running);
      mocks.getAgentSessionInfo.mockReturnValue({
        sessionId: running.sessionId,
        paneId: running.paneId,
        role: 'worker',
        missionId: running.missionId,
        workerIncarnationId: running.workerIncarnationId,
        scope,
      });
      mocks.getAgentSemanticStatusBySession.mockReturnValue({
        status: 'completed',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: Date.now(),
      });

      mocks.semanticTap?.({
        status: 'completed',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: Date.now(),
      });
      context.stopAttempts = 1;
      await vi.advanceTimersByTimeAsync(TASK_DISPATCH_TERMINAL_GRACE_MS);

      expect(mocks.submitPendingAgentPrompt).not.toHaveBeenCalled();
      expect(mocks.closeWorker).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(
        TASK_DISPATCH_STOP_GATE_GRACE_MS -
          TASK_DISPATCH_TERMINAL_GRACE_MS,
      );

      expect(mocks.submitPendingAgentPrompt).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechecks a late Stop rejection at the exact Enter boundary', async () => {
    vi.useFakeTimers();
    try {
      const running = {
        id: 'dispatch-stop-submit-race',
        taskId: 'task-stop-submit-race',
        missionId: 'mission-a',
        intentVersion: 1,
        revision: 9,
        attempt: 1,
        state: 'running',
        adapterId: 'claude',
        paneId: 'pane-stop-submit-race',
        sessionId: 'session-stop-submit-race',
        workerIncarnationId: 'worker-incarnation-a',
        leaseExpiresAt: now + 10 * 60_000,
      };
      const context = {
        role: 'worker',
        missionId: running.missionId,
        workerIncarnationId: running.workerIncarnationId,
        stopAttempts: 0,
        handoffSubmitted: false,
        scope,
      };
      mocks.getContextBySession.mockReturnValue(context);
      mocks.list.mockReturnValue([running]);
      mocks.getDispatch.mockReturnValue(running);
      mocks.getAgentSessionInfo.mockReturnValue({
        sessionId: running.sessionId,
        paneId: running.paneId,
        role: 'worker',
        missionId: running.missionId,
        workerIncarnationId: running.workerIncarnationId,
        scope,
      });
      mocks.getAgentSemanticStatusBySession.mockReturnValue({
        status: 'completed',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: Date.now(),
      });
      mocks.submitPendingAgentPrompt.mockImplementationOnce(
        async (_sessionId, _invocation, options) => {
          context.stopAttempts = 1;
          expect(options.canSubmit?.()).toBe(false);
          return false;
        },
      );

      mocks.semanticTap?.({
        status: 'completed',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(TASK_DISPATCH_TERMINAL_GRACE_MS);

      expect(mocks.submitPendingAgentPrompt).toHaveBeenCalledOnce();
      expect(mocks.closeWorker).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(
        TASK_DISPATCH_STOP_GATE_GRACE_MS -
          TASK_DISPATCH_TERMINAL_GRACE_MS,
      );

      expect(mocks.closeWorker).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers an exact worker in its isolated worktree scope', async () => {
    vi.useFakeTimers();
    try {
      const executionScope = {
        ...scope,
        rootRealPath: '/workspace/.nexus/worktrees/task-worktree',
      };
      const running = {
        id: 'dispatch-worktree-worker',
        taskId: 'task-worktree-worker',
        missionId: 'mission-a',
        intentVersion: 1,
        revision: 9,
        attempt: 1,
        state: 'running',
        adapterId: 'kimi',
        paneId: 'pane-worktree-worker',
        sessionId: 'session-worktree-worker',
        workerIncarnationId: 'worker-incarnation-a',
        leaseExpiresAt: now + 10 * 60_000,
      };
      mocks.getContextBySession.mockReturnValue({
        role: 'worker',
        missionId: running.missionId,
        workerIncarnationId: running.workerIncarnationId,
        stopAttempts: 0,
        handoffSubmitted: false,
        scope,
        executionScope,
      });
      mocks.list.mockReturnValue([running]);
      mocks.getDispatch.mockReturnValue(running);
      mocks.getAgentSessionInfo.mockReturnValue({
        sessionId: running.sessionId,
        paneId: running.paneId,
        role: 'worker',
        missionId: running.missionId,
        workerIncarnationId: running.workerIncarnationId,
        scope: executionScope,
      });
      mocks.getAgentSemanticStatusBySession.mockReturnValue({
        status: 'completed',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: Date.now(),
      });

      mocks.semanticTap?.({
        status: 'completed',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(TASK_DISPATCH_TERMINAL_GRACE_MS);

      expect(mocks.submitPendingAgentPrompt).toHaveBeenCalledOnce();
      expect(mocks.closeWorker).toHaveBeenCalledWith({
        paneId: running.paneId,
        sessionId: running.sessionId,
        missionId: running.missionId,
        workerIncarnationId: running.workerIncarnationId,
        scope,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the exact dispatch fenced when terminal-turn retirement is not proven', async () => {
    vi.useFakeTimers();
    try {
      const running = {
        id: 'dispatch-terminal-close-failed',
        taskId: 'task-terminal-close-failed',
        missionId: 'mission-a',
        revision: 6,
        intentVersion: 1,
        attempt: 1,
        state: 'running',
        adapterId: 'kimi',
        paneId: 'pane-terminal-close-failed',
        sessionId: 'session-terminal-close-failed',
        workerIncarnationId: 'worker-incarnation-a',
        leaseExpiresAt: now + 10 * 60_000,
      };
      mocks.list.mockReturnValue([running]);
      mocks.getDispatch.mockReturnValue(running);
      mocks.getAgentSessionInfo.mockReturnValue({
        sessionId: running.sessionId,
        paneId: running.paneId,
        role: 'worker',
        missionId: running.missionId,
        workerIncarnationId: running.workerIncarnationId,
        scope,
      });
      mocks.getAgentSemanticStatusBySession.mockReturnValue({
        status: 'error',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: now,
      });
      mocks.closeWorker.mockResolvedValueOnce(false);

      mocks.semanticTap?.({
        status: 'error',
        sessionId: running.sessionId,
        paneId: running.paneId,
        updatedAt: now,
      });
      await vi.advanceTimersByTimeAsync(TASK_DISPATCH_TERMINAL_GRACE_MS);

      expect(mocks.closeWorker).toHaveBeenCalledOnce();
      expect(mocks.blockSessionExit).not.toHaveBeenCalled();
      expect(mocks.requeueMissingRuntime).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

  it('retires an exact live worker whose durable activity lease expired and requeues an unknown effect', async () => {
    mocks.list.mockReturnValue([
      {
        taskId: 'task-live', missionId: 'mission-a', revision: 3,
        state: 'running', paneId: 'pane-live',
        sessionId: 'session-live', leaseExpiresAt: 900,
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
    mocks.closeWorker.mockImplementationOnce(async (input) => {
      mocks.exitTap?.(input.sessionId, {
        role: 'worker',
        missionId: input.missionId,
        workerIncarnationId: input.workerIncarnationId,
        scope,
      });
      return true;
    });

    await reconcileTaskDispatchLifecycle(now);

    expect(mocks.heartbeat).not.toHaveBeenCalled();
    expect(mocks.closeWorker).toHaveBeenCalledWith({
      paneId: 'pane-live',
      sessionId: 'session-live',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-live',
      scope,
    });
    expect(mocks.blockSessionExit).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-live',
      workerIncarnationId: 'worker-incarnation-live',
      reason: 'O worker ficou sem atividade e sem heartbeat por 10 minutos (stalled).',
    });
    expect(mocks.requeueMissingRuntime).toHaveBeenCalledWith({
      taskId: 'task-unknown',
      revision: 2,
    });
    expect(mocks.blockExpired).not.toHaveBeenCalled();
  });

  it('cannot keep a hookless PTY alive forever with repaint bytes', async () => {
    const hookless = {
      id: 'dispatch-hookless-repaint',
      taskId: 'task-hookless-repaint',
      missionId: 'mission-a',
      revision: 3,
      state: 'running',
      paneId: 'pane-hookless-repaint',
      sessionId: 'session-hookless-repaint',
      leaseExpiresAt: 1_500,
      workerIncarnationId: 'worker-incarnation-hookless',
    };
    mocks.list.mockReturnValue([hookless]);
    mocks.getContextBySession.mockReturnValue({
      role: 'worker',
      missionId: hookless.missionId,
      workerIncarnationId: hookless.workerIncarnationId,
      scope,
    });
    mocks.getAgentSessionInfo.mockReturnValue({
      sessionId: hookless.sessionId,
      paneId: hookless.paneId,
      role: 'worker',
      missionId: hookless.missionId,
      workerIncarnationId: hookless.workerIncarnationId,
      scope,
    });
    mocks.getAgentSemanticStatusBySession.mockReturnValue(null);

    mocks.dataTap?.(hookless.sessionId, 'initial unverified output');
    expect(mocks.heartbeat).toHaveBeenLastCalledWith({
      sessionId: hookless.sessionId,
      missionId: hookless.missionId,
      workerIncarnationId: hookless.workerIncarnationId,
      leaseMs: 10 * 60_000,
    });

    now += TASK_DISPATCH_UNVERIFIED_ACTIVITY_MAX_MS - 1_000;
    mocks.dataTap?.(hookless.sessionId, 'late repaint');
    expect(mocks.heartbeat).toHaveBeenLastCalledWith({
      sessionId: hookless.sessionId,
      missionId: hookless.missionId,
      workerIncarnationId: hookless.workerIncarnationId,
      leaseMs: 1_000,
    });

    now += TASK_DISPATCH_ACTIVITY_THROTTLE_MS + 1;
    mocks.dataTap?.(hookless.sessionId, 'repaint after absolute deadline');
    mocks.stateTap?.(hookless.sessionId, 'busy');
    await reconcileTaskDispatchLifecycle(now);

    expect(mocks.heartbeat).toHaveBeenCalledTimes(2);
    expect(mocks.closeWorker).toHaveBeenCalledWith({
      paneId: hookless.paneId,
      sessionId: hookless.sessionId,
      missionId: hookless.missionId,
      workerIncarnationId: hookless.workerIncarnationId,
      scope,
    });
    expect(mocks.blockSessionExit).toHaveBeenCalledWith({
      sessionId: hookless.sessionId,
      workerIncarnationId: hookless.workerIncarnationId,
      reason: expect.stringMatching(/sem atividade|stalled/i),
    });
  });

  it('renews only on new output: byte-identical repaints never extend the lease', async () => {
    const hookless = {
      id: 'dispatch-repaint-filter',
      taskId: 'task-repaint-filter',
      missionId: 'mission-a',
      revision: 3,
      state: 'running',
      paneId: 'pane-repaint-filter',
      sessionId: 'session-repaint-filter',
      leaseExpiresAt: 1_500,
      workerIncarnationId: 'worker-incarnation-repaint-filter',
    };
    mocks.list.mockReturnValue([hookless]);
    mocks.getContextBySession.mockReturnValue({
      role: 'worker',
      missionId: hookless.missionId,
      workerIncarnationId: hookless.workerIncarnationId,
      scope,
    });
    mocks.getAgentSessionInfo.mockReturnValue({
      sessionId: hookless.sessionId,
      paneId: hookless.paneId,
      role: 'worker',
      missionId: hookless.missionId,
      workerIncarnationId: hookless.workerIncarnationId,
      scope,
    });
    mocks.getAgentSemanticStatusBySession.mockReturnValue(null);

    mocks.dataTap?.(hookless.sessionId, 'placeholder handoff frame');
    expect(mocks.heartbeat).toHaveBeenCalledTimes(1);

    // The stalled TUI repaints the identical frame: no new output, no
    // renewal — neither via the data tap nor via the busy transition it
    // causes.
    now += TASK_DISPATCH_ACTIVITY_THROTTLE_MS + 1;
    mocks.dataTap?.(hookless.sessionId, 'placeholder handoff frame');
    mocks.stateTap?.(hookless.sessionId, 'busy');
    expect(mocks.heartbeat).toHaveBeenCalledTimes(1);

    // Real new output renews again...
    now += TASK_DISPATCH_ACTIVITY_THROTTLE_MS + 1;
    mocks.dataTap?.(hookless.sessionId, 'real turn output');
    expect(mocks.heartbeat).toHaveBeenCalledTimes(2);

    // ...and a later identical repeat of THAT chunk is repaint again.
    now += TASK_DISPATCH_ACTIVITY_THROTTLE_MS + 1;
    mocks.dataTap?.(hookless.sessionId, 'real turn output');
    mocks.stateTap?.(hookless.sessionId, 'busy');
    expect(mocks.heartbeat).toHaveBeenCalledTimes(2);

    // With repaint-only activity the durable lease expires and the ordinary
    // stall recovery retires the worker.
    await reconcileTaskDispatchLifecycle(now);

    expect(mocks.heartbeat).toHaveBeenCalledTimes(2);
    expect(mocks.closeWorker).toHaveBeenCalledWith({
      paneId: hookless.paneId,
      sessionId: hookless.sessionId,
      missionId: hookless.missionId,
      workerIncarnationId: hookless.workerIncarnationId,
      scope,
    });
    expect(mocks.blockSessionExit).toHaveBeenCalledWith({
      sessionId: hookless.sessionId,
      workerIncarnationId: hookless.workerIncarnationId,
      reason: expect.stringMatching(/sem atividade|stalled/i),
    });
  });

  it('keeps an expired external transport fenced without a physical close authority', async () => {
    mocks.list.mockReturnValue([{
      id: 'dispatch-external',
      taskId: 'task-external',
      missionId: 'mission-a',
      revision: 4,
      state: 'running',
      paneId: 'pane-external',
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

    expect(mocks.heartbeat).not.toHaveBeenCalled();
    expect(mocks.closeWorker).not.toHaveBeenCalled();
    expect(mocks.blockSessionExit).not.toHaveBeenCalled();
    expect(mocks.requeueMissingRuntime).not.toHaveBeenCalled();
  });

  it('recovers the exact PTY pane identity when a legacy running row omitted paneId', async () => {
    mocks.list.mockReturnValue([{
      id: 'dispatch-legacy',
      taskId: 'task-legacy',
      missionId: 'mission-a',
      revision: 4,
      state: 'running',
      sessionId: 'session-legacy',
      leaseExpiresAt: 900,
      workerIncarnationId: 'worker-incarnation-legacy',
    }]);
    mocks.getAgentSessionInfo.mockReturnValue({
      sessionId: 'session-legacy',
      paneId: 'pane-legacy',
      role: 'worker',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-legacy',
      scope,
    });

    await reconcileTaskDispatchLifecycle(now);

    expect(mocks.closeWorker).toHaveBeenCalledWith({
      paneId: 'pane-legacy',
      sessionId: 'session-legacy',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-legacy',
      scope,
    });
    expect(mocks.blockSessionExit).toHaveBeenCalledWith({
      sessionId: 'session-legacy',
      workerIncarnationId: 'worker-incarnation-legacy',
      reason: expect.stringMatching(/sem atividade|stalled/i),
    });
  });

  it('keeps an expired worker fenced when physical retirement is not proven', async () => {
    mocks.list.mockReturnValue([{
      id: 'dispatch-live-db-error',
      taskId: 'task-live-db-error',
      missionId: 'mission-a',
      revision: 5,
      state: 'running',
      paneId: 'pane-live-db-error',
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
    mocks.closeWorker.mockResolvedValueOnce(false);

    await reconcileTaskDispatchLifecycle(now);

    expect(mocks.heartbeat).not.toHaveBeenCalled();
    expect(mocks.blockSessionExit).not.toHaveBeenCalled();
    expect(mocks.requeueMissingRuntime).not.toHaveBeenCalled();
  });

  it('keeps an expired exact worker alive while it awaits real user input', async () => {
    mocks.list.mockReturnValue([{
      id: 'dispatch-awaiting-input',
      taskId: 'task-awaiting-input',
      missionId: 'mission-a',
      revision: 5,
      state: 'running',
      paneId: 'pane-awaiting-input',
      sessionId: 'session-awaiting-input',
      leaseExpiresAt: 900,
      workerIncarnationId: 'worker-incarnation-awaiting-input',
    }]);
    mocks.getAgentSessionInfo.mockReturnValue({
      sessionId: 'session-awaiting-input',
      paneId: 'pane-awaiting-input',
      role: 'worker',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-awaiting-input',
      scope,
    });
    mocks.getAgentSemanticStatusBySession.mockReturnValue({
      status: 'awaiting-input',
      sessionId: 'session-awaiting-input',
      paneId: 'pane-awaiting-input',
      updatedAt: now,
    });

    await reconcileTaskDispatchLifecycle(now);

    expect(mocks.closeWorker).not.toHaveBeenCalled();
    expect(mocks.blockSessionExit).not.toHaveBeenCalled();
    expect(mocks.requeueMissingRuntime).not.toHaveBeenCalled();
  });

  it('leaves an exact live worker alone while its activity lease is valid', async () => {
    mocks.list.mockReturnValue([{
      id: 'dispatch-live',
      taskId: 'task-live',
      missionId: 'mission-a',
      revision: 5,
      state: 'running',
      paneId: 'pane-live',
      sessionId: 'session-live',
      leaseExpiresAt: now + 1,
      workerIncarnationId: 'worker-incarnation-live',
    }]);
    mocks.getAgentSessionInfo.mockReturnValue({
      sessionId: 'session-live',
      role: 'worker',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-live',
      scope,
    });

    await reconcileTaskDispatchLifecycle(now);

    expect(mocks.heartbeat).not.toHaveBeenCalled();
    expect(mocks.closeWorker).not.toHaveBeenCalled();
    expect(mocks.blockSessionExit).not.toHaveBeenCalled();
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

  it('repairs the exact legacy dirty-checkout block after checkpointing the primary once', async () => {
    mocks.list.mockReturnValue([
      {
        id: 'dispatch-legacy-dirty-checkout',
        taskId: 'task-legacy-dirty-checkout',
        missionId: 'mission-a',
        revision: 9,
        attempt: TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS,
        state: 'blocked',
        lastError: LEGACY_GUIDED_DIRTY_CHECKOUT_TERMINAL_REASON,
        leaseExpiresAt: 900,
      },
      {
        id: 'dispatch-auth-block',
        taskId: 'task-auth-block',
        missionId: 'mission-a',
        revision: 4,
        attempt: TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS,
        state: 'blocked',
        lastError: 'authentication failed',
        leaseExpiresAt: 900,
      },
    ]);

    await reconcileTaskDispatchLifecycle(now);

    expect(
      mocks.ensureGuidedGitBaselineForWorktreeAsync,
    ).toHaveBeenCalledOnce();
    expect(
      mocks.ensureGuidedGitBaselineForWorktreeAsync,
    ).toHaveBeenCalledWith(scope);
    expect(
      mocks.recoverLegacyGuidedDirtyCheckoutBootstrap,
    ).toHaveBeenCalledOnce();
    expect(
      mocks.recoverLegacyGuidedDirtyCheckoutBootstrap,
    ).toHaveBeenCalledWith('task-legacy-dirty-checkout');
  });

  it('does not checkpoint a stale legacy row before store authority is proven', async () => {
    mocks.list.mockReturnValue([
      {
        id: 'dispatch-stale-dirty-checkout',
        taskId: 'task-stale-dirty-checkout',
        missionId: 'mission-replanned',
        revision: 9,
        attempt: TASK_DISPATCH_MAX_SESSION_EXIT_ATTEMPTS,
        state: 'blocked',
        lastError: LEGACY_GUIDED_DIRTY_CHECKOUT_TERMINAL_REASON,
        leaseExpiresAt: 900,
      },
    ]);
    mocks.canRecoverLegacyGuidedDirtyCheckoutBootstrap.mockReturnValue(false);

    await reconcileTaskDispatchLifecycle(now);

    expect(
      mocks.canRecoverLegacyGuidedDirtyCheckoutBootstrap,
    ).toHaveBeenCalledWith('task-stale-dirty-checkout');
    expect(
      mocks.ensureGuidedGitBaselineForWorktreeAsync,
    ).not.toHaveBeenCalled();
    expect(
      mocks.recoverLegacyGuidedDirtyCheckoutBootstrap,
    ).not.toHaveBeenCalled();
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
