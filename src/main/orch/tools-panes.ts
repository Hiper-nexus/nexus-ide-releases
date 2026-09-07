import {
  assertMcpInvocationCurrent,
  type McpToolDef,
} from './mcp-protocol';
import type { PaneSnapshot } from '../../shared/orch-types';
import {
  getPaneRuntimeAuthorityBySession,
  listPaneSnapshots,
  listVisiblePaneSnapshots,
  newOutputSince,
  readSessionOutput,
  requestPaneClose,
  waitForIdle,
  waitForNextIdle,
} from './pane-registry';
import { inspectSessionLease, orchWriteSession, sessionLeaseRegistry } from '../pty/pty-manager';
import {
  listAdapterInfos,
} from '../adapters/adapter-registry';
import {
  armAutoCloseOnHandoff,
  selectScopedPaneCloseTargets,
} from './pane-close-scopes';
import { findAgentInSquad, getSquad, squadRoutableCliIds } from './squad-store';
import { adHocSpawnGateError } from './route-provenance';
import { recordRouteLog } from './route-log';
import {
  isFreeAgentChoiceContract,
  requiresRouteReservation,
  squadBindingViolationError,
} from './free-agent-choice';
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
import {
  honorSealedRosterRuntime,
  uniqueSealedRuntimeForAdapter,
} from '../../shared/sealed-agent-runtime';
import { getContextWorkflowService } from '../context/context-workflow-registry';
import {
  isTaskQueueManagedMission,
  viaRapidaAllowsOrchestratorWorkerSpawn,
} from './task-dispatch-authority';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import { missionControlPlaneSnapshot } from './mission-control-plane-ipc';
import { getOrchSettings } from '../persistence/settings-store';
import { isPaneMetaTask } from './mission-fast-lane';
import {
  decideMetaPaneWorkerSpawn,
  liveMissionWorkerCount,
  liveWorkerSeatKeys,
} from './via-rapida-first-wave';
import { AGENT_SEMANTIC_STATUSES } from './agent-status';
import {
  AGENT_PROMPT_EFFECT_TIMEOUT_MS,
  promptAgentAndWait,
  SEMANTIC_WAIT_DEFAULT_TIMEOUT_MS,
  waitForSemanticStatus,
} from './semantic-wait';

export function coerceSpawnReadOnly<T extends { readOnly?: boolean }>(
  options: T,
  callerReadOnly: boolean | undefined,
): T {
  if (callerReadOnly === true) {
    return { ...options, readOnly: true };
  }
  return options;
}

/** The pane + agent-wait tools of the embedded MCP server (tool group 1). */

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

function uniqueSealedRuntimeForMission(
  scope: ProjectExecutionScope,
  missionId: string,
  adapterId: string,
): { readonly model: string; readonly effort?: string } | null {
  try {
    const mission = getProjectDomainStores(scope).missions.get(missionId);
    if (!mission?.squadId) return null;
    const squad = getSquad(mission.squadId);
    if (!squad) return null;
    return uniqueSealedRuntimeForAdapter(squad.agents, adapterId);
  } catch {
    return null;
  }
}

/**
 * "Escolha livre de agentes" (opt-in por missão) lido do contrato de intenção
 * selado. Fail-safe: qualquer erro de leitura ou missão sem contrato = off, ou
 * seja, o caminho cerimonial atual permanece intacto.
 */
function missionFreeAgentChoice(
  scope: ProjectExecutionScope,
  missionId: string,
): boolean {
  try {
    const mission = getProjectDomainStores(scope).missions.get(missionId);
    return isFreeAgentChoiceContract(mission?.intentContract);
  } catch {
    return false;
  }
}

const SAME_CHECKOUT_ACTIVE_STATES = new Set<PaneSnapshot['state']>([
  'spawning',
  'busy',
]);

/** Footer anexado a prompts de worker para lembrar o nexus_handoff_submit. */
const WORKER_HANDOFF_FOOTER =
  '[Ao terminar, chame nexus_handoff_submit uma vez com status, summary, artifacts e evidenceIds.]';

function withWorkerHandoffFooter(
  sessionId: string,
  text: string,
): string {
  const authority = getPaneRuntimeAuthorityBySession(sessionId);
  if (authority?.role !== 'worker' || text.includes('nexus_handoff_submit')) {
    return text;
  }
  return `${text}\n\n${WORKER_HANDOFF_FOOTER}`;
}

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
    // A doutrina (orchestrator-doctrine.ts) diz "1 worker ESCRITOR por vez".
    // Um worker readOnly/nativeReadOnly não muta o checkout compartilhado e
    // não pode ser o bloqueador serializador de um spawn paralelo — caso
    // contrário um único fan-out de leitura (mapa de viabilidade + auditoria)
    // fica serializado como se fosse escrita concorrente. Espelha o guard de
    // disjointness em mission-wave-pack.ts que já ignora não-escritores.
    !pane.readOnly &&
    !pane.nativeReadOnly &&
    pane.executionScope?.rootRealPath === checkoutRoot &&
    SAME_CHECKOUT_ACTIVE_STATES.has(pane.state),
  ) ?? null;
}

/**
 * 0.32.26: leitor acompanha escritor. Um spawn read-only (readOnly ou
 * nativeReadOnly) NÃO é recusado por um escritor ativo no mesmo checkout —
 * o relatório do Maestro (2026-08-17) mostrou o revisor read-only
 * serializado atrás do executor, atrasando a missão inteira. Leitura não
 * muta o WIP; a doutrina "1 escritor por vez" permanece intacta.
 */
export function decideSameCheckoutSpawn(input: {
  readonly spawnReadOnly: boolean;
  readonly activeWorker: { readonly paneId: string; readonly state: string } | null;
}): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
  if (!input.activeWorker) return { allowed: true };
  if (input.spawnReadOnly) return { allowed: true };
  return {
    allowed: false,
    reason:
      `same-checkout delegation is serialized; worker ${input.activeWorker.paneId} ` +
      `is still ${input.activeWorker.state}`,
  };
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

/** Worker may hand off; only orchestrator/maestro/user may create a pane. */
export function assertCallerMaySpawnPane(
  role: AgentGateContext['role'],
): void {
  if (role === 'worker') {
    throw new Error(
      'not authorized: workers cannot create panes — only the orchestrator may spawn',
    );
  }
}

const paneSpawn: McpToolDef = {
  name: 'nexus_pane_spawn',
  description:
    'Open a new terminal pane running an AI CLI. Provide agentName (a squad ' +
    'agent — inherits allowlists/title). The model and effort sealed on that ' +
    'roster member WIN over nexus_route_task, ranking, and the CLI default ' +
    '(Codex 5.5 / DeepSeek Flash / adapter.models.default). Pass adapterId ' +
    'only to fail over to a different CLI — never to substitute the sealed ' +
    'model on the same CLI. If the sealed model cannot be applied, spawn fails ' +
    'visibly. In a running mission, pass routeReservationId when the CLI is ' +
    'not the sticky roster route. Prompt is delivered in the CLI argv AT BIRTH. ' +
    'Returns {paneId, sessionId}.',
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
      readOnly: {
        type: 'boolean',
        description:
          'Spawn with provider-native read-only enforcement. Required before PREVC execution. ' +
          'Read-only workers spawn in parallel even with an active writer — use for review/analysis that edits nothing.',
      },
      autoCloseOnHandoff: {
        type: 'boolean',
        description:
          'Close this pane automatically when it submits a SUCCESS handoff ' +
          '(declared at birth; failure keeps the pane open for diagnosis).',
      },
      resume: {
        type: 'string',
        description:
          'Resume a CLOSED worker with its context intact: pass the task id ' +
          '("h-N") or the old paneId ("pane-N"). The new pane relaunches that ' +
          'worker\'s CLI session (e.g. claude --resume / codex resume) — same ' +
          'files and conversation in its head, zero re-briefing. Use for any ' +
          'adjustment/follow-up on a deliverable whose worker was already closed. ' +
          'Combine with prompt (the adjustment).',
      },
    },
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    assertCallerMaySpawnPane(ctx.role);
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
      const honored = honorSealedRosterRuntime({
        sealedCli: agent.cli,
        sealedModel: agent.model,
        sealedEffort: agent.effort,
        requestedAdapterId,
        requestedModel,
        requestedEffort,
      });
      const selectedAdapterId = honored.adapterId;
      const selectedModel = honored.model;
      const selectedEffort = honored.effort;
      const noRouteOverride =
        requestedAdapterId === undefined &&
        requestedModel === undefined &&
        requestedEffort === undefined;
      rosterRouteAuthorized = honored.rosterHonored || noRouteOverride;
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
        readOnly: args.readOnly === true,
        prompt: str(args, 'prompt'),
        scope: ctx.scope,
        resume: str(args, 'resume') ? true : undefined,
      };
    } else {
      const adHocAdapterId = requireStr(args, 'adapterId');
      const adHocModel = str(args, 'model');
      const adHocEffort = str(args, 'effort');
      const adHocMissionId = childMissionId(ctx, str(args, 'missionId'));
      const uniqueSealed = adHocMissionId
        ? uniqueSealedRuntimeForMission(
            ctx.scope,
            adHocMissionId,
            adHocAdapterId,
          )
        : null;
      const selectedAdHocModel = uniqueSealed?.model ?? adHocModel;
      const selectedAdHocEffort = uniqueSealed?.effort ?? adHocEffort;
      // Spawn ad-hoc (sem agentName): modelo com warning de catálogo (ex.:
      // grok-4.5) só entra se veio de uma decisão real do nexus_route_task.
      // Omitir o model NÃO contorna o gate: sem model explícito, o que roda é
      // o default do adapter — é ele que precisa passar na checagem. Roster
      // selado único para esta CLI vence esse default.
      const gateModel =
        selectedAdHocModel ?? defaultModelForAdapter(adHocAdapterId);
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
        model: selectedAdHocModel,
        effort: selectedAdHocEffort,
        cwd: str(args, 'cwd'),
        title: str(args, 'title'),
        missionId: adHocMissionId,
        contextRevision: ctx.contextRevision,
        // An MCP-initiated spawn is the orchestrator delegating: default to a
        // WORKER (gated) so an ad-hoc spawn without agentName never lands as an
        // unrestricted 'user'-role token (SEC#5).
        allowedTools: attenuateTools(ctx.allowedTools, []),
        allowedSkills: attenuateSkills(ctx.allowedSkills, null),
        role: 'worker',
        readOnly: args.readOnly === true,
        prompt: str(args, 'prompt'),
        scope: ctx.scope,
        resume: str(args, 'resume') ? true : undefined,
      };
    }
    // "Escolha livre de agentes" (opt-in por missão): atravessa os três gates
    // cerimoniais (release-qualified / squad_binding / route_reservation)
    // mantendo os guardrails que não são cerimônia. Lido do contrato selado e
    // propagado ao backstop físico via options.freeAgentChoice.
    const freeAgentChoice = options.missionId
      ? missionFreeAgentChoice(ctx.scope, options.missionId)
      : false;
    if (freeAgentChoice) {
      options = { ...options, freeAgentChoice: true };
    }
    // Gate (a): reject stale/sticky/non-reserved legacy roster choices before
    // consuming a route reservation or mutating any worker-slot/worktree state.
    // Free-choice widens the lane exactly like the global operator-choice
    // policy. The physical spawn path repeats this check as the final backstop.
    if (
      options.missionId &&
      options.role === 'worker' &&
      options.readOnly !== true &&
      !isMissionWorkerWriteEligibleCli(
        options.adapterId,
        isOperatorChoicePolicy(getOrchSettings().squadCliPolicy) ||
          freeAgentChoice,
      )
    ) {
      throw new Error(
        `governed_worker_spawn_unsupported: ${options.adapterId} não pode ` +
          'executar como worker autônomo de missão nesta release; use o ' +
          'adapter Codex builtin qualificado, ative Configurações › ' +
          'Squads › Escolha livre (ou inicie a missão em modo livre), ou ' +
          'abra esse CLI manualmente no Terminal fora da missão',
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
          // Plano selado + PREVC/worktree congelado: o dispatcher main-owned
          // materializa o worker. Via Rápida (sem freeze) precisa que o
          // Maestro continue spawnando — senão ele sela 20 stories e o
          // board fica 0/20 sem worker.
          let frozen = false;
          try {
            frozen = Boolean(
              getContextWorkflowService(ctx.scope).getMissionWorkflow(
                options.missionId,
              ).contract,
            );
          } catch {
            frozen = false;
          }
          if (
            !viaRapidaAllowsOrchestratorWorkerSpawn({
              isTaskQueueManaged: true,
              hasFrozenPrevContract: frozen,
            })
          ) {
            throw new Error(
              'task_dispatcher_authority: workers de uma missão planejada só podem ser ' +
                'criados pelo dispatcher durável do main; aguarde o Nexus despachar a task',
            );
          }
        }
        // Gate (b) — vínculo do squad no caminho agêntico: um worker ad-hoc
        // (sem agentName) só pode rodar numa CLI que o roster do squad selado da
        // missão contém. O conjunto é o roster INTEIRO (multi-CLI) — o gate
        // admite QUALQUER membro (claude/codex/gemini/...), nunca força um
        // provider só, e recusa uma CLI de fora do squad. Membros nomeados já
        // são vinculados pelo branch de agentName acima (findAgentInSquad +
        // agent.cli). Fail-open quando o roster é irresolúvel (conjunto vazio).
        // Modo livre dispensa o vínculo por completo.
        if (!agentRef && missionRow.squadId) {
          const bindingError = squadBindingViolationError({
            hasNamedAgent: false,
            missionSquadId: missionRow.squadId,
            rosterClis: squadRoutableCliIds(missionRow.squadId),
            adapterId: options.adapterId,
            freeAgentChoice,
          });
          if (bindingError) throw new Error(bindingError);
        }
        // Gate (c) — uma missão em execução exige routeReservationId de
        // nexus_route_task, salvo rota sticky do roster ou modo livre. No modo
        // livre a auditoria é preservada com um registro no route_log (spawn
        // sem reserva continua "ver para crer").
        if (
          requiresRouteReservation({
            missionRunning: missionRow.status === 'running',
            rosterRouteAuthorized,
            freeAgentChoice,
          })
        ) {
          if (!routeReservationId) {
            throw new Error(
              'route_reservation_required: missão em execução exige routeReservationId válido; ' +
                'chame nexus_route_task e repasse routeReservationId/adapterId/model/effort, ' +
                'use agentName sem substituir a rota sticky do roster, ' +
                'ou inicie a missão em modo livre (Escolha livre de agentes)',
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
        // Auditoria do modo livre: um spawn que atravessou o gate de reserva por
        // Escolha livre ainda é registrado no route_log — a decisão de rota
        // continua inspecionável ("ver para crer"), só sem a cerimônia da
        // reserva durável.
        if (
          freeAgentChoice &&
          missionRow.status === 'running' &&
          !rosterRouteAuthorized &&
          !routeReservationId &&
          options.role === 'worker'
        ) {
          recordRouteLog({
            task:
              options.prompt?.slice(0, 120) ??
              options.title ??
              options.agentName ??
              'worker ad-hoc',
            tier: 'free',
            adapterId: options.adapterId,
            ...(options.model ? { model: options.model } : {}),
            ...(options.effort ? { effort: options.effort } : {}),
            reason:
              'escolha livre de agentes (opt-in da missão): spawn sem ' +
              'RouteReservation nem squad_binding',
          });
        }
      }
      if (options.role === 'worker' && options.missionId) {
        const missionId = options.missionId;
        // Enforce maxWorkers + parent deny attenuation (intent contract teeth).
        const suite = missionSuite!;
        if (!missionRow?.intentContract) {
          throw new Error('approval_required: current mission contract unavailable');
        }
        const liveSnapshotStates = new Map(
          listPaneSnapshots().map((pane) => [pane.paneId, pane.state] as const),
        );
        const metaPaneMission =
          isPaneMetaTask(missionRow.description ?? '') ||
          isPaneMetaTask(missionRow.title ?? '');
        if (metaPaneMission) {
          const squad = missionRow.squadId
            ? getSquad(missionRow.squadId)
            : null;
          const fromRows = suite
            .missionPanes.list(missionId)
            .filter((row) => row.role === 'worker')
            .filter((row) => {
              if (!row.paneId) return true;
              const state = liveSnapshotStates.get(row.paneId);
              return state !== undefined && state !== 'exited';
            })
            .flatMap((row) =>
              [row.agentName, row.title].filter(
                (key): key is string =>
                  typeof key === 'string' && key.length > 0,
              ),
            );
          const liveKeys = [
            ...liveWorkerSeatKeys(listPaneSnapshots(), missionId),
            ...fromRows,
          ];
          const liveCount = liveMissionWorkerCount(
            listPaneSnapshots(),
            missionId,
          );
          const decision = decideMetaPaneWorkerSpawn({
            isMetaPaneMission: true,
            requestedAgentName: options.agentName,
            rosterWorkerNames: (squad?.agents ?? [])
              .filter((agent) => agent.category !== 'orchestrator')
              .map((agent) => agent.agentName),
            liveWorkerKeys: liveKeys,
            liveWorkerCount: Math.max(liveCount, fromRows.length),
          });
          if (!decision.allowed) throw new Error(decision.reason);
        }
        // Slots contam só workers VIVOS: linha durável de worker morto/fechado
        // não pode segurar maxWorkers para sempre (deadlock de campo). A
        // reserva `pendingWorkerSpawns` cobre o período de pré-bind; depois de
        // gravado o pane precisa aparecer nos snapshots — se sumiu, é morto.
        const liveWorkerCount = suite.missionPanes
          .list(missionId)
          .filter((row) => row.role === 'worker')
          .filter((row) => {
            if (!row.paneId) return true; // reserva de pré-bind
            const state = liveSnapshotStates.get(row.paneId);
            return state !== undefined && state !== 'exited';
          }).length;
        const policy = reserveWorkerSpawnSlot({
          scope: ctx.scope,
          missionId,
          contract: missionRow.intentContract,
          currentWorkerCount: liveWorkerCount,
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
          const decision = decideSameCheckoutSpawn({
            spawnReadOnly:
              options.readOnly === true ||
              options.executionMode === 'read_only',
            activeWorker: activeSameCheckoutWorker(
              listPaneSnapshots(),
              ctx.scope.rootRealPath,
            ),
          });
          if (!decision.allowed) {
            throw new Error(decision.reason);
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
      // A read-only caller can delegate/spawn, but the spawned pane itself must
      // inherit the read-only confinement; handlers downstream trust this flag.
      options = coerceSpawnReadOnly(options, ctx.readOnly);
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
      // F-104: sem marcação de "handoff pendente" no spawn — o marcador só
      // era limpo por um submit do próprio worker e vetava o fechamento
      // mecânico para sempre. A dedup por janela de turno basta.
      // Declarado no nascimento (registro, não pergunta): o pane se fecha
      // sozinho no handoff SUCCESS — paridade Bridge, libera a vaga sem
      // segurar slot da onda seguinte; falha preserva pane para diagnóstico.
      if (args.autoCloseOnHandoff === true && spawned.sessionId) {
        armAutoCloseOnHandoff(spawned.sessionId, spawned.paneId);
      }
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
    'List the panes this caller may see (same mission; never the user\'s ' +
    'shell). Use this to resolve a spoken "pane 7" / peer title before ' +
    'nexus_pane_read. Each pane reports paneId (protocol identity) and ' +
    'paneNumber (the short header number the operator says out loud); ' +
    'either is accepted wherever a paneId is taken. Live state is ' +
    'spawning|busy|idle|exited, plus adapter, model and mission binding.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => listVisiblePaneSnapshots(ctx),
};

const missionControl: McpToolDef = {
  name: 'nexus_mission_control',
  description:
    'Mission-wide control-plane snapshot in ONE read: every pane with live ' +
    'activity (working|idle|dead) and current task, the task queue with wave ' +
    'order and dispatch state, the per-task ownership map, and named blocks ' +
    '(mission-level cause + per-task sanitized errors). Defaults to the ' +
    "calling pane's mission.",
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'Mission to inspect; defaults to the caller mission.',
      },
    },
  },
  handler: async (args, ctx) => {
    const requested =
      typeof args.missionId === 'string' && args.missionId.length > 0
        ? args.missionId
        : ctx.missionId;
    if (!requested) {
      throw new Error(
        'nexus_mission_control: informe missionId (o pane chamador não está ' +
          'vinculado a uma missão).',
      );
    }
    // Workers enxergam apenas a própria missão — mesma fronteira de
    // visibilidade do nexus_pane_list (SEC#5 info disclosure).
    if (ctx.role === 'worker' && ctx.missionId && requested !== ctx.missionId) {
      throw new Error(
        'nexus_mission_control: um worker só inspeciona a própria missão.',
      );
    }
    const stores = getProjectDomainStores(ctx.scope);
    const mission = stores.missions.get(requested);
    if (!mission) {
      throw new Error(`nexus_mission_control: missão ${requested} não existe.`);
    }
    return missionControlPlaneSnapshot(
      stores,
      mission,
      listVisiblePaneSnapshots(ctx),
      Date.now(),
    );
  },
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
    "Read the tail of a pane's terminal as plain text (ANSI stripped). " +
    'When the operator says "look at what pane X is doing" / "olha o que ' +
    'o pane X está fazendo", call this once with that pane — do not poll ' +
    'in a loop (completion arrives via handoff_submit). Any pane in the ' +
    'same mission may read any other, including the orchestrator/senior; ' +
    'other missions and the user\'s shell/browser are refused. paneId ' +
    'accepts paneId, sessionId, or the spoken header number ("7", "pane 7").',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: {
        type: 'string',
        description:
          'Pane identity: paneId, sessionId, or the short pane number the ' +
          'operator sees in the header ("7" or "pane 7").',
      },
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
  description:
    'Read the output tails of several panes at once. Same visibility as ' +
    'nexus_pane_read: same-mission peers including the orchestrator; ' +
    'unknown / other-mission / user-shell targets return per-item errors. ' +
    'Prefer this over looping nexus_pane_read; prefer handoff_list when ' +
    'you only need structured completion, not the raw PTY.',
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
      paneId: {
        type: 'string',
        description:
          'Pane identity: paneId, sessionId, or the short pane number the ' +
          'operator sees in the header ("7" or "pane 7").',
      },
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
    const text = withWorkerHandoffFooter(
      sessionId,
      typeof args.text === 'string' ? args.text : '',
    );
    if (args.submit === false) {
      assertMcpInvocationCurrent(invocation);
      orchWriteSession(sessionId, text);
    } else {
      await injectPrompt(sessionId, text, invocation);
    }
    return { ok: true };
  },
};

/** Uma pergunta em voo por sessão: evita tempestade de asks cruzados. */
const paneAskInFlight = new Set<string>();

const paneAsk: McpToolDef = {
  name: 'nexus_pane_ask',
  description:
    'Converse com outro pane da missão: envia a pergunta para o terminal ' +
    'dele, aguarda a resposta (idle) e devolve APENAS o texto novo. ' +
    'Qualquer pane pode perguntar a qualquer worker da missão (pane-authz ' +
    'continua a fronteira: worker não escreve no orquestrador nem toca ' +
    'shell/browser). Prefira isto a write+wait+read manuais.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: {
        type: 'string',
        description:
          'Pane alvo: paneId, sessionId ou o número do cabeçalho ("7").',
      },
      question: { type: 'string', description: 'Pergunta (até 4000 chars).' },
      timeoutMs: {
        type: 'number',
        description: 'Espera máxima pela resposta (default 60000, máx 120000).',
      },
    },
    required: ['paneId', 'question'],
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const question = requireStr(args, 'question');
    if (question.length > 4_000) {
      throw new Error('pergunta longa demais (máx 4000 chars)');
    }
    const timeoutMs = Math.min(
      Math.max(Math.round(num(args, 'timeoutMs') ?? 60_000), 1_000),
      120_000,
    );
    const sessionId = authorizedSessionIdOf(
      ctx,
      requireStr(args, 'paneId'),
      'write',
    );
    if (ctx.sessionId && sessionId === ctx.sessionId) {
      throw new Error('pergunte a OUTRO pane — este é o seu próprio');
    }
    const asker = ctx.sessionId ?? 'anon';
    if (paneAskInFlight.has(asker)) {
      throw new Error(
        'você já tem uma pergunta em voo — aguarde a resposta antes de outra',
      );
    }
    paneAskInFlight.add(asker);
    try {
      const before = readSessionOutput(sessionId, 200);
      await injectPrompt(sessionId, question, invocation);
      // Worker já idle (Codex no prompt) não pode resolver na hora — senão o
      // Maestro colhe a tela antiga, chama nexus 6 vezes e o "3" nasce depois.
      const state = await waitForNextIdle(sessionId, timeoutMs);
      const after = readSessionOutput(sessionId, 400);
      const answer = newOutputSince(before, after).trim();
      return {
        ok: state === 'idle' && answer.length > 0,
        state,
        answer:
          answer.length > 0
            ? answer.slice(0, 8_000)
            : '(o pane não produziu texto novo dentro do prazo)',
      };
    } finally {
      paneAskInFlight.delete(asker);
    }
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
            paneId: {
        type: 'string',
        description:
          'Pane identity: paneId, sessionId, or the short pane number the ' +
          'operator sees in the header ("7" or "pane 7").',
      },
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
        const text = withWorkerHandoffFooter(sessionId, write.text ?? '');
        if (write.submit === false) {
          assertMcpInvocationCurrent(invocation);
          orchWriteSession(sessionId, text);
        } else {
          await injectPrompt(sessionId, text, invocation);
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
  description:
    'Close a pane (collapses the layout and kills its session). Pass paneId ' +
    'for one pane, OR scope (caller_mission | caller_workspace) to close the ' +
    'named set: never the caller, never orchestrators, and running workers ' +
    'of OTHER missions are preserved.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: {
        type: 'string',
        description:
          'Pane identity: paneId, sessionId, or the short pane number the ' +
          'operator sees in the header ("7" or "pane 7").',
      },
      scope: {
        type: 'string',
        enum: ['caller_mission', 'caller_workspace'],
        description:
          'Explicit close scope (coordination parity): the caller NAMES what ' +
          'closes; nothing implicit.',
      },
      startKey: {
        type: 'string',
        description: 'Optional startKey proof issued when session was spawned',
      },
    },
  },
  handler: async (args, ctx) => {
    const scope = str(args, 'scope');
    if (!scope) {
      const info = authorizePaneRef(ctx, requireStr(args, 'paneId'), 'close');
      const startKey = str(args, 'startKey');
      if (startKey && info.sessionId) {
        const auth = sessionLeaseRegistry.authorizeKill(info.sessionId, startKey);
        if (!auth.ok) {
          throw new Error(`pane_close refused: ${auth.reason}`);
        }
      }
      if (!(await requestPaneClose(info.paneId))) {
        throw new Error('no renderer window available');
      }
      return { ok: true };
    }
    if (scope !== 'caller_mission' && scope !== 'caller_workspace') {
      throw new Error(`unknown close scope: ${scope}`);
    }
    if (ctx.role === 'worker') {
      throw new Error('not authorized: workers cannot scope-close panes');
    }
    const suite = getProjectDomainStores(ctx.scope);
    const selection = selectScopedPaneCloseTargets({
      scope,
      callerSessionId: ctx.sessionId,
      callerMissionId: ctx.missionId,
      callerScopeRoot: ctx.scope.rootRealPath,
      panes: listPaneSnapshots().map((pane) => ({
        paneId: pane.paneId,
        sessionId: pane.sessionId ?? undefined,
        missionId: pane.missionId,
        role: pane.role,
        scopeRoot: pane.scope?.rootRealPath,
      })),
      isMissionRunning: (missionId) =>
        suite.missions.get(missionId)?.status === 'running',
    });
    const closed: string[] = [];
    for (const paneId of selection.close) {
      try {
        if (await requestPaneClose(paneId)) closed.push(paneId);
      } catch (error) {
        console.warn(`[pane-close] scope close failed for ${paneId}:`, error);
      }
    }
    return { ok: true, closed, skipped: selection.skipped };
  },
};

/** Timeout máximo para confirmação de boot — 30s, abaixo do cap MCP. */
export const PANE_BOOT_TIMEOUT_MS = 30_000;

const paneWaitIdle: McpToolDef = {
  name: 'nexus_pane_wait_idle',
  description:
    'Boot confirmation only — hard-capped at 30s. Confirms a pane came up ' +
    'and its CLI is ready. NEVER use this to wait for worker RESULTS ' +
    '(results arrive via nexus_handoff_submit and wake you automatically). ' +
    'Returns {state}. On timeout the pane is still booting — call again or ' +
    'proceed (the pane will finish booting on its own).',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: {
        type: 'string',
        description:
          'Pane identity: paneId, sessionId, or the short pane number.',
      },
      timeoutMs: {
        type: 'number',
        description: `Max wait in ms. Default ${PANE_BOOT_TIMEOUT_MS} (30s). Hard cap ${PANE_BOOT_TIMEOUT_MS}.`,
      },
      poll: {
        type: 'boolean',
        description: 'If true, return current status immediately without blocking.',
      },
    },
    required: ['paneId'],
  },
  handler: async (args, ctx) => {
    const sessionId = authorizedSessionIdOf(ctx, requireStr(args, 'paneId'), 'wait');
    const requestedTimeout = num(args, 'timeoutMs');
    const effectiveTimeout = Math.min(
      requestedTimeout ?? PANE_BOOT_TIMEOUT_MS,
      PANE_BOOT_TIMEOUT_MS,
    );
    if (args.poll === true) {
      const state = await waitForIdle(sessionId, 0);
      return { state };
    }
    const state = await waitForIdle(sessionId, effectiveTimeout);
    return { state };
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

const AGENT_WAIT_UNTIL_SCHEMA = {
  type: 'array',
  items: { type: 'string', enum: [...AGENT_SEMANTIC_STATUSES] },
  description:
    'Semantic statuses that settle the wait ' +
    '(default ["idle", "completed", "awaiting-input"]).',
};

const AGENT_TARGET_SCHEMA = {
  type: 'string',
  description:
    'Agent pane: paneId, sessionId, or the short pane number the operator ' +
    'sees in the header ("7" or "pane 7").',
};

const agentWait: McpToolDef = {
  name: 'nexus_agent_wait',
  description:
    "Wait for a managed agent's SEMANTIC status (working | completed | " +
    'awaiting-input | idle | error), event-driven with no polling — the ' +
    'provider-hook state, unlike nexus_pane_wait_idle which only watches PTY ' +
    'boot/quiet. Use it to wait for a turn to finish or for a permission ' +
    'dialog to open. The wait is pinned to the exact agent occupying the ' +
    'pane: if the session exits or a substitute process respawns in the pane, ' +
    'the call fails with agent_not_running instead of matching the wrong ' +
    'process. On timeout the current status is probed one last time before ' +
    'the call fails with timeout.',
  inputSchema: {
    type: 'object',
    properties: {
      target: AGENT_TARGET_SCHEMA,
      until: AGENT_WAIT_UNTIL_SCHEMA,
      timeoutMs: {
        type: 'number',
        description: `Max wait in ms. Default ${SEMANTIC_WAIT_DEFAULT_TIMEOUT_MS}. Hard cap ${PANE_WAIT_TIMEOUT_CAP_MS} — on "timeout", call again to keep waiting.`,
      },
    },
    required: ['target'],
  },
  handler: async (args, ctx, invocation) => {
    const sessionId = authorizedSessionIdOf(ctx, requireStr(args, 'target'), 'wait');
    const timeoutMs = Math.min(
      num(args, 'timeoutMs') ?? SEMANTIC_WAIT_DEFAULT_TIMEOUT_MS,
      PANE_WAIT_TIMEOUT_CAP_MS,
    );
    return waitForSemanticStatus(
      { sessionId },
      { until: strArray(args, 'until'), timeoutMs, signal: invocation?.signal },
    );
  },
};

const agentPrompt: McpToolDef = {
  name: 'nexus_agent_prompt',
  description:
    'Atomic prompt+wait on a managed agent pane. Fails with agent_blocked ' +
    'WITHOUT writing anything when the agent is already awaiting interactive ' +
    'input (permission/question dialog) — answer that dialog first. The ' +
    'prompt is written through the same path as nexus_pane_write; afterwards ' +
    `an activity gate requires an observed effect within ${AGENT_PROMPT_EFFECT_TIMEOUT_MS}ms ` +
    '(turn start or status transition), else agent_prompt_stalled. Pass ' +
    'wait.until / wait.timeout_ms to also wait for the semantic status ' +
    '(default until: idle, completed, awaiting-input); omit `wait` for ' +
    'fire-and-forget submission confirmation. The whole call is pinned to ' +
    'the exact agent: a respawned substitute in the same pane fails with ' +
    'agent_not_running.',
  inputSchema: {
    type: 'object',
    properties: {
      target: AGENT_TARGET_SCHEMA,
      text: { type: 'string', description: 'Prompt text (submitted with Enter).' },
      wait: {
        type: 'object',
        properties: {
          until: AGENT_WAIT_UNTIL_SCHEMA,
          timeout_ms: {
            type: 'number',
            description: `Total budget in ms (submission + activity gate + status wait). Default ${SEMANTIC_WAIT_DEFAULT_TIMEOUT_MS}. Hard cap ${PANE_WAIT_TIMEOUT_CAP_MS}.`,
          },
        },
      },
    },
    required: ['target', 'text'],
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const sessionId = authorizedSessionIdOf(ctx, requireStr(args, 'target'), 'write');
    const text = withWorkerHandoffFooter(sessionId, requireStr(args, 'text'));
    const waitArgs = args.wait as
      | { until?: unknown; timeout_ms?: unknown }
      | undefined;
    const requestedTimeoutMs =
      waitArgs &&
      typeof waitArgs.timeout_ms === 'number' &&
      Number.isFinite(waitArgs.timeout_ms)
        ? waitArgs.timeout_ms
        : SEMANTIC_WAIT_DEFAULT_TIMEOUT_MS;
    return promptAgentAndWait({
      sessionId,
      text,
      write: (targetSessionId, prompt) =>
        injectPrompt(targetSessionId, prompt, invocation),
      wait: waitArgs
        ? {
            until: Array.isArray(waitArgs.until)
              ? waitArgs.until.filter(
                  (status): status is string => typeof status === 'string',
                )
              : undefined,
            timeoutMs: Math.min(requestedTimeoutMs, PANE_WAIT_TIMEOUT_CAP_MS),
          }
        : undefined,
      signal: invocation?.signal,
    });
  },
};

const sessionLeaseInspect: McpToolDef = {
  name: 'nexus_session_lease_inspect',
  description:
    'Inspect the active physical lease and startKey proof for a session ID. ' +
    'Returns the lease metadata if active, or null if unleased or terminated.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Session ID to inspect lease for',
      },
    },
    required: ['sessionId'],
  },
  handler: async (args) => {
    const sessionId = requireStr(args, 'sessionId');
    const lease = inspectSessionLease(sessionId);
    return { ok: true, lease };
  },
};

export function buildPaneTools(): McpToolDef[] {
  return [
    paneSpawn,
    paneList,
    missionControl,
    paneWhoami,
    paneListProviders,
    paneRead,
    paneReadMany,
    paneWrite,
    paneWriteMany,
    paneAsk,
    paneClose,
    paneWaitIdle,
    paneWaitMany,
    agentWait,
    agentPrompt,
    sessionLeaseInspect,
  ];
}

/** Reused by nexus_mission_spawn_pane / nexus_agent_invoke. */
export const paneSpawnTool = paneSpawn;
