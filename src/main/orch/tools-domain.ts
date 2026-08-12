import {
  describeCronReversal,
  type CronChange,
  type CronJobSnapshot,
} from './cron-reversibility';
import { emitPersistentChangeReversalEvent } from './mission-event-emit';
import { rankCapabilitiesByNeed } from './capability-need-ranking';
import type { ProjectExecutionScope } from '../../shared/project-identity-types';
import {
  assertCurrentMissionOrchestratorSession,
  assertOrchestratorMission,
} from './gate';
import {
  assertMcpInvocationCurrent,
  type McpToolDef,
} from './mcp-protocol';
import { findPane, readSessionOutput, waitForIdle } from './pane-registry';
import { listProviderSettings } from '../persistence/provider-config-store';
import { routeTask, type TaskTier } from './task-router';
import { mergeAdapterUseLists } from './route-pipeline';
import { recordRouteDecision } from './route-provenance';
import { recordRouteLog, recentRouteLog } from './route-log';
import { loadSpecialtyBenchmark } from './specialty-benchmark';
import { hasAvailableAccount } from '../persistence/account-store';
import { authReadyModelsForProvider } from '../adapters/model-auth-readiness';
import { appendMissionVerdict } from '../../shared/mission-block-cause';
import { missionStatusSchema } from '../../shared/orch-types';
import { missionResultSchema } from '../../shared/mission-engine-contract';
import { buildClarify } from '../../shared/clarify';
import { emitClarifyQuestion } from './clarify-flow';
import { findAgent, listAgents, saveSquad } from './squad-store';
import { DEFAULT_TODO_LIST } from './todo-store';
import { getProjectDomainStores } from './project-domain-store-registry';
import { getContextWorkflowService } from '../context/context-workflow-registry';
import { missionEngineForScope } from './mission-engine-registry';
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
import { canCompleteConsultLane, canCompleteOpsLane } from '../../shared/mission-intent';
import { isTaskQueueManagedMission } from './task-dispatch-authority';
import {
  liveSquadRuntimeInventory,
  warmSquadRuntimeSubscriptionAuth,
} from './squad-runtime-inventory';

const MAX_MISSION_RESULT_CHARS = 65_536;

function completionLearnings(
  existingLearnings: string,
  note: string,
): string {
  if (!note) return existingLearnings;
  const entry = `## Consulta / conclusão\n${note}`;
  if (!existingLearnings.trim()) return entry.slice(0, MAX_MISSION_RESULT_CHARS);
  return `${existingLearnings}\n\n${entry}`.slice(-MAX_MISSION_RESULT_CHARS);
}

/**
 * MCP tools for handoffs (2), agents (3), missions (5), squad/catalog/task
 * (3) and todos (1) — orchestration tool groups 2-6.
 */

const agentListTool: McpToolDef = {
  name: 'nexus_agent_list',
  description:
    'List agents defined across saved squads. Prefira passar `need` com a ' +
    'necessidade em uma frase ("revisar hooks de React", "auditar OWASP"): a ' +
    'resposta vem ranqueada e curta, com os termos que casaram. Sem `need` ' +
    'devolve o catálogo inteiro.',
  inputSchema: {
    type: 'object',
    properties: {
      need: {
        type: 'string',
        description: 'Necessidade em uma frase; ranqueia em vez de despejar.',
      },
      limit: { type: 'number', description: 'Máximo de candidatos (padrão 5).' },
    },
  },
  handler: async (args) => {
    const agents = listAgents();
    const need = str(args, 'need');
    if (!need) return agents;
    const limit = typeof args.limit === 'number' ? args.limit : 5;
    const ranking = rankCapabilitiesByNeed(
      agents.map((agent) => ({
        name: agent.agentName,
        // Persona e CLI são o vocabulário que o operador usa ao descrever a
        // necessidade; o schema do agente não tem prosa livre além disso.
        description: [agent.persona, agent.cli, agent.model]
          .filter((part): part is string => typeof part === 'string')
          .join(' '),
        labels: [
          agent.category,
          ...(agent.allowedSkills ?? []),
          ...(agent.allowedTools ?? []),
        ].filter((label): label is string => typeof label === 'string'),
        agent,
      })),
      need,
      limit,
    );
    // D1: busca sem resultado não pode ser pior que não ter buscado — devolve o
    // catálogo em vez de deixar o orquestrador achar que não há agente nenhum.
    if (!ranking.matched) {
      return { matched: false, need, agents };
    }
    return {
      matched: true,
      need,
      agents: ranking.ranked.map((entry) => ({
        ...entry.item.agent,
        matchedTerms: entry.matchedTerms,
      })),
    };
  },
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
      if (current.status === 'done') {
        if (!current.result) {
          throw new Error(
            'completed mission is missing its canonical MissionResult',
          );
        }
        return current;
      }
      const lane = current.intentContract?.lane ?? 'standard';
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
      const summary =
        note ||
        current.learnings.trim() ||
        `Missão "${current.title}" concluída pelo motor Nexus após verificação.`;
      const result = missionResultSchema.parse({
        outcome: 'success',
        summary: summary.slice(0, MAX_MISSION_RESULT_CHARS),
        evidenceIds: [
          ...new Set(
            current.milestones.flatMap(
              (milestone) => milestone.evidenceIds ?? [],
            ),
          ),
        ].slice(0, 64),
        artifactRefs: [],
      });
      missionEngineForScope(ctx.scope).completeVerified(ctx.scope, {
        missionId,
        expectedStatus: 'running',
        expectedIntentState: current.intentState ?? 'legacy',
        expectedUpdatedAt: current.updatedAt,
        expectedIntentVersion: current.intentVersion ?? 0,
        learnings: completionLearnings(current.learnings, note),
        result,
      });
      const completed = stores.missions.get(missionId);
      if (completed?.status !== 'done' || !completed.result) {
        throw new Error(
          'MissionEngine did not persist the canonical verified completion result',
        );
      }
      return completed;
    }
    if (note.length > 0) {
      const heading =
        status === 'blocked'
          ? '## Encerrada como bloqueada'
          : status === 'failed'
            ? '## Falha'
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
        enum: ['create', 'update', 'list'],
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
        }
        const detail = str(args, 'detail') ?? '';
        return tasks.create({
          title: requireStr(args, 'title'),
          detail,
          missionId,
        });
      }
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

const routeTaskTool: McpToolDef = {
  name: 'nexus_route_task',
  description:
    'Mission-orchestrator-only: reserve the best cost/capability route for a task before spawning it. ' +
    'The decision is resolved against the current installed provider and model ' +
    'catalog, never against model names remembered by the orchestrator. ' +
    'Classifies the task (trivial|easy|medium|hard|critical) and the work ' +
    'specialty (visual|security|bug|feature|doc|ops|general), then returns ' +
    '{tier, specialty, policySource, adapterId, model, effort, reason, ' +
    'alternatives, routeReservationId, routeReservationExpiresAt}: ' +
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
    let reservedAdapterIds: string[] | undefined;
    if (missionId) {
      try {
        const stores = getProjectDomainStores(ctx.scope);
        missionAdapterIds = stores.missionPanes
          .list(missionId)
          .map((pane) => pane.adapterId)
          .filter(Boolean);
        reservedAdapterIds = stores.missions.listOpenRouteAdapterIds(missionId);
      } catch {
        missionAdapterIds = undefined;
        reservedAdapterIds = undefined;
      }
    }
    const preferAdapters = strArray(args, 'preferAdapters');
    const missionUseCounts = mergeAdapterUseLists(
      missionAdapterIds,
      reservedAdapterIds,
    );
    const usedAdapterIds = [
      ...(missionAdapterIds ?? []),
      ...(reservedAdapterIds ?? []),
    ];
    // Claude shares one OAuth credential state. Another CLI may route one
    // Claude worker in autopilot, but once any Claude pane belongs to this
    // mission a second concurrent Claude route is physically unavailable.
    const reserveClaude = Boolean(
      missionId &&
        (ctx.providerId === 'claude' ||
          usedAdapterIds.includes('claude')),
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
        missionUsedAdapters:
          usedAdapterIds.length > 0 ? new Set(usedAdapterIds) : undefined,
        missionUseCounts,
        preferAdapters: preferAdapters.length > 0 ? preferAdapters : undefined,
        multiScore: Boolean(missionId),
        specialtyBenchmark: loadSpecialtyBenchmark(),
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
