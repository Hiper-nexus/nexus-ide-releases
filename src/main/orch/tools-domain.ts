import { markHandoffSubmitted } from './gate';
import type { McpToolDef } from './mcp-protocol';
import { readSessionOutput, waitForIdle } from './pane-registry';
import {
  handoffStatusSchema,
  missionStatusSchema,
} from '../../shared/orch-types';
import {
  createMission,
  getMission,
  listMissions,
  setMissionStatus,
} from './mission-store';
import { listHandoffs, submitHandoff } from './handoff-store';
import { findAgent, listAgents, saveSquad } from './squad-store';
import {
  addTask as todoAddTask,
  DEFAULT_TODO_LIST,
  getTodoList,
  markAllDone,
  moveToTask,
  setTasks,
} from './todo-store';
import { createTask, listTasks, updateTask } from './task-store';
import { catalogInstall } from './catalog';
import { onHandoffSubmitted } from './idle-delivery';
import { paneSpawnTool } from './tools-panes';
import {
  num,
  requireStr,
  spawnPaneAndMaybePrompt,
  str,
  strArray,
} from './tool-util';

/**
 * MCP tools for handoffs (2), agents (3), missions (5), squad/catalog/task
 * (3) and todos (1) — Overclock parity groups 2-6.
 */

const handoffSubmitTool: McpToolDef = {
  name: 'nexus_handoff_submit',
  description:
    'Submit your work handoff to the orchestrator: ' +
    '{status: success|partial|blocked|failed, summary, artifacts?}. Always ' +
    'allowed regardless of allowlists. Required before a worker finishes.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['success', 'partial', 'blocked', 'failed'],
      },
      summary: { type: 'string' },
      artifacts: { type: 'array', items: {} },
    },
    required: ['status', 'summary'],
  },
  handler: async (args, ctx) => {
    const handoff = submitHandoff({
      status: handoffStatusSchema.parse(args.status),
      summary: requireStr(args, 'summary'),
      artifacts: Array.isArray(args.artifacts) ? args.artifacts : [],
      missionId: ctx.missionId,
      sessionId: ctx.sessionId,
      fromAgent: ctx.agentName ?? ctx.label,
    });
    markHandoffSubmitted(ctx);
    onHandoffSubmitted(handoff);
    return { ok: true, handoffId: handoff.id };
  },
};

const handoffListTool: McpToolDef = {
  name: 'nexus_handoff_list',
  description:
    'List submitted handoffs (undelivered by default; includeDelivered: true ' +
    'for the full audit trail). Optionally filter by missionId.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: { type: 'string' },
      includeDelivered: { type: 'boolean' },
    },
  },
  handler: async (args, ctx) =>
    listHandoffs({
      missionId: str(args, 'missionId') ?? ctx.missionId,
      includeDelivered: args.includeDelivered === true,
    }),
};

const agentListTool: McpToolDef = {
  name: 'nexus_agent_list',
  description: 'List every agent defined across saved squads.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => listAgents(),
};

const agentGetTool: McpToolDef = {
  name: 'nexus_agent_get',
  description: 'Get one squad agent by id or agentName.',
  inputSchema: {
    type: 'object',
    properties: { agent: { type: 'string' } },
    required: ['agent'],
  },
  handler: async (args) => {
    const found = findAgent(requireStr(args, 'agent'));
    if (!found) throw new Error('agent not found');
    return { squadId: found.squad.id, ...found.agent };
  },
};

const agentInvokeTool: McpToolDef = {
  name: 'nexus_agent_invoke',
  description:
    'Run a squad agent on a prompt: spawns its CLI in a new pane, types the ' +
    'prompt, waits for the response to finish, and returns the output tail. ' +
    'The pane stays open for follow-ups.',
  inputSchema: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'Agent id or agentName' },
      prompt: { type: 'string' },
      cwd: { type: 'string' },
      timeoutMs: { type: 'number', description: 'Default 300000' },
    },
    required: ['agent', 'prompt'],
  },
  handler: async (args, ctx) => {
    const found = findAgent(requireStr(args, 'agent'));
    if (!found) throw new Error('agent not found');
    const { agent } = found;
    const { paneId, sessionId } = await spawnPaneAndMaybePrompt({
      adapterId: agent.cli,
      model: agent.model,
      cwd: str(args, 'cwd'),
      title: agent.agentName,
      missionId: ctx.missionId,
      agentName: agent.agentName,
      allowedTools: agent.allowedTools ?? null,
      allowedSkills: agent.allowedSkills ?? null,
      role: 'worker',
      prompt: requireStr(args, 'prompt'),
    });
    const state = await waitForIdle(
      sessionId,
      num(args, 'timeoutMs') ?? 300_000,
    );
    return {
      paneId,
      sessionId,
      state,
      output: readSessionOutput(sessionId, 120),
    };
  },
};

const missionCreateTool: McpToolDef = {
  name: 'nexus_mission_create',
  description:
    'Create a mission (a tracked unit of orchestrated work). The calling ' +
    'session becomes the orchestrator and receives worker handoffs when idle.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      squadId: { type: 'string' },
      milestones: { type: 'array', items: { type: 'string' } },
    },
    required: ['title'],
  },
  handler: async (args, ctx) => {
    const mission = createMission({
      title: requireStr(args, 'title'),
      description: str(args, 'description'),
      squadId: str(args, 'squadId'),
      milestones: strArray(args, 'milestones'),
      orchestratorSessionId: ctx.sessionId,
    });
    ctx.missionId = mission.id;
    return mission;
  },
};

const missionGetTool: McpToolDef = {
  name: 'nexus_mission_get',
  description: 'Get a mission by id.',
  inputSchema: {
    type: 'object',
    properties: { missionId: { type: 'string' } },
    required: ['missionId'],
  },
  handler: async (args) => {
    const mission = getMission(requireStr(args, 'missionId'));
    if (!mission) throw new Error('mission not found');
    return mission;
  },
};

const missionListTool: McpToolDef = {
  name: 'nexus_mission_list',
  description: 'List missions, optionally filtered by status.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'running', 'blocked', 'done', 'failed'],
      },
    },
  },
  handler: async (args) => {
    const status = str(args, 'status');
    return listMissions(status ? missionStatusSchema.parse(status) : undefined);
  },
};

const missionSetStatusTool: McpToolDef = {
  name: 'nexus_mission_set_status',
  description:
    'Update a mission status (pending|running|blocked|done|failed).',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: { type: 'string' },
      status: {
        type: 'string',
        enum: ['pending', 'running', 'blocked', 'done', 'failed'],
      },
    },
    required: ['missionId', 'status'],
  },
  handler: async (args) => {
    const mission = setMissionStatus(
      requireStr(args, 'missionId'),
      missionStatusSchema.parse(args.status),
    );
    if (!mission) throw new Error('mission not found');
    return mission;
  },
};

const missionSpawnPaneTool: McpToolDef = {
  name: 'nexus_mission_spawn_pane',
  description:
    'Spawn a pane bound to a mission (worker pane). Same options as ' +
    'nexus_pane_spawn plus the required missionId.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: { type: 'string' },
      adapterId: { type: 'string' },
      agentName: { type: 'string' },
      model: { type: 'string' },
      cwd: { type: 'string' },
      prompt: { type: 'string' },
    },
    required: ['missionId'],
  },
  handler: async (args, ctx) => {
    const missionId = requireStr(args, 'missionId');
    if (!getMission(missionId)) throw new Error('mission not found');
    return paneSpawnTool.handler({ ...args, missionId }, ctx);
  },
};

const squadSaveTool: McpToolDef = {
  name: 'nexus_squad_save',
  description:
    'Save a squad definition (Overclock-compatible schema: {id, name, ' +
    'createdAt, builtin, orchestratorInstructions, agents[]}).',
  inputSchema: {
    type: 'object',
    properties: { squad: { type: 'object' } },
    required: ['squad'],
  },
  handler: async (args) => {
    const squad = saveSquad(args.squad);
    return { ok: true, squadId: squad.id };
  },
};

const catalogInstallTool: McpToolDef = {
  name: 'nexus_catalog_install',
  description:
    'Search the aitmpl.com community catalog (70+ agents/skills/commands) ' +
    'and install an item into ~/.nexus/plugins/catalog. Pass query to ' +
    'search; pass item (exact name from a previous search) to install.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      kind: { type: 'string', enum: ['agent', 'skill', 'command'] },
      limit: { type: 'number' },
      item: { type: 'string', description: 'Exact item name to install' },
    },
  },
  handler: async (args) =>
    catalogInstall({
      query: str(args, 'query'),
      kind: str(args, 'kind') as 'agent' | 'skill' | 'command' | undefined,
      limit: num(args, 'limit'),
      item: str(args, 'item'),
    }),
};

const taskTool: McpToolDef = {
  name: 'nexus_task',
  description:
    'Tracked background work items. action "create" {title, detail?, ' +
    'missionId?}, "update" {taskId, status?, detail?}, "list" {missionId?}.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'list'] },
      title: { type: 'string' },
      detail: { type: 'string' },
      taskId: { type: 'string' },
      missionId: { type: 'string' },
      status: {
        type: 'string',
        enum: ['pending', 'running', 'done', 'failed'],
      },
    },
    required: ['action'],
  },
  handler: async (args, ctx) => {
    switch (args.action) {
      case 'create':
        return createTask({
          title: requireStr(args, 'title'),
          detail: str(args, 'detail'),
          missionId: str(args, 'missionId') ?? ctx.missionId,
        });
      case 'update': {
        const updated = updateTask(requireStr(args, 'taskId'), {
          status: str(args, 'status') as
            | 'pending'
            | 'running'
            | 'done'
            | 'failed'
            | undefined,
          detail: str(args, 'detail'),
          title: str(args, 'title'),
        });
        if (!updated) throw new Error('task not found');
        return updated;
      }
      case 'list':
        return listTasks(str(args, 'missionId') ?? ctx.missionId);
      default:
        throw new Error(`unknown action: ${String(args.action)}`);
    }
  },
};

const todoManagerTool: McpToolDef = {
  name: 'nexus_todo_manager',
  description:
    'User-visible task list with milestones. Actions: set_tasks {tasks[]}, ' +
    'move_to_task {task}, add_task {task}, read_list, mark_all_done. The ' +
    'list renders live in the workspace UI.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'set_tasks',
          'move_to_task',
          'add_task',
          'read_list',
          'mark_all_done',
        ],
      },
      tasks: { type: 'array', items: { type: 'string' } },
      task: { type: 'string', description: 'Task id or name' },
      listId: { type: 'string' },
    },
    required: ['action'],
  },
  handler: async (args, ctx) => {
    const listId = str(args, 'listId') ?? ctx.missionId ?? DEFAULT_TODO_LIST;
    switch (args.action) {
      case 'set_tasks': {
        const tasks = strArray(args, 'tasks');
        if (tasks.length === 0) throw new Error('set_tasks requires tasks[]');
        return setTasks(tasks, listId);
      }
      case 'move_to_task': {
        const moved = moveToTask(requireStr(args, 'task'), listId);
        if (!moved) throw new Error('task not found in list');
        return moved;
      }
      case 'add_task':
        return todoAddTask(requireStr(args, 'task'), listId);
      case 'read_list':
        return getTodoList(listId);
      case 'mark_all_done':
        return markAllDone(listId);
      default:
        throw new Error(`unknown action: ${String(args.action)}`);
    }
  },
};

export function buildDomainTools(): McpToolDef[] {
  return [
    handoffSubmitTool,
    handoffListTool,
    agentInvokeTool,
    agentListTool,
    agentGetTool,
    missionCreateTool,
    missionGetTool,
    missionListTool,
    missionSetStatusTool,
    missionSpawnPaneTool,
    squadSaveTool,
    catalogInstallTool,
    taskTool,
    todoManagerTool,
  ];
}
