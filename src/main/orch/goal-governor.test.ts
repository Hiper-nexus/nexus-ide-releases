import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/project-identity-types';
import {
  advanceWave,
  bindWorkerPaneToGoal,
  clearGoalsForTesting,
  controlGoal,
  getActiveGoalForScope,
  getGoalGovernorSnapshot,
  reconcileGoalGovernor,
  registerGoal,
  setCustomGateRunnerForTesting,
  shutdownGoalGovernor,
  updateGoalTask,
} from './goal-governor';

vi.mock('../pty/pty-manager', () => {
  const sessionStates = new Map<string, 'idle' | 'busy' | 'exited'>();
  const writtenData: Array<{ sessionId: string; data: string }> = [];

  return {
    getSessionState: vi.fn((sessionId: string) => sessionStates.get(sessionId) ?? 'idle'),
    orchWriteSession: vi.fn((sessionId: string, data: string) => {
      writtenData.push({ sessionId, data });
      return true;
    }),
    __setSessionState: (sessionId: string, state: 'idle' | 'busy' | 'exited') => {
      sessionStates.set(sessionId, state);
    },
    __getWrittenData: () => writtenData,
    __clearMock: () => {
      sessionStates.clear();
      writtenData.length = 0;
    },
  };
});

vi.mock('./pane-registry', () => {
  const panes = new Map<string, { paneId: string; sessionId: string; state: string }>();

  return {
    findPane: vi.fn((paneId: string) => panes.get(paneId) ?? null),
    __setPane: (paneId: string, entry: { paneId: string; sessionId: string; state: string }) => {
      panes.set(paneId, entry);
    },
    __clearPanes: () => panes.clear(),
  };
});

vi.mock('../agent-runtime/agent-runtime-bridge', () => ({
  getAgentAwakeService: () => ({
    setStatuses: vi.fn(),
  }),
}));

vi.mock('electron', () => ({
  powerSaveBlocker: {
    start: vi.fn(() => 42),
    stop: vi.fn(),
    isStarted: vi.fn(() => true),
  },
}));

vi.mock('./workspace-path', () => ({
  resolveRootForScope: (scope: ProjectExecutionScope) => scope.rootRealPath,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    existsSync: vi.fn(() => true),
  };
});

describe('Goal Governor & Wave Engine', () => {
  const scope: ProjectExecutionScope = {
    version: 1,
    identitySource: 'manifest',
    rootRealPath: '/test/workspace',
    checkoutId: 'test-checkout',
    installationId: 'test-inst',
    projectId: 'test-project',
  };

  const orchSessionId = 'session-orch-1';

  beforeEach(() => {
    clearGoalsForTesting();
    // @ts-expect-error __clearMock só existe no vi.mock deste arquivo, não no tipo real do pty-manager
    import('../pty/pty-manager').then((m) => m.__clearMock?.());
  });

  afterEach(async () => {
    await shutdownGoalGovernor();
    clearGoalsForTesting();
  });

  it('registers a multi-wave goal and sets Wave 1 running', () => {
    const goal = registerGoal({
      title: 'Roadmap Overnight Waves',
      scope,
      orchestratorSessionId: orchSessionId,
      waves: [
        {
          id: 'wave_4',
          name: 'Onda 4: Integrador e Produção',
          instructions: 'Spawn Codex for RU-186 and RU-209',
          tasks: [
            { id: 'RU-186', title: 'Sender SES' },
            { id: 'RU-209', title: 'Smoke de Produção' },
          ],
          gate: { type: 'all_tasks_completed' },
        },
        {
          id: 'wave_5',
          name: 'Onda 5: Frontend e Mobile',
          instructions: 'Execute mobile smoke and components',
          tasks: [{ id: 'RU-211', title: 'Mobile Smoke' }],
          gate: { type: 'all_tasks_completed' },
        },
      ],
    });

    expect(goal.id).toMatch(/^goal_/);
    expect(goal.status).toBe('running');
    expect(goal.currentWaveIndex).toBe(0);
    expect(goal.waves.length).toBe(2);
    expect(goal.waves[0].status).toBe('running');
    expect(goal.waves[1].status).toBe('pending');

    const active = getActiveGoalForScope(scope);
    expect(active?.id).toBe(goal.id);

    const snapshot = getGoalGovernorSnapshot();
    expect(snapshot.activeGoalId).toBe(goal.id);
  });

  it('binds worker panes and tracks task completion on worker exit', async () => {
    const ptyMock = await import('../pty/pty-manager');
    const paneMock = await import('./pane-registry');

    // @ts-expect-error test helper
    ptyMock.__setSessionState(orchSessionId, 'idle');

    const goal = registerGoal({
      title: 'Roadmap Execution',
      scope,
      orchestratorSessionId: orchSessionId,
      waves: [
        {
          id: 'wave_4',
          name: 'Onda 4',
          instructions: 'Execute worker tasks',
          tasks: [
            { id: 'RU-209', title: 'Smoke de produção' },
          ],
          gate: { type: 'all_tasks_completed' },
        },
      ],
    });

    // Bind worker pane
    const workerPaneId = 'worker-pane-9';
    // @ts-expect-error test helper
    paneMock.__setPane(workerPaneId, {
      paneId: workerPaneId,
      sessionId: 'session-worker-9',
      state: 'busy',
    });

    const bindResult = bindWorkerPaneToGoal(goal.id, workerPaneId, 'RU-209');
    expect(bindResult.ok).toBe(true);

    const wave = goal.waves[0];
    expect(wave.workerPaneIds).toContain(workerPaneId);
    expect(wave.tasks[0].status).toBe('in_progress');
    expect(wave.tasks[0].assignedPaneId).toBe(workerPaneId);

    // Simulate worker pane completing and exiting
    // @ts-expect-error test helper
    paneMock.__setPane(workerPaneId, {
      paneId: workerPaneId,
      sessionId: 'session-worker-9',
      state: 'exited',
    });

    // Reconciler runs
    await reconcileGoalGovernor(Date.now());

    // Task is marked completed because worker finished with exited
    expect(wave.tasks[0].status).toBe('completed');
    // Since all tasks completed and gate is all_tasks_completed, gate passed and wave completed!
    expect(goal.status).toBe('completed');
    expect(wave.status).toBe('passed');
  });

  it('advances wave automatically when gate passes and nudges orchestrator with next wave', async () => {
    const ptyMock = await import('../pty/pty-manager');
    // @ts-expect-error test helper
    ptyMock.__setSessionState(orchSessionId, 'idle');

    let gateCallCount = 0;
    setCustomGateRunnerForTesting(async () => {
      gateCallCount++;
      return {
        checkedAt: Date.now(),
        passed: true,
        output: 'All tests passed (12 passed)',
        exitCode: 0,
        attempt: 1,
      };
    });

    const goal = registerGoal({
      title: 'Multi-wave Project',
      scope,
      orchestratorSessionId: orchSessionId,
      waves: [
        {
          id: 'wave_4',
          name: 'Onda 4',
          instructions: 'Run backend integrations',
          tasks: [{ id: 'RU-186', title: 'SES Sender' }],
          gate: { type: 'command', command: 'npm test' },
        },
        {
          id: 'wave_5',
          name: 'Onda 5',
          instructions: 'Run frontend integrations',
          tasks: [{ id: 'RU-211', title: 'Frontend UI' }],
          gate: { type: 'command', command: 'npm run test:ui' },
        },
      ],
    });

    // Mark task completed
    updateGoalTask(goal.id, 'RU-186', 'completed', 'SES sender implemented');

    // Run reconciler
    await reconcileGoalGovernor(Date.now());

    expect(gateCallCount).toBe(1);
    expect(goal.waves[0].status).toBe('passed');
    expect(goal.currentWaveIndex).toBe(1);
    expect(goal.waves[1].status).toBe('running');
    expect(goal.status).toBe('running');

    // Check that orchestrator was nudged with instructions for Wave 5
    // @ts-expect-error test helper
    const written = ptyMock.__getWrittenData() as Array<{ sessionId: string; data: string }>;
    const wave5Nudge = written.find((w) => w.data.includes('Onda 5') && w.data.includes('RU-211'));
    expect(wave5Nudge).toBeDefined();
  });

  it('trips circuit breaker when gate fails repeatedly and halts goal without token burn', async () => {
    const ptyMock = await import('../pty/pty-manager');
    // @ts-expect-error test helper
    ptyMock.__setSessionState(orchSessionId, 'idle');

    setCustomGateRunnerForTesting(async (_gate, _cwd) => {
      return {
        checkedAt: Date.now(),
        passed: false,
        output: 'FAIL: Type error in SES sender',
        exitCode: 1,
        attempt: 1,
      };
    });

    const goal = registerGoal({
      title: 'Failing Wave Project',
      scope,
      orchestratorSessionId: orchSessionId,
      circuitBreakerMaxFailures: 3,
      waves: [
        {
          id: 'wave_4',
          name: 'Onda 4',
          instructions: 'Run integrations',
          tasks: [{ id: 'RU-186', title: 'SES Sender' }],
          gate: { type: 'command', command: 'npm test' },
        },
      ],
    });

    updateGoalTask(goal.id, 'RU-186', 'completed');

    // 1st failure
    await reconcileGoalGovernor(Date.now());
    expect(goal.consecutiveFailures).toBe(1);
    expect(goal.status).toBe('running');

    // 2nd failure
    goal.status = 'evaluating_gate';
    await reconcileGoalGovernor(Date.now());
    expect(goal.consecutiveFailures).toBe(2);
    expect(goal.status).toBe('running');

    // 3rd failure -> Circuit breaker trips!
    goal.status = 'evaluating_gate';
    await reconcileGoalGovernor(Date.now());
    expect(goal.consecutiveFailures).toBe(3);
    expect(goal.status).toBe('blocked');
    expect(goal.blockReason).toContain('Circuit breaker tripped');

    // Orchestrator notified of blocked status
    // @ts-expect-error test helper
    const written = ptyMock.__getWrittenData() as Array<{ sessionId: string; data: string }>;
    const blockNudge = written.find((w) => w.data.includes('Circuit breaker tripped'));
    expect(blockNudge).toBeDefined();
  });

  it('supports manual advance and control operations', async () => {
    const goal = registerGoal({
      title: 'Controllable Goal',
      scope,
      orchestratorSessionId: orchSessionId,
      waves: [
        {
          id: 'wave_1',
          name: 'Onda 1',
          instructions: 'First step',
          tasks: [{ id: 'T1', title: 'Task 1' }],
        },
        {
          id: 'wave_2',
          name: 'Onda 2',
          instructions: 'Second step',
          tasks: [{ id: 'T2', title: 'Task 2' }],
        },
      ],
    });

    // Pause goal
    const pauseRes = controlGoal(goal.id, 'pause', 'operator stepped away');
    expect(pauseRes.ok).toBe(true);
    expect(goal.status).toBe('paused');
    expect(goal.blockReason).toBe('operator stepped away');

    // Resume goal
    const resumeRes = controlGoal(goal.id, 'resume');
    expect(resumeRes.ok).toBe(true);
    expect(goal.status).toBe('running');
    expect(goal.blockReason).toBeUndefined();

    // Force advance wave
    const advRes = await advanceWave(goal.id, { force: true, summary: 'Manually verified' });
    expect(advRes.ok).toBe(true);
    expect(advRes.currentWaveIndex).toBe(1);
    expect(goal.waves[0].status).toBe('passed');
    expect(goal.waves[1].status).toBe('running');

    // Force advance final wave -> completes goal
    const finalAdv = await advanceWave(goal.id, { force: true });
    expect(finalAdv.ok).toBe(true);
    expect(goal.status).toBe('completed');
  });
});
