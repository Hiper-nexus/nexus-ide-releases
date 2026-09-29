import { assertTabSupportsOperation, missionExecutionScope } from './mission-execution-scope';
import {
  assertMcpInvocationCurrent,
  type McpToolDef,
  type McpToolInvocation,
} from './mcp-protocol';
import type { PaneSnapshot } from '../../shared/orch-types';
import {
  getPaneRuntimeAuthorityBySession,
  listPaneSnapshots,
  listVisiblePaneSnapshots,
  newOutputSince,
  readSessionOutput,
  requestPaneClose,
  PENDING_SPAWN_RESULT,
  takePendingPaneSpawnResult,
  waitForIdle,
  waitForNextIdle,
  findPane,
} from './pane-registry';
import {
  getAgentSessionInfo,
  getSessionState,
  inspectSessionLease,
  orchWriteSession,
  sessionLeaseRegistry,
} from '../pty/pty-manager';
import {
  getAdapter,
  listAdapterInfos,
  listAdapters,
} from '../adapters/adapter-registry';
import { canUseNexusMcp } from './cli-mcp-inject';
import { adapterSchema } from '../../shared/adapter-types';
import {
  armAutoCloseOnHandoff,
  armAutoCloseOnHandoffForPane,
  selectScopedPaneCloseTargets,
} from './pane-close-scopes';
import { armDeliveryContract, parseExpectArg } from './delivery-contract';
import {
  briefingPointerWarning,
  formatBriefingWarning,
} from './briefing-warnings';
import { harnessReceiptForTask } from './tools-harness';
import {
  findAgentInAnySquad,
  findAgentInSquad,
  getSquad,
  squadRoutableCliIds,
} from './squad-store';
import { adHocSpawnGateError } from './route-provenance';
import { recordRouteLog } from './route-log';
import {
  adapterIdsWithoutNexusMcp,
  sameAdapterDiversityHint,
  ignoredRouteChoice,
  operatorChildUseCounts,
  operatorRouteTask,
  routeString,
  spawnRouteFrom,
} from './operator-spawn-route';
import {
  claimSameCheckoutWriter,
  decideDelegatedWriterSpawn,
  delegatedPaneFacts,
  hasPendingWriterClaim,
} from './delegated-writer-gate';
import {
  isFreeAgentChoiceContract,
  requiresRouteReservation,
  squadBindingViolationError,
} from './free-agent-choice';
import { loadModelCatalog, modelCatalogInfo } from '../adapters/model-catalog';
import { discoverCliModels } from '../adapters/cli-model-discovery';
import { resolveRoutableModel } from './task-router';
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
import { getAccountChoiceReceipt } from '../persistence/account-choice-receipts';
import { trace } from '../observability/main-trace';
import {
  startPhaseTimer,
  type PhaseTimer,
} from '../observability/phase-timer';
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
import {
  allocateIsolatedWriterWorktree,
  isolatedWriterPaneOfSession,
  resumeIsolatedWriterWorktree,
  type IsolatedWriterAllocation,
} from './isolated-writer-worktree';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import { isOperatorTabMission } from './operator-tab-mission-resume';
import { OPERATOR_CHOICE_PROOF_WINDOW_MS, operatorRecentlyNamedCli } from './operator-cli-mentions';
import {
  judgeIdleHelperReuse,
  listIdleHelperCandidates,
} from './idle-helper-reuse';
import { digestPaneTail } from './pane-output-digest';
import { classifyPaneTailForDigest } from '../jev/jev-pane-state';
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

/**
 * 0.76.45: `resume` aceita um paneId antigo ("pane-…") ou o número/sessão de
 * um pane ainda registrado; devolve o paneId cuja sessão do provider deve ser
 * copiada para o pane novo. Task id ("h-N"): a sessão que entregou o handoff
 * → o pane dela (vivo, ou o writer isolado no registry durável, que sobrevive
 * a reinício). Sem nada disso segue só como flag booleana.
 */
function resumePaneRefOf(ref: string | undefined, scope: ProjectExecutionScope): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith('pane-')) return ref;
  const known = findPane(ref);
  if (known) return known.paneId;
  try {
    const sessionId = getProjectDomainStores(scope).handoffs.get(ref)?.sessionId;
    if (!sessionId) return undefined;
    return findPane(sessionId)?.paneId ?? isolatedWriterPaneOfSession(scope, sessionId);
  } catch {
    return undefined;
  }
}

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

function cliAdapterFor(adapterId: string): ReturnType<typeof getAdapter> {
  const builtin = BUILTIN_ADAPTERS.find(
    (item) => (item as { id?: string }).id === adapterId,
  );
  return getAdapter(adapterId) ?? (builtin ? adapterSchema.parse(builtin) : null);
}

/**
 * 0.76.110 (paridade): a mão do operador sem missão que PEDE uma CLI/modelo
 * é atendida — mas só com o que está instalado. Recusa CLI sem MCP do Nexus
 * (sem missão, o handoff não teria por onde voltar) e modelo que a CLI não
 * roda, listando as opções válidas em vez de cair calado no default.
 */
function assertOperatorExplicitRuntime(adapterId: string, model: string | undefined): string | undefined {
  const adapter = cliAdapterFor(adapterId);
  if (!adapter || adapter.kind !== 'cli-pty') {
    throw new Error(`nexus_pane_spawn: CLI desconhecida ou não-terminal: ${adapterId}`);
  }
  if (!canUseNexusMcp(adapter)) {
    throw new Error(
      `nexus_pane_spawn: ${adapterId} não tem MCP do Nexus — sem missão o pane ` +
        'não consegue entregar o handoff; escolha outra CLI, omita adapterId ' +
        'para o Nexus rotear, ou abra dentro de uma missão',
    );
  }
  const runnable = [
    ...new Set([...(discoverCliModels().get(adapterId) ?? []), ...adapter.models.list]),
  ];
  const resolved = resolveRoutableModel(model, runnable);
  if (!resolved.ok) {
    throw new Error(
      `nexus_pane_spawn: modelo "${model}" não existe em ${adapterId}; ` +
        `opções válidas: ${runnable.join(', ')}`,
    );
  }
  return resolved.model;
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

/** Aviso do auto-isolamento: a worktree sai do HEAD, sem o WIP do operador. */
export const ISOLATED_WORKTREE_NOTE =
  'não contém alterações não commitadas do checkout principal';

function isolatedWriterOptions(
  options: SpawnToolOptions,
  scope: ProjectExecutionScope,
  writer: IsolatedWriterAllocation,
): SpawnToolOptions {
  return {
    ...options,
    executionMode: 'isolated_worktree',
    isolatedWriter: true,
    cwd: writer.worktreePath,
    executionScope: Object.freeze({ ...scope, rootRealPath: writer.worktreePath }),
    memoryQuery: options.memoryQuery ?? options.prompt,
    prompt: withIsolatedWriterContract(options.prompt ?? 'Execute a tarefa delegada.', writer),
  };
}

export function withSameCheckoutWorkerContract(prompt: string): string {
  return (
    '## Nexus execution authority\n' +
    'executionMode=`same_checkout`: esta tarefa depende do WIP atual e roda no ' +
    'checkout já aberto. Preserve integralmente o trabalho existente: não use stash, ' +
    'reset, checkout, clean nem troque de branch. Você é o único writer neste checkout ' +
    '(outros writers rodam em worktrees próprias); limite mudanças ao escopo pedido, inspecione o git status antes de editar ' +
    'e não reverta arquivos que você não criou. Ao terminar, chame nexus_handoff_submit ' +
    'uma vez com arquivos tocados, validações e qualquer bloqueio.\n\n' +
    prompt
  );
}

export function withIsolatedWriterContract(
  prompt: string,
  workspace: { branch: string; worktreePath: string; baseSha?: string },
): string {
  return '## Nexus execution authority\n' +
    `executionMode=\`isolated_worktree\`: esta tarefa roda na worktree própria ${workspace.worktreePath}, ` +
    `na branch ${workspace.branch}. ` +
    `A worktree nasce do commit ${workspace.baseSha ?? 'HEAD'} do checkout de coordenação e ${ISOLATED_WORKTREE_NOTE}. ` +
    'Commit na própria branch é permitido e esperado. ' +
    'A branch não pode ser publicada: não use push, pull, stash, checkout, reset ou clean; ' +
    'não toque em outras branches nem no checkout de coordenação. ' +
    'Não há reserva exclusiva de arquivos: outros escritores podem editar o mesmo arquivo e gerar conflitos. ' +
    'Não há merge automático; o orquestrador revisa e integra as branches na ordem de dependência. ' +
    'Use nexus_git_add/commit/status/diff/log na própria worktree; nexus_terminal_run aceita somente essas operações Git estruturadas. ' +
    'Use a ferramenta nativa do CLI, conforme o perfil escolhido, para builds e testes. ' +
    'Ao terminar, chame nexus_handoff_submit uma vez com branch, sha, lista completa de arquivos tocados e diff ' +
    '(patch anexado ou caminho de um artefato de diff), além das validações e bloqueios.\n\n' + prompt;
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

/**
 * Fan-out do operador sem missão: `nexus_pane_spawn` sem `adapterId` roteia
 * `task ?? prompt` pelo mesmo motor do `nexus_route_task`. Registrado por
 * tools-domain.ts (late-bound: tools-panes não pode importar tools-domain —
 * ciclo tools-panes → tools-domain → tools-panes).
 */
/** Parâmetros internos do roteamento do spawn — nunca vêm de argumento MCP. */
export interface OperatorRouteInternal {
  readonly tieBreakUseCounts?: ReadonlyMap<string, number>;
  readonly excludeAdapterIds?: readonly string[];
  /**
   * Pin do agente sem pedido do operador → PREFERÊNCIA suave: entra em
   * `preferAdapters` do roteador (boost), nunca em excludes.
   */
  readonly preferAdapterIds?: readonly string[];
}

export type OperatorRouteResolver = (
  task: string,
  ctx: AgentGateContext,
  internal: OperatorRouteInternal,
) => Promise<Record<string, unknown>>;

let operatorRouteResolver: OperatorRouteResolver | null = null;

export function setOperatorRouteResolver(
  resolver: OperatorRouteResolver | null,
): void {
  operatorRouteResolver = resolver;
}

/**
 * Cria (ou reusa) a missão leve da aba do pane chamador e o adota como
 * orquestrador dela, pelo mesmo caminho do "Tornar orquestrador". Devolve o id
 * da missão, ou `null` quando não deu (o pane segue mão do operador).
 */
export interface OperatorTabMission {
  readonly missionId: string;
  /** Spawn falhou: desfaz a missão que nasceu para ele, se ainda vazia. */
  readonly discardIfUnused: () => void;
}

export type OperatorTabMissionProvider = (
  ctx: AgentGateContext,
  task: string | null,
) => OperatorTabMission | null;

let operatorTabMissionProvider: OperatorTabMissionProvider | null = null;

export function setOperatorTabMissionProvider(
  provider: OperatorTabMissionProvider | null,
): void {
  operatorTabMissionProvider = provider;
}

/**
 * Acesso fora do spawn ao provedor da missão sob demanda (o hook
 * /hook/delegate adota o pane na auto-orquestração do Autopilot). O chamador
 * decide se usa `discardIfUnused` — o hook nunca descarta: o pane já vive.
 */
export function adoptThroughOperatorTabMission(
  ctx: AgentGateContext,
  task: string | null,
): OperatorTabMission | null {
  return operatorTabMissionProvider?.(ctx, task) ?? null;
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

/**
 * `skill`/`skillSuggestion` do resultado do auto-route (nexus_route_task):
 * normaliza para `{ name, confidence }` ou null. O Jev só SUGERE — quem
 * decide usar é o spawn (confiança ≥ 0.7 e skill permitida ao filho).
 */
function skillSuggestionFromRoute(
  autoRoute: Record<string, unknown> | undefined,
): { name: string; pkg: string; confidence: number } | null {
  const raw = autoRoute?.skill ?? autoRoute?.skillSuggestion;
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.name !== 'string' || !rec.name.trim()) return null;
  if (typeof rec.confidence !== 'number' || !Number.isFinite(rec.confidence)) {
    return null;
  }
  return {
    name: rec.name,
    pkg: typeof rec.pkg === 'string' ? rec.pkg : '',
    confidence: rec.confidence,
  };
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

/**
 * F-213: telemetria do nascimento do pane via MCP — o timer mede cada fase
 * awaitada da entrada do tool até a criação do PTY; `meta` recebe a
 * identidade conforme o caminho a descobre (adapter resolvido, paneId do
 * resultado) e `ok` só vira true quando o handler devolve sucesso.
 */
interface PaneSpawnTimingMeta {
  adapterId?: string;
  paneId?: string;
  missionId?: string;
  role?: string;
  ok?: boolean;
  /** F-215: tempos por etapa do materialize da worktree isolada (ms). */
  gitWorktreeMs?: number;
  cowMs?: number;
}
interface PaneSpawnTiming {
  readonly timer: PhaseTimer;
  readonly meta: PaneSpawnTimingMeta;
}

const paneSpawn: McpToolDef = {
  name: 'nexus_pane_spawn',
  description:
    'Open a new terminal pane running an AI CLI. Provide agentName (a squad ' +
    'agent — inherits allowlists/title). The model and effort sealed on that ' +
    'roster member WIN over nexus_route_task, ranking, and the CLI default ' +
    '(Codex Luna / DeepSeek Flash / adapter.models.default). Pass adapterId ' +
    'only to fail over to a different CLI — never to substitute the sealed ' +
    'model on the same CLI. If the sealed model cannot be applied, spawn fails ' +
    'visibly. In a running mission, pass routeReservationId when the CLI is ' +
    'not the sticky roster route. Prompt is delivered in the CLI argv AT BIRTH. ' +
    'From the operator\'s own pane without a mission, omit adapterId and ' +
    'describe the work in `task` (or prompt/title) to let Nexus route it ' +
    '(a model/effort without adapterId is listed under route.ignored); pass ' +
    'adapterId (+ model/effort) to pick the CLI/model yourself — it is ' +
    'validated against the installed catalog (an unknown model fails listing ' +
    'the valid ones; a CLI without Nexus MCP is refused) and the receipt says ' +
    'harness.source explicit vs auto-route. resume keeps the resumed ' +
    'pane\'s CLI, and a confident Jev skill ' +
    'suggestion adds one hint line to the prompt. Inside a mission, omit ' +
    'adapterId and describe `task` to get the same automatic routing (roster, ' +
    'CLI policy and route reservation applied). DEFAULT: omit adapterId and ' +
    'model — Nexus spreads helpers across every ready CLI (Claude, Codex, Kimi, ' +
    'Grok, MiMo, …) by task. A pinned adapterId is a SOFT preference when the ' +
    'operator did not ask for it: in any mission (orchestrator) or on the ' +
    'operator pane (explicit pin), Nexus re-routes by task and keeps the pin ' +
    'only as a routing preference (receipt: route.redistributed ' +
    'pin-sem-pedido-do-operador). The pin is honored literally only when the ' +
    'operator named that CLI (typed in the calling pane or sent through the ' +
    'Quadro direction) — operatorChoice:true without that request is ignored ' +
    'and the helper is routed by task. Writers run in parallel: ' +
    'isolatedWriter gives each one its own git worktree/branch, and from the ' +
    'operator pane a writer that would share the checkout with another active ' +
    'writer is isolated automatically (receipt: executionMode ' +
    'isolated_worktree + isolatedWorktree {branch, worktreePath, reason}); the ' +
    'orchestrator integrates the branches. In Autopilot the FIRST helper a ' +
    '"+ Pane" pane opens creates THIS pane\'s light mission (free agent ' +
    'choice, no squad; another pane of the same tab gets its own and never ' +
    'takes this crown) with this pane as its orchestrator: helpers join it, ' +
    'their handoffs come back here, and this pane keeps reading/listing the ' +
    'panes it already could (receipt: tabMission {missionId}). ' +
    'Returns {paneId, sessionId} or {paneId, sessionId:null, pending:true} ' +
    'while the CLI session is still starting; use nexus_pane_wait_idle next. ' +
    '`harness.account` diz qual conta o pane usa, quem decidiu (regra de ' +
    'folga/pinada/ativa/nativa) e as alternativas com sua folga — rótulos ' +
    'mascarados. If a live idle helper of the same owner and CLI has ' +
    'related context, the task may be delivered to it instead of spawning ' +
    '(receipt: reused:true + reusedReason); pass fresh:true to always ' +
    'spawn.',
  inputSchema: {
    type: 'object',
    properties: {
      adapterId: {
        type: 'string',
        description:
          'Adapter id (cli) to run. Optional and usually omitted: Nexus routes ' +
          '`task` (operator pane: Jev + cost table; mission: nexus_route_task) ' +
          'and spreads helpers across CLIs. A pin is honored literally only ' +
          'when the operator named this CLI (in the calling pane or through ' +
          'the Quadro direction); otherwise it becomes a soft routing ' +
          'preference (see operatorChoice).',
      },
      operatorChoice: {
        type: 'boolean',
        description:
          'Marks that the OPERATOR asked for this adapterId. It is verified: ' +
          'Nexus honors it only when the operator actually named that CLI in ' +
          'the calling pane or in a Quadro direction during the last 30 ' +
          'minutes. Setting it on your own (the operator never named the CLI) ' +
          'is ignored — the helper is routed by task and the receipt says ' +
          'operatorChoice-sem-pedido-do-operador. Never set it to keep a ' +
          'favourite CLI: the operator wants every ready LLM in use.',
      },
      agentName: { type: 'string', description: 'Squad agent name or id' },
      task: {
        type: 'string',
        description:
          'What this pane will do. Without adapterId Nexus routes it (Jev ' +
          'tier/specialty + cost table) to a CLI/model; prompt/title are used ' +
          'when task is absent.',
      },
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
      isolatedWriter: {
        type: 'boolean',
        description: 'Spawn this writer in its own git worktree/branch so several writers run in parallel (with or without a mission); the orchestrator integrates the branch afterwards. The worktree and branch are kept for integration after the pane closes; a merged, clean one is garbage-collected. It starts at the checkout HEAD without uncommitted changes (the receipt carries baseSha). Resuming such a pane reuses its original worktree. Errors in a tab with its own shared worktree (open writers there one at a time)',
      },
      autoCloseOnHandoff: {
        type: 'boolean',
        description:
          'Close this pane automatically when it submits a SUCCESS handoff ' +
          '(declared at birth; failure keeps the pane open for diagnosis).',
      },
      expect: {
        type: 'object',
        description:
          'Delivery contract (declared at birth): {schema, retries?}. On a ' +
          'SUCCESS nexus_handoff_submit the worker artifacts are validated ' +
          'against this JSON Schema (subset: type/required/properties/items/' +
          'enum/const/minItems/pattern/anyOf). A mismatch is returned to the ' +
          'worker naming what is missing, up to `retries` times (default 1, ' +
          'max 5); after that the handoff is recorded as blocked with the ' +
          'violations in artifacts.',
        properties: {
          schema: { type: 'object' },
          retries: { type: 'integer', minimum: 0, maximum: 5 },
        },
        required: ['schema'],
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
      fresh: {
        type: 'boolean',
        description:
          'true always opens a NEW pane. Without it, a task from the ' +
          'operator pane (no mission) or an operator-tab mission may be ' +
          'delivered to a live idle helper of the same owner and CLI whose ' +
          'recent work is related (receipt: reused:true + reusedReason) — ' +
          'saving the spawn and re-briefing.',
      },
    },
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    assertCallerMaySpawnPane(ctx.role);
    // Contrato de entrega inválido falha AQUI, visível para quem declarou —
    // nunca no handoff do worker, que não tem como consertar o schema. Antes
    // da missão da aba: argumento inválido não deixa missão nem pane promovido.
    const deliveryContract = parseExpectArg(args.expect);
    // Missão SOB DEMANDA (0.76.110, decisão do operador): o primeiro helper que
    // um pane do "+ Pane" abre cria a missão leve da aba e adota o pane como
    // orquestrador dela — o helper nasce nela e as entregas chegam ao pane, que
    // não perde o alcance de mão do operador (pane-authz). Pane que só conversa
    // não vira missão; filho do operador e Hardened seguem como antes. Se não
    // der, nada muda: o spawn segue pela mão do operador.
    let tabMission: OperatorTabMission | null = null;
    if (
      operatorTabMissionProvider &&
      ctx.role === 'user' &&
      !ctx.missionId &&
      ctx.sessionId &&
      !ctx.operatorParentSessionId &&
      !str(args, 'missionId') &&
      !str(args, 'resume') &&
      isOperatorChoicePolicy(getOrchSettings().squadCliPolicy)
    ) {
      tabMission = operatorTabMissionProvider(ctx, operatorRouteTask(args));
    }
    const spawnTiming: PaneSpawnTiming = {
      timer: startPhaseTimer(),
      meta: {},
    };
    try {
      return await paneSpawnAfterTabMission.handler(
        args,
        ctx,
        invocation,
        tabMission?.missionId ?? null,
        deliveryContract,
        spawnTiming,
      );
    } catch (error) {
      // Spawn que não saiu não deixa a missão da aba que nasceu para ele:
      // missão running vazia e pane promovido sem helper nenhum.
      tabMission?.discardIfUnused();
      throw error;
    } finally {
      // F-213: um evento por tentativa — sucesso, rota que falhou antes do
      // PTY, falha de spawn ou exceção interna. Só ids/labels/números.
      const { totalMs, phases } = spawnTiming.timer.finish();
      trace({
        kind: 'pane-spawn-timing',
        source: 'mcp',
        adapterId:
          spawnTiming.meta.adapterId ?? str(args, 'adapterId') ?? null,
        paneId: spawnTiming.meta.paneId ?? null,
        missionId:
          spawnTiming.meta.missionId ??
          str(args, 'missionId') ??
          ctx.missionId ??
          null,
        role: spawnTiming.meta.role ?? null,
        ok: spawnTiming.meta.ok === true,
        totalMs,
        phases,
        ...(spawnTiming.meta.gitWorktreeMs === undefined
          ? {}
          : { gitWorktreeMs: spawnTiming.meta.gitWorktreeMs }),
        ...(spawnTiming.meta.cowMs === undefined
          ? {}
          : { cowMs: spawnTiming.meta.cowMs }),
      });
    }
  },
};

/** O spawn depois da missão sob demanda (falha aqui desfaz a missão vazia). */
const paneSpawnAfterTabMission = {
  handler: async (
    args: Record<string, unknown>,
    ctx: AgentGateContext,
    invocation: McpToolInvocation | undefined,
    tabMissionId: string | null,
    deliveryContract: ReturnType<typeof parseExpectArg>,
    spawnTiming?: PaneSpawnTiming,
  ): Promise<unknown> => {
    const agentRef = str(args, 'agentName');
    let routeReservationId = str(args, 'routeReservationId');
    let options: SpawnToolOptions;
    let executionMode: 'same_checkout' | 'isolated_worktree' | undefined;
    let rosterRouteAuthorized = false;
    // Reserva criada pelo auto-roteamento em missão (C, 0.76.110).
    let autoRouteReservation = false;
    let autoRoute: Record<string, unknown> | undefined;
    let routeSkill: { name: string; pkg: string; confidence: number } | null =
      null;
    /**
     * Mão do operador sem missão: o pane filho é a MESMA mão. Omitir `role`
     * faz o main mintar `user` (`mcp-server`: `meta?.role ?? "user"`), então o
     * filho herda o modo vibe e a pane-authz do operador em vez de nascer
     * worker preso. Decisão 09/09 — opção "panes que você abre herdam a
     * liberdade". Com missão nada muda: worker/orchestrator seguem como sempre.
     */
    const operatorHand = ctx.role === 'user' && !ctx.missionId;
    // Decisão 09/09 "panes que você abre herdam a liberdade": em Autopilot o
    // filho ad-hoc do operador herda o allowlist dele (não nasce worker de
    // allowlist vazio). Em Hardened (governed) continua atenuado — workers-of-
    // the-operator como hoje.
    const inheritOperatorFreedom =
      operatorHand && isOperatorChoicePolicy(getOrchSettings().squadCliPolicy);
    // A (25/09): na mão do operador sem missão, sem adapterId, o Jev + tabela
    // decidem a CLI; model/effort soltos viram `route.ignored` no recibo.
    // 0.76.110: adapterId EXPLÍCITO é honrado (com model/effort), validado
    // contra o que está instalado. `resume` fica de fora — trocar a CLI
    // perderia a conversa retomada.
    const resumeRef = str(args, 'resume');
    const operatorExplicit =
      operatorHand && !resumeRef && !str(args, 'missionId') && str(args, 'adapterId') !== undefined;
    // Uso geral: um adapterId fixado SEM o operador ter digitado a CLI nesta
    // sessão vira PREFERÊNCIA suave de roteamento, nunca destino certo — para
    // o orquestrador de QUALQUER missão e para a mão do operador com pin
    // explícito. `operatorChoice:true`, a CLI que o operador acabou de
    // digitar, `resume`, reserva de rota e spawn de agente do roster seguem
    // honrando o pin literal; sem texto roteável não há o que preferir.
    const pinnedAdapterId = str(args, 'adapterId');
    // F-682: `operatorChoice:true` é AFIRMAÇÃO do agente, não prova — o Maestro
    // da missão RU-261 (29/09) marcou-a sozinho em 4 de 4 helpers Claude. Só
    // vale quando o operador nomeou a CLI no pane (input humano ou orientação
    // do Quadro) dentro da retenção; sem isso o pin vira preferência.
    const operatorChoiceProved =
      pinnedAdapterId !== undefined &&
      args.operatorChoice === true &&
      operatorRecentlyNamedCli(
        ctx.sessionId,
        pinnedAdapterId,
        Date.now(),
        OPERATOR_CHOICE_PROOF_WINDOW_MS,
      );
    const operatorChoiceUnproved =
      args.operatorChoice === true && !operatorChoiceProved;
    const pinRedistributed =
      pinnedAdapterId !== undefined &&
      !agentRef &&
      !operatorChoiceProved &&
      !resumeRef &&
      !routeReservationId &&
      operatorRouteResolver !== null &&
      operatorRouteTask(args) !== null &&
      !operatorRecentlyNamedCli(ctx.sessionId, pinnedAdapterId) &&
      ((ctx.role === 'orchestrator' && ctx.missionId !== undefined) ||
        operatorExplicit)
        ? {
            adapterId: pinnedAdapterId,
            ...(str(args, 'model') ? { model: str(args, 'model')! } : {}),
          }
        : null;
    const operatorExplicitModel = operatorExplicit && !pinRedistributed
      ? assertOperatorExplicitRuntime(str(args, 'adapterId')!, str(args, 'model'))
      : undefined;
    const forceOperatorRoute =
      operatorHand &&
      (!operatorExplicit || pinRedistributed !== null) &&
      !resumeRef &&
      !str(args, 'missionId') &&
      operatorRouteResolver !== null;
    // O pin redistribuído sai do `ignored` (tem campo próprio no recibo);
    // model/effort pedidos junto seguem listados como ignorados.
    const ignoredRouteArgs = pinRedistributed
      ? { ...args, adapterId: undefined }
      : args;
    let ignoredChoice = forceOperatorRoute ? ignoredRouteChoice(ignoredRouteArgs) : null;
    const resolveOperatorRoute = async (): Promise<Record<string, unknown>> => {
      const task = operatorRouteTask(args);
      if (!task) {
        throw new Error(
          'nexus_pane_spawn: descreva a tarefa em `task` (ou `prompt`/`title`) — ' +
            'o Nexus escolhe a CLI pelo roteamento automático',
        );
      }
      const tieBreakUseCounts = operatorChildUseCounts(
        ctx.sessionId,
        ctx.providerId,
        listPaneSnapshots(),
        (sessionId) => getPaneRuntimeAuthorityBySession(sessionId)?.operatorParentSessionId,
      );
      const excluded: string[] = [];
      for (;;) {
        let route: Record<string, unknown>;
        try {
          route = await operatorRouteResolver!(task, ctx, {
            tieBreakUseCounts,
            excludeAdapterIds: excluded,
            ...(pinRedistributed
              ? { preferAdapterIds: [pinRedistributed.adapterId] }
              : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`nexus_pane_spawn: roteamento automático falhou (${message})`);
        }
        const adapterId = routeString(route, 'adapterId');
        if (!adapterId) {
          throw new Error('nexus_pane_spawn: roteamento automático falhou (sem adapterId)');
        }
        const adapter = cliAdapterFor(adapterId);
        if (!adapter || adapter.kind !== 'cli-pty') {
          throw new Error(`nexus_pane_spawn: rota sem adapter CLI válido (${adapterId})`);
        }
        if (str(args, 'missionId') || canUseNexusMcp(adapter)) {
          return excluded.length === 0 ? route : {
            ...route,
            reason: `${typeof route.reason === 'string' ? route.reason : 'rota elegível'}; ` +
              `${excluded.join(', ')} sem MCP do Nexus para handoff sem missão`,
            ignoredMcpAdapterId: excluded[0],
          };
        }
        if (excluded.includes(adapterId)) {
          throw new Error('nexus_pane_spawn: roteador repetiu CLI sem MCP do Nexus');
        }
        excluded.push(adapterId);
      }
    };
    // F-213: a rota Jev/missão é uma das fases medidas — o mark no finally
    // cobre o sucesso E o throw sem mudar o resultado.
    const timedOperatorRoute = async (): Promise<Record<string, unknown>> => {
      try {
        return await resolveOperatorRoute();
      } finally {
        spawnTiming?.timer.mark('route-resolve');
      }
    };
    if (agentRef) {
      const requestedMissionId = childMissionId(ctx, str(args, 'missionId'));
      const mission = requestedMissionId
        ? getProjectDomainStores(ctx.scope).missions.get(requestedMissionId)
        : null;
      // A sessão `user` é a mão do operador: ela já pode abrir um pane ad-hoc
      // com qualquer CLI e modelo, então exigir missão só para NOMEAR um
      // agente do roster era cerimônia — e virou parede em campo (09/09:
      // "mandei abrir outro pane e não conseguiu"). Fora do operador, o
      // vínculo com a missão continua obrigatório.
      const found = mission?.squadId
        ? findAgentInSquad(mission.squadId, agentRef)
        : ctx.role === 'user'
          ? findAgentInAnySquad(agentRef)
          : null;
      if (!found && !mission?.squadId && ctx.role !== 'user') {
        throw new Error('squad agent spawn requires a mission bound to a squad');
      }
      if (!found) {
        throw new Error(
          `unknown squad agent: ${agentRef} — confira o nome em ` +
            'Configurações › Squads, ou abra o pane direto passando ' +
            'adapterId (ex.: { adapterId: "codex" }), que não depende de ' +
            'roster nem de missão',
        );
      }
      const { agent } = found;
      const role = agent.category === 'orchestrator' ? 'orchestrator' : 'worker';
      if (ctx.role === 'worker' && role === 'orchestrator') {
        throw new Error('not authorized: workers cannot create orchestrators');
      }
      const requestedAdapterId = str(args, 'adapterId');
      const requestedModel = str(args, 'model');
      const requestedEffort = str(args, 'effort');
      if (forceOperatorRoute) autoRoute = await timedOperatorRoute();
      const honored = forceOperatorRoute
        ? null
        : honorSealedRosterRuntime({
            sealedCli: agent.cli,
            sealedModel: agent.model,
            sealedEffort: agent.effort,
            requestedAdapterId,
            requestedModel,
            requestedEffort,
          });
      const selectedAdapterId = honored
        ? honored.adapterId
        : routeString(autoRoute, 'adapterId')!;
      const selectedModel = honored ? honored.model : routeString(autoRoute, 'model');
      const selectedEffort = honored ? honored.effort : routeString(autoRoute, 'effort');
      const noRouteOverride =
        requestedAdapterId === undefined &&
        requestedModel === undefined &&
        requestedEffort === undefined;
      rosterRouteAuthorized = honored ? honored.rosterHonored || noRouteOverride : false;
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
          agent.allowedTools ??
            (role === 'orchestrator' || inheritOperatorFreedom ? null : []),
        ),
        allowedSkills: attenuateSkills(ctx.allowedSkills, agent.allowedSkills ?? null),
        // Sem missão a categoria do roster não confere autoridade: o filho do
        // operador nasce `user` (ver `operatorHand`).
        role: operatorHand ? undefined : role,
        readOnly: args.readOnly === true,
        // Sem `prompt`, a `task` (que também roteia) é a tarefa do worker —
        // senão ele nasceria sem brief.
        prompt: str(args, 'prompt') ?? str(args, 'task'),
        scope: ctx.scope,
        resume: str(args, 'resume') ? true : undefined,
        resumeFromPaneId: resumePaneRefOf(str(args, 'resume'), ctx.scope),
      };
    } else {
      // Fan-out do operador sem missão: sem `adapterId`, roteia `task ??
      // prompt` pelo mesmo motor do nexus_route_task (sugestão livre, sem
      // RouteReservation). Fora da mão do operador o adapterId segue
      // obrigatório como sempre.
      let adHocAdapterId = forceOperatorRoute ? undefined : str(args, 'adapterId');
      if (forceOperatorRoute) {
        autoRoute = await timedOperatorRoute();
        adHocAdapterId = routeString(autoRoute, 'adapterId');
      } else if (operatorHand && resumeRef) {
        // Retomar mantém a CLI do pane retomado: o registro vivo (pane
        // estacionado) vence o que o agente mandou; sem registro, os args.
        adHocAdapterId = findPane(resumeRef)?.adapterId ?? adHocAdapterId;
      } else if (adHocAdapterId === undefined && operatorHand && operatorRouteResolver) {
        // Resolver sempre existe em produção; este ramo só cobre args com
        // missionId explícito vindos da mão do operador.
        autoRoute = await timedOperatorRoute();
        adHocAdapterId = routeString(autoRoute, 'adapterId');
      }
      // Pin → preferência suave (uso geral): o adapterId pedido sem o
      // operador ter nomeado a CLI cai aqui e o spawn segue pelo caminho
      // automático de sempre — missão usa missionAutoRoute. A mão do
      // operador já saiu por forceOperatorRoute acima e o valor em
      // adHocAdapterId é o da ROTA, não o pin.
      if (pinRedistributed && !forceOperatorRoute) adHocAdapterId = undefined;
      // C (0.76.110): paridade com o + Pane — dentro da missão, sem
      // adapterId, o Nexus roteia `task` pelo mesmo nexus_route_task da
      // missão (roster selado, política de CLI e RouteReservation inclusos).
      const missionAutoRoute =
        adHocAdapterId === undefined &&
        !resumeRef &&
        !routeReservationId &&
        Boolean(ctx.missionId) &&
        operatorRouteResolver !== null;
      if (missionAutoRoute) {
        const task = operatorRouteTask(args);
        if (!task) {
          throw new Error(
            'nexus_pane_spawn: descreva a tarefa em `task` (ou `prompt`/`title`) ' +
              'ou passe adapterId — o Nexus roteia a tarefa dentro da missão',
          );
        }
        // F-658: o pane do "+ Pane" promovido à missão da aba segue a regra da
        // mão do operador — helper só em CLI com MCP do Nexus (F-157). A missão
        // sob demanda (0.76.110) levava os helpers dele à rota de missão, que
        // aceitava AGY: três panes mudos no `--print`. Missão do assistente
        // segue aceitando CLI que entrega pelo fim do PTY.
        try {
          autoRoute = await operatorRouteResolver!(
            task,
            ctx,
            {
              ...(ctx.promotedFromUserSession === true
                ? { excludeAdapterIds: adapterIdsWithoutNexusMcp(listAdapters(), canUseNexusMcp) }
                : {}),
              ...(pinRedistributed
                ? { preferAdapterIds: [pinRedistributed.adapterId] }
                : {}),
            },
          );
        } finally {
          spawnTiming?.timer.mark('route-resolve');
        }
        adHocAdapterId = routeString(autoRoute, 'adapterId');
        // model/effort soltos não valem aqui: o recibo diz o que foi ignorado.
        ignoredChoice = ignoredRouteChoice(ignoredRouteArgs);
        routeReservationId =
          typeof autoRoute.routeReservationId === 'string' ? autoRoute.routeReservationId : undefined;
        autoRouteReservation = routeReservationId !== undefined;
      }
      if (adHocAdapterId === undefined) {
        adHocAdapterId = requireStr(args, 'adapterId');
      }
      assertMcpInvocationCurrent(invocation);
      const adHocModel =
        (forceOperatorRoute || missionAutoRoute ? undefined : operatorExplicitModel ?? str(args, 'model')) ??
        routeString(autoRoute, 'model');
      const adHocEffort =
        (forceOperatorRoute || missionAutoRoute ? undefined : str(args, 'effort')) ??
        routeString(autoRoute, 'effort');
      const adHocMissionId = childMissionId(ctx, str(args, 'missionId'));
      const uniqueSealed = adHocMissionId
        ? uniqueSealedRuntimeForMission(
            ctx.scope,
            adHocMissionId,
            adHocAdapterId,
          )
        : null;
      const squadAgent = !autoRoute && !uniqueSealed && !adHocModel
        ? findAgentInAnySquad(adHocAdapterId)?.agent
        : undefined;
      const selectedAdHocModel = uniqueSealed?.model ?? adHocModel ?? squadAgent?.model;
      const selectedAdHocEffort = uniqueSealed?.effort ?? adHocEffort ?? squadAgent?.effort;
      // Spawn ad-hoc (sem agentName): modelo com warning de catálogo (ex.:
      // grok-4.5) só entra se veio de uma decisão real do nexus_route_task.
      // Omitir o model NÃO contorna o gate: sem model explícito, o que roda é
      // o default do adapter — é ele que precisa passar na checagem. Roster
      // selado único para esta CLI vence esse default.
      // Skill suggestion do auto-route: com confiança ≥ 0.7 E a skill
      // permitida ao filho, uma linha é acrescentada ao prompt existente
      // (nunca inventa prompt). O recibo expõe `route.skill` sempre que
      // o router devolveu uma sugestão.
      const adHocAllowedSkills = attenuateSkills(ctx.allowedSkills, null);
      routeSkill = skillSuggestionFromRoute(autoRoute);
      let adHocPrompt = str(args, 'prompt') ?? str(args, 'task');
      if (
        adHocPrompt &&
        routeSkill &&
        routeSkill.confidence >= 0.7 &&
        (adHocAllowedSkills === null ||
          adHocAllowedSkills.some(
            // Grants são por pacote OU por nome, como o skill-mirror.
            (skill) =>
              skill.toLowerCase() === routeSkill!.name.toLowerCase() ||
              (routeSkill!.pkg !== '' &&
                skill.toLowerCase() === routeSkill!.pkg.toLowerCase()),
          ))
      ) {
        adHocPrompt =
          `${adHocPrompt}\n\nSkill sugerida pelo Nexus: ${routeSkill.name} ` +
          '— leia a SKILL.md dela antes de começar.';
      }
      const gateModel =
        selectedAdHocModel ?? defaultModelForAdapter(adHocAdapterId);
      // A mão do operador escolhe o modelo: o aviso de catálogo (custo/faixa)
      // não vira parede `route_required` no pane dele. O gate de modelo
      // fantasma continua a jusante (resolveModelForSpawn).
      if (!routeReservationId && !operatorHand) {
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
        // unrestricted 'user'-role token (SEC#5). A mão do operador sem missão
        // é a exceção explícita: o filho É o operador (ver `operatorHand`) —
        // em Autopilot herda o allowlist dele (ver `inheritOperatorFreedom`).
        allowedTools: attenuateTools(
          ctx.allowedTools,
          inheritOperatorFreedom ? null : [],
        ),
        allowedSkills: adHocAllowedSkills,
        role: operatorHand ? undefined : 'worker',
        readOnly: args.readOnly === true,
        prompt: adHocPrompt,
        scope: ctx.scope,
        resume: str(args, 'resume') ? true : undefined,
        resumeFromPaneId: resumePaneRefOf(str(args, 'resume'), ctx.scope),
      };
    }
    if (autoRoute) {
      const spawnRoute = spawnRouteFrom(autoRoute);
      if (spawnRoute) options = { ...options, spawnRoute };
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
    options = coerceSpawnReadOnly(options, ctx.readOnly);
    const executionMission = options.missionId ? getProjectDomainStores(ctx.scope).missions.get(options.missionId) : null;
    const callerExecutionScope = options.missionId
      ? (executionMission ? missionExecutionScope(ctx.scope, executionMission) : ctx.scope)
      : ctx.executionScope ?? ctx.scope;
    if (!options.missionId && callerExecutionScope.rootRealPath !== ctx.scope.rootRealPath) {
      options = { ...options, executionScope: callerExecutionScope,
        cwd: options.cwd ?? callerExecutionScope.rootRealPath };
    }
    let isolatedWriter: IsolatedWriterAllocation | undefined;
    let isolatedWriterReason: string | undefined;
    // Claim síncrono do checkout (ver delegated-writer-gate): tomado no mesmo
    // bloco da decisão, antes de qualquer await; solto no finally.
    let writerClaim: ReturnType<typeof claimSameCheckoutWriter> | undefined;
    let spawnedPaneId: string | undefined;
    // C3 (25/09) → 0.76.110: na mão do operador, dois writers nunca dividem o
    // mesmo checkout. `isolatedWriter:true` ganha worktree/branch própria; um
    // writer comum que colidiria com outro ativo é auto-isolado (em vez de
    // recusado). Helpers de leitura seguem em paralelo no checkout. `resume`
    // de um writer isolado volta à worktree/branch original.
    if (operatorHand && !options.missionId) {
      const resumed = resumeIsolatedWriterWorktree(ctx.scope, undefined, options.resumeFromPaneId);
      if (resumed) {
        isolatedWriter = resumed;
      } else if (options.readOnly !== true) {
        const checkoutRoot = callerExecutionScope.rootRealPath;
        let blockedBy: string | undefined;
        if (args.isolatedWriter !== true) {
          const snapshots = listPaneSnapshots();
          const writerDecision = decideDelegatedWriterSpawn({
            spawnReadOnly: false,
            checkoutId: ctx.scope.checkoutId,
            executionRoot: checkoutRoot,
            panes: delegatedPaneFacts(
              snapshots,
              (sessionId) =>
                getPaneRuntimeAuthorityBySession(sessionId)?.operatorParentSessionId,
            ),
          });
          blockedBy = !writerDecision.allowed
            ? writerDecision.reason
            : hasPendingWriterClaim(checkoutRoot, snapshots)
              ? 'writer em spawn ainda ativo — espere a entrega dele ou abra este como readOnly'
              : undefined;
          if (blockedBy === undefined) writerClaim = claimSameCheckoutWriter(checkoutRoot);
        }
        if (args.isolatedWriter === true || blockedBy !== undefined) {
          try {
            assertTabSupportsOperation(ctx.scope, callerExecutionScope, 'isolatedWriter', ctx.sharedTabWorktree);
          } catch (error) {
            // Aba em pasta compartilhada não suporta worktree: mantém a fila.
            throw blockedBy !== undefined ? new Error(blockedBy) : error;
          }
          if (blockedBy !== undefined) {
            isolatedWriterReason = `auto-isolado: ${blockedBy.replace(/ — .*$/, '')} no mesmo checkout`;
          }
          try {
            isolatedWriter = await allocateIsolatedWriterWorktree(ctx.scope, undefined);
            if (spawnTiming && isolatedWriter.materialize) {
              spawnTiming.meta.gitWorktreeMs = isolatedWriter.materialize.gitWorktreeMs;
              spawnTiming.meta.cowMs = isolatedWriter.materialize.cowMs;
            }
          } finally {
            spawnTiming?.timer.mark('writer-isolation');
          }
        }
      }
      if (isolatedWriter) {
        executionMode = 'isolated_worktree';
        options = isolatedWriterOptions(options, ctx.scope, isolatedWriter);
      }
    }
    let isolatedWriterPending = false;
    // Recibo: quem spawnou sabe qual branch/worktree integrar depois.
    const isolatedReceipt = () => isolatedWriter
      ? { isolatedWorktree: {
          branch: isolatedWriter.branch,
          worktreePath: isolatedWriter.worktreePath,
          baseSha: isolatedWriter.baseSha,
          note: ISOLATED_WORKTREE_NOTE,
          ...(isolatedWriterReason ? { reason: isolatedWriterReason } : {}),
        } }
      : {};
    let releaseWorkerSlot: (() => void) | undefined;
    let spawnedWorkerPaneId: string | undefined;
    let consumeReservedRoute: (() => void) | undefined;
    let reservedRouteConsumed = false;
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
        // sem reserva continua "ver para crer"). A reserva que o próprio
        // auto-roteamento criou é consumida também no modo livre — senão fica
        // pendurada contando como "CLI já usada" até expirar.
        if (
          requiresRouteReservation({
            missionRunning: missionRow.status === 'running',
            rosterRouteAuthorized,
            freeAgentChoice,
          }) ||
          (autoRouteReservation && Boolean(ctx.sessionId))
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
            reservedRouteConsumed = true;
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
          assertTabSupportsOperation(ctx.scope, callerExecutionScope, 'PREVC com worktrees de tarefas', ctx.sharedTabWorktree);
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
          const checkoutRoot = callerExecutionScope.rootRealPath;
          const spawnReadOnly =
            options.readOnly === true || options.executionMode === 'read_only';
          isolatedWriter = resumeIsolatedWriterWorktree(ctx.scope, missionId, options.resumeFromPaneId) ?? undefined;
          if (!isolatedWriter && !spawnReadOnly) {
            let blockedBy: string | undefined;
            if (args.isolatedWriter !== true) {
              const snapshots = listPaneSnapshots();
              const decision = decideSameCheckoutSpawn({
                spawnReadOnly,
                activeWorker:
                  activeSameCheckoutWorker(snapshots, checkoutRoot) ??
                  (hasPendingWriterClaim(checkoutRoot, snapshots)
                    ? { paneId: 'em spawn', state: 'spawning' }
                    : null),
              });
              blockedBy = decision.allowed ? undefined : decision.reason;
              if (blockedBy === undefined) writerClaim = claimSameCheckoutWriter(checkoutRoot);
            }
            // Paridade com a mão do operador: o segundo writer comum é
            // auto-isolado numa worktree própria em vez de recusado.
            if (args.isolatedWriter === true || blockedBy !== undefined) {
              try {
                assertTabSupportsOperation(ctx.scope, callerExecutionScope, 'isolatedWriter', ctx.sharedTabWorktree);
              } catch (error) {
                throw blockedBy !== undefined ? new Error(blockedBy) : error;
              }
              if (blockedBy !== undefined) {
                isolatedWriterReason = `auto-isolado: ${blockedBy} no mesmo checkout`;
              }
              try {
                isolatedWriter = await allocateIsolatedWriterWorktree(ctx.scope, missionId);
                if (spawnTiming && isolatedWriter.materialize) {
                  spawnTiming.meta.gitWorktreeMs = isolatedWriter.materialize.gitWorktreeMs;
                  spawnTiming.meta.cowMs = isolatedWriter.materialize.cowMs;
                }
              } finally {
                spawnTiming?.timer.mark('writer-isolation');
              }
            }
          }
          if (isolatedWriter) {
            executionMode = 'isolated_worktree';
            options = isolatedWriterOptions(options, ctx.scope, isolatedWriter);
          } else {
            executionMode = 'same_checkout';
            options = {
              ...options,
              cwd: checkoutRoot,
              executionScope: callerExecutionScope,
              memoryQuery: options.memoryQuery ?? options.prompt,
              prompt: withSameCheckoutWorkerContract(
                options.prompt ?? 'Inspecione o estado atual e aguarde uma tarefa com escopo explícito.',
              ),
            };
          }
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
      // This opt-in is carried through the existing spawn helper without
      // widening its public options type. Internal requestPaneSpawn callers
      // continue waiting for a concrete session id.
      options = {
        ...options,
        [PENDING_SPAWN_RESULT]: true,
        operatorParentSessionId: operatorHand && !ctx.contextRevision
          ? ctx.sessionId
          : undefined,
      } as SpawnToolOptions;
      const harness = {
        adapterId: options.adapterId,
        model: options.model ?? null,
        effort: options.effort ?? null,
        source: autoRoute
          ? 'auto-route'
          : agentRef
            ? 'sealed-roster'
            : routeReservationId
              ? 'route'
              : operatorExplicit || str(args, 'model')
                ? 'explicit'
                : 'cli-default',
        ...(deliveryContract
          ? { deliveryContract: { retries: deliveryContract.retries } }
          : {}),
      };
      // Auto-route receipt: quem spawnou lê tier/especialidade/motivo do
      // roteamento Jev sem ter acionado nexus_route_task explicitamente.
      const routeReceipt = autoRoute
        ? {
            route: {
              ...(typeof autoRoute.tier === 'string'
                ? { tier: autoRoute.tier }
                : {}),
              ...(typeof autoRoute.specialty === 'string'
                ? { specialty: autoRoute.specialty }
                : {}),
              ...(typeof autoRoute.reason === 'string'
                ? { reason: autoRoute.reason }
                : {}),
              ...(typeof autoRoute.classifierSource === 'string'
                ? { classifierSource: autoRoute.classifierSource }
                : {}),
              // `escalate` é noul 0..1 (jev-task-routing), não booleano.
              ...(typeof autoRoute.escalate === 'number'
                ? { escalate: autoRoute.escalate }
                : {}),
              ...(routeSkill ? { skill: routeSkill } : {}),
              ...(typeof autoRoute.jevUnavailable === 'string'
                ? { jevUnavailable: autoRoute.jevUnavailable }
                : {}),
              ...(ignoredChoice ? { ignored: ignoredChoice } : {}),
              ...(pinRedistributed
                ? {
                    redistributed: {
                      ...pinRedistributed,
                      reason: operatorChoiceUnproved
                        ? 'operatorChoice-sem-pedido-do-operador'
                        : 'pin-sem-pedido-do-operador',
                      hint: operatorChoiceUnproved
                        ? 'operatorChoice só vale quando o operador nomeou esta CLI ' +
                          '(no pane ou pelo Quadro); sem isso o Nexus distribui pela tarefa.'
                        : 'Passe operatorChoice:true quando o operador pedir esta CLI.',
                    },
                  }
                : {}),
              ...(!ignoredChoice && typeof autoRoute.ignoredMcpAdapterId === 'string'
                ? { ignored: { adapterId: autoRoute.ignoredMcpAdapterId } }
                : {}),
            },
          }
        : {};
      // C3 (25/09): helper da mão do operador fecha sozinho no handoff de
      // sucesso por padrão — a aba não enche de panes que já entregaram.
      const autoClose =
        args.autoCloseOnHandoff === true ||
        (operatorHand && !options.missionId && args.autoCloseOnHandoff !== false);
      if (spawnTiming) {
        spawnTiming.meta.adapterId = options.adapterId;
        spawnTiming.meta.missionId = options.missionId;
        spawnTiming.meta.role = options.role ?? ctx.role;
      }
      // Reuso de helper ocioso (lote 0.76.135, superfície Jev helperReuse):
      // mão do operador sem missão ou orquestrador da missão da aba entrega a
      // tarefa a um pane vivo e parado em vez de pagar um spawn novo. agentName,
      // resume, isolatedWriter, expect e fresh:true sempre caem no spawn de
      // sempre; qualquer falha (inclusive de entrega) também.
      const reuseMissionId =
        options.missionId !== undefined &&
        options.missionId === ctx.missionId &&
        missionRow &&
        isOperatorTabMission(missionRow)
          ? options.missionId
          : undefined;
      const reuseEligible =
        args.fresh !== true &&
        !agentRef &&
        !resumeRef &&
        args.isolatedWriter !== true &&
        !deliveryContract &&
        typeof options.prompt === 'string' &&
        options.prompt.length > 0 &&
        typeof ctx.sessionId === 'string' &&
        ((operatorHand && !ctx.missionId && !options.missionId) ||
          (ctx.role === 'orchestrator' && reuseMissionId !== undefined));
      if (reuseEligible) {
        try {
          const reuseChoice = await judgeIdleHelperReuse({
            newTask: options.prompt!,
            candidates: listIdleHelperCandidates({
              mode: reuseMissionId ? 'tab-mission' : 'operator-hand',
              callerSessionId: ctx.sessionId!,
              ...(reuseMissionId ? { missionId: reuseMissionId } : {}),
              adapterId: options.adapterId,
              readOnly: options.readOnly === true,
              newTask: options.prompt!,
              scope: ctx.scope,
            }),
            scope: ctx.scope,
            missionId: reuseMissionId ?? null,
            callerSessionId: ctx.sessionId,
          });
          if (reuseChoice) {
            await injectPrompt(
              reuseChoice.candidate.sessionId,
              withWorkerHandoffFooter(
                reuseChoice.candidate.sessionId,
                options.prompt!,
              ),
              invocation,
            );
            return {
              paneId: reuseChoice.candidate.paneId,
              sessionId: reuseChoice.candidate.sessionId,
              reused: true,
              reusedReason: reuseChoice.reason,
              ...(tabMissionId ? { tabMission: { missionId: tabMissionId } } : {}),
              harness: {
                ...harness,
                source: 'reuse',
                account:
                  getAccountChoiceReceipt(reuseChoice.candidate.sessionId) ??
                  null,
              },
              ...routeReceipt,
            };
          }
        } catch (error) {
          console.warn(
            '[tools-panes] reuso de helper falhou; segue o spawn normal:',
            error,
          );
        }
      }
      let spawned: { paneId: string; sessionId: string };
      try {
        spawned = await spawnPaneAndMaybePrompt(options, {
          // Capture the PTY identity before missionPanes.record(). If that
          // durable write fails, the finally block must retain the reservation
          // instead of treating the spawn as if it never happened.
          onPaneCreated: (paneId) => {
            spawnedWorkerPaneId = paneId;
          },
          invocation,
          // F-213/R6: subdivide 'pty-spawn' nos awaits internos — em 28/09 a
          // espera de ~50 s veio antes da alocação do pane, sem saber em qual
          // etapa (rota, isolamento ou dentro desta chamada).
          timer: spawnTiming?.timer,
        });
        spawnTiming?.timer.mark('pty-spawn');
      } catch (error) {
        spawnTiming?.timer.mark('pty-spawn');
        // The legacy helper still requires a session id. When the renderer has
        // already acknowledged the main-minted pane as pending, translate that
        // compatibility throw back into the successful effect result.
        const pending = takePendingPaneSpawnResult(invocation?.signal);
        if (!pending) throw error;
        // ACK pendente: ainda não há sessão para armar; o braço vai no pane e
        // o handoff da sessão que nascer nele o encontra.
        if (autoClose && pending.paneId) armAutoCloseOnHandoffForPane(pending.paneId);
        isolatedWriterPending = Boolean(isolatedWriter);
        spawnedPaneId = pending.paneId ?? undefined;
        if (isolatedWriter && pending.paneId) isolatedWriter.link(pending.paneId, pending.sessionId ?? undefined);
        if (spawnTiming) {
          spawnTiming.meta.ok = true;
          spawnTiming.meta.paneId = pending.paneId ?? undefined;
        }
        const pendingDiversity = harness.source === 'explicit'
          ? sameAdapterDiversityHint(options.adapterId, options.missionId, listPaneSnapshots(), pending.paneId ?? undefined)
          : null;
        return {
          ...pending,
          ...(executionMode ? { executionMode } : {}),
          ...isolatedReceipt(),
          ...(tabMissionId ? { tabMission: { missionId: tabMissionId } } : {}),
          // ACK pendente: ainda não há sessionId para buscar o recibo.
          harness: { ...harness, account: null },
          ...routeReceipt,
          ...(pendingDiversity ? { diversity: pendingDiversity } : {}),
        };
      }
      // F-104: sem marcação de "handoff pendente" no spawn — o marcador só
      // era limpo por um submit do próprio worker e vetava o fechamento
      // mecânico para sempre. A dedup por janela de turno basta.
      // Declarado no nascimento (registro, não pergunta): o pane se fecha
      // sozinho no handoff SUCCESS — paridade Bridge, libera a vaga sem
      // segurar slot da onda seguinte; falha preserva pane para diagnóstico.
      spawnedPaneId = spawned.paneId;
      if (spawnTiming) {
        spawnTiming.meta.ok = true;
        spawnTiming.meta.paneId = spawned.paneId;
      }
      isolatedWriter?.link(spawned.paneId, spawned.sessionId ?? undefined);
      if (autoClose && spawned.sessionId) {
        armAutoCloseOnHandoff(spawned.sessionId, spawned.paneId);
      }
      if (deliveryContract && spawned.sessionId) {
        armDeliveryContract(spawned.sessionId, deliveryContract);
      }
      // Receipt de harness (Overclock 1.3.23 + OVKA-748): quem spawnou lê O QUE
      // foi decidido — CLI, modelo, esforço e de onde a escolha veio — em vez
      // de inferir pelo título do pane. `harnessReceipt` (tabela por task) entra
      // quando o chamador declarou `task`.
      const briefingWarn = briefingPointerWarning(
        options.prompt ?? str(args, 'prompt') ?? null,
      );
      // The structured route already describes this spawn; a table receipt
      // would invent medium for a CLI with no native effort control (F-163).
      const taskHarnessReceipt = autoRoute ? null : harnessReceiptForTask(str(args, 'task'), {
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort as 'low' | 'medium' | 'high' } : {}),
      });
      const diversity = harness.source === 'explicit'
        ? sameAdapterDiversityHint(options.adapterId, options.missionId, listPaneSnapshots(), spawned.paneId)
        : null;
      return {
        ...spawned,
        ...(executionMode ? { executionMode } : {}),
        ...isolatedReceipt(),
        ...(tabMissionId ? { tabMission: { missionId: tabMissionId } } : {}),
        ...(diversity ? { diversity } : {}),
        harness: {
          ...harness,
          account: getAccountChoiceReceipt(spawned.sessionId) ?? null,
          ...(taskHarnessReceipt ? { receipt: taskHarnessReceipt } : {}),
        },
        ...routeReceipt,
        ...(briefingWarn
          ? { briefingWarnings: [formatBriefingWarning(briefingWarn)] }
          : {}),
      };
    } finally {
      writerClaim?.settle(spawnedPaneId);
      // Tentativa abortada antes do consumo: a reserva que o próprio
      // auto-roteamento criou é fechada aqui — senão conta como "CLI já usada"
      // no desempate até expirar (30 min), sem pane algum.
      if (autoRouteReservation && !reservedRouteConsumed && routeReservationId &&
          options.missionId && ctx.sessionId) {
        try {
          const routeModel = routeString(autoRoute, 'model');
          const routeEffort = routeString(autoRoute, 'effort');
          getProjectDomainStores(ctx.scope).missions.consumeRouteReservation({
            reservationId: routeReservationId,
            missionId: options.missionId,
            adapterId: routeString(autoRoute, 'adapterId')!,
            ...(routeModel ? { model: routeModel } : {}),
            ...(routeEffort ? { effort: routeEffort } : {}),
          }, ctx.sessionId);
        } catch (error) {
          console.warn('[tools-panes] reserva do auto-roteamento não pôde ser fechada', error);
        }
      }
      if (isolatedWriter && !isolatedWriterPending && !spawnedWorkerPaneId && !listPaneSnapshots().some(
        (pane) => pane.executionScope?.rootRealPath === isolatedWriter!.worktreePath && pane.state !== 'exited',
      )) isolatedWriter.release();
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
    'spawning|busy|idle|exited|parked (parked = CLI stopped to free memory, conversation kept; ' +
    'wake with nexus_pane_spawn { resume: paneId }), plus adapter, model and mission binding.',
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
    'the bearer token. `account` diz qual conta o pane usa, quem decidiu ' +
    '(regra de folga/pinada/ativa/nativa) e as alternativas com sua folga — ' +
    'rótulos mascarados.',
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
    account: ctx.sessionId
      ? (getAccountChoiceReceipt(ctx.sessionId) ?? null)
      : null,
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

const paneReadHint = "mode:'full' devolve o texto inteiro";

type PaneReadMode = 'digest' | 'full';

// Default por papel: o orquestrador lê para DECIDIR — ganha o digest
// compactado; worker/operador/papel desconhecido seguem com o tail cru de
// sempre (`full`), que é o contrato que já existia.
function paneReadMode(
  args: Record<string, unknown>,
  ctx: AgentGateContext,
): PaneReadMode {
  const raw = str(args, 'mode');
  if (raw === 'digest' || raw === 'full') return raw;
  if (raw !== undefined) {
    throw new Error("nexus_pane_read: mode deve ser 'digest' ou 'full'");
  }
  return ctx.role === 'orchestrator' ? 'digest' : 'full';
}

async function paneDigestResult(tail: string): Promise<Record<string, unknown>> {
  const digest = digestPaneTail(tail);
  const classified = await classifyPaneTailForDigest(digest.text);
  return {
    mode: 'digest',
    ...(classified
      ? {
          state: classified.state,
          stateConfidence: classified.confidence,
          needsHuman: classified.needsHuman,
        }
      : {}),
    text: digest.text,
    keptLines: digest.keptLines,
    omittedLines: digest.omittedLines,
    hint: paneReadHint,
  };
}

const paneRead: McpToolDef = {
  name: 'nexus_pane_read',
  description:
    "Read a pane's terminal (ANSI stripped). mode:'digest' (default for the " +
    'orchestrator) returns a compact object: signal lines (errors, test ' +
    'results, prompts, handoffs) from the older part of the window plus the ' +
    'last 30 non-blank lines verbatim, Jev state when the classifier ' +
    'answers, keptLines/omittedLines counts and a hint — much cheaper than ' +
    'raw text. mode:\'full\' returns the raw tail string as before (default ' +
    'for workers/user/unknown roles). ' +
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
      mode: {
        type: 'string',
        enum: ['digest', 'full'],
        description:
          "'digest' = compacted object (default for the orchestrator); " +
          "'full' = raw tail text (default for everyone else).",
      },
    },
    required: ['paneId'],
  },
  handler: async (args, ctx) => {
    const sessionId = authorizedSessionIdOf(ctx, requireStr(args, 'paneId'), 'read');
    const tail = readSessionOutput(sessionId, num(args, 'lines') ?? 200);
    if (paneReadMode(args, ctx) !== 'digest') return tail;
    return paneDigestResult(tail);
  },
};

const paneReadMany: McpToolDef = {
  name: 'nexus_pane_read_many',
  description:
    'Read the output of several panes at once. Same visibility and ' +
    "mode:'digest'|'full' semantics as nexus_pane_read (orchestrator " +
    'defaults to digest); errors come back per item. ' +
    'Prefer this over looping nexus_pane_read; prefer handoff_list when ' +
    'you only need structured completion, not the raw PTY.',
  inputSchema: {
    type: 'object',
    properties: {
      paneIds: { type: 'array', items: { type: 'string' } },
      lines: { type: 'number' },
      mode: { type: 'string', enum: ['digest', 'full'] },
    },
    required: ['paneIds'],
  },
  handler: async (args, ctx) => {
    const lines = num(args, 'lines') ?? 200;
    const mode = paneReadMode(args, ctx);
    return Promise.all(
      strArray(args, 'paneIds').map(async (paneId) => {
        try {
          const tail = readSessionOutput(
            authorizedSessionIdOf(ctx, paneId, 'read'),
            lines,
          );
          if (mode !== 'digest') return { paneId, output: tail };
          return { paneId, ...(await paneDigestResult(tail)) };
        } catch (err) {
          return {
            paneId,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
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
    // OVKA-750 (soft): brief longo que cita card/task file → avisa o ponteiro.
    const briefingWarn = briefingPointerWarning(text);
    // F-662: a escrita segue (pode ser a resposta a um prompt de primeiro uso),
    // mas o recibo diz que o agente one-shot não vai ler a mensagem.
    const target = getAgentSessionInfo(sessionId);
    return {
      ok: true,
      ...(briefingWarn
        ? { briefingWarnings: [formatBriefingWarning(briefingWarn)] }
        : {}),
      ...(target?.oneShot ? { oneShot: oneShotPaneNotice(target.adapterId) } : {}),
    };
  },
};

/**
 * F-662: pane one-shot (AGY `--print`, OpenCode `run`) não lê o terminal e
 * só imprime ao terminar. Perguntar a ele esperava o prazo inteiro e voltava
 * vazio — o orquestrador concluía "infraestrutura quebrada" e abandonava um
 * worker que estava trabalhando.
 */
export function oneShotPaneNotice(adapterId: string): string {
  return (
    `pane one-shot (${adapterId}): a CLI roda sem terminal interativo, não lê ` +
    'perguntas nem mensagens e só mostra a resposta quando termina — tela ' +
    'vazia até lá é o normal. A entrega chega pelo fim do processo; espere com ' +
    'nexus_pane_wait em vez de perguntar.'
  );
}

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
    // F-662: nada é digitado — no one-shot a pergunta cairia no stdin cru.
    const target = getAgentSessionInfo(sessionId);
    if (target?.oneShot) {
      return { ok: false, state: 'oneshot', answer: oneShotPaneNotice(target.adapterId) };
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
    'Broadcast with a receipt per target. writes: [{paneId, text, submit?, ' +
    'force?}]. Each entry answers outcome submitted|skipped|failed and, when ' +
    'skipped, reason pane_dead|agent_not_ready|pane_hibernated. A refused ' +
    'target never stops the others; a dead pane never receives.',
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
            force: {
              type: 'boolean',
              description:
                'Deliver even to a pane still spawning or hibernated. ' +
                'A dead pane never receives.',
            },
          },
          required: ['paneId', 'text'],
        },
      },
    },
    required: ['writes'],
  },
  handler: async (args, ctx, invocation) => {
    const writes = Array.isArray(args.writes) ? args.writes : [];
    const results: PaneWriteReceipt[] = [];
    for (const raw of writes) {
      // Do not turn a revoked batch into N best-effort writes. Every iteration
      // revalidates outside the per-item error wrapper so revocation stops it.
      assertMcpInvocationCurrent(invocation);
      const write = raw as {
        paneId?: string;
        text?: string;
        submit?: boolean;
        force?: boolean;
      };
      if (typeof write.paneId !== 'string' || typeof write.text !== 'string') {
        results.push({
          paneId: String(write.paneId),
          ok: false,
          outcome: 'failed',
          error: 'invalid write',
        });
        continue;
      }
      try {
        const sessionId = authorizedSessionIdOf(ctx, write.paneId, 'write');
        const skip = broadcastSkipReason(
          getSessionState(sessionId),
          write.force === true,
        );
        if (skip) {
          results.push({
            paneId: write.paneId,
            ok: false,
            outcome: 'skipped',
            reason: skip,
          });
          continue;
        }
        const text = withWorkerHandoffFooter(sessionId, write.text ?? '');
        if (write.submit === false) {
          assertMcpInvocationCurrent(invocation);
          orchWriteSession(sessionId, text);
        } else {
          await injectPrompt(sessionId, text, invocation);
        }
        results.push({ paneId: write.paneId, ok: true, outcome: 'submitted' });
      } catch (err) {
        results.push({
          paneId: write.paneId,
          ok: false,
          outcome: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  },
};

/** Recibo por alvo de um broadcast: o que aconteceu com CADA pane, nomeado. */
export interface PaneWriteReceipt {
  readonly paneId: string;
  /** Compatibilidade: `true` só quando `outcome === 'submitted'`. */
  readonly ok: boolean;
  readonly outcome: 'submitted' | 'skipped' | 'failed';
  readonly reason?: BroadcastSkipReason;
  readonly error?: string;
}

export type BroadcastSkipReason =
  | 'pane_dead'
  | 'agent_not_ready'
  | 'pane_hibernated';

/**
 * Regra do broadcast (herdada do Sidecar): entregar a quem pode receber e
 * dizer, por alvo, por que não entregou aos outros — nunca acordar pane
 * morto, nunca digitar num agente que ainda está nascendo. `force` passa por
 * cima de "não pronto"/"hibernado"; morto continua morto.
 */
export function broadcastSkipReason(
  state: ReturnType<typeof getSessionState>,
  force: boolean,
): BroadcastSkipReason | null {
  if (state === null || state === 'exited') return 'pane_dead';
  if (force) return null;
  if (state === 'spawning') return 'agent_not_ready';
  if (state === 'hibernated') return 'pane_hibernated';
  return null;
}

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
