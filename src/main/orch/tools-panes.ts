import type { McpToolDef } from './mcp-protocol';
import type { PaneSnapshot } from '../../shared/orch-types';
import {
  listPaneSnapshots,
  listVisiblePaneSnapshots,
  readSessionOutput,
  requestPaneClose,
  waitForIdle,
} from './pane-registry';
import { orchWriteSession } from '../pty/pty-manager';
import { listAdapterInfos } from '../adapters/adapter-registry';
import { findAgentInSquad } from './squad-store';
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
import { canonicalToolName, type AgentGateContext } from './gate';
import { applyWorkerSpawnPolicy } from '../../shared/mission-intent';
import type { MissionIntentContract } from '../../shared/mission-intent';
import type { ProjectExecutionScope } from '../../shared/types';
import { getContextWorkflowService } from '../context/context-workflow-registry';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { getProjectDomainStores } from './project-domain-store-registry';

/** The 11 pane tools of the embedded MCP server (tool group 1). */

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
    'nexus_route_task: the explicit adapterId/model WIN over the roster ' +
    'defaults (cost routing). Optional prompt is typed into the CLI once it ' +
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
      taskId: { type: 'string' },
      prompt: { type: 'string' },
    },
  },
  handler: async (args, ctx) => {
    const agentRef = str(args, 'agentName');
    let options: SpawnToolOptions;
    let executionMode: 'same_checkout' | 'isolated_worktree' | undefined;
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
      options = {
        // Roteamento de custo: o adapterId vindo do route_task vence o
        // default do roster — senão o squad inteiro cai num modelo só.
        adapterId: str(args, 'adapterId') ?? agent.cli,
        model: str(args, 'model') ?? agent.model,
        effort: str(args, 'effort') ?? agent.effort,
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
      options = {
        adapterId: requireStr(args, 'adapterId'),
        model: str(args, 'model'),
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
    let releaseWorkerSlot: (() => void) | undefined;
    try {
      if (options.role === 'worker' && options.missionId) {
        const missionId = options.missionId;
        // Enforce maxWorkers + parent deny attenuation (intent contract teeth).
        const suite = getProjectDomainStores(ctx.scope);
        const missionRow = suite.missions.get(missionId);
        if (!missionRow?.intentContract) {
          throw new Error('approval_required: current mission contract unavailable');
        }
        const liveWorkers = suite.missionPanes
          .list(missionId)
          .filter((pane) => pane.role === 'worker').length;
        const policy = reserveWorkerSpawnSlot({
          scope: ctx.scope,
          missionId,
          contract: missionRow.intentContract,
          currentWorkerCount: liveWorkers,
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
      const spawned = await spawnPaneAndMaybePrompt(options);
      return {
        ...spawned,
        ...(executionMode ? { executionMode } : {}),
      };
    } finally {
      releaseWorkerSlot?.();
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
  handler: async () => listAdapterInfos(),
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
  handler: async (args, ctx) => {
    const sessionId = authorizedSessionIdOf(ctx, requireStr(args, 'paneId'), 'write');
    const text = typeof args.text === 'string' ? args.text : '';
    if (args.submit === false) {
      orchWriteSession(sessionId, text);
    } else {
      await injectPrompt(sessionId, text);
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
  handler: async (args, ctx) => {
    const writes = Array.isArray(args.writes) ? args.writes : [];
    const results: Array<{ paneId: string; ok: boolean; error?: string }> = [];
    for (const raw of writes) {
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
          orchWriteSession(sessionId, write.text);
        } else {
          await injectPrompt(sessionId, write.text);
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
    if (!requestPaneClose(info.paneId)) {
      throw new Error('no renderer window available');
    }
    return { ok: true };
  },
};

const paneWaitIdle: McpToolDef = {
  name: 'nexus_pane_wait_idle',
  description:
    "Block until a pane's CLI goes idle (finished responding), exits, or " +
    'the timeout elapses. Returns {state, output} with the fresh tail.',
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
      num(args, 'timeoutMs') ?? 120_000,
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
    '"all" waits for every pane (default). Returns per-pane states.',
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
    const timeoutMs = num(args, 'timeoutMs') ?? 300_000;
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
