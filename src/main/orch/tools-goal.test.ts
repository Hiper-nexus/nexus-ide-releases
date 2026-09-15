import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/project-identity-types';
import { buildGoalTools } from './tools-goal';
import { clearGoalsForTesting, shutdownGoalGovernor } from './goal-governor';
import type { AgentGateContext } from './gate';
import type { McpToolInvocation } from './mcp-protocol';

vi.mock('../pty/pty-manager', () => ({
  getSessionState: vi.fn(() => 'idle'),
  orchWriteSession: vi.fn(() => true),
}));

vi.mock('./pane-registry', () => ({
  findPane: vi.fn((ref: string) => ({
    paneId: ref,
    sessionId: `session-${ref}`,
    state: 'idle',
  })),
}));

vi.mock('../agent-runtime/agent-runtime-bridge', () => ({
  getAgentAwakeService: () => ({
    setStatuses: vi.fn(),
  }),
}));

vi.mock('electron', () => ({
  powerSaveBlocker: {
    start: vi.fn(() => 1),
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

describe('Goal Governor MCP Tools', () => {
  const scope: ProjectExecutionScope = {
    version: 1,
    identitySource: 'manifest',
    rootRealPath: '/test/workspace',
    checkoutId: 'test-checkout',
    installationId: 'test-inst',
    projectId: 'test-project',
  };

  const ctx = {
    token: 'test-token',
    label: 'test-orchestrator',
    role: 'orchestrator',
    sessionId: 'session-orch-001',
    executionScope: scope,
  } as unknown as AgentGateContext;

  const invocation: McpToolInvocation = {};

  const tools = buildGoalTools();
  const registerTool = tools.find((t) => t.name === 'nexus_goal_register')!;
  const statusTool = tools.find((t) => t.name === 'nexus_goal_status')!;
  const bindTool = tools.find((t) => t.name === 'nexus_goal_bind_pane')!;
  const advanceTool = tools.find((t) => t.name === 'nexus_wave_advance')!;
  const controlTool = tools.find((t) => t.name === 'nexus_goal_control')!;
  const taskUpdateTool = tools.find((t) => t.name === 'nexus_goal_task_update')!;

  beforeEach(() => {
    clearGoalsForTesting();
  });

  afterEach(async () => {
    await shutdownGoalGovernor();
    clearGoalsForTesting();
  });

  it('exports all 6 goal tools in buildGoalTools catalog', () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain('nexus_goal_register');
    expect(names).toContain('nexus_goal_status');
    expect(names).toContain('nexus_goal_bind_pane');
    expect(names).toContain('nexus_wave_advance');
    expect(names).toContain('nexus_goal_control');
    expect(names).toContain('nexus_goal_task_update');
  });

  it('nexus_goal_register creates a goal with waves and binds orchestrator', async () => {
    const result = (await registerTool.handler(
      {
        title: 'Overnight Multi-Wave Run',
        waves: [
          {
            name: 'Onda 4: Integrador',
            instructions: 'Execute SES sender and production smoke',
            tasks: [
              { id: 'RU-186', title: 'SES Sender' },
              { id: 'RU-209', title: 'Smoke de Produção' },
            ],
            gate: { type: 'command', command: 'npm test' },
          },
          {
            name: 'Onda 5: Frontend',
            instructions: 'UI polish and tests',
            tasks: [{ id: 'RU-210', title: 'Mascote' }],
          },
        ],
      },
      ctx,
      invocation,
    )) as { ok: boolean; goalId: string; wavesCount: number; currentWave: string };

    expect(result.ok).toBe(true);
    expect(result.goalId).toMatch(/^goal_/);
    expect(result.wavesCount).toBe(2);
    expect(result.currentWave).toBe('Onda 4: Integrador');
  });

  it('nexus_goal_status reports the current active goal progress', async () => {
    // Register goal first
    const reg = (await registerTool.handler(
      {
        title: 'Status Test Goal',
        waves: [
          {
            name: 'Wave 1',
            instructions: 'Do step 1',
            tasks: [{ id: 'T1', title: 'Task 1' }],
          },
        ],
      },
      ctx,
      invocation,
    )) as { goalId: string };

    // Query status without goalId (active goal lookup)
    const statusRes = (await statusTool.handler({}, ctx, invocation)) as {
      ok: boolean;
      activeGoal: { id: string; title: string; currentWaveIndex: number } | null;
      totalGoals: number;
    };

    expect(statusRes.ok).toBe(true);
    expect(statusRes.activeGoal?.id).toBe(reg.goalId);
    expect(statusRes.activeGoal?.title).toBe('Status Test Goal');
    expect(statusRes.totalGoals).toBe(1);

    // Query status with specific goalId
    const specificRes = (await statusTool.handler({ goalId: reg.goalId }, ctx, invocation)) as {
      ok: boolean;
      goal: { id: string; status: string };
    };
    expect(specificRes.ok).toBe(true);
    expect(specificRes.goal.id).toBe(reg.goalId);
    expect(specificRes.goal.status).toBe('running');
  });

  it('nexus_goal_bind_pane binds worker pane to task and active wave', async () => {
    await registerTool.handler(
      {
        title: 'Binding Test Goal',
        waves: [
          {
            name: 'Wave 1',
            instructions: 'Step 1',
            tasks: [{ id: 'RU-209', title: 'Smoke check' }],
          },
        ],
      },
      ctx,
      invocation,
    );

    const bindRes = (await bindTool.handler(
      {
        paneId: 'worker-pane-7',
        taskId: 'RU-209',
      },
      ctx,
      invocation,
    )) as { ok: boolean; boundPaneId: string; taskId: string };

    expect(bindRes.ok).toBe(true);
    expect(bindRes.boundPaneId).toBe('worker-pane-7');
    expect(bindRes.taskId).toBe('RU-209');
  });

  it('nexus_goal_task_update updates task status with summary', async () => {
    await registerTool.handler(
      {
        title: 'Task Update Test Goal',
        waves: [
          {
            name: 'Wave 1',
            instructions: 'Step 1',
            tasks: [{ id: 'RU-186', title: 'SES Sender' }],
          },
        ],
      },
      ctx,
      invocation,
    );

    const updateRes = (await taskUpdateTool.handler(
      {
        taskId: 'RU-186',
        status: 'completed',
        summary: 'SES sender deployed and verified with test event',
      },
      ctx,
      invocation,
    )) as { ok: boolean; taskId: string; status: string };

    expect(updateRes.ok).toBe(true);
    expect(updateRes.taskId).toBe('RU-186');
    expect(updateRes.status).toBe('completed');
  });

  it('nexus_wave_advance and nexus_goal_control execute wave transition and control actions', async () => {
    const reg = (await registerTool.handler(
      {
        title: 'Advance Test Goal',
        waves: [
          {
            name: 'Wave 1',
            instructions: 'Step 1',
            tasks: [{ id: 'T1', title: 'Task 1' }],
          },
          {
            name: 'Wave 2',
            instructions: 'Step 2',
            tasks: [{ id: 'T2', title: 'Task 2' }],
          },
        ],
      },
      ctx,
      invocation,
    )) as { goalId: string };

    // Advance wave with force: true
    const advRes = (await advanceTool.handler(
      {
        goalId: reg.goalId,
        force: true,
        summary: 'Wave 1 completed by Codex',
      },
      ctx,
      invocation,
    )) as { ok: boolean; currentWaveIndex: number; status: string };

    expect(advRes.ok).toBe(true);
    expect(advRes.currentWaveIndex).toBe(1);
    expect(advRes.status).toBe('running');

    // Pause goal
    const pauseRes = (await controlTool.handler(
      {
        goalId: reg.goalId,
        action: 'pause',
        reason: 'Operator reviewing Onda 5 scope',
      },
      ctx,
      invocation,
    )) as { ok: boolean; action: string; status: string };

    expect(pauseRes.ok).toBe(true);
    expect(pauseRes.status).toBe('paused');

    // Resume goal
    const resumeRes = (await controlTool.handler(
      {
        goalId: reg.goalId,
        action: 'resume',
      },
      ctx,
      invocation,
    )) as { ok: boolean; action: string; status: string };

    expect(resumeRes.ok).toBe(true);
    expect(resumeRes.status).toBe('running');
  });
});
