import { assertOrchestratorMission } from './gate';
import type { McpToolDef } from './mcp-protocol';
import { findPane, readSessionOutput, waitForIdle } from './pane-registry';
import { listProviderSettings } from '../persistence/provider-config-store';
import { routeTask, type TaskTier } from './task-router';
import { recordRouteDecision } from './route-provenance';
import { recordRouteLog, recentRouteLog } from './route-log';
import { missionStatusSchema } from '../../shared/orch-types';
import { buildClarify } from '../../shared/clarify';
import { findAgent, listAgents, saveSquad } from './squad-store';
import { DEFAULT_TODO_LIST } from './todo-store';
import { getProjectDomainStores } from './project-domain-store-registry';
import { getContextWorkflowService } from '../context/context-workflow-registry';
import { installCatalogItem } from './catalog';
import { saveCatalogOverlay, proposeRecipes } from './catalog-overlay';
import { writeAgentSpec } from './agent-spec-writer';
import {
  addCronJob,
  deleteCronJob,
  listCronJobs,
  syncCronJobsForScope,
  updateCronJob,
} from './cron-runtime';
import {
  childMissionId,
  paneSpawnTool,
} from './tools-panes';
import { buildBrowserTools } from './tools-browser';
import { runRemoteBridgeToolAction } from './remote-bridge-tool';
import {
  createRemoteTmuxSession,
  detectRemoteClis,
  listRemoteTmuxSessions,
} from '../remote/remote-spawn';
import {
  num,
  requireStr,
  str,
  strArray,
} from './tool-util';
import { buildHandoffTools } from './tools-handoff';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { canCompleteConsultLane } from '../../shared/mission-intent';
import { emitPlannedTasksWithContract } from './mission-scheduler';
import { encodeTaskScheduleDetail } from './mission-scheduler-meta';

/**
 * MCP tools for handoffs (2), agents (3), missions (5), squad/catalog/task
 * (3) and todos (1) — orchestration tool groups 2-6.
 */

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
      taskId: { type: 'string' },
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
    if (ctx.role === 'worker' && role === 'orchestrator') {
      throw new Error('not authorized: workers cannot invoke orchestrators');
    }
    const spawned = (await paneSpawnTool.handler({
      adapterId: agent.cli,
      model: agent.model,
      cwd: str(args, 'cwd'),
      title: agent.agentName,
      missionId: childMissionId(ctx),
      taskId: str(args, 'taskId'),
      agentName: agent.agentName,
      prompt: requireStr(args, 'prompt'),
    }, ctx)) as { paneId: string; sessionId: string };
    const { paneId, sessionId } = spawned;
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
    if (ctx.role !== 'user') {
      throw new Error(
        'not authorized: only a user-owned session may create a mission',
      );
    }
    const stores = getProjectDomainStores(ctx.scope);
    const mission = stores.missions.create({
      title: requireStr(args, 'title'),
      description: str(args, 'description'),
      squadId: str(args, 'squadId'),
      milestones: strArray(args, 'milestones'),
      orchestratorSessionId: ctx.sessionId,
    });
    ctx.missionId = mission.id;
    ctx.role = 'orchestrator';
    // The creator's own pane is part of the mission composition too, so a
    // history reopen restores the orchestrator alongside the workers.
    const orchPane = ctx.sessionId ? findPane(ctx.sessionId) : null;
    if (orchPane?.adapterId) {
      stores.missionPanes.record({
        missionId: mission.id,
        adapterId: orchPane.adapterId,
        model: orchPane.model,
        title: orchPane.title,
        role: 'orchestrator',
        paneId: orchPane.paneId,
        allowedTools: ctx.allowedTools,
        allowedSkills: ctx.allowedSkills,
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
  handler: async (args, ctx) => {
    const mission = getProjectDomainStores(ctx.scope).missions.get(
      requireStr(args, 'missionId'),
    );
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
  handler: async (args, ctx) => {
    const status = str(args, 'status');
    return getProjectDomainStores(ctx.scope).missions.list(
      status ? missionStatusSchema.parse(status) : undefined,
    );
  },
};

const missionSetStatusTool: McpToolDef = {
  name: 'nexus_mission_set_status',
  description:
    'Update a mission status (pending|running|blocked|done|failed). ' +
    'done is ONLY for full PREVC completion with immutable step receipts — never a shortcut. ' +
    'Use blocked when the environment is not ready or PREVC never started (work may still ' +
    'have been delivered outside the pipeline). Use failed when execution started and ended in error. ' +
    'Optional note: required for durable blocked/failed justification; for lane=consult done, ' +
    'note (or existing learnings) must be ≥40 chars (consult is not code PREVC green).',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: { type: 'string' },
      status: {
        type: 'string',
        enum: ['pending', 'running', 'blocked', 'done', 'failed'],
      },
      note: {
        type: 'string',
        description:
          'Justification or consult learning note. Appended to mission learnings when provided.',
      },
    },
    required: ['missionId', 'status'],
  },
  handler: async (args, ctx) => {
    const missionId = requireStr(args, 'missionId');
    const status = missionStatusSchema.parse(args.status);
    const note = str(args, 'note')?.trim() ?? '';
    assertOrchestratorMission(ctx, missionId);
    const stores = getProjectDomainStores(ctx.scope);
    const current = stores.missions.get(missionId);
    if (!current) throw new Error('mission not found');
    if (current.status === 'done' && status !== 'done') {
      throw new Error('completed mission status is immutable');
    }
    if (status === 'blocked' || status === 'failed') {
      if (note.length < 8 && current.learnings.trim().length < 8) {
        throw new Error(
          `status=${status} requires a note (or existing learnings) explaining the cause — ` +
            'this is a fail-safe demotion, not a silent close',
        );
      }
    }
    if (status === 'done') {
      const workflow = getContextWorkflowService(ctx.scope);
      if (!workflow.isMissionDriverComplete(
        missionId,
        current.milestones.map((milestone) => milestone.id),
      )) {
        const lane = current.intentContract?.lane ?? 'standard';
        if (
          lane === 'consult' &&
          canCompleteConsultLane({ learnings: current.learnings, note })
        ) {
          // Consult lane: allow done when a durable learning note exists —
          // not a code-change PREVC green. Standard missions still hard-require PREVC.
        } else if (lane === 'consult') {
          throw new Error(
            'consult-lane done requires a durable learning note (≥40 chars) via note=… ' +
              'or existing learnings. This is not a code PREVC completion.',
          );
        } else {
          throw new Error(
            'mission done requires complete PREVC workflow and immutable step receipts. ' +
              'If PREVC never started or the environment is not ready, use status=blocked ' +
              '(not done). If execution started and failed, use status=failed. ' +
              'blocked/failed are fail-safe demotions, not a green completion.',
          );
        }
      }
    }
    if (note.length > 0) {
      const heading =
        status === 'blocked'
          ? '## Encerrada como bloqueada'
          : status === 'failed'
            ? '## Falha'
            : status === 'done'
              ? '## Consulta / conclusão'
              : '## Nota de status';
      stores.missions.appendLearning(missionId, `${heading}\n${note}`);
    }
    const mission = stores.missions.setStatus(missionId, status);
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
    if (!getProjectDomainStores(ctx.scope).missions.get(missionId)) {
      throw new Error('mission not found');
    }
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

const catalogOverlayTool: McpToolDef = {
  name: 'nexus_catalog_overlay',
  description:
    'Persist workspace catalog overlay fields: stacks, disabled refs, tombstones ' +
    'and category overrides. Use this when recipe lint needs local context.',
  inputSchema: {
    type: 'object',
    properties: {
      workspacePath: { type: 'string' },
      stacks: { type: 'array', items: { type: 'string' } },
      disabled: { type: 'array', items: { type: 'string' } },
      tombstones: { type: 'array', items: { type: 'string' } },
      categories: { type: 'object' },
    },
  },
  handler: async (args) =>
    saveCatalogOverlay({
      workspacePath: str(args, 'workspacePath'),
      stacks: Array.isArray(args.stacks) ? strArray(args, 'stacks') : undefined,
      disabled: Array.isArray(args.disabled) ? strArray(args, 'disabled') : undefined,
      tombstones: Array.isArray(args.tombstones) ? strArray(args, 'tombstones') : undefined,
      categories:
        args.categories && typeof args.categories === 'object'
          ? (args.categories as Record<string, string>)
          : undefined,
    }),
};

const recipeProposeTool: McpToolDef = {
  name: 'nexus_recipe_propose',
  description:
    'Synthesize candidate squad recipes for this workspace from detected stacks ' +
    'and catalog overlay. Returns recipes with explicit gaps.',
  inputSchema: {
    type: 'object',
    properties: { workspacePath: { type: 'string' } },
  },
  handler: async (args) => proposeRecipes(str(args, 'workspacePath')),
};

const agentSpecWriteTool: McpToolDef = {
  name: 'nexus_agent_spec_write',
  description:
    'Create or update a Claude agent spec frontmatter file in ~/.claude/agents. ' +
    'Edits tools, skills, model, effort, category and systemPrompt.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      tools: { type: 'array', items: { type: 'string' } },
      skills: { type: 'array', items: { type: 'string' } },
      model: { type: 'string' },
      effort: { type: 'string' },
      category: { type: 'string' },
      systemPrompt: { type: 'string' },
    },
    required: ['name'],
  },
  handler: async (args) =>
    writeAgentSpec({
      name: requireStr(args, 'name'),
      tools: Array.isArray(args.tools) ? strArray(args, 'tools') : undefined,
      skills: Array.isArray(args.skills) ? strArray(args, 'skills') : undefined,
      model: str(args, 'model'),
      effort: str(args, 'effort'),
      category: str(args, 'category'),
      systemPrompt: str(args, 'systemPrompt'),
    }),
};

const remoteBridgeTool: McpToolDef = {
  name: 'nexus_remote_bridge_status',
  description:
    'Manage the Nexus Remote Bridge WSS server. action=status|start|stop|rotate_pairing.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'start', 'stop', 'rotate_pairing'],
      },
      port: { type: 'number' },
    },
  },
  handler: async (args, ctx) =>
    runRemoteBridgeToolAction(
      str(args, 'action') ?? 'status',
      num(args, 'port'),
      ctx.scope,
    ),
};

const remoteCliDetectTool: McpToolDef = {
  name: 'nexus_remote_cli_detect',
  description: 'SSH into target and detect supported remote CLIs.',
  inputSchema: {
    type: 'object',
    properties: { target: { type: 'string' } },
    required: ['target'],
  },
  handler: async (args) => detectRemoteClis(requireStr(args, 'target')),
};

const remoteTmuxListTool: McpToolDef = {
  name: 'nexus_remote_tmux_list',
  description: 'List tmux sessions on a remote SSH target for adoption/recovery.',
  inputSchema: {
    type: 'object',
    properties: { target: { type: 'string' } },
    required: ['target'],
  },
  handler: async (args) => listRemoteTmuxSessions(requireStr(args, 'target')),
};

const remoteSpawnTool: McpToolDef = {
  name: 'nexus_remote_spawn',
  description:
    'Create/adopt a remote tmux session running a supported AI CLI over SSH. ' +
    'Returns the local attach command for a Nexus shell pane.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string' },
      cwd: { type: 'string' },
      cli: {
        type: 'string',
        enum: ['claude', 'codex', 'agy', 'kimi'],
      },
      sessionName: { type: 'string' },
      prompt: { type: 'string' },
    },
    required: ['target', 'cli'],
  },
  handler: async (args) =>
    createRemoteTmuxSession({
      target: requireStr(args, 'target'),
      cwd: str(args, 'cwd'),
      cli: requireStr(args, 'cli') as 'claude' | 'codex' | 'agy' | 'kimi',
      sessionName: str(args, 'sessionName'),
      prompt: str(args, 'prompt'),
    }),
};

const taskTool: McpToolDef = {
  name: 'nexus_task',
  description:
    'Tracked background work items. action "create" {title, detail?, ' +
    'missionId?, ownership?, dependsOn?}, "update" {taskId, status?, detail?}, ' +
    '"list" {missionId?}, "plan" {missionId, tasks[]} emits ownership+dependsOn ' +
    'contract (sequential chain when ownership unknown).',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'update', 'list', 'plan'],
      },
      title: { type: 'string' },
      detail: { type: 'string' },
      taskId: { type: 'string' },
      missionId: { type: 'string' },
      status: {
        type: 'string',
        enum: ['pending', 'running', 'done', 'failed'],
      },
      ownership: { type: 'object' },
      dependsOn: { type: 'array', items: { type: 'string' } },
      tasks: { type: 'array', items: { type: 'object' } },
    },
    required: ['action'],
  },
  handler: async (args, ctx) => {
    const tasks = getProjectDomainStores(ctx.scope).tasks;
    switch (args.action) {
      case 'create': {
        const missionId = str(args, 'missionId') ?? ctx.missionId;
        if (missionId) {
          if (ctx.role === 'worker') throw new Error('only an orchestrator can define the mission plan');
          if (requireWorktreeRuntimeRegistry().listMission(ctx.scope, missionId).length > 0) {
            throw new Error('mission task plan is sealed after the first worktree allocation');
          }
        }
        const body = str(args, 'detail') ?? '';
        const rawOwnership = args.ownership;
        const rawDepends = args.dependsOn;
        let detail = body;
        if (
          (rawOwnership && typeof rawOwnership === 'object') ||
          (Array.isArray(rawDepends) && rawDepends.length > 0)
        ) {
          const ownershipObj =
            rawOwnership && typeof rawOwnership === 'object'
              ? (rawOwnership as {
                  files?: unknown;
                  symbols?: unknown;
                  domains?: unknown;
                })
              : {};
          const files = Array.isArray(ownershipObj.files)
            ? ownershipObj.files.filter((f): f is string => typeof f === 'string')
            : [];
          const symbols = Array.isArray(ownershipObj.symbols)
            ? ownershipObj.symbols.filter(
                (s): s is string => typeof s === 'string',
              )
            : [];
          const domains = Array.isArray(ownershipObj.domains)
            ? ownershipObj.domains.filter(
                (d): d is string => typeof d === 'string',
              )
            : [];
          const dependsOn = Array.isArray(rawDepends)
            ? rawDepends.filter((d): d is string => typeof d === 'string')
            : [];
          const planned = emitPlannedTasksWithContract([
            {
              id: 'pending',
              title: requireStr(args, 'title'),
              detail: body,
              ownership:
                files.length > 0
                  ? { files, symbols, domains }
                  : undefined,
              dependsOn,
            },
          ])[0]!;
          detail = encodeTaskScheduleDetail(body, {
            dependsOn: planned.dependsOn,
            ownership: planned.ownership,
            merged: false,
            parallelEligible: planned.parallelEligible,
          });
        }
        return tasks.create({
          title: requireStr(args, 'title'),
          detail,
          missionId,
        });
      }
      case 'plan': {
        if (ctx.role === 'worker') {
          throw new Error('only an orchestrator can plan mission tasks');
        }
        const missionId = str(args, 'missionId') ?? ctx.missionId;
        if (!missionId) throw new Error('missionId is required for plan');
        if (requireWorktreeRuntimeRegistry().listMission(ctx.scope, missionId).length > 0) {
          throw new Error('mission task plan is sealed after the first worktree allocation');
        }
        const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
        if (rawTasks.length === 0) throw new Error('tasks[] is required for plan');
        if (rawTasks.length > 64) throw new Error('at most 64 tasks per plan');
        const inputs = rawTasks.map((raw, index) => {
          if (!raw || typeof raw !== 'object') {
            throw new Error(`invalid task at index ${index}`);
          }
          const row = raw as {
            id?: unknown;
            title?: unknown;
            detail?: unknown;
            ownership?: {
              files?: unknown;
              symbols?: unknown;
              domains?: unknown;
            };
            dependsOn?: unknown;
          };
          const id =
            typeof row.id === 'string' && row.id.trim().length > 0
              ? row.id.trim()
              : `task-${index + 1}`;
          const title =
            typeof row.title === 'string' && row.title.trim().length > 0
              ? row.title.trim()
              : id;
          const ownershipFiles = Array.isArray(row.ownership?.files)
            ? row.ownership!.files!.filter(
                (f): f is string => typeof f === 'string',
              )
            : [];
          const ownership =
            ownershipFiles.length > 0
              ? {
                  files: ownershipFiles,
                  symbols: Array.isArray(row.ownership?.symbols)
                    ? row.ownership!.symbols!.filter(
                        (s): s is string => typeof s === 'string',
                      )
                    : [],
                  domains: Array.isArray(row.ownership?.domains)
                    ? row.ownership!.domains!.filter(
                        (d): d is string => typeof d === 'string',
                      )
                    : [],
                }
              : undefined;
          const dependsOn = Array.isArray(row.dependsOn)
            ? row.dependsOn.filter((d): d is string => typeof d === 'string')
            : undefined;
          return {
            id,
            title,
            detail: typeof row.detail === 'string' ? row.detail : '',
            ownership,
            dependsOn,
          };
        });
        const planned = emitPlannedTasksWithContract(inputs);
        // Create first so store ids exist, then remap dependsOn planner ids → store ids.
        const createdDraft = planned.map((p) =>
          tasks.create({
            title: p.title,
            missionId,
            detail: p.detail,
          }),
        );
        const idMap = new Map(
          planned.map((p, i) => [p.id, createdDraft[i]!.id] as const),
        );
        const created = planned.map((p, i) => {
          const storeId = createdDraft[i]!.id;
          const dependsOn = p.dependsOn
            .map((dep) => idMap.get(dep) ?? dep)
            .filter((dep) => dep !== storeId);
          const detail = encodeTaskScheduleDetail(p.detail, {
            dependsOn,
            ownership: p.ownership,
            merged: false,
            parallelEligible: p.parallelEligible,
          });
          return (
            tasks.update(storeId, { detail }) ?? {
              ...createdDraft[i]!,
              detail,
            }
          );
        });
        return Object.freeze({
          missionId,
          tasks: created,
          planned: planned.map((p, i) =>
            Object.freeze({
              plannerId: p.id,
              taskId: created[i]!.id,
              dependsOn: p.dependsOn
                .map((dep) => idMap.get(dep) ?? dep)
                .filter((dep) => dep !== created[i]!.id),
              ownership: p.ownership,
              parallelEligible: p.parallelEligible,
            }),
          ),
        });
      }
      case 'update': {
        const updated = tasks.update(requireStr(args, 'taskId'), {
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
        return tasks.list(str(args, 'missionId') ?? ctx.missionId);
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
    const todos = getProjectDomainStores(ctx.scope).todos;
    switch (args.action) {
      case 'set_tasks': {
        const tasks = strArray(args, 'tasks');
        if (tasks.length === 0) throw new Error('set_tasks requires tasks[]');
        return todos.setTasks(tasks, listId);
      }
      case 'move_to_task': {
        const moved = todos.moveToTask(requireStr(args, 'task'), listId);
        if (!moved) throw new Error('task not found in list');
        return moved;
      }
      case 'add_task':
        return todos.addTask(requireStr(args, 'task'), listId);
      case 'read_list':
        return todos.get(listId);
      case 'mark_all_done':
        return todos.markAllDone(listId);
      default:
        throw new Error(`unknown action: ${String(args.action)}`);
    }
  },
};

const TIERS: TaskTier[] = ['trivial', 'easy', 'medium', 'hard', 'critical'];

const clarifyTool: McpToolDef = {
  name: 'nexus_clarify',
  description:
    'Ask the user ONE clarifying question with 2-6 suggestion chips instead ' +
    'of a vague free-text prompt. Returns {question, chips:[{id,label}], ' +
    'allowFreeform} — present the chips to the user; when they reply, route ' +
    'their answer with the chip id/label/number. Use before spawning work ' +
    'when a decision is genuinely ambiguous — not for confirmations.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The single question to ask' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: '2-6 suggested answers, shown as clickable chips',
      },
      allowFreeform: {
        type: 'boolean',
        description: 'Whether a typed answer outside the chips is accepted (default true)',
      },
    },
    required: ['question', 'options'],
  },
  handler: async (args) => {
    const question = requireStr(args, 'question');
    const options = strArray(args, 'options');
    const allowFreeformRaw = args.allowFreeform;
    return buildClarify({
      question,
      options,
      allowFreeform:
        typeof allowFreeformRaw === 'boolean' ? allowFreeformRaw : undefined,
    });
  },
};

const routeLogTool: McpToolDef = {
  name: 'nexus_route_log',
  description:
    'Inspect the recent nexus_route_task decisions with their reason — so ' +
    'the adapter/model choice is auditable instead of invisible. Returns the ' +
    'most-recent-first list of {seq, tier, adapterId, model, effort, reason, ' +
    'taskPreview}. Read-only; useful to explain why a provider was (not) used.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Max entries to return (default 20)',
      },
    },
  },
  handler: async (args) => {
    const limitRaw = args.limit;
    const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(50, Math.floor(limitRaw)))
      : 20;
    return { decisions: recentRouteLog(limit) };
  },
};

const routeTaskTool: McpToolDef = {
  name: 'nexus_route_task',
  description:
    'Decide the best cost/capability route for a task before spawning it. ' +
    'The decision is resolved against the current installed provider and model ' +
    'catalog, never against model names remembered by the orchestrator. Classifies the task ' +
    '(trivial|easy|medium|hard|critical) and returns {tier, adapterId, ' +
    'model, effort, reason, alternatives}: pass adapterId/model/effort ' +
    'straight into nexus_pane_spawn. Call it for every delegation and trust the ' +
    'returned runtime snapshot so removed, deprecated or unavailable models are never forced by a stale playbook.',
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
    const adapters = listProviderSettings()
      // 'shell' não é um provider roteável (sem modelos avaliados); incluí-lo
      // mantinha o gate de cobertura do task-router sempre falso, matando a
      // avaliação por dimensão. Alinha com o filtro id!=='shell' do architect.
      .filter((a) => a.adapterId !== 'shell')
      .map((a) => ({
        id: a.adapterId,
        installed:
          !excluded.has(a.adapterId) &&
          a.enabled &&
          a.installed &&
          a.authStrategy !== 'login-needed',
        models: a.models,
      }));
    // reserveClaude=true: workers nunca no binário claude OAuth — evita
    // corromper o keychain compartilhado com o orquestrador.
    const decision = routeTask(task, adapters, undefined, tier, true);
    if (!decision) throw new Error('no installed adapters to route to');
    // Proveniência: o spawn ad-hoc de modelos com warning de catálogo exige
    // uma decisão recente do router (ver adHocSpawnGateError em tools-panes).
    recordRouteDecision({ adapterId: decision.adapterId, model: decision.model });
    // Observabilidade ("ver para crer"): registra a decisão + motivo para
    // inspeção, já que o reason antes só existia no retorno consumido pelo LLM.
    recordRouteLog({
      task,
      tier: decision.tier,
      adapterId: decision.adapterId,
      model: decision.model,
      effort: decision.effort,
      reason: decision.reason,
    });
    return decision;
  },
};

const cronTool: McpToolDef = {
  name: 'nexus_cron',
  description:
    'Agendar squads/agentes: action "create" {name, schedule (cron 5 campos ' +
    '"min hora dom mês dow"), brief, workspacePath?, agentName? XOR squadId?, ' +
    'executionMode?: "shared" | "local"}. Shared é o padrão e exige lease ' +
    'remoto; local só existe quando solicitado explicitamente. ' +
    '"list", "update" {id, campos}, "delete" {id}. Shared usa definição ' +
    'portátil versionada com conflito CAS explícito. O job dispara o brief no horário; atraso > 5min ' +
    '(laptop fechado) é pulado, sem catch-up em rajada.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'list', 'update', 'delete'] },
      name: { type: 'string' },
      schedule: { type: 'string' },
      brief: { type: 'string' },
      workspacePath: { type: 'string' },
      executionMode: { type: 'string', enum: ['shared', 'local'] },
      agentName: { type: 'string' },
      squadId: { type: 'string' },
      id: { type: 'string' },
      status: { type: 'string', enum: ['active', 'paused'] },
    },
    required: ['action'],
  },
  handler: async (args, ctx) => {
    switch (args.action) {
      case 'create': {
        const agentName = str(args, 'agentName');
        const squadId = str(args, 'squadId');
        if (!agentName && !squadId) {
          throw new Error('informe agentName OU squadId');
        }
        const requestedMode = str(args, 'executionMode');
        if (
          requestedMode !== undefined &&
          requestedMode !== 'shared' &&
          requestedMode !== 'local'
        ) {
          throw new Error('executionMode deve ser "shared" ou "local"');
        }
        return await addCronJob({
          name: requireStr(args, 'name'),
          schedule: requireStr(args, 'schedule'),
          brief: requireStr(args, 'brief'),
          workspacePath: str(args, 'workspacePath'),
          executionMode: requestedMode ?? 'shared',
          agentName,
          squadId,
        }, ctx.scope);
      }
      case 'list':
        await syncCronJobsForScope(ctx.scope);
        return listCronJobs(ctx.scope);
      case 'update': {
        const status = str(args, 'status');
        if (
          status !== undefined &&
          status !== 'active' &&
          status !== 'paused'
        ) {
          throw new Error('status deve ser active ou paused');
        }
        return await updateCronJob(
          requireStr(args, 'id'),
          {
            name: str(args, 'name'),
            schedule: str(args, 'schedule'),
            brief: str(args, 'brief'),
            workspacePath: str(args, 'workspacePath'),
            agentName: str(args, 'agentName'),
            squadId: str(args, 'squadId'),
            status,
          },
          ctx.scope,
        );
      }
      case 'delete':
        return {
          deleted: await deleteCronJob(requireStr(args, 'id'), ctx.scope),
        };
      default:
        throw new Error(`unknown action: ${String(args.action)}`);
    }
  },
};

export function buildDomainTools(): McpToolDef[] {
  return [
    routeTaskTool,
    routeLogTool,
    clarifyTool,
    ...buildHandoffTools(),
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
    catalogOverlayTool,
    recipeProposeTool,
    agentSpecWriteTool,
    taskTool,
    todoManagerTool,
    remoteBridgeTool,
    remoteCliDetectTool,
    remoteTmuxListTool,
    remoteSpawnTool,
    ...buildBrowserTools(),
    cronTool,
  ];
}
