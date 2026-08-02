import {
  assertMcpInvocationCurrent,
  type McpToolDef,
} from './mcp-protocol';
import type { PaneSnapshot } from '../../shared/orch-types';
import {
  listPaneSnapshots,
  listVisiblePaneSnapshots,
  readSessionOutput,
  requestPaneClose,
  waitForIdle,
} from './pane-registry';
import { orchWriteSession } from '../pty/pty-manager';
import {
  listAdapterInfos,
} from '../adapters/adapter-registry';
import { findAgentInSquad } from './squad-store';
import { adHocSpawnGateError } from './route-provenance';
import { countLiveMissionWorkerSlots } from './mission-driver-io';
import { loadModelCatalog, modelCatalogInfo } from '../adapters/model-catalog';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import {
  authorizePaneRef,
  authorizedSessionIdOf,
  injectPrompt,
  num,
  requireStr,
  spawnPaneAndMaybePrompt,
  str,
  strArray,
  type SpawnToolOptions,
} from './tool-util';
import { isMissionWorkerWriteEligibleCli } from './squad-runtime-policy';
import { isOperatorChoicePolicy } from '../../shared/squad-cli-policy';
import { CODEX_MCP_TOOL_TIMEOUT_SEC } from './cli-mcp-inject';
import {
  assertCurrentMissionOrchestratorSession,
  canonicalToolName,
  type AgentGateContext,
} from './gate';
import { applyWorkerSpawnPolicy } from '../../shared/mission-intent';
import type { MissionIntentContract } from '../../shared/mission-intent';
import type { ProjectExecutionScope } from '../../shared/types';
import { getContextWorkflowService } from '../context/context-workflow-registry';
import { isTaskQueueManagedMission } from './task-dispatch-authority';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import { getOrchSettings } from '../persistence/settings-store';

/** The 11 pane tools of the embedded MCP server (tool group 1). */

/**
 * Teto de espera por chamada MCP. O cliente do Codex aborta tools/call que
 * passam de `tool_timeout_sec` (CODEX_MCP_TOOL_TIMEOUT_SEC), então uma espera
 * longa morreria no transporte antes de devolver "timeout" — o orquestrador
 * via erro de tool em vez de um estado pesquisável e a missão bloqueava
 * (release gate 27/07). Devolvemos "timeout" alguns segundos antes do corte
 * do cliente para o orquestrador pollingar com uma nova chamada.
 */
export const PANE_WAIT_TIMEOUT_CAP_MS = (CODEX_MCP_TOOL_TIMEOUT_SEC - 10) * 1000;

// Default de model por adapter para o gate de proveniência: registry vivo
// primeiro (respeita override do usuário), defs builtin como fallback (o
// registry só é populado no boot do main — nunca em unit test).
function defaultModelForAdapter(adapterId: string): string | undefined {
  const live = listAdapterInfos().find((adapter) => adapter.id === adapterId);
  if (live?.models.default) return live.models.default;
  for (const raw of BUILTIN_ADAPTERS) {
    const def = raw as { id?: string; models?: { default?: string } };
    if (def.id === adapterId) return def.models?.default;
  }
  return undefined;
}

const SAME_CHECKOUT_ACTIVE_STATES = new Set<PaneSnapshot['state']>([
  'spawning',
  'busy',
]);

const pendingWorkerSpawns = new Map<string, number>();

function workerReservationKey(
  scope: ProjectExecutionScope,
  missionId: string,
): string {
  return [
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    missionId,
  ].join('\0');
}

export function reserveWorkerSpawnSlot(input: {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly contract: MissionIntentContract | null | undefined;
  readonly currentWorkerCount: number;
  readonly allowedTools: readonly string[] | null | undefined;
}):
  | {
      readonly ok: true;
      readonly allowedTools?: string[];
      readonly release: () => void;
    }
  | { readonly ok: false; readonly code: string; readonly error: string } {
  const key = workerReservationKey(input.scope, input.missionId);
  const reserved = pendingWorkerSpawns.get(key) ?? 0;
  const policy = applyWorkerSpawnPolicy({
    contract: input.contract,
    currentWorkerCount: input.currentWorkerCount + reserved,
    allowedTools: input.allowedTools,
  });
  if (!policy.ok) return policy;
  pendingWorkerSpawns.set(key, reserved + 1);
  let isReleased = false;
  return {
    ok: true,
    ...(policy.allowedTools ? { allowedTools: policy.allowedTools } : {}),
    release: () => {
      if (isReleased) return;
      isReleased = true;
      const current = pendingWorkerSpawns.get(key) ?? 0;
      if (current <= 1) pendingWorkerSpawns.delete(key);
      else pendingWorkerSpawns.set(key, current - 1);
    },
  };
}

/**
 * Budget invariant: the in-flight reservation may only drop after the spawned
 * worker is durably visible to the next maxWorkers check (a missionPanes row).
 * Releasing without that row reopens the TOCTOU the reservation exists to
 * close — a concurrent spawn would see neither the live worker nor the
 * reservation. When the row is missing we keep the reservation (fail-safe:
 * blocking one slot beats exceeding maxWorkers).
 */
export function shouldReleaseWorkerReservation(input: {
  readonly spawnedPaneId: string | undefined;
  readonly recordedPaneIds: readonly string[];
}): boolean {
  if (!input.spawnedPaneId) return true; // spawn failed — nothing to count
  return input.recordedPaneIds.includes(input.spawnedPaneId);
}

export function activeSameCheckoutWorker(
  panes: readonly PaneSnapshot[],
  checkoutRoot: string,
): PaneSnapshot | null {
  return panes.find((pane) =>
    pane.role === 'worker' &&
    pane.executionScope?.rootRealPath === checkoutRoot &&
    SAME_CHECKOUT_ACTIVE_STATES.has(pane.state)
  ) ?? null;
}

export function withSameCheckoutWorkerContract(prompt: string): string {
  return (
    '## Nexus execution authority\n' +
    'executionMode=`same_checkout`: esta tarefa depende do WIP atual e roda no ' +
    'checkout já aberto. Preserve integralmente o trabalho existente: não use stash, ' +
    'reset, checkout, clean nem troque de branch. Há no máximo um worker escrevendo ' +
    'por vez; limite mudanças ao escopo pedido, inspecione o git status antes de editar ' +
    'e não reverta arquivos que você não criou. Ao terminar, chame nexus_handoff_submit ' +
    'uma vez com arquivos tocados, validações e qualquer bloqueio.\n\n' +
    prompt
  );
}

export function childMissionId(
  ctx: AgentGateContext,
  requested?: string,
): string | undefined {
  if (ctx.missionId && requested && requested !== ctx.missionId) {
    throw new Error('not authorized: child mission must match its parent');
  }
  if (!ctx.missionId && requested && ctx.role !== 'user') {
    throw new Error('not authorized: only the user can attach an unbound agent to a mission');
  }
  return ctx.missionId ?? requested;
}

export function attenuateTools(
  parent: string[] | null,
  requested: string[] | null,
): string[] | null {
  if (parent === null) return requested;
  if (requested === null) return [...parent];
  const allowed = new Set(parent.map(canonicalToolName));
  return requested.filter((tool) => allowed.has(canonicalToolName(tool)));
}

export function attenuateSkills(
  parent: string[] | null,
  requested: string[] | null,
): string[] | null {
  if (parent === null) return requested;
  if (requested === null) return [...parent];
  const allowed = new Set(parent.map((skill) => skill.toLowerCase()));
  return requested.filter((skill) => allowed.has(skill.toLowerCase()));
}

const paneSpawn: McpToolDef = {
  name: 'nexus_pane_spawn',
  description:
    'Open a new terminal pane running an AI CLI. Provide agentName (a squad ' +
    'agent — inherits allowlists/title) and ALSO adapterId/model/effort from ' +
    'nexus_route_task: in a running mission, pass its routeReservationId too. ' +
    'The explicit adapterId/model WIN over non-sticky roster defaults (cost routing). ' +
    'Optional prompt is typed into the CLI once it ' +
    'boots. Returns {paneId, sessionId}.',
  inputSchema: {
    type: 'object',
    properties: {
      adapterId: { type: 'string', description: 'Adapter id (cli) to run' },
      agentName: { type: 'string', description: 'Squad agent name or id' },
      model: { type: 'string' },
      effort: {
        type: 'string',
        description:
          'Reasoning effort for this spawn (low|medium|high|xhigh) — use ' +
          'the value returned by nexus_route_task',
      },
      cwd: { type: 'string' },
      title: { type: 'string' },
      missionId: { type: 'string' },
      routeReservationId: {
        type: 'string',
        description: 'Durable one-shot reservation returned by nexus_route_task',
      },
      taskId: { type: 'string' },
      prompt: { type: 'string' },
    },
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const agentRef = str(args, 'agentName');
    const routeReservationId = str(args, 'routeReservationId');
    let options: SpawnToolOptions;
    let executionMode: 'same_checkout' | 'isolated_worktree' | undefined;
    let rosterRouteAuthorized = false;
    if (agentRef) {
      const requestedMissionId = childMissionId(ctx, str(args, 'missionId'));
      const mission = requestedMissionId
        ? getProjectDomainStores(ctx.scope).missions.get(requestedMissionId)
        : null;
      if (!mission?.squadId) {
        throw new Error('squad agent spawn requires a mission bound to a squad');
      }
      const found = findAgentInSquad(mission.squadId, agentRef);
      if (!found) throw new Error(`unknown squad agent: ${agentRef}`);
      const { agent } = found;
      const role = agent.category === 'orchestrator' ? 'orchestrator' : 'worker';
      if (ctx.role === 'worker' && role === 'orchestrator') {
        throw new Error('not authorized: workers cannot create orchestrators');
      }
      const requestedAdapterId = str(args, 'adapterId');
      const requestedModel = str(args, 'model');
      const requestedEffort = str(args, 'effort');
      const selectedAdapterId = requestedAdapterId ?? agent.cli;
      const selectedModel = requestedModel ?? agent.model;
      const selectedEffort = requestedEffort ?? agent.effort;
      const noRouteOverride =
        requestedAdapterId === undefined &&
        requestedModel === undefined &&
        requestedEffort === undefined;
      rosterRouteAuthorized =
        noRouteOverride ||
        (selectedAdapterId === agent.cli &&
          selectedModel === agent.model &&
          selectedEffort === agent.effort);
      options = {
        adapterId: selectedAdapterId,
        model: selectedModel,
        effort: selectedEffort,
        cwd: str(args, 'cwd'),
        title: str(args, 'title') ?? agent.agentName,
        missionId: requestedMissionId,
        contextRevision: ctx.contextRevision,
        agentName: agent.agentName,
        agentCategory: agent.category,
        allowedTools: attenuateTools(
          ctx.allowedTools,
          agent.allowedTools ?? (role === 'orchestrator' ? null : []),
        ),
        allowedSkills: attenuateSkills(ctx.allowedSkills, agent.allowedSkills ?? null),
        role,
        prompt: str(args, 'prompt'),
        scope: ctx.scope,
      };
    } else {
      const adHocAdapterId = requireStr(args, 'adapterId');
      const adHocModel = str(args, 'model');
      // Spawn ad-hoc (sem agentName): modelo com warning de catálogo (ex.:
      // grok-4.5) só entra se veio de uma decisão real do nexus_route_task.
      // Omitir o model NÃO contorna o gate: sem model explícito, o que roda é
      // o default do adapter — é ele que precisa passar na checagem.
      const gateModel = adHocModel ?? defaultModelForAdapter(adHocAdapterId);
      if (!routeReservationId) {
        const gateError = adHocSpawnGateError(
          adHocAdapterId,
          gateModel,
          modelCatalogInfo(loadModelCatalog(), adHocAdapterId, gateModel),
        );
        if (gateError) throw new Error(gateError);
      }
      options = {
        adapterId: adHocAdapterId,
        model: adHocModel,
        effort: str(args, 'effort'),
        cwd: str(args, 'cwd'),
        title: str(args, 'title'),
        missionId: childMissionId(ctx, str(args, 'missionId')),
        contextRevision: ctx.contextRevision,
        // An MCP-initiated spawn is the orchestrator delegating: default to a
        // WORKER (gated) so an ad-hoc spawn without agentName never lands as an
        // unrestricted 'user'-role token (SEC#5).
        allowedTools: attenuateTools(ctx.allowedTools, []),
        allowedSkills: attenuateSkills(ctx.allowedSkills, null),
        role: 'worker',
        prompt: str(args, 'prompt'),
        scope: ctx.scope,
      };
    }
    // Reject stale/sticky/non-reserved legacy roster choices before consuming
    // a route reservation or mutating any worker-slot/worktree state. The
    // physical spawn path repeats this check as the final backstop.
    if (
      options.missionId &&
      options.role === 'worker' &&
      options.readOnly !== true &&
      !isMissionWorkerWriteEligibleCli(
        options.adapterId,
        isOperatorChoicePolicy(getOrchSettings().squadCliPolicy),
      )
    ) {
      throw new Error(
        `governed_worker_spawn_unsupported: ${options.adapterId} não pode ` +
          'executar como worker autônomo de missão nesta release; use o ' +
          'adapter Codex builtin qualificado, ative Configurações › ' +
          'Orquestração › Escolha livre, ou abra esse CLI manualmente no ' +
          'Terminal fora da missão',
      );
    }
    let releaseWorkerSlot: (() => void) | undefined;
    let spawnedWorkerPaneId: string | undefined;
    let consumeReservedRoute: (() => void) | undefined;
    try {
      let missionSuite: ReturnType<typeof getProjectDomainStores> | undefined;
      let missionRow: ReturnType<
        ReturnType<typeof getProjectDomainStores>['missions']['get']
      > = null;
      if (options.missionId) {
        missionSuite = getProjectDomainStores(ctx.scope);
        missionRow = missionSuite.missions.get(options.missionId);
        if (!missionRow) {
          throw new Error(`mission not found: ${options.missionId}`);
        }
        if (ctx.role === 'orchestrator') {
          assertCurrentMissionOrchestratorSession(ctx, missionRow);
        }
        if (
          missionRow.status === 'running' &&
          options.role === 'orchestrator'
        ) {
          throw new Error(
            'orchestrator_spawn_forbidden: o orquestrador de uma missão running ' +
              'é materializado exclusivamente pelo bootstrap main-owned; use ' +
              '“Retomar missão” para recuperar a sessão vinculada',
          );
        }
        if (
          options.role === 'worker' &&
          isTaskQueueManagedMission(missionSuite, options.missionId)
        ) {
          throw new Error(
            'task_dispatcher_authority: workers de uma missão planejada só podem ser ' +
              'criados pelo dispatcher durável do main; aguarde o Nexus despachar a task',
          );
        }
        if (missionRow.status === 'running' && !rosterRouteAuthorized) {
          if (!routeReservationId) {
            throw new Error(
              'route_reservation_required: missão em execução exige routeReservationId válido; ' +
                'chame nexus_route_task e repasse routeReservationId/adapterId/model/effort, ' +
                'ou use agentName sem substituir a rota sticky do roster',
            );
          }
          const expectedRoute = {
            reservationId: routeReservationId,
            missionId: options.missionId,
            adapterId: options.adapterId,
            ...(options.model ? { model: options.model } : {}),
            ...(options.effort ? { effort: options.effort } : {}),
          };
          missionSuite.missions.assertRouteReservation(expectedRoute);
          if (!ctx.sessionId) {
            throw new Error(
              'route_reservation_session_required: a reserva só pode ser consumida ' +
                'por uma sessão PTY vinculada ao agente; reabra o orquestrador e roteie novamente',
            );
          }
          consumeReservedRoute = () => {
            missionSuite!.missions.consumeRouteReservation(
              expectedRoute,
              ctx.sessionId!,
            );
          };
        }
      }
      if (options.role === 'worker' && options.missionId) {
        const missionId = options.missionId;
        // Enforce maxWorkers + parent deny attenuation (intent contract teeth).
        const suite = missionSuite!;
        if (!missionRow?.intentContract) {
          throw new Error('approval_required: current mission contract unavailable');
        }
        // Slots contam só workers VIVOS: linha durável de worker morto/fechado
        // não pode segurar maxWorkers para sempre (deadlock de campo).
        const workerSlots = countLiveMissionWorkerSlots(
          ctx.scope,
          missionId,
          suite.missionPanes.list(missionId),
        );
        const policy = reserveWorkerSpawnSlot({
          scope: ctx.scope,
          missionId,
          contract: missionRow.intentContract,
          currentWorkerCount: workerSlots.live,
          allowedTools: options.allowedTools,
        });
        if (!policy.ok) {
          throw new Error(policy.error);
        }
        if (policy.allowedTools) {
          options = { ...options, allowedTools: policy.allowedTools };
        }
        releaseWorkerSlot = policy.release;

        const workflowService = getContextWorkflowService(ctx.scope);
        const missionWorkflow = workflowService.getMissionWorkflow(missionId);
        if (missionWorkflow.contract) {
          executionMode = 'isolated_worktree';
          const taskId = str(args, 'taskId');
          if (!taskId) {
            throw new Error('frozen missions require taskId and an allocated worktree');
          }
          const worktree = requireWorktreeRuntimeRegistry().get(
            ctx.scope,
            missionId,
            taskId,
          );
          if (!worktree || worktree.status !== 'ready') {
            throw new Error('task worktree is not ready');
          }
          if (options.agentName && worktree.workerId !== options.agentName) {
            throw new Error('task worktree belongs to another worker');
          }
          options = {
            ...options,
            cwd: worktree.worktreePath,
            executionScope: Object.freeze({
              ...ctx.scope,
              rootRealPath: worktree.worktreePath,
            }),
          };
          if (options.prompt) {
            const snapshot = workflowService.compileMissionSnapshot(missionId);
            options.prompt =
              `${snapshot.markdown}\n\n` +
              `Contract hash: ${missionWorkflow.contract.contract.contractHash}\n` +
              `Task ownership: ${JSON.stringify(worktree.ownership)}\n\n` +
              options.prompt;
          }
        } else {
          executionMode = 'same_checkout';
          const activeWorker = activeSameCheckoutWorker(
            listPaneSnapshots(),
            ctx.scope.rootRealPath,
          );
          if (activeWorker) {
            throw new Error(
              `same-checkout delegation is serialized; worker ${activeWorker.paneId} ` +
              `is still ${activeWorker.state}`,
            );
          }
          options = {
            ...options,
            cwd: ctx.scope.rootRealPath,
            executionScope: ctx.scope,
            prompt: withSameCheckoutWorkerContract(
              options.prompt ?? 'Inspecione o estado atual e aguarde uma tarefa com escopo explícito.',
            ),
          };
        }
      }
      // Everything above may consult durable/worktree/provider state. Recheck
      // the exact bearer/intent after preparation, then linearize reservation
      // consumption and physical spawn without trusting the original call.
      assertMcpInvocationCurrent(invocation);
      consumeReservedRoute?.();
      assertMcpInvocationCurrent(invocation);
      const spawned = await spawnPaneAndMaybePrompt(options, {
        // Capture the PTY identity before missionPanes.record(). If that
        // durable write fails, the finally block must retain the reservation
        // instead of treating the spawn as if it never happened.
        onPaneCreated: (paneId) => {
          spawnedWorkerPaneId = paneId;
        },
        invocation,
      });
      return {
        ...spawned,
        ...(executionMode ? { executionMode } : {}),
      };
    } finally {
      if (releaseWorkerSlot) {
        const missionId = options.missionId;
        const recordedPaneIds =
          spawnedWorkerPaneId && missionId
            ? getProjectDomainStores(ctx.scope)
                .missionPanes.list(missionId)
                .map((pane) => pane.paneId)
                .filter((paneId): paneId is string => typeof paneId === 'string')
            : [];
        if (
          shouldReleaseWorkerReservation({
            spawnedPaneId: spawnedWorkerPaneId,
            recordedPaneIds,
          })
        ) {
          releaseWorkerSlot();
        } else {
          console.warn(
            '[tools-panes] worker spawned but not durably recorded; keeping ' +
              `maxWorkers reservation (mission=${missionId}, pane=${spawnedWorkerPaneId})`,
          );
        }
      }
    }
  },
};

const paneList: McpToolDef = {
  name: 'nexus_pane_list',
  description:
    'List every pane in the workspace with its live state ' +
    '(spawning|busy|idle|exited), adapter, model and mission binding.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => listVisiblePaneSnapshots(ctx),
};

const paneWhoami: McpToolDef = {
  name: 'nexus_pane_whoami',
  description:
    'Describe the calling pane and its effective authority: role, mission, ' +
    'agent/provider identity, project scope and tool/skill grants. Never returns ' +
    'the bearer token.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => ({
    label: ctx.label,
    role: ctx.role,
    sessionId: ctx.sessionId,
    missionId: ctx.missionId,
    contextRevision: ctx.contextRevision,
    agentName: ctx.agentName,
    providerId: ctx.providerId,
    readOnly: ctx.readOnly === true,
    scope: {
      installationId: ctx.scope.installationId,
      projectId: ctx.scope.projectId,
      checkoutId: ctx.scope.checkoutId,
      rootRealPath: ctx.scope.rootRealPath,
    },
    executionRoot: ctx.executionScope?.rootRealPath ?? ctx.scope.rootRealPath,
    allowedTools: ctx.allowedTools,
    allowedSkills: ctx.allowedSkills,
  }),
};

const paneListProviders: McpToolDef = {
  name: 'nexus_pane_list_providers',
  description:
    'List the CLI/API providers (adapters) available on this machine: id, ' +
    'label, models, install status.',
  inputSchema: { type: 'object', properties: {} },
  // `listAdapterInfos()` carrega `resolvedBinPath` — caminho ABSOLUTO, que na
  // prática contém o nome de usuário do sistema operacional. Devolvê-lo
  // verbatim entregava esse dado a todo agente que listasse providers, sem
  // nenhuma decisão depender dele: para escolher provider basta saber se está
  // instalado.
  //
  // Projeção campo a campo, NÃO rest-spread: filtro por exclusão deixa qualquer
  // campo novo do registry vazar por omissão — o oposto da garantia que este
  // comentário precisa sustentar. Campo novo aqui é decisão consciente.
  handler: async () =>
    listAdapterInfos().map((info) => ({
      id: info.id,
      kind: info.kind,
      label: info.label,
      icon: info.icon,
      models: info.models,
      installed: info.installed,
      installCommand: info.installCommand,
      loginHint: info.loginHint,
      idleTimeoutMs: info.idleTimeoutMs,
      orchestratorCapable: info.orchestratorCapable,
      taskHandoffCapable: info.taskHandoffCapable,
      missionControlCapable: info.missionControlCapable,
      autonomousWorkspaceWriteCapable: info.autonomousWorkspaceWriteCapable,
      orchestrationEvidence: info.orchestrationEvidence,
    })),
};

const paneRead: McpToolDef = {
  name: 'nexus_pane_read',
  description:
    "Read the tail of a pane's terminal output as plain text (ANSI " +
    'stripped). paneId also accepts a sessionId.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      lines: {
        type: 'number',
        description: 'Max lines from the tail (default 200)',
      },
    },
    required: ['paneId'],
  },
  handler: async (args, ctx) => {
    const sessionId = authorizedSessionIdOf(ctx, requireStr(args, 'paneId'), 'read');
    return readSessionOutput(sessionId, num(args, 'lines') ?? 200);
  },
};

const paneReadMany: McpToolDef = {
  name: 'nexus_pane_read_many',
  description: 'Read the output tails of several panes at once.',
  inputSchema: {
    type: 'object',
    properties: {
      paneIds: { type: 'array', items: { type: 'string' } },
      lines: { type: 'number' },
    },
    required: ['paneIds'],
  },
  handler: async (args, ctx) => {
    const lines = num(args, 'lines') ?? 200;
    return strArray(args, 'paneIds').map((paneId) => {
      try {
        return {
          paneId,
          output: readSessionOutput(authorizedSessionIdOf(ctx, paneId, 'read'), lines),
        };
      } catch (err) {
        return {
          paneId,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
  },
};

const paneWrite: McpToolDef = {
  name: 'nexus_pane_write',
  description:
    "Type text into a pane's terminal. By default an Enter keypress is sent " +
    'after the text (submit: false to suppress).',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      text: { type: 'string' },
      submit: {
        type: 'boolean',
        description: 'Press Enter after the text (default true)',
      },
    },
    required: ['paneId', 'text'],
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const sessionId = authorizedSessionIdOf(ctx, requireStr(args, 'paneId'), 'write');
    const text = typeof args.text === 'string' ? args.text : '';
    if (args.submit === false) {
      assertMcpInvocationCurrent(invocation);
      orchWriteSession(sessionId, text);
    } else {
      await injectPrompt(sessionId, text, invocation);
    }
    return { ok: true };
  },
};

const paneWriteMany: McpToolDef = {
  name: 'nexus_pane_write_many',
  description:
    'Write prompts to several panes in one call. writes: ' +
    '[{paneId, text, submit?}].',
  inputSchema: {
    type: 'object',
    properties: {
      writes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            paneId: { type: 'string' },
            text: { type: 'string' },
            submit: { type: 'boolean' },
          },
          required: ['paneId', 'text'],
        },
      },
    },
    required: ['writes'],
  },
  handler: async (args, ctx, invocation) => {
    const writes = Array.isArray(args.writes) ? args.writes : [];
    const results: Array<{ paneId: string; ok: boolean; error?: string }> = [];
    for (const raw of writes) {
      // Do not turn a revoked batch into N best-effort writes. Every iteration
      // revalidates outside the per-item error wrapper so revocation stops it.
      assertMcpInvocationCurrent(invocation);
      const write = raw as { paneId?: string; text?: string; submit?: boolean };
      if (typeof write.paneId !== 'string' || typeof write.text !== 'string') {
        results.push({
          paneId: String(write.paneId),
          ok: false,
          error: 'invalid write',
        });
        continue;
      }
      try {
        const sessionId = authorizedSessionIdOf(ctx, write.paneId, 'write');
        if (write.submit === false) {
          assertMcpInvocationCurrent(invocation);
          orchWriteSession(sessionId, write.text);
        } else {
          await injectPrompt(sessionId, write.text, invocation);
        }
        results.push({ paneId: write.paneId, ok: true });
      } catch (err) {
        results.push({
          paneId: write.paneId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  },
};

const paneClose: McpToolDef = {
  name: 'nexus_pane_close',
  description: 'Close a pane (collapses the layout and kills its session).',
  inputSchema: {
    type: 'object',
    properties: { paneId: { type: 'string' } },
    required: ['paneId'],
  },
  handler: async (args, ctx) => {
    const info = authorizePaneRef(ctx, requireStr(args, 'paneId'), 'close');
    if (!(await requestPaneClose(info.paneId))) {
      throw new Error('no renderer window available');
    }
    return { ok: true };
  },
};

const paneWaitIdle: McpToolDef = {
  name: 'nexus_pane_wait_idle',
  description:
    "Block until a pane's CLI goes idle (finished responding), exits, or " +
    'the timeout elapses. Returns {state, output} with the fresh tail. ' +
    `timeoutMs is capped at ${PANE_WAIT_TIMEOUT_CAP_MS} per call; on state ` +
    '"timeout" call again to keep waiting.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      timeoutMs: { type: 'number', description: 'Default 120000' },
      lines: { type: 'number' },
    },
    required: ['paneId'],
  },
  handler: async (args, ctx) => {
    const sessionId = authorizedSessionIdOf(ctx, requireStr(args, 'paneId'), 'wait');
    const state = await waitForIdle(
      sessionId,
      Math.min(num(args, 'timeoutMs') ?? 120_000, PANE_WAIT_TIMEOUT_CAP_MS),
    );
    return {
      state,
      output: readSessionOutput(sessionId, num(args, 'lines') ?? 60),
    };
  },
};

const paneWaitMany: McpToolDef = {
  name: 'nexus_pane_wait_many',
  description:
    'Wait on several panes. returnOn "any" resolves at the first idle pane; ' +
    '"all" waits for every pane (default). Returns per-pane states. ' +
    `timeoutMs is capped at ${PANE_WAIT_TIMEOUT_CAP_MS} per call; while ` +
    'panes return "timeout", call again to keep waiting.',
  inputSchema: {
    type: 'object',
    properties: {
      paneIds: { type: 'array', items: { type: 'string' } },
      returnOn: { type: 'string', enum: ['any', 'all'] },
      timeoutMs: { type: 'number' },
    },
    required: ['paneIds'],
  },
  handler: async (args, ctx) => {
    const paneIds = strArray(args, 'paneIds');
    const timeoutMs = Math.min(
      num(args, 'timeoutMs') ?? 300_000,
      PANE_WAIT_TIMEOUT_CAP_MS,
    );
    const waits = paneIds.map(async (paneId) => {
      try {
        const state = await waitForIdle(
          authorizedSessionIdOf(ctx, paneId, 'wait'),
          timeoutMs,
        );
        return { paneId, state };
      } catch (err) {
        return {
          paneId,
          state: 'error' as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
    if (args.returnOn === 'any' && waits.length > 0) {
      const first = await Promise.race(waits);
      return { first, pending: paneIds.filter((p) => p !== first.paneId) };
    }
    return Promise.all(waits);
  },
};

export function buildPaneTools(): McpToolDef[] {
  return [
    paneSpawn,
    paneList,
    paneWhoami,
    paneListProviders,
    paneRead,
    paneReadMany,
    paneWrite,
    paneWriteMany,
    paneClose,
    paneWaitIdle,
    paneWaitMany,
  ];
}

/** Reused by nexus_mission_spawn_pane / nexus_agent_invoke. */
export const paneSpawnTool = paneSpawn;
