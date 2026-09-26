import { missionExecutionScope } from './mission-execution-scope';
import { sharedPaneSpaceId } from '../pty/pane-space-worktree';
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
import { requireMissionLeaderSession } from './mission-leader-gate';
import {
  assertMcpInvocationCurrent,
  type McpToolDef,
  type McpToolInvocation,
} from './mcp-protocol';
import type { AgentGateContext } from './gate';
import { z } from 'zod';
import { findPane, readSessionOutput, waitForIdle } from './pane-registry';
import { listProviderSettings } from '../persistence/provider-config-store';
import { routeTask, type TaskTier } from './task-router';
import {
  classifyTaskForRouting,
  routingOverridesFrom,
  type JevTaskRoutingResult,
} from './jev-task-routing';
import { mergeAdapterUseLists } from './route-pipeline';
import { suggestSkillForTask } from './jev-skill-suggestion';
import { recordRouteDecision } from './route-provenance';
import { recordRouteLog, recentRouteLog } from './route-log';
import { loadSpecialtyBenchmark } from './specialty-benchmark';
import { hasAvailableAccount } from '../persistence/account-store';
import { authReadyModelsForProvider } from '../adapters/model-auth-readiness';
import {
  firstWaveCanSeat,
  peekKimiSeatReadiness,
} from '../adapters/seat-auth-readiness';
import { writerCircuitBlocksSeat } from './writer-circuit-break';
import { appendMissionVerdict } from '../../shared/mission-block-cause';
import { missionStatusSchema, type SquadAgent } from '../../shared/orch-types';
import { missionResultSchema } from '../../shared/mission-engine-contract';
import { buildClarify } from '../../shared/clarify';
import { emitClarifyQuestion } from './clarify-flow';
import { findAgent, getSquad, listAgents, listSquads, saveSquad } from './squad-store';
import { BUILTIN_SQUADS } from './builtin-squads';
import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import { PersistenceUnavailableError } from '../persistence/persistence-error';
import { pinUniqueSealedRosterOnDecision } from '../../shared/sealed-agent-runtime';
import { DEFAULT_TODO_LIST } from './todo-store';
import { getProjectDomainStores } from './project-domain-store-registry';
import { getContextWorkflowService } from '../context/context-workflow-registry';
import { ProcessGitRunner } from '../runtime/git-command';
import { missionEngineForScope } from './mission-engine-registry';
import { maybeCompleteFastLaneOnDelivery } from './civilian-delivery-completion';
import { missionRequiresAutomaticCompletionReview } from './mission-independent-review-gate';
import { saveCatalogOverlay, proposeRecipes } from './catalog-overlay';
import { getOrchSettings } from '../persistence/settings-store';
import { isOperatorChoicePolicy } from '../../shared/squad-cli-policy';
import {
  addCronJob,
  deleteCronJob,
  listCronJobs,
  updateCronJob,
} from './cron-runtime';
import {
  childMissionId,
  paneSpawnTool,
  setOperatorRouteResolver,
  type OperatorRouteInternal,
} from './tools-panes';
import { buildBrowserTools } from './tools-browser';
import { buildBrowserAutopilotTools } from './tools-browser-autopilot';
import { buildComputerAutopilotTools } from './tools-computer-autopilot';
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
import { buildJudgeTools } from './tools-judge';
import { buildRankTools } from './tools-rank';
import { pickAccountTool } from './tools-pick-account';
import { accountWindowsTool } from './tools-account-windows';
import { harnessTool } from './tools-harness';
import { skillOpsTool } from './tools-skill-ops';
import { describeEnvelope, DESCRIBE_PROPERTY } from './tool-describe';
import { buildToolPickTools } from './tools-tool-pick';
import { squadSchema } from '../../shared/orch-types';
import { collectPerfSnapshot } from '../perf/perf-ipc';
import {
  canCompleteConsultLane,
  canCompleteOpsLane,
  compileIntentContract,
  MISSION_INTENT_GOAL_MAX_CHARS,
  type MissionIntentContract,
} from '../../shared/mission-intent';
import { isTaskQueueManagedMission } from './task-dispatch-authority';
import {
  countMissionItems,
  fastLaneObjectiveText,
  shouldRejectRoleCollapsedPlan,
} from './mission-story-plan';
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

/**
 * Contrato da missão que a mão do operador cria em Autopilot: aprovado e
 * despachado agora (é o próprio operador pedindo), em modo livre. Os
 * guardrails que não são cerimônia — containment, allowlists, 1 escritor por
 * checkout, maxWorkers — continuam valendo a jusante.
 */
function operatorHandMissionContract(
  title: string,
  description: string | undefined,
  milestones: readonly string[],
): MissionIntentContract {
  const now = Date.now();
  const acceptanceCriteria = milestones
    .map((milestone) => milestone.trim().slice(0, 2_048))
    .filter((milestone) => milestone.length > 0)
    .slice(0, 32);
  return {
    ...compileIntentContract({
      goal: (description?.trim() || title).slice(0, MISSION_INTENT_GOAL_MAX_CHARS),
      source: 'typed',
      intentVersion: 1,
      executionMode: 'autopilot',
      contextPolicy: 'on-demand',
      freeAgentChoice: true,
      ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
    }),
    approvedAt: now,
    dispatchedAt: now,
  };
}

const missionCreateTool: McpToolDef = {
  name: 'nexus_mission_create',
  description:
    'Create a mission (a tracked unit of orchestrated work). Optional: a pane ' +
    'the operator opened already spawns helper panes with nexus_pane_spawn ' +
    'without any mission. The calling session becomes the orchestrator and ' +
    'receives worker handoffs when idle. In Autopilot the mission starts ' +
    'running in free agent choice (any installed CLI; no squad unless squadId ' +
    'is given), so you can spawn its workers right away, and once it is done ' +
    'or failed this pane is the operator hand again. In Hardened it waits for ' +
    'the operator to dispatch it.',
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
    const title = requireStr(args, 'title');
    const description = str(args, 'description');
    const milestones = strArray(args, 'milestones');
    const rawSquadId = str(args, 'squadId');
    const autopilot = isOperatorChoicePolicy(getOrchSettings().squadCliPolicy);
    // A mão do operador já abre panes e worktrees sem missão; a missão dela só
    // registra o trabalho. Em Autopilot ela nasce como o "modo livre" da UI:
    // rodando, com contrato despachado e Escolha livre de agentes, e SEM squad
    // que ninguém pediu. Antes nascia sem contrato (todo spawn de worker voltava
    // approval_required) e presa ao nexus-fullstack (squad_binding_violation,
    // route_reservation_required, cutucada de delegação no pane do operador) —
    // o agente acabava pedindo ao operador um despacho que a UI não oferece
    // (campos 23/09 e 25/09). Hardened segue com squad padrão e despacho
    // explícito na interface.
    const defaultSquadId = autopilot
      ? undefined
      : (listSquads().find((s) => s.id === 'nexus-fullstack')?.id ??
        listSquads().find((s) => s.id !== PET_STUDIO_SQUAD_ID)?.id);
    const spaceId = ctx.executionScope ? sharedPaneSpaceId(ctx.scope, ctx.executionScope) : undefined;
    const operatorContract = operatorHandMissionContract(title, description, milestones);
    if (spaceId) operatorContract.workspaceBinding = { version: 1, spaceId };
    const created = stores.missions.create({
      title,
      description,
      squadId: rawSquadId || defaultSquadId,
      milestones,
      orchestratorSessionId: ctx.sessionId,
      ...(autopilot
        ? {
            intentState: 'dispatched' as const,
            intentVersion: 1,
            intentContract: operatorContract,
          }
        : spaceId ? {
            intentState: 'awaiting_approval' as const,
            intentVersion: 1,
            intentContract: {
              ...compileIntentContract({ goal: description?.trim() || title, source: 'typed', intentVersion: 1 }),
              workspaceBinding: { version: 1 as const, spaceId },
            },
          } : {}),
    });
    const mission = autopilot
      ? (stores.missions.update(created.id, { status: 'running' }) ?? created)
      : created;
    ctx.missionId = mission.id;
    ctx.role = 'orchestrator';
    // Marca a promoção para que ela possa ser desfeita se a missão for
    // descartada. Sem isto o pane fica estéril para sempre.
    ctx.promotedFromUserSession = true;
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
        ...(ctx.executionScope && ctx.executionScope.rootRealPath !== ctx.scope.rootRealPath
          ? { cwd: ctx.executionScope.rootRealPath, executionScope: ctx.executionScope }
          : {}),
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

const gitRunner = new ProcessGitRunner();
const missionPushSchema = z.object({
  remote: z.string().trim().max(2_048).optional(),
  branch: z.string().trim().max(1_024).optional(),
}).strict();
type MissionPush = z.infer<typeof missionPushSchema>;

function safeGitPush(
  scope: ProjectExecutionScope,
  push: MissionPush,
): { ok: boolean; output?: string; error?: string } {
  const remote = (push.remote ?? 'origin').trim();
  const branch = push.branch?.trim();
  if (!remote || remote.startsWith('-') || /[;&|`$(){}[\]\\]/.test(remote)) {
    return { ok: false, error: 'unsafe git remote' };
  }
  if (branch && (/^[-+]/.test(branch) || /[;&|:`$(){}[\]\\]/.test(branch))) {
    return { ok: false, error: 'unsafe git branch' };
  }
  const args = branch ? ['push', remote, branch] : ['push', remote];
  const cwd = scope.rootRealPath;
  try {
    const result = gitRunner.run(cwd, args, { timeoutMs: 60_000 });
    return result.status === 0
      ? { ok: true, output: result.stdout.trim() }
      : { ok: false, error: result.stderr.trim() || result.stdout.trim() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function pushCompletedMission(
  ctx: AgentGateContext,
  expected: { readonly id: string; readonly intentVersion?: number },
  push: MissionPush,
  invocation?: McpToolInvocation,
) {
  assertMcpInvocationCurrent(invocation);
  const completed = getProjectDomainStores(ctx.scope).missions.get(expected.id);
  if (!completed || completed.status !== 'done' || !completed.result ||
    completed.intentVersion !== expected.intentVersion) {
    throw new Error('mission changed before the requested push');
  }
  if (!completed.orchestratorSessionId?.trim()) {
    throw new Error('requested push requires an explicit current orchestrator session');
  }
  assertCurrentMissionOrchestratorSession(ctx, completed);
  const execution = missionExecutionScope(ctx.scope, completed);
  let effectivePush = push;
  if (completed.intentContract?.workspaceBinding?.spaceId) {
    const branch = gitRunner.run(execution.rootRealPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim();
    if (!branch || (push.branch !== undefined && push.branch !== branch)) {
      throw new Error('O push da missão deve publicar a branch atual da própria aba.');
    }
    effectivePush = { ...push, branch };
  }
  const pushed = safeGitPush(execution, effectivePush);
  if (!pushed.ok) {
    console.warn(`[mission-set-status] git push falhou para ${expected.id}: ${pushed.error}`);
  }
  return {
    ...completed,
    pushExecuted: pushed.ok,
    pushPending: !pushed.ok,
    ...(!pushed.ok ? {
      message: 'A missão concluiu localmente, mas o push não foi confirmado. Confira o destino antes de tentar novamente.',
    } : {}),
  };
}

const missionSetStatusTool: McpToolDef = {
  name: 'nexus_mission_set_status',
  description:
    'Update a mission status (pending|running|blocked|done|failed). ' +
    'For standard squads, done requests automatic verification and returns the current mission state. ' +
    'If completionRequested=true, finish your turn so Nexus can verify; do not poll or mark blocked merely to wait. ' +
    'An explicit push waits for this verification attempt. If pushPending=true, no push is queued; retry with fresh authority after completion. ' +
    'The mission reaches done ONLY after real completion. A standard squad mission is ' +
    'completed through the main-owned verified path, which does NOT re-check PREVC step ' +
    'receipts — do not assume incomplete steps will be refused there. For any other mission, ' +
    'with a frozen PREVC contract, done requires the complete workflow and immutable step ' +
    'receipts; without a frozen contract (PREVC degrades, never blocks), a non-orchestrated ' +
    'completion requires a durable note (or existing learnings) ≥40 chars. A standard squad ' +
    'mission may only reach done through main-owned verified completion receipts; prose or a ' +
    'reporter claim is never orchestration completion. ' +
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
      push: {
        type: 'object',
        additionalProperties: false,
        description:
          'Optional git push to run after the mission reaches done. ' +
          'Only plain push is supported; force flags are rejected.',
        properties: {
          remote: { type: 'string', description: 'Remote name (default: origin)' },
          branch: { type: 'string', description: 'Branch name (default: current branch)' },
        },
      },
    },
    required: ['missionId', 'status'],
  },
  handler: async (args, ctx, invocation) => {
    const missionId = requireStr(args, 'missionId');
    const status = missionStatusSchema.parse(args.status);
    const note = str(args, 'note')?.trim() ?? '';
    const push = args.push === undefined ? undefined : missionPushSchema.parse(args.push);
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
        return push ? pushCompletedMission(ctx, current, push, invocation) : current;
      }
      const lane = current.intentContract?.lane ?? 'standard';
      if (missionRequiresAutomaticCompletionReview(current, current.squadId ? getSquad(current.squadId) : null)) {
        const entry = `## Solicitação de conclusão\n${note}`.slice(0, MAX_MISSION_RESULT_CHARS);
        if (note && !current.learnings.includes(entry)) {
          stores.missions.appendLearning(missionId, entry);
        }
        const verification = maybeCompleteFastLaneOnDelivery(ctx.scope, missionId).catch((error) => {
          console.warn('[mission-set-status] verificação de conclusão falhou:', error instanceof Error ? error.message : error);
          return null;
        });
        // Let immediate decisions settle; a slow sensor must not keep its own
        // orchestrator turn busy and prevent the mission from becoming idle.
        if (push) await verification;
        else await Promise.race([verification, new Promise<void>((resolve) => setImmediate(resolve))]);
        const latest = stores.missions.get(missionId) ?? current;
        if (latest.status !== 'done') {
          return {
            ...latest,
            completionRequested: true,
            message: push
              ? 'A verificação ainda não concluiu a missão e o push não foi executado. Tente novamente após a missão concluir; o push não ficou agendado.'
              : 'Solicitação de conclusão recebida. Você pode encerrar este turno; o Nexus continua verificando a entrega.',
            ...(push ? { pushExecuted: false, pushPending: true } : {}),
          };
        }
        if (!latest.result) throw new Error('completed mission is missing its canonical MissionResult');
        return push ? pushCompletedMission(ctx, current, push, invocation) : latest;
      }
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
            // Via Rápida (rodada 2 R4): fast-lane não congela contrato nem tem
            // dispatch authority POR CONSTRUÇÃO — exigir isso aqui impedia
            // QUALQUER done do Maestro (missão real D#2: "2 handoffs success
            // consumidos" e mesmo assim blocked). Na Via Rápida o ACK do
            // orquestrador corrente É a verificação: o main testemunhou os
            // dois lados (worker entregou, Maestro corrente leu e ack'ou a
            // entrega). Nota durável ≥40 mantém o "nunca verde silencioso".
            const acceptedByCurrentSession = (() => {
              try {
                // The durable `current.orchestratorSessionId` field alone is
                // not proof of who is leading now — resolve and require a
                // proven leader before trusting any attempt as "current".
                const leader = requireMissionLeaderSession(ctx.scope, missionId, {});
                if (!leader.ok) return false;
                return stores.handoffs
                  .list({ missionId, includeDelivered: true })
                  .some(
                    (handoff) =>
                      handoff.status === 'success' &&
                      (handoff.deliveryState === 'consumed' ||
                        handoff.deliveryState === 'acknowledged') &&
                      (
                        stores.handoffs.listDeliveryAttempts(handoff.id) ??
                        []
                      ).some(
                        (attempt) =>
                          attempt.state === 'accepted' &&
                          attempt.acceptedAt !== undefined &&
                          attempt.orchestratorSessionId === leader.leader.sessionId,
                      ),
                  );
              } catch {
                // Store ilegível: fail-closed — sem prova de aceite corrente.
                return false;
              }
            })();
            if (!(hasDurableNote && acceptedByCurrentSession)) {
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
            // Sanctioned: consumido+aceito pela sessão corrente com nota
            // durável — segue para o completeVerified abaixo.
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
      return push ? pushCompletedMission(ctx, current, push, invocation) : completed;
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
          'Spawn with provider-native read-only enforcement. Required before PREVC execution. ' +
          'Read-only workers spawn in parallel even with an active writer — use for review/analysis that edits nothing.',
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
    'createdAt, builtin, orchestratorInstructions, agents[]}). Pass ' +
    'describe:true to get the full argument schema and stop (schema-on-demand).',
  inputSchema: {
    type: 'object',
    properties: {
      squad: { type: 'object' },
      ...DESCRIBE_PROPERTY,
    },
  },
  handler: async (args, ctx) => {
    if (args.describe === true) {
      return describeEnvelope(true, 'save', {
        type: 'object',
        properties: {
          squad: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              createdAt: { type: 'number' },
              builtin: { type: 'boolean' },
              orchestratorInstructions: { type: 'string' },
              nativeInstructions: { type: 'string' },
              agents: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    agentName: { type: 'string' },
                    category: { type: 'string' },
                    cli: { type: 'string' },
                    model: { type: 'string' },
                    effort: { type: 'string' },
                    allowedSkills: { type: 'array', items: { type: 'string' } },
                    delegateOnly: { type: 'boolean' },
                    leaf: { type: 'boolean' },
                    invocable: { type: 'boolean' },
                  },
                  required: ['agentName'],
                },
              },
            },
            required: ['name', 'agents'],
          },
        },
        required: ['squad'],
      });
    }
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
  description:
    'SSH into a registered alias from Settings → Remoto (e.g. vps-1). Never pass IP or user@host.',
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
  description:
    'List tmux sessions on a registered SSH alias from Settings → Remoto. Never pass IP or user@host.',
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
    'Create/adopt a remote tmux session on a registered SSH alias from Settings → Remoto ' +
    '(e.g. vps-1). Never pass IP or user@host. Returns the local attach command.',
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
      case 'plan': {
        // 0.32.26: a action que a description promete e o gate exige.
        // Sela o plano da missão no registro de tasks (rastreio durável:
        // queue, ownership, dependsOn embutidos no detail) contra o roster
        // selado real. Só orquestrador; replay idêntico devolve os mesmos
        // ids (createPlanAtomically é determinístico).
        if (ctx.role === 'worker') {
          throw new Error('only an orchestrator can seal the mission plan');
        }
        const missionId = str(args, 'missionId') ?? ctx.missionId;
        if (!missionId) {
          throw new Error('nexus_task plan exige missionId');
        }
        const mission = suite.missions.get(missionId);
        if (!mission) throw new Error(`mission not found: ${missionId}`);
        if (mission.status !== 'running') {
          throw new Error(
            `nexus_task plan exige missão running (atual: ${mission.status})`,
          );
        }
        const squad = mission.squadId ? getSquad(mission.squadId) : null;
        if (!squad || squad.agents.length === 0) {
          throw new Error(
            'nexus_task plan exige missão vinculada a um squad com roster',
          );
        }
        const rows = mcpPlanTasksToRows(args.tasks, squad.agents);
        const objective = fastLaneObjectiveText(mission);
        if (
          shouldRejectRoleCollapsedPlan({
            objective,
            planTitles: rows.map((row) => row.title),
          })
        ) {
          throw new Error(
            `nexus_task plan recusou colapso em ${rows.length} papéis: ` +
              `o objetivo sela ${countMissionItems(objective)} stories. ` +
              'Use uma task por story listada — não Frontend/Backend/UX.',
          );
        }
        const sealedTasks = tasks.createPlanAtomically({
          missionId,
          intentVersion: mission.intentVersion ?? 0,
          squad: { id: squad.id, agents: squad.agents },
          rows,
        });
        return {
          sealed: true,
          missionId,
          intentVersion: mission.intentVersion ?? 0,
          tasks: sealedTasks.map((task) => ({
            id: task.id,
            plannerId: rows.find((row) => row.title === task.title)?.plannerId,
            title: task.title,
            status: task.status,
          })),
        };
      }
      default:
        throw new Error(`unknown action: ${String(args.action)}`);
    }
  },
};

/**
 * nexus_task plan (0.32.26): a tool promete selar o plano desde sempre, o
 * gate exigia "somente UMA chamada nexus_task plan", mas a action não
 * existia — o Maestro registrava o plano na lista de tarefas visível
 * ("o rastreio existe, só não no objeto task", print 2026-08-17). Aqui o
 * mapa puro das tasks do MCP para as rows seladas: valida contra o roster
 * real (categoria exata, sem task para orquestrador) e embute os campos
 * extras (dependsOn/executionMode/ownership) como rodapé estruturado no
 * detail — o rastreio fica durável sem cirurgia no schema do selo.
 */
export function mcpPlanTasksToRows(
  rawTasks: unknown,
  agents: readonly SquadAgent[],
): Array<{
  plannerId: string;
  title: string;
  detail: string;
  agentRef: string;
  agentCategory: SquadAgent['category'];
}> {
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    throw new Error('nexus_task plan exige ao menos 1 task em tasks[]');
  }
  if (rawTasks.length > 64) {
    throw new Error('nexus_task plan aceita no máximo 64 tasks');
  }
  const seen = new Set<string>();
  return rawTasks.map((raw) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('task do plano precisa ser objeto');
    }
    const task = raw as Record<string, unknown>;
    const id = typeof task.id === 'string' && task.id.trim() ? task.id.trim() : '';
    if (!id) throw new Error('task do plano exige id (plannerId)');
    if (seen.has(id)) throw new Error(`id de task duplicado no plano: ${id}`);
    seen.add(id);
    const title =
      typeof task.title === 'string' && task.title.trim()
        ? task.title.trim().slice(0, 1_024)
        : '';
    if (!title) throw new Error(`task ${id} exige title`);
    const agentRef =
      typeof task.agentRef === 'string' ? task.agentRef.trim() : '';
    const agent = agents.find((candidate) => candidate.id === agentRef);
    if (!agent) {
      throw new Error(
        `task ${id}: agentRef "${agentRef}" não está no roster selado da missão`,
      );
    }
    if (agent.category === 'orchestrator') {
      throw new Error(
        `task ${id}: plano não atribui task de worker ao orquestrador (${agentRef})`,
      );
    }
    const category =
      typeof task.category === 'string' ? task.category : agent.category;
    if (category !== agent.category) {
      throw new Error(
        `task ${id}: category "${category}" diverge do roster ` +
          `(${agentRef} é ${agent.category})`,
      );
    }
    const detailBase =
      typeof task.detail === 'string' ? task.detail.slice(0, 60_000) : '';
    const meta: Record<string, unknown> = {};
    if (Array.isArray(task.dependsOn) && task.dependsOn.length > 0) {
      meta.dependsOn = task.dependsOn;
    }
    if (typeof task.executionMode === 'string') meta.executionMode = task.executionMode;
    if (task.ownership && typeof task.ownership === 'object') {
      meta.ownership = task.ownership;
    }
    const metaFooter =
      Object.keys(meta).length > 0
        ? `\n\n[plan-meta]${JSON.stringify(meta)}`
        : '';
    return {
      plannerId: id,
      title,
      detail: `${detailBase}${metaFooter}`.slice(0, 65_536),
      agentRef,
      agentCategory: agent.category as SquadAgent['category'],
    };
  });
}

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
 * Corpo do nexus_route_task. `internal` só é preenchido pelo resolver do spawn
 * da mão do operador (contagens de uso para o desempate) — o handler MCP nunca
 * repassa argumentos para cá.
 */
export async function routeTaskForCaller(
  args: Record<string, unknown>,
  ctx: AgentGateContext,
  internal: OperatorRouteInternal = {},
): Promise<Record<string, unknown>> {
  if (ctx.role !== 'orchestrator' && ctx.role !== 'user') {
    throw new Error(
      'route_task delegation authority is reserved to the mission orchestrator or operator',
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
  const callerTier = TIERS.includes(tierRaw as TaskTier)
    ? (tierRaw as TaskTier)
    : undefined;
  // Classificação Jev (piloto automático, superfície taskRouting): troca a
  // heurística de palavras-chave por tier/especialidade calibrados, cada
  // campo só quando confiante; o caller que passou `tier` continua mandando.
  // Fail-open: sem chave/serviço → heurística como sempre.
  let jevRouting: JevTaskRoutingResult = { kind: 'skipped' };
  try {
    jevRouting = await classifyTaskForRouting(task);
  } catch (error) {
    console.warn('[route_task] classificação Jev falhou (ignorada):', error);
    jevRouting = { kind: 'unavailable', reason: 'network' };
  }
  const jevClassification =
    jevRouting.kind === 'classified' ? jevRouting.classification : null;
  const jevUnavailable =
    jevRouting.kind === 'unavailable' ? jevRouting.reason : undefined;
  const routing = routingOverridesFrom(jevClassification, callerTier);
  const tier = routing.tierOverride;
  // Failover de rate limit: o orquestrador re-roteia excluindo a CLI que
  // acabou de estourar cota/quebrar, em vez de insistir nela.
  const excluded = new Set([
    ...strArray(args, 'exclude'),
    ...(internal.excludeAdapterIds ?? []),
  ]);
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
          firstWaveCanSeat({
            adapterId: a.adapterId,
            authStrategy: a.authStrategy,
            hasKey: a.hasKey,
            kimiListReadiness:
              a.adapterId === 'kimi' ? peekKimiSeatReadiness() : undefined,
            hasCredentiallessModel:
              a.adapterId === 'opencode' && models.length > 0,
          }) &&
          !writerCircuitBlocksSeat({
            adapterId: a.adapterId,
            role: 'worker',
            missionId: missionId ?? undefined,
          }),
        models,
        efforts: a.efforts,
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
      specialtyOverride: routing.specialtyOverride,
      effortOverride: routing.effortOverride,
      ...(internal.tieBreakUseCounts
        ? { tieBreakUseCounts: internal.tieBreakUseCounts }
        : {}),
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
  } else if (mission?.squadId) {
    const squad = getSquad(mission.squadId);
    if (squad) {
      decision = pinUniqueSealedRosterOnDecision(decision, squad.agents);
    }
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
    classifierSource: routing.classifierSource,
    ...(jevUnavailable ? { jevUnavailable } : {}),
  });
  // Proveniência da classificação (jev | heuristic | mixed) e o sinal
  // `escalate` do Jev — informação para o Maestro, nunca decisão do router.
  const provenance = {
    classifierSource: routing.classifierSource,
    ...(routing.escalate !== undefined ? { escalate: routing.escalate } : {}),
    ...(jevUnavailable ? { jevUnavailable } : {}),
  };
  // Skill suggestion (cookbook TypeSafe): UMA choice do Jev entre as skills
  // bundled permitidas ao chamador. Fail-open: qualquer falha → null.
  let skillSuggestion: { name: string; pkg: string; confidence: number } | null = null;
  try {
    skillSuggestion = await suggestSkillForTask(task, {
      allowedSkills: ctx.allowedSkills ?? null,
      sessionId: ctx.sessionId,
      missionId: missionId ?? undefined,
    });
  } catch {
    skillSuggestion = null;
  }
  if (!missionId) return { ...decision, ...provenance, skillSuggestion };
  const reservation = getProjectDomainStores(ctx.scope)
    .missions.reserveRouteDecision(missionId, task, decision);
  return {
    ...decision,
    ...provenance,
    skillSuggestion,
    routeReservationId: reservation.id,
    routeReservationExpiresAt: reservation.expiresAt,
  };
}

const routeTaskTool: McpToolDef = {
  name: 'nexus_route_task',
  description:
    'Mission orchestrator OR the operator\'s own pane (fan-out without a mission): pick the best cost/capability route for a task before spawning it. ' +
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
    'roster.' +
    ' Without a mission the answer is a free suggestion (no RouteReservation): ' +
    'pass adapterId/model/effort into nexus_pane_spawn — or omit adapterId in ' +
    'nexus_pane_spawn and pass `task` so Nexus routes it automatically. ' +
    'The result also carries skillSuggestion: the single bundled skill Jev ' +
    'judged clearly useful for the task (null when none).',
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
  handler: (args, ctx) => routeTaskForCaller(args, ctx),
};

// Fan-out do operador sem missão: `nexus_pane_spawn` sem adapterId resolve
// `task ?? prompt` por este mesmo handler (sugestão livre, sem reserva).
// Late-bound porque tools-panes não pode importar tools-domain (ciclo).
setOperatorRouteResolver((task, ctx, internal) =>
  routeTaskForCaller({ task }, ctx, internal),
);

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

const cronScheduleTool: McpToolDef = {
  name: 'nexus_cron_schedule',
  description:
    'Agendar tarefa periódica no cron persistido (alias de conveniência para nexus_cron create). ' +
    'Requer schedule (5 campos cron), name, brief e squadId ou agentName.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      schedule: { type: 'string' },
      brief: { type: 'string' },
      workspacePath: { type: 'string' },
      executionMode: { type: 'string', enum: ['shared', 'local'] },
      agentName: { type: 'string' },
      squadId: { type: 'string' },
    },
    required: ['name', 'schedule', 'brief'],
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
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
    const created = await addCronJob(
      {
        name: requireStr(args, 'name'),
        schedule: requireStr(args, 'schedule'),
        brief: requireStr(args, 'brief'),
        workspacePath: str(args, 'workspacePath'),
        executionMode: requestedMode ?? 'shared',
        agentName,
        squadId,
      },
      ctx.scope,
      invocation,
    );
    assertMcpInvocationCurrent(invocation);
    reportCronReversal(ctx, { action: 'create', created: cronSnapshot(created) });
    return created;
  },
};

const cronListTool: McpToolDef = {
  name: 'nexus_cron_list',
  description: 'Listar jobs agendados no cron persistido (alias de conveniência para nexus_cron list).',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    return listCronJobs(ctx.scope);
  },
};

const cronCancelTool: McpToolDef = {
  name: 'nexus_cron_cancel',
  description: 'Cancelar job agendado no cron persistido (alias de conveniência para nexus_cron delete).',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const id = requireStr(args, 'id');
    const beforeDelete = findCronJob(ctx.scope, id);
    const deleted = await deleteCronJob(id, ctx.scope, invocation);
    assertMcpInvocationCurrent(invocation);
    if (beforeDelete) {
      reportCronReversal(ctx, { action: 'delete', before: beforeDelete });
    }
    return { deleted, id };
  },
};

const recipesLintTool: McpToolDef = {
  name: 'nexus_recipes_lint',
  description:
    'Valida a definição de um squad ou recipe contra o squadSchema (Zod). ' +
    'Aceita objeto JSON direto ou id de squad existente no catálogo.',
  inputSchema: {
    type: 'object',
    properties: {
      recipe: { type: 'object', description: 'Definição do squad/recipe em formato de objeto' },
      squadId: { type: 'string', description: 'ID de squad para carregar e validar' },
    },
  },
  handler: async (args, _ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    let target = args.recipe;
    if (typeof target === 'string') {
      try {
        target = JSON.parse(target);
      } catch {
        return {
          valid: false,
          errors: [{ path: 'recipe', message: 'String JSON inválida para recipe' }],
        };
      }
    }
    if (!target && args.squadId) {
      target = getSquad(String(args.squadId)) as Record<string, unknown> | null;
      if (!target) {
        return {
          valid: false,
          errors: [{ path: 'squadId', message: `Squad ${String(args.squadId)} não encontrado` }],
        };
      }
    }
    if (!target || typeof target !== 'object') {
      return {
        valid: false,
        errors: [{ path: '', message: 'Informe "recipe" (objeto) ou "squadId" válido' }],
      };
    }
    const result = squadSchema.safeParse(target);
    if (result.success) {
      return { valid: true, squad: result.data };
    }
    return {
      valid: false,
      errors: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  },
};

const recipesFormatTool: McpToolDef = {
  name: 'nexus_recipes_format',
  description:
    'Formata e normaliza a definição de um squad/recipe de acordo com o squadSchema. ' +
    'Devolve o squad normalizado e JSON formatado.',
  inputSchema: {
    type: 'object',
    properties: {
      recipe: { type: 'object', description: 'Definição de squad a formatar' },
    },
    required: ['recipe'],
  },
  handler: async (args, _ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    let target = args.recipe;
    if (typeof target === 'string') {
      try {
        target = JSON.parse(target);
      } catch {
        throw new Error('Informe "recipe" como um JSON válido');
      }
    }
    if (!target || typeof target !== 'object') {
      throw new Error('Informe "recipe" como um objeto válido');
    }
    const result = squadSchema.safeParse(target);
    if (!result.success) {
      const errorMsg = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new Error(`Recipe inválido para formatação: ${errorMsg}`);
    }
    return {
      formattedJson: JSON.stringify(result.data, null, 2),
      squad: result.data,
    };
  },
};

const perfEventsTool: McpToolDef = {
  name: 'nexus_perf_events',
  description:
    'Consulta snapshot recente de eventos e telemetria de performance do sistema ' +
    '(processo, memória, sessões PTY ativas, browser views e métricas da warm pool de panes).',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, _ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    return collectPerfSnapshot();
  },
};

const recipeListTool: McpToolDef = {
  name: 'nexus_recipe_list',
  description:
    'List all predefined and user-composed recipes (id, name, deliverable, bundledAgents, bundledSkills). ' +
    'Read-only.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler: async (_args, _ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const map = new Map<string, (typeof BUILTIN_SQUADS)[number]>();
    for (const s of BUILTIN_SQUADS) map.set(s.id, s);
    for (const s of listSquads()) map.set(s.id, s);
    const squads = [...map.values()];
    return {
      recipes: squads.map((s) => ({
        id: s.id,
        name: s.name,
        deliverable: s.name,
        bundledAgents: s.agents.map((a) => a.agentName),
        bundledSkills: Array.from(new Set(s.agents.flatMap((a) => a.allowedSkills ?? []))),
      })),
    };
  },
};

const recipeGetTool: McpToolDef = {
  name: 'nexus_recipe_get',
  description:
    'Fetch one recipe by id with its complete squad definition, ordered roles, allowed skills and native instructions.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The recipe id (e.g. "absurd-landing", "qa-swarm")' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  handler: async (args, _ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const id = requireStr(args, 'id');
    const squad = getSquad(id) ?? BUILTIN_SQUADS.find((s) => s.id === id) ?? null;
    if (!squad) {
      throw new Error(`recipe not found: ${id}`);
    }
    return {
      id: squad.id,
      name: squad.name,
      deliverable: squad.name,
      squad,
      nativeInstructions: squad.nativeInstructions,
      bundledAgents: squad.agents.map((a) => a.agentName),
      bundledSkills: Array.from(new Set(squad.agents.flatMap((a) => a.allowedSkills ?? []))),
    };
  },
};

const recipeSaveTool: McpToolDef = {
  name: 'nexus_recipe_save',
  description:
    'Persist a user-composed recipe so it appears in nexus_recipe_list alongside baked-in recipes. ' +
    'Upserts by id — resaving with the same id overwrites.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Stable slug/uuid that uniquely identifies this recipe' },
      name: { type: 'string', description: 'Human-readable recipe name' },
      deliverable: { type: 'string', description: 'One-line description of the recipe output' },
      orchestratorInstructions: { type: 'string' },
      nativeInstructions: { type: 'string' },
      agents: { type: 'array', items: { type: 'object' } },
    },
    required: ['id', 'name'],
    additionalProperties: false,
  },
  handler: async (args, _ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const id = requireStr(args, 'id');
    const name = requireStr(args, 'name');
    const existing = getSquad(id) ?? BUILTIN_SQUADS.find((s) => s.id === id) ?? null;
    const squadInput = {
      id,
      name,
      createdAt: existing?.createdAt ?? Date.now().toString(),
      builtin: false,
      orchestratorInstructions: str(args, 'orchestratorInstructions') ?? existing?.orchestratorInstructions ?? '',
      nativeInstructions: str(args, 'nativeInstructions') ?? existing?.nativeInstructions,
      agents: Array.isArray(args.agents) ? args.agents : (existing?.agents ?? []),
    };
    const parsed = squadSchema.safeParse(squadInput);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`invalid recipe schema: ${issues}`);
    }
    try {
      saveSquad(parsed.data);
    } catch (err) {
      if (err instanceof PersistenceUnavailableError) {
        return { ok: true, id, recipe: parsed.data, persisted: false };
      }
      throw err;
    }
    return { ok: true, id, recipe: parsed.data, persisted: true };
  },
};

const workspaceListTool: McpToolDef = {
  name: 'nexus_workspace_list',
  description:
    'List active and known project workspaces with the active root path and scope identifiers. ' +
    'Check this before spawning panes or creating missions.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler: async (_args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    return {
      activeWorkspace: ctx.scope.rootRealPath,
      projectId: ctx.scope.projectId,
      checkoutId: ctx.scope.checkoutId,
      version: ctx.scope.version,
    };
  },
};

export function buildDomainTools(): McpToolDef[] {
  return [
    routeTaskTool,
    routeLogTool,
    pickAccountTool,
    accountWindowsTool,
    harnessTool,
    skillOpsTool,
    clarifyTool,
    ...buildHandoffTools(),
    ...buildJudgeTools(),
    ...buildRankTools(),
    ...buildToolPickTools(),
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
    ...buildBrowserAutopilotTools(),
    ...buildComputerAutopilotTools(),
    cronTool,
    cronScheduleTool,
    cronListTool,
    cronCancelTool,
    recipesLintTool,
    recipesFormatTool,
    perfEventsTool,
    recipeListTool,
    recipeGetTool,
    recipeSaveTool,
    workspaceListTool,
  ];
}
