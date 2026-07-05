import { markHandoffSubmitted } from './gate';
import type { McpToolDef } from './mcp-protocol';
import { findPane, readSessionOutput, waitForIdle } from './pane-registry';
import { recordMissionPane } from './mission-pane-store';
import { listAdapterInfos } from '../adapters/adapter-registry';
import { hasKey } from '../persistence/secrets-store';
import { routeTask, type TaskTier } from './task-router';
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
import { installCatalogItem } from './catalog';
import { startPreview, stopPreview, listPreviews } from './preview-server';
import { requestBrowserPane } from './pane-registry';
import { loadBrowser } from '../browser/browser-manager';
import { collectPerfSnapshot } from '../perf/perf-ipc';
import { onHandoffSubmitted } from './idle-delivery';
import { paneSpawnTool } from './tools-panes';
import {
  authorizePaneRef,
  num,
  requireStr,
  spawnPaneAndMaybePrompt,
  str,
  strArray,
} from './tool-util';

/**
 * MCP tools for handoffs (2), agents (3), missions (5), squad/catalog/task
 * (3) and todos (1) — orchestration tool groups 2-6.
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
    const summary = requireStr(args, 'summary').trim();
    // Workers ocasionalmente colam o TEMPLATE do contrato como resumo
    // ("<resumo objetivo do que fez>") — rejeitar força uma reentrega real.
    if (summary.length < 20 || /^<.*>$/.test(summary)) {
      throw new Error(
        'summary inválido: descreva de verdade o que foi feito (mínimo 20 ' +
          'caracteres, sem placeholders como "<resumo...>").',
      );
    }
    const handoff = submitHandoff({
      status: handoffStatusSchema.parse(args.status),
      summary,
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
    const role = agent.category === 'orchestrator' ? 'orchestrator' : 'worker';
    const { paneId, sessionId } = await spawnPaneAndMaybePrompt({
      adapterId: agent.cli,
      model: agent.model,
      cwd: str(args, 'cwd'),
      title: agent.agentName,
      missionId: ctx.missionId,
      agentName: agent.agentName,
      allowedTools: agent.allowedTools ?? (role === 'orchestrator' ? null : []),
      allowedSkills: agent.allowedSkills ?? null,
      role,
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
    // The creator's own pane is part of the mission composition too, so a
    // history reopen restores the orchestrator alongside the workers.
    const orchPane = ctx.sessionId ? findPane(ctx.sessionId) : null;
    if (orchPane?.adapterId) {
      recordMissionPane({
        missionId: mission.id,
        adapterId: orchPane.adapterId,
        model: orchPane.model,
        title: orchPane.title,
        role: 'orchestrator',
      });
    }
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
    'Save a squad definition (JSON schema: {id, name, ' +
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

// Schema for the catalog-install tool.
const catalogInstallTool: McpToolDef = {
  name: 'nexus_catalog_install',
  description:
    'Install an agent or skill from the aitmpl catalog ' +
    '(davila7/claude-code-templates) into ~/.claude. Skips silently when ' +
    'the target already exists. After install the component appears in the ' +
    'settings catalog immediately.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['agent', 'skill'],
        description:
          'Whether to install an agent (.md → ~/.claude/agents/) or a ' +
          'skill (dir → ~/.claude/skills/).',
      },
      slug: {
        type: 'string',
        description:
          'Catalog slug, e.g. "deep-research-team" or ' +
          '"ai-research/ai-agents-architect".',
      },
      source: {
        type: 'string',
        enum: ['aitmpl'],
        description: 'Source catalog. Currently only "aitmpl".',
      },
      targetCli: {
        type: 'string',
        enum: ['claude'],
        description: 'Target CLI namespace. Currently only "claude".',
      },
    },
    required: ['kind', 'slug'],
  },
  handler: async (args) => {
    const kind = str(args, 'kind');
    if (kind !== 'agent' && kind !== 'skill') {
      throw new Error('kind must be "agent" or "skill"');
    }
    return installCatalogItem({ kind, slug: requireStr(args, 'slug') });
  },
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

const TIERS: TaskTier[] = ['trivial', 'easy', 'medium', 'hard', 'critical'];

const routeTaskTool: McpToolDef = {
  name: 'nexus_route_task',
  description:
    'Decide the CHEAPEST capable agent for a task BEFORE spawning it — this ' +
    'is how missions save tokens and finish faster. Classifies the task ' +
    '(trivial|easy|medium|hard|critical) and returns {tier, adapterId, ' +
    'model, effort, reason, alternatives}: pass adapterId/model/effort ' +
    'straight into nexus_pane_spawn. Work is spread across ALL installed LLMs: ' +
    'trivial/easy → fast cheap models (grok/kimi/gemini-flash), medium → ' +
    'GLM 5.2/kimi (cheap + strong), hard/critical → opus/fable/gpt-5.5. ' +
    'Call it for EVERY delegation.',
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'What the worker will be asked to do',
      },
      tier: {
        type: 'string',
        enum: TIERS,
        description: 'Optional override when you already know the complexity',
      },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description:
          'adapterIds to skip (rate-limited, not logged in, or just failed)',
      },
    },
    required: ['task'],
  },
  handler: async (args) => {
    const task = requireStr(args, 'task');
    const tierRaw = str(args, 'tier');
    const tier = TIERS.includes(tierRaw as TaskTier)
      ? (tierRaw as TaskTier)
      : undefined;
    // Failover de rate limit: o orquestrador re-roteia excluindo a CLI que
    // acabou de estourar cota/quebrar, em vez de insistir nela.
    const excluded = new Set(strArray(args, 'exclude'));
    const adapters = listAdapterInfos().map((a) => ({
      id: a.id,
      // GLM rides the Claude binary but authenticates with a z.ai token — it is
      // only routable once that key is stored, otherwise the spawn would fail.
      installed:
        !excluded.has(a.id) &&
        (a.id === 'glm' ? a.installed && hasKey('glm') : a.installed),
    }));
    // reserveClaude=true: workers nunca no binário claude OAuth — evita
    // corromper o keychain compartilhado com o orquestrador.
    const decision = routeTask(task, adapters, undefined, tier, true);
    if (!decision) throw new Error('no installed adapters to route to');
    return decision;
  },
};

const previewStartTool: McpToolDef = {
  name: 'nexus_preview_start',
  description:
    'Serve a static directory (a built web app) on a local preview URL ' +
    '(127.0.0.1, random port). Returns { url }. Idempotent per directory. ' +
    'Use after building so the user can click the result.',
  inputSchema: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: 'Absolute path of the directory to serve' },
    },
    required: ['dir'],
  },
  handler: async (args) => {
    const dir = requireStr(args, 'dir');
    if (!dir.startsWith('/')) throw new Error('dir deve ser um caminho absoluto');
    try {
      return await startPreview(dir);
    } catch (err) {
      throw new Error(
        `preview falhou para ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};

const previewStopTool: McpToolDef = {
  name: 'nexus_preview_stop',
  description:
    'Stop a running preview server. Pass the same dir used in ' +
    'nexus_preview_start; omit dir to list what is running.',
  inputSchema: {
    type: 'object',
    properties: { dir: { type: 'string' } },
  },
  handler: async (args) => {
    const dir = str(args, 'dir');
    if (!dir) return { running: listPreviews() };
    return { stopped: stopPreview(dir) };
  },
};

const browserOpenTool: McpToolDef = {
  name: 'nexus_browser_open',
  description:
    'Open an embedded browser pane at a URL. Use with nexus_preview_start URLs ' +
    'for in-app previews.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      title: { type: 'string' },
    },
    required: ['url'],
  },
  handler: async (args, ctx) => {
    if (ctx.role === 'worker') {
      throw new Error('not authorized: workers cannot open browser panes');
    }
    const result = await requestBrowserPane({
      url: requireStr(args, 'url'),
      title: str(args, 'title'),
      missionId: ctx.missionId,
      agentName: ctx.agentName ?? ctx.label,
      ...(ctx.role === 'orchestrator' ? { role: 'orchestrator' as const } : {}),
    });
    if (!result.ok || !result.paneId) {
      throw new Error(result.error ?? 'browser open failed');
    }
    return { ok: true, paneId: result.paneId };
  },
};

const browserNavigateTool: McpToolDef = {
  name: 'nexus_browser_navigate',
  description:
    'Navigate an existing embedded browser pane to a new URL. The paneId must ' +
    'come from nexus_browser_open or nexus_pane_list.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      url: { type: 'string' },
    },
    required: ['paneId', 'url'],
  },
  handler: async (args, ctx) => {
    const paneId = requireStr(args, 'paneId');
    authorizePaneRef(ctx, paneId, 'write');
    return loadBrowser(paneId, requireStr(args, 'url'));
  },
};

const perfSnapshotTool: McpToolDef = {
  name: 'nexus_perf_snapshot',
  description:
    'Return a performance snapshot: process memory, Electron app metrics, live ' +
    'PTY session count and browser view count.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => collectPerfSnapshot(),
};

export function buildDomainTools(): McpToolDef[] {
  return [
    routeTaskTool,
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
    previewStartTool,
    previewStopTool,
    browserOpenTool,
    browserNavigateTool,
    perfSnapshotTool,
  ];
}
