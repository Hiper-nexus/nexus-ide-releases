/**
 * MCP Tools for Goal Governor and Autonomous Wave Engine.
 *
 * Tools:
 * - nexus_goal_register: Register a multi-wave goal for loose-pane orchestration
 * - nexus_goal_status: Inspect active goal, wave progress, and gate status
 * - nexus_goal_bind_pane: Bind a worker pane to a wave/task
 * - nexus_wave_advance: Advance to next wave or submit completion proof
 * - nexus_goal_control: Pause, resume, cancel, or retry gate evaluation
 */

import type { McpToolDef } from './mcp-protocol';
import { assertMcpInvocationCurrent } from './mcp-protocol';
import {
  advanceWave,
  bindWorkerPaneToGoal,
  controlGoal,
  getActiveGoalForScope,
  getGoal,
  getGoalGovernorSnapshot,
  listGoals,
  registerGoal,
  updateGoalTask,
} from './goal-governor';
import { executionScopeFor } from './gate';
import { num, requireStr, str } from './tool-util';
import { findPane } from './pane-registry';
import type { GoalGate, GoalGateType, TaskStatus } from '../../shared/goal-governor-types';

const goalRegisterTool: McpToolDef = {
  name: 'nexus_goal_register',
  description:
    'Register an autonomous multi-wave goal for loose-pane grid orchestration. ' +
    'The Goal Governor continuously supervises workers overnight, keeps the system awake, ' +
    'evaluates verification gates between waves, and automatically nudges the orchestrator ' +
    'terminal with instructions to advance to subsequent waves (e.g. Onda 4 -> Onda 5 -> Onda 6).',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Goal title, e.g. "Overnight Migration Roadmap"',
      },
      waves: {
        type: 'array',
        description: 'Sequential waves to execute',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Wave identifier (e.g. "wave_4")' },
            name: { type: 'string', description: 'Wave name (e.g. "Onda 4: Integrador e Testes")' },
            instructions: {
              type: 'string',
              description: 'Instructions for the orchestrator to execute in this wave',
            },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Task code (e.g. "RU-209")' },
                  title: { type: 'string' },
                },
                required: ['id', 'title'],
              },
            },
            gate: {
              type: 'object',
              description: 'Verification gate to pass before transitioning to the next wave',
              properties: {
                type: {
                  type: 'string',
                  enum: ['command', 'test', 'file_exists', 'all_tasks_completed', 'manual_or_mcp'],
                },
                command: {
                  type: 'string',
                  description: 'Verification command (e.g. "npm test" or "npm run typecheck")',
                },
                cwd: { type: 'string', description: 'Relative working directory' },
                timeoutMs: { type: 'number', description: 'Timeout in ms (default: 120000)' },
                expectedRegex: { type: 'string', description: 'Regex pattern expected in output' },
              },
              required: ['type'],
            },
          },
          required: ['name', 'instructions'],
        },
      },
      orchestratorPaneId: {
        type: 'string',
        description: 'Optional pane ID or pane number of the orchestrator. Defaults to caller pane.',
      },
      preventSleep: {
        type: 'boolean',
        description: 'Keep system awake overnight during wave execution (default: true)',
      },
      circuitBreakerMaxFailures: {
        type: 'number',
        description: 'Maximum consecutive gate failures before pausing (default: 3)',
      },
    },
    required: ['title', 'waves'],
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const scope = executionScopeFor(ctx);
    const title = requireStr(args, 'title');

    const rawWaves = args.waves;
    if (!Array.isArray(rawWaves) || rawWaves.length === 0) {
      throw new Error('waves must be a non-empty array');
    }

    let orchestratorSessionId = ctx.sessionId ?? '';
    const paneRef = str(args, 'orchestratorPaneId');
    if (paneRef) {
      const pane = findPane(paneRef);
      if (pane?.sessionId) {
        orchestratorSessionId = pane.sessionId;
      }
    }

    if (!orchestratorSessionId) {
      throw new Error('orchestrator session could not be determined for goal');
    }

    const waves = rawWaves.map((w: Record<string, unknown>, idx: number) => {
      const name = typeof w.name === 'string' ? w.name : `Wave ${idx + 1}`;
      const instructions = typeof w.instructions === 'string' ? w.instructions : '';
      const rawTasks = Array.isArray(w.tasks) ? w.tasks : [];
      const tasks = rawTasks.map((t: Record<string, unknown>) => ({
        id: String(t.id || ''),
        title: String(t.title || ''),
      })).filter((t) => t.id && t.title);

      let gate: GoalGate | undefined;
      if (w.gate && typeof w.gate === 'object') {
        const g = w.gate as Record<string, unknown>;
        gate = {
          type: (g.type as GoalGateType) || 'all_tasks_completed',
          command: typeof g.command === 'string' ? g.command : undefined,
          cwd: typeof g.cwd === 'string' ? g.cwd : undefined,
          timeoutMs: typeof g.timeoutMs === 'number' ? g.timeoutMs : undefined,
          expectedRegex: typeof g.expectedRegex === 'string' ? g.expectedRegex : undefined,
        };
      }

      return {
        id: typeof w.id === 'string' ? w.id : `wave_${idx + 1}`,
        name,
        instructions,
        tasks,
        gate,
      };
    });

    const goal = registerGoal({
      title,
      scope,
      orchestratorSessionId,
      orchestratorPaneId: paneRef,
      waves,
      preventSleep: args.preventSleep !== false,
      circuitBreakerMaxFailures: num(args, 'circuitBreakerMaxFailures') ?? 3,
    });

    return {
      ok: true,
      goalId: goal.id,
      title: goal.title,
      wavesCount: goal.waves.length,
      currentWave: goal.waves[0]?.name,
      preventSleep: goal.preventSleep,
    };
  },
};

const goalStatusTool: McpToolDef = {
  name: 'nexus_goal_status',
  description:
    'Check the live status of the Goal Governor, active wave progress, remaining tasks, ' +
    'worker pane bindings, and verification gate results.',
  inputSchema: {
    type: 'object',
    properties: {
      goalId: {
        type: 'string',
        description: 'Optional specific goal ID. Defaults to the active goal for current workspace.',
      },
    },
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const scope = executionScopeFor(ctx);
    const goalId = str(args, 'goalId');

    if (goalId) {
      const goal = getGoal(goalId);
      if (!goal) throw new Error(`goal not found: ${goalId}`);
      return { ok: true, goal };
    }

    const active = getActiveGoalForScope(scope);
    const all = listGoals(scope);
    const snapshot = getGoalGovernorSnapshot();

    return {
      ok: true,
      activeGoal: active,
      totalGoals: all.length,
      isAwakeLocked: snapshot.isAwakeLocked,
    };
  },
};

const goalBindPaneTool: McpToolDef = {
  name: 'nexus_goal_bind_pane',
  description:
    'Bind a spawned worker pane to the active wave or a specific task in the goal. ' +
    'The Goal Governor will monitor the worker pane until it exits or completes.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: {
        type: 'string',
        description: 'Pane ID or pane number of the worker pane',
      },
      goalId: {
        type: 'string',
        description: 'Optional goal ID (defaults to the active goal)',
      },
      taskId: {
        type: 'string',
        description: 'Optional task ID in the current wave (e.g. "RU-209")',
      },
    },
    required: ['paneId'],
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const scope = executionScopeFor(ctx);
    const paneRef = requireStr(args, 'paneId');
    const taskId = str(args, 'taskId');

    let goalId = str(args, 'goalId');
    if (!goalId) {
      const active = getActiveGoalForScope(scope);
      if (!active) {
        throw new Error('no active goal found to bind pane; specify goalId or register a goal first');
      }
      goalId = active.id;
    }

    const pane = findPane(paneRef);
    const effectivePaneId = pane?.paneId ?? paneRef;

    const result = bindWorkerPaneToGoal(goalId, effectivePaneId, taskId);
    if (!result.ok) throw new Error(result.error);

    return {
      ok: true,
      goalId,
      boundPaneId: effectivePaneId,
      taskId: taskId ?? null,
    };
  },
};

const waveAdvanceTool: McpToolDef = {
  name: 'nexus_wave_advance',
  description:
    'Explicitly advance the current wave to the next wave, or submit wave completion summary and evaluate gates.',
  inputSchema: {
    type: 'object',
    properties: {
      goalId: {
        type: 'string',
        description: 'Optional goal ID (defaults to active goal)',
      },
      summary: {
        type: 'string',
        description: 'Summary of work accomplished in the completed wave',
      },
      force: {
        type: 'boolean',
        description: 'Force immediate advance without re-evaluating gate check (default: false)',
      },
    },
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const scope = executionScopeFor(ctx);
    let goalId = str(args, 'goalId');
    if (!goalId) {
      const active = getActiveGoalForScope(scope);
      if (!active) throw new Error('no active goal found to advance');
      goalId = active.id;
    }

    const force = args.force === true;
    const summary = str(args, 'summary');

    const result = await advanceWave(goalId, { force, summary });
    if (!result.ok) throw new Error(result.error);

    return {
      ok: true,
      goalId,
      currentWaveIndex: result.currentWaveIndex,
      status: result.status,
    };
  },
};

const goalControlTool: McpToolDef = {
  name: 'nexus_goal_control',
  description:
    'Control an autonomous goal: pause, resume, cancel, or retry failed verification gate.',
  inputSchema: {
    type: 'object',
    properties: {
      goalId: { type: 'string', description: 'Goal ID' },
      action: {
        type: 'string',
        enum: ['pause', 'resume', 'cancel', 'retry_gate'],
        description: 'Action to execute on the goal',
      },
      reason: {
        type: 'string',
        description: 'Reason for pause or cancellation',
      },
    },
    required: ['goalId', 'action'],
  },
  handler: async (args, _ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const goalId = requireStr(args, 'goalId');
    const action = requireStr(args, 'action') as 'pause' | 'resume' | 'cancel' | 'retry_gate';
    const reason = str(args, 'reason');

    const result = controlGoal(goalId, action, reason);
    if (!result.ok) throw new Error(result.error);

    return {
      ok: true,
      goalId,
      action,
      status: result.goal?.status,
    };
  },
};

const goalTaskUpdateTool: McpToolDef = {
  name: 'nexus_goal_task_update',
  description:
    'Update the status of a specific task in the goal (e.g. mark RU-209 as completed).',
  inputSchema: {
    type: 'object',
    properties: {
      goalId: { type: 'string', description: 'Optional goal ID (defaults to active goal)' },
      taskId: { type: 'string', description: 'Task ID (e.g. "RU-209")' },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'failed'],
        description: 'New task status',
      },
      summary: { type: 'string', description: 'Optional completion notes or evidence' },
    },
    required: ['taskId', 'status'],
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const scope = executionScopeFor(ctx);
    let goalId = str(args, 'goalId');
    if (!goalId) {
      const active = getActiveGoalForScope(scope);
      if (!active) throw new Error('no active goal found');
      goalId = active.id;
    }

    const taskId = requireStr(args, 'taskId');
    const status = requireStr(args, 'status') as TaskStatus;
    const summary = str(args, 'summary');

    const result = updateGoalTask(goalId, taskId, status, summary);
    if (!result.ok) throw new Error(result.error);

    return { ok: true, goalId, taskId, status };
  },
};

export function buildGoalTools(): McpToolDef[] {
  return [
    goalRegisterTool,
    goalStatusTool,
    goalBindPaneTool,
    waveAdvanceTool,
    goalControlTool,
    goalTaskUpdateTool,
  ];
}
