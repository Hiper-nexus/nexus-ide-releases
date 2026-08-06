import {
  describeCronReversal,
  type CronChange,
  type CronJobSnapshot,
} from './cron-reversibility';
import { emitPersistentChangeReversalEvent } from './mission-event-emit';
import type { ProjectExecutionScope } from '../../shared/project-identity-types';
import {
  assertCurrentMissionOrchestratorSession,
  assertOrchestratorMission,
} from './gate';
import {
  assertMcpInvocationCurrent,
  type McpToolDef,
  type McpToolInvocation,
} from './mcp-protocol';
import { findPane, readSessionOutput, waitForIdle } from './pane-registry';
import { listProviderSettings } from '../persistence/provider-config-store';
import { routeTask, type RouteDecision, type TaskTier } from './task-router';
import { resolveSealedWorkerRoute } from './mission-scheduler-plan';
import { countAdapterUses } from './route-pipeline';
import { recordRouteDecision } from './route-provenance';
import { recordRouteLog, recentRouteLog } from './route-log';
import { hasAvailableAccount } from '../persistence/account-store';
import { authReadyModelsForProvider } from '../adapters/model-auth-readiness';
import { appendMissionVerdict } from '../../shared/mission-block-cause';
import { missionStatusSchema, type Mission } from '../../shared/orch-types';
import { buildClarify } from '../../shared/clarify';
import { emitClarifyQuestion } from './clarify-flow';
import { findAgent, listAgents, saveSquad } from './squad-store';
import { DEFAULT_TODO_LIST } from './todo-store';
import { getProjectDomainStores } from './project-domain-store-registry';
import { getContextWorkflowService } from '../context/context-workflow-registry';
import { saveCatalogOverlay, proposeRecipes } from './catalog-overlay';
import {
  addCronJob,
  deleteCronJob,
  listCronJobs,
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
import { canCompleteConsultLane, canCompleteOpsLane } from '../../shared/mission-intent';
import { isCurrentProcessRealMissionE2E } from '../../shared/real-mission-e2e';
import { emitPlannedTasksWithContract } from './mission-scheduler';
import { encodeTaskScheduleDetail } from './mission-scheduler-meta';
import { isTaskQueueManagedMission } from './task-dispatch-authority';
import {
  hasLiveMissionWorktreeAllocation,
  planMissionTasks,
} from './mission-task-plan-authority';
import {
  liveSquadRuntimeInventory,
  warmSquadRuntimeSubscriptionAuth,
} from './squad-runtime-inventory';
import { standardTopologyFromSealedTaskDetails } from './guided-mission-topology-authority';

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
      readOnly: {
        type: 'boolean',
        description:
          'Invoke with provider-native read-only enforcement. Required before PREVC execution.',
      },
    },
    required: ['agent', 'prompt'],
  },
  handler: async (args, ctx, invocation) => {
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
      readOnly: args.readOnly === true,
      prompt: requireStr(args, 'prompt'),
    }, ctx, invocation)) as { paneId: string; sessionId: string };
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
        // Sem `title` de propósito: o título do registry é mutável (o próprio
        // CLI o reescreve via OSC escapes) e gravá-lo na chave de dedup do
        // store faz um re-record futuro falhar com "pane id already belongs
        // to another mission pane". O fallback do store (adapterId) é estável.
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

function requireFanoutConsolidationPhysicalReceipt(
  invocation: McpToolInvocation | undefined,
): NonNullable<McpToolInvocation['agentTransportPhysicalReceipt']> {
  const intent = invocation?.effectIntent;
  if (
    !intent ||
    !['http-mcp', 'acp-stdio', 'pty-stream'].includes(intent.source) ||
    intent.toolName !== 'nexus_mission_set_status' ||
    !invocation?.agentTransportPhysicalReceipt
  ) {
    throw new Error(
      'fanout_consolidation_provenance: exact physical Maestro tool-call receipt is required',
    );
  }
  assertMcpInvocationCurrent(invocation);
  return invocation.agentTransportPhysicalReceipt;
}

const missionSetStatusTool: McpToolDef = {
  name: 'nexus_mission_set_status',
  description:
    'Update a mission status (pending|running|blocked|done|failed). ' +
    'done is ONLY for real completion — never a shortcut. With a frozen PREVC contract, ' +
    'done requires the complete workflow and immutable step receipts; without a frozen ' +
    'contract (PREVC degrades, never blocks), a non-orchestrated completion requires a ' +
    'durable note (or existing learnings) ≥40 chars. A standard squad mission may only ' +
    'reach done through main-owned verified completion receipts; prose or a reporter claim ' +
    'is never orchestration completion. ' +
    'Use blocked when the environment is not ready (work may still ' +
    'have been delivered outside the pipeline). Use failed when execution started and ended in error. ' +
    'Optional note: required for durable blocked/failed justification and for done without ' +
    'a frozen PREVC contract (consult/ops are not code PREVC green).',
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
  handler: async (args, ctx, invocation) => {
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
      // Release gate: orchestrator CLI demoting to blocked aborts the proof
      // while advisors/workers are still in the durable scheduler (seen as
      // mission-blocked with panes>0 / handoffs=0). Keep waiting instead.
      if (isCurrentProcessRealMissionE2E()) {
        throw new Error(
          `status=${status} is forbidden in real-mission E2E — ` +
            'wait for the durable scheduler; do not demote the mission',
        );
      }
      if (note.length < 8 && current.learnings.trim().length < 8) {
        throw new Error(
          `status=${status} requires a note (or existing learnings) explaining the cause — ` +
            'this is a fail-safe demotion, not a silent close',
        );
      }
    }
    if (status === 'done') {
      const lane = current.intentContract?.lane ?? 'standard';
      const intentVersion = current.intentContract?.intentVersion;
      if (
        lane === 'standard' &&
        intentVersion !== undefined &&
        stores.tasks?.hasPlan?.(missionId, intentVersion) === true
      ) {
        const planReceipt = stores.tasks.getPlanReceipt(
          missionId,
          intentVersion,
        );
        const topology = standardTopologyFromSealedTaskDetails(
          planReceipt?.tasks.map((task) => task.detail) ?? [],
        );
        if (topology !== 'team-read-only-fanout') {
          if (current.status === 'done') return current;
          throw new Error(
            'task_dispatcher_authority: missão com plano selado ' +
              '(delivery/wave-pack) só conclui pelo motor Nexus após receipts ' +
              'verificados; status=done do Maestro não substitui integração',
          );
        }
        assertCurrentMissionOrchestratorSession(ctx, current);
        const physicalReceipt =
          requireFanoutConsolidationPhysicalReceipt(invocation);
        const recorded = stores.taskDispatches.recordFanoutConsolidation({
          missionId,
          intentVersion,
          orchestratorSessionId: ctx.sessionId!,
          finalOutput: note,
          physicalReceipt,
        });
        if (!recorded) {
          throw new Error(
            'task_dispatcher_authority: a consolidação fanout só é aceita após ' +
              'todos os receipts físicos, ACKs nexus_handoff_ack e a seção ## Maestro',
          );
        }
        stores.taskDispatches.completeMissionFromVerifiedPlan({
          missionId,
          intentVersion,
        });
        const completed = stores.missions.get(missionId);
        if (completed?.status !== 'done') {
          throw new Error(
            'task_dispatcher_authority: consolidação persistida, mas a prova final ' +
              'mudou antes da conclusão; o scheduler retomará de forma idempotente',
          );
        }
        return completed;
      }
      if (current.status === 'done') return current;
      const workflow = getContextWorkflowService(ctx.scope);
      if (!workflow.isMissionDriverComplete(
        missionId,
        current.milestones.map((milestone) => milestone.id),
      )) {
        const hasFrozenContract = Boolean(
          workflow.getMissionWorkflow(missionId).contract,
        );
        const hasDurableNote =
          lane === 'consult'
            ? canCompleteConsultLane({ learnings: current.learnings, note })
            : canCompleteOpsLane({ learnings: current.learnings, note });
        if (!hasFrozenContract) {
          // Sem contrato congelado o PREVC degrada em vez de bloquear: done é
          // aceito em QUALQUER lane com nota durável do que foi entregue —
          // nunca como verde silencioso.
          if (!hasDurableNote) {
            throw new Error(
              'mission done without a frozen PREVC contract requires a durable note (≥40 chars) ' +
                'via note=… or existing learnings describing what was delivered. ' +
                'This is not a code PREVC completion.',
            );
          }
          if (lane === 'standard' && current.squadId) {
            // Reporter metadata is intentionally untrusted: even a `success`
            // handoff plus an idle→busy delivery attempt cannot prove that the
            // exact current worker/incarnation produced and integrated the
            // result. Modern missions close atomically in the task-dispatch
            // authority; PREVC missions close from trusted immutable evidence.
            // A legacy direct status call has neither authority and must fail
            // closed instead of reconstructing a weaker third completion path.
            throw new Error(
              'main-owned verified completion required: orchestrated mission done requires ' +
                'a current worker, a success handoff with trusted/current evidence, and an ' +
                'accepted handoff for the current orchestrator session. Direct status=done ' +
                'cannot prove worker incarnation, integration, or current intent. Use ' +
                'status=blocked with one actionable cause when the verified path is unavailable.',
            );
          }
        } else if (
          lane === 'consult' &&
          hasDurableNote
        ) {
          // Consult lane: allow done when a durable learning note exists —
          // not a code-change PREVC green. Standard missions still hard-require PREVC.
        } else if (lane === 'consult') {
          throw new Error(
            'consult-lane done requires a durable learning note (≥40 chars) via note=… ' +
              'or existing learnings. This is not a code PREVC completion.',
          );
        } else if (
          lane === 'ops' &&
          hasDurableNote
        ) {
          // Ops lane: allow done with a durable note of what was executed —
          // ops completion is not a code-change PREVC green either.
        } else if (lane === 'ops') {
          throw new Error(
            'ops-lane done requires a durable note (≥40 chars) via note=… ' +
              'or existing learnings describing what was executed. ' +
              'This is not a code PREVC completion.',
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
    // Fail-safe demotion used to vanish into learnings only — the rail showed
    // "motivo não registrado". Mirror the agent's own verdict into description
    // so every surface can name the cause (learnings keep the full note).
    if ((status === 'blocked' || status === 'failed') && note.length > 0) {
      const before = stores.missions.get(missionId);
      if (before) {
        stores.missions.update(missionId, {
          description: appendMissionVerdict(
            before.description,
            '<!-- nexus:agent-status-block -->',
            '[NEXUS_AGENT_STATUS_BLOCK]',
            `O orquestrador declarou status=${status}: ${note}`,
          ),
        });
      }
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
      effort: { type: 'string' },
      routeReservationId: { type: 'string' },
      taskId: { type: 'string' },
      cwd: { type: 'string' },
      prompt: { type: 'string' },
      readOnly: {
        type: 'boolean',
        description:
          'Spawn with provider-native read-only enforcement. Required before PREVC execution.',
      },
    },
    required: ['missionId'],
  },
  handler: async (args, ctx, invocation) => {
    const missionId = requireStr(args, 'missionId');
    if (!getProjectDomainStores(ctx.scope).missions.get(missionId)) {
      throw new Error('mission not found');
    }
    return paneSpawnTool.handler({ ...args, missionId }, ctx, invocation);
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
  handler: async (args, ctx) => {
    if (ctx.role !== 'user' || ctx.missionId) {
      throw new Error(
        'squad save is operator-owned: mission agents cannot mutate the persistent squad catalog',
      );
    }
    const squad = saveSquad(args.squad);
    return { ok: true, squadId: squad.id };
  },
};


/**
 * Reversibilidade de agenda (N1): a mudança persistente vira registro visível
 * com o caminho de volta, em vez de um modal que interrompe uma missão já
 * aprovada. Nunca lança — visibilidade não pode derrubar a mutação que já
 * aconteceu; um caminho de volta perdido é ruim, uma agenda meio-aplicada é pior.
 */
function cronSnapshot(job: {
  id: string;
  name: string;
  schedule: string;
  status?: string;
}): CronJobSnapshot {
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    ...(job.status === undefined ? {} : { status: job.status }),
  };
}

function findCronJob(
  scope: ProjectExecutionScope,
  id: string,
): CronJobSnapshot | undefined {
  try {
    const found = listCronJobs(scope).find((job) => job.id === id);
    return found ? cronSnapshot(found) : undefined;
  } catch {
    return undefined;
  }
}

function reportCronReversal(
  ctx: { missionId?: string },
  change: CronChange,
): void {
  if (!ctx.missionId) return;
  try {
    emitPersistentChangeReversalEvent(ctx.missionId, {
      surface: 'cron',
      revertPath: describeCronReversal(change),
    });
  } catch (err) {
    console.warn('[cron] registro de reversibilidade falhou:', err);
  }
}

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
  handler: async () => {
    throw new Error(
      'renderer_exact_confirmation_required: use o Marketplace nativo',
    );
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
      stacks: { type: 'array', items: { type: 'string' } },
      disabled: { type: 'array', items: { type: 'string' } },
      tombstones: { type: 'array', items: { type: 'string' } },
      categories: { type: 'object' },
    },
  },
  handler: async (args, ctx) =>
    saveCatalogOverlay({
      // Renderer/agent input is never a filesystem authority. The MCP gate
      // already bound this call to one immutable ProjectExecutionScope.
      workspacePath: ctx.scope.rootRealPath,
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
    properties: {},
  },
  handler: async (_args, ctx) => proposeRecipes(ctx.scope.rootRealPath),
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
  handler: async () => {
    throw new Error(
      'renderer_exact_confirmation_required: use o editor nativo de agentes',
    );
  },
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
  handler: async (args, ctx, invocation) =>
    runRemoteBridgeToolAction(
      str(args, 'action') ?? 'status',
      num(args, 'port'),
      ctx.scope,
      invocation,
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
  handler: async (args, _ctx, invocation) =>
    detectRemoteClis(requireStr(args, 'target'), invocation),
};

const remoteTmuxListTool: McpToolDef = {
  name: 'nexus_remote_tmux_list',
  description: 'List tmux sessions on a remote SSH target for adoption/recovery.',
  inputSchema: {
    type: 'object',
    properties: { target: { type: 'string' } },
    required: ['target'],
  },
  handler: async (args, _ctx, invocation) =>
    listRemoteTmuxSessions(requireStr(args, 'target'), invocation),
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
  handler: async (args, _ctx, invocation) => {
    const result = await createRemoteTmuxSession(
      {
        target: requireStr(args, 'target'),
        cwd: str(args, 'cwd'),
        cli: requireStr(args, 'cli') as 'claude' | 'codex' | 'agy' | 'kimi',
        sessionName: str(args, 'sessionName'),
        prompt: str(args, 'prompt'),
      },
      {
        signal: invocation?.signal,
        assertCurrentAuthority: invocation?.assertCurrentAuthority,
      },
    );
    if (!result.ok) {
      throw new Error(result.error ?? 'remote tmux spawn failed');
    }
    return result;
  },
};

const taskTool: McpToolDef = {
  name: 'nexus_task',
  description:
    'Tracked background work items. action "create" {title, detail?, ' +
    'missionId?, ownership?, dependsOn?}, "update" {taskId, status?, detail?}, ' +
    '"list" {missionId?}, "plan" {missionId, tasks:[{id,title,detail,' +
    'agentRef,category,executionMode,ownership,dependsOn}]} seals one immutable ' +
    'plan to the current squad roster. isolated_worktree requires owned files; ' +
    'read_only is restricted to scout/reviewer.',
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
    const suite = getProjectDomainStores(ctx.scope);
    const tasks = suite.tasks;
    switch (args.action) {
      case 'create': {
        const missionId = str(args, 'missionId') ?? ctx.missionId;
        if (missionId) {
          if (ctx.role === 'worker') throw new Error('only an orchestrator can define the mission plan');
          const mission = suite.missions.get(missionId);
          if (
            mission?.status === 'running' &&
            mission.intentContract?.lane === 'standard'
          ) {
            throw new Error(
              'task_plan_required: missão standard/running aceita somente UMA chamada nexus_task plan; não crie task avulsa',
            );
          }
          if (isTaskQueueManagedMission(suite, missionId)) {
            throw new Error(
              'task_dispatcher_authority: o plano durável já existe; liste as tasks em vez de criar dispatch manual',
            );
          }
          if (
            hasLiveMissionWorktreeAllocation(
              requireWorktreeRuntimeRegistry().listMission(ctx.scope, missionId),
            )
          ) {
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
      case 'plan':
        return planMissionTasks(args, ctx, suite);
      case 'update': {
        const taskId = requireStr(args, 'taskId');
        const existing = tasks.list().find((task) => task.id === taskId);
        if (tasks.getPlannedTask(taskId)) {
          throw new Error(
            'task_plan_immutable: task selada só pode avançar pelo dispatcher Nexus e pelo handoff do worker',
          );
        }
        if (
          str(args, 'status') !== undefined &&
          existing?.missionId &&
          isTaskQueueManagedMission(suite, existing.missionId)
        ) {
          throw new Error(
            'task_dispatcher_authority: status de task planejada é exclusivo do motor Nexus; envie o handoff',
          );
        }
        const updated = tasks.update(taskId, {
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
      case 'list': {
        const requestedMission = str(args, 'missionId');
        const missionId = ctx.role === 'worker'
          ? ctx.missionId
          : (requestedMission ?? ctx.missionId);
        return tasks.list(missionId);
      }
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
    'of a vague free-text prompt. The Nexus main process persists the question ' +
    'and shows its chips in the mission rail; the scoped operator answer is ' +
    'delivered back as an accepted handoff. Returns {missionId, questionId, ' +
    'question, chips, allowFreeform}. Use before spawning work when a decision ' +
    'is genuinely ambiguous — not for confirmations.',
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
  handler: async (args, ctx) => {
    const question = requireStr(args, 'question');
    const options = strArray(args, 'options');
    const allowFreeformRaw = args.allowFreeform;
    return emitClarifyQuestion(
      ctx,
      buildClarify({
        question,
        options,
        allowFreeform:
          typeof allowFreeformRaw === 'boolean' ? allowFreeformRaw : undefined,
      }),
    );
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

/**
 * Plano selado = autoridade fechada de rota. Com roster aprovado o router não
 * rankeia providers: resolve o membro EXATO do roster para a task planejada
 * (role/agentRef → cli/model/effort do selo) e falha fechado quando a task não
 * consta no plano — nunca recomenda uma CLI fora do roster. Sem plano selado
 * retorna null e o roteamento livre/governado existente segue intacto.
 */
function sealedRosterRouteDecision(input: {
  readonly stores: ReturnType<typeof getProjectDomainStores>;
  readonly mission: Mission;
  readonly task: string;
  readonly tierOverride?: TaskTier;
}): RouteDecision | null {
  const intentVersion =
    input.mission.intentContract?.intentVersion ?? input.mission.intentVersion;
  if (intentVersion === undefined) return null;
  const receipt = input.stores.tasks.getPlanReceipt(
    input.mission.id,
    intentVersion,
  );
  if (!receipt) return null;
  const wanted = input.task.trim();
  const exact = receipt.tasks.filter(
    (entry) => entry.taskId === wanted || entry.title.trim() === wanted,
  );
  const matches =
    exact.length > 0
      ? exact
      : receipt.tasks.filter(
          (entry) =>
            entry.title.trim().toLowerCase() === wanted.toLowerCase(),
        );
  if (matches.length === 0) {
    const planned = receipt.tasks
      .map((entry) => `"${entry.title}"`)
      .join(', ');
    throw new Error(
      'roster_sealed_task_fora_do_plano: a missão tem plano selado e a ' +
        `tarefa "${wanted.slice(0, 120)}" não consta no plano aprovado; ` +
        'route_task não recomenda CLI fora do roster selado. Tarefas do ' +
        `plano: ${planned}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      'roster_sealed_task_ambigua: mais de uma task do plano selado tem o ' +
        `título "${wanted.slice(0, 120)}"; a seleção do roster exige título ` +
        'único — corrija o plano em vez de rotear no chute',
    );
  }
  const entry = matches[0]!;
  const agent = receipt.agents.find(
    (candidate) => candidate.id === entry.agentRef,
  );
  if (!agent) {
    throw new Error(
      `roster_sealed_agent_ausente: o agente ${entry.agentRef} da task ` +
        `"${entry.title}" não consta no roster selado`,
    );
  }
  const liveAdapters = listProviderSettings()
    .filter((provider) => provider.adapterId !== 'shell')
    .map((provider) => {
      const models = [
        ...authReadyModelsForProvider(provider, provider.models),
      ];
      return {
        id: provider.adapterId,
        installed:
          provider.enabled &&
          provider.installed &&
          models.length > 0 &&
          hasAvailableAccount(provider.adapterId),
        models: { list: models, default: provider.defaultModel },
      };
    });
  const sealed = resolveSealedWorkerRoute({
    taskText: input.task,
    agent,
    adapters: liveAdapters,
    rosterHash: receipt.rosterHash,
    orchestratorCliId: receipt.agents.find(
      (candidate) => candidate.category === 'orchestrator',
    )?.cli,
  });
  const routeLabel =
    sealed.routeContract.adapterId +
    (sealed.routeContract.model ? `/${sealed.routeContract.model}` : '');
  return {
    ...sealed.decision,
    tier: input.tierOverride ?? sealed.decision.tier,
    reason:
      `roster selado: ${agent.category}=${routeLabel} ` +
      `(agente ${agent.id}/${agent.agentName}, plano ` +
      `${receipt.rosterHash.slice(0, 12)}); sem reroute automático`,
  };
}

const routeTaskTool: McpToolDef = {
  name: 'nexus_route_task',
  description:
    'Mission-orchestrator-only: reserve the best cost/capability route for a task before spawning it. ' +
    'The decision is resolved against the current installed provider and model ' +
    'catalog, never against model names remembered by the orchestrator. Classifies the task ' +
    '(trivial|easy|medium|hard|critical) and returns {tier, adapterId, ' +
    'model, effort, reason, alternatives, routeReservationId, routeReservationExpiresAt}: ' +
    'for a mission, pass routeReservationId and adapterId/model/effort straight ' +
    'into nexus_pane_spawn. Call it for every delegation and trust the ' +
    'returned runtime snapshot so removed, deprecated or unavailable models are never forced by a stale playbook. ' +
    'Inside a running mission, candidates are restricted to release-qualified ' +
    'governed workers (Codex in this release). Other CLIs remain available ' +
    'for direct/manual Terminal use, never through a mission RouteReservation. ' +
    'When the mission has a sealed task plan, routing is closed: the task must ' +
    'match a planned task (by title or taskId) and the answer is exactly that ' +
    "task's roster cli/model/effort — never an adapter outside the sealed " +
    'roster.',
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
      missionId: {
        type: 'string',
        description:
          'Current orchestrator mission id; when supplied it must match the bound mission',
      },
      preferAdapters: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional adapter preference list applied after table rank',
      },
    },
    required: ['task'],
  },
  handler: async (args, ctx) => {
    if (ctx.role !== 'orchestrator') {
      throw new Error(
        'route_task delegation authority is reserved to the mission orchestrator',
      );
    }
    const missionId = childMissionId(ctx, str(args, 'missionId'));
    const missionStores = missionId ? getProjectDomainStores(ctx.scope) : null;
    const mission = missionId && missionStores
      ? missionStores.missions.get(missionId)
      : null;
    if (missionId) {
      if (!mission) throw new Error(`mission not found: ${missionId}`);
      assertCurrentMissionOrchestratorSession(ctx, mission);
    }
    const task = requireStr(args, 'task');
    const tierRaw = str(args, 'tier');
    const tier = TIERS.includes(tierRaw as TaskTier)
      ? (tierRaw as TaskTier)
      : undefined;
    // Failover de rate limit: o orquestrador re-roteia excluindo a CLI que
    // acabou de estourar cota/quebrar, em vez de insistir nela.
    const excluded = new Set(strArray(args, 'exclude'));
    // 'shell' não é um provider roteável (sem modelos avaliados); incluí-lo
    // mantinha o gate de cobertura do task-router sempre falso, matando a
    // avaliação por dimensão. Alinha com o filtro id!=='shell' do architect.
    if (missionId) {
      // O inventário síncrono lê apenas o cache quente de assinatura; aqueça
      // os providers keychain-only (AGY) para não ler uma sessão viva como
      // login-needed e derrubar o roteamento da missão.
      await warmSquadRuntimeSubscriptionAuth();
      // Roster selado = autoridade fechada: a rota sai do membro exato do
      // roster para a task planejada; task fora do plano falha fechado em vez
      // de cair no roteamento livre (que já sugeriu CLI fora do roster).
      const sealedDecision = sealedRosterRouteDecision({
        stores: missionStores!,
        mission: mission!,
        task,
        tierOverride: tier,
      });
      if (sealedDecision) {
        recordRouteDecision({
          adapterId: sealedDecision.adapterId,
          model: sealedDecision.model,
        });
        recordRouteLog({
          task,
          tier: sealedDecision.tier,
          adapterId: sealedDecision.adapterId,
          model: sealedDecision.model,
          effort: sealedDecision.effort,
          reason: sealedDecision.reason,
        });
        const sealedReservation = missionStores!.missions.reserveRouteDecision(
          missionId,
          task,
          sealedDecision,
        );
        return {
          ...sealedDecision,
          routeReservationId: sealedReservation.id,
          routeReservationExpiresAt: sealedReservation.expiresAt,
        };
      }
    }
    const governedMissionWorkerIds = missionId
      ? liveSquadRuntimeInventory().policy.routableWorkerCliIds
      : null;
    const providers = listProviderSettings().filter(
      (a) =>
        a.adapterId !== 'shell' &&
        (governedMissionWorkerIds === null ||
          governedMissionWorkerIds.has(a.adapterId)),
    );
    if (missionId && providers.length === 0) {
      throw new Error(
        'mission_worker_route_unavailable: nenhuma CLI do roster está instalada, ' +
        'habilitada, autenticada e pronta para handoff. Confira Providers e tente ' +
        'novamente; nenhuma RouteReservation foi criada.',
      );
    }
    // Quota-aware auto-exclude: an adapter whose Nexus-managed accounts are
    // ALL on an active cooldown is treated as excluded, so routing no longer
    // depends on the orchestrator remembering to pass `exclude` (prompt-hope).
    // Adapters with no Nexus accounts report available (hasAvailableAccount →
    // true — third-party auth state is not ours to judge) and are never
    // affected; only a fully-cooling account pool leaves the route.
    const quotaExcluded = providers
      .map((a) => a.adapterId)
      .filter((id) => !excluded.has(id) && !hasAvailableAccount(id));
    const buildAdapters = (skip: ReadonlySet<string>) =>
      providers.map((a) => {
        const models = [
          ...authReadyModelsForProvider(a, a.models),
        ];
        return {
          id: a.adapterId,
          installed:
            !skip.has(a.adapterId) &&
            a.enabled &&
            a.installed &&
            (a.authStrategy !== 'login-needed' || models.length > 0),
          models,
        };
      });
    let adapters = buildAdapters(new Set([...excluded, ...quotaExcluded]));
    let quotaFallbackNote = '';
    if (quotaExcluded.length > 0 && !adapters.some((a) => a.installed)) {
      // Fail-safe: the auto-exclude
      // emptied the routable pool → revert to the caller-provided list. A
      // spawn on a cooling account surfaces the real cooldown error; no route
      // at all would hide it.
      adapters = buildAdapters(excluded);
      quotaFallbackNote = `; quota auto-exclude reverted, all candidates cooling: ${quotaExcluded.join(',')}`;
    }
    let missionAdapterIds: string[] | undefined;
    if (missionId) {
      try {
        missionAdapterIds = getProjectDomainStores(ctx.scope)
          .missionPanes.list(missionId)
          .map((pane) => pane.adapterId)
          .filter(Boolean);
      } catch {
        missionAdapterIds = undefined;
      }
    }
    const preferAdapters = strArray(args, 'preferAdapters');
    const missionUseCounts = missionAdapterIds?.length
      ? countAdapterUses(missionAdapterIds)
      : undefined;
    // Claude shares one OAuth credential state. Another CLI may route one
    // Claude worker in autopilot, but once any Claude pane belongs to this
    // mission a second concurrent Claude route is physically unavailable.
    const reserveClaude = Boolean(
      missionId &&
        (ctx.providerId === 'claude' ||
          missionAdapterIds?.includes('claude')),
    );
    if (reserveClaude) {
      adapters = adapters.map((adapter) =>
        adapter.id === 'claude'
          ? { ...adapter, installed: false }
          : adapter,
      );
    }
    let decision = routeTask(
      task,
      adapters,
      undefined,
      tier,
      reserveClaude,
      undefined,
      {
        missionUsedAdapters: missionAdapterIds?.length
          ? new Set(missionAdapterIds)
          : undefined,
        missionUseCounts,
        preferAdapters: preferAdapters.length > 0 ? preferAdapters : undefined,
      },
    );
    if (!decision) {
      if (missionId) {
        throw new Error(
          'mission_worker_route_unavailable: nenhuma CLI elegível está disponível ' +
          'agora (confira autenticação, cota, cooldown, exclusões e a reserva de ' +
          'uma única sessão Claude). Nenhuma RouteReservation foi criada.',
        );
      }
      throw new Error('no installed adapters to route to');
    }
    // Fail-safe: append note without mutating a frozen/shared decision object.
    if (quotaFallbackNote) {
      decision = {
        ...decision,
        reason: `${decision.reason}${quotaFallbackNote}`,
      };
    }
    if (!missionId) {
      // Sem missão vinculada não existe roster para honrar — e o chamador não
      // tem como saber disso pelo retorno. Dizer que é SUGESTÃO evita que uma
      // resposta livre seja lida como a rota selada de alguma missão.
      decision = {
        ...decision,
        reason:
          `${decision.reason}; sugestão livre: nenhuma missão vinculada, ` +
          'portanto nenhum roster selado foi consultado',
      };
    }
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
    if (!missionId) return decision;
    const reservation = getProjectDomainStores(ctx.scope)
      .missions.reserveRouteDecision(missionId, task, decision);
    return {
      ...decision,
      routeReservationId: reservation.id,
      routeReservationExpiresAt: reservation.expiresAt,
    };
  },
};

const cronTool: McpToolDef = {
  name: 'nexus_cron',
  description:
    'Persistir definições de agenda (grant explícito + consentimento por mutação): ' +
    'action "create" {name, schedule (cron 5 campos ' +
    '"min hora dom mês dow"), brief, workspacePath?, agentName? XOR squadId?, ' +
    'executionMode?: "shared" | "local"}. Shared é o padrão e exige lease ' +
    'remoto; local só existe quando solicitado explicitamente. ' +
    '"list", "update" {id, campos}, "delete" {id}. Shared usa definição ' +
    'portátil versionada com conflito CAS explícito. Jobs criados/reaprovados com ' +
    'consentimento exato entram pelo bootstrap main-owned; jobs legados/importados ' +
    'sem autoridade ficam fail-closed e devem ser recriados. Toda execução atravessa ' +
    'missão selada, RouteReservation/roster sticky, kickoff e handoff. ' +
    'Atraso > 5min (laptop fechado) é pulado, sem catch-up em rajada.',
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
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
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
        const created = await addCronJob({
          name: requireStr(args, 'name'),
          schedule: requireStr(args, 'schedule'),
          brief: requireStr(args, 'brief'),
          workspacePath: str(args, 'workspacePath'),
          executionMode: requestedMode ?? 'shared',
          agentName,
          squadId,
        }, ctx.scope, invocation);
        assertMcpInvocationCurrent(invocation);
        reportCronReversal(ctx, { action: 'create', created: cronSnapshot(created) });
        return created;
      }
      case 'list':
        return listCronJobs(ctx.scope);
      case 'update': {
        // Anterior capturado ANTES da mutação: depois dela ele não existe mais,
        // e sem ele a frase de desfazer não tem para onde voltar.
        const beforeUpdate = findCronJob(ctx.scope, requireStr(args, 'id'));
        const status = str(args, 'status');
        if (
          status !== undefined &&
          status !== 'active' &&
          status !== 'paused'
        ) {
          throw new Error('status deve ser active ou paused');
        }
        const updated = await updateCronJob(
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
          invocation,
        );
        assertMcpInvocationCurrent(invocation);
        if (beforeUpdate) {
          reportCronReversal(ctx, {
            action: 'update',
            before: beforeUpdate,
            after: cronSnapshot(updated),
          });
        }
        return updated;
      }
      case 'delete': {
        const beforeDelete = findCronJob(ctx.scope, requireStr(args, 'id'));
        const deleted = await deleteCronJob(
          requireStr(args, 'id'),
          ctx.scope,
          invocation,
        );
        assertMcpInvocationCurrent(invocation);
        if (beforeDelete) {
          reportCronReversal(ctx, { action: 'delete', before: beforeDelete });
        }
        return { deleted };
      }
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
