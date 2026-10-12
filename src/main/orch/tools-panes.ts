import { getMissionDecisionHints } from './mission-decision-hints';
import type { MissionDecisionHints } from '../../shared/orch-types';
import { assertLicenseAccess } from '../license-enforcement';
import { captureMissionPaneResume } from './mission-pane-resume';
import { rollbackWorkerContinuationBeforeBirth } from './mission-pane-resume-ownership';
import { createVisualTaskRequirement, visualTaskRequirement } from './visual-handoff-gate';
import { assertTabSupportsOperation, isolatedWriterBaseRoot, missionExecutionScope } from './mission-execution-scope';
import { nestedWorktreeExecution, requestedCwdInside } from './nested-worktree-execution';
import {
  assertMcpInvocationCurrent,
  type McpToolDef,
  type McpToolInvocation,
} from './mcp-protocol';
import type { PaneSnapshot } from '../../shared/orch-types';
import {
  getPaneRuntimeAuthorityBySession,
  isPaneSpawnPending,
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
  isOneShotSessionRunning,
  orchWriteSession,
  sessionLeaseRegistry,
  tapSessionExit,
} from '../pty/pty-manager';
import {
  getAdapter,
  isAdapterInstalled,
  listAdapterInfos,
  listAdapters,
} from '../adapters/adapter-registry';
import { canUseNexusMcp } from './cli-mcp-inject';
import { adapterSchema } from '../../shared/adapter-types';
import {
  armAutoCloseOnHandoff,
  armAutoCloseOnHandoffForPane,
  disarmAutoCloseOnHandoff,
  selectScopedPaneCloseTargets,
  shouldArmAutoCloseOnHandoff,
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
  requireCatalogAgent,
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
  routeJevReceipt,
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
import { loadModelCatalog, modelCatalogInfo, isModelBlockedForAutoRouting } from '../adapters/model-catalog';
import { discoverCliModels } from '../adapters/cli-model-discovery';
import { modelAccessQuarantine } from './model-access-quarantine';
import { newestInModelLine } from '../../shared/model-line';
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
  type PendingMissionPaneRecord,
  type PendingSpawnAttemptInfo,
  type SpawnToolOptions,
} from './tool-util';
import {
  trackPaneStart,
  untrackPaneStart,
  type PaneStartRerouteResult,
} from './pane-start-watchdog';
import {
  forgetPaneTaskReroute,
  registerPaneTaskReroute,
  setNextCliResolver,
  type PaneTaskRerouteRequest,
} from './pane-task-reroute';
import { selectSpawnFailSuccessor } from './spawn-fail-reroute';
import { adapterCircuitBreakers } from './circuit-breaker';
import { isMissionWorkerWriteEligibleCli } from './squad-runtime-policy';
import { isOperatorChoicePolicy } from '../../shared/squad-cli-policy';
import { getAccountChoiceReceipt } from '../persistence/account-choice-receipts';
import { trace } from '../observability/main-trace';
import { peekCodexCliVersion } from './codex-cli-version';
import {
  buildPaneSpawnLifecycleEvent,
  buildPaneSpawnRecoveryEvent,
  classifySpawnErrorCode,
  type PaneSpawnLifecycleMeta,
} from './pane-spawn-lifecycle';
import {
  startPhaseTimer,
  type PhaseTimer,
} from '../observability/phase-timer';
import { CODEX_MCP_TOOL_TIMEOUT_SEC } from './cli-mcp-inject';
import {
  assertCurrentMissionOrchestratorSession,
  canonicalToolName,
  gateContextAbortSignal,
  getContextBySession,
  isCurrentGateContext,
  PreEffectRefusalError,
  type AgentGateContext,
} from './gate';
import { applyWorkerSpawnPolicy } from '../../shared/mission-intent';
import { SKILL_SUGGESTION_MIN_CONFIDENCE } from './jev-skill-suggestion';
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
import { defaultMissionWorkerTools } from './nexus-browser-policy';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import { isOperatorTabMission } from './operator-tab-mission-resume';
import { OPERATOR_CHOICE_PROOF_WINDOW_MS, operatorRecentlyNamedCli } from './operator-cli-mentions';
import {
  judgeIdleHelperReuse,
  listIdleHelperCandidates,
} from './idle-helper-reuse';
import {
  capDigestEntries,
  DIGEST_MAX_CHARS,
  digestBudgetPerPane,
  digestPaneTail,
  PANE_READ_MANY_MAX_PANES,
  PANE_READ_MANY_MAX_REFS,
} from './pane-output-digest';
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

/**
 * F-919: `resume` mantém a CLI do pane retomado — adapterId/model herdados
 * do registro vivo ou do worker record durável (`missionPanes`, que
 * sobrevive ao pane fechado e ao reinício do app). Sem nenhum dos dois,
 * devolve null e o chamador falha no `requireStr` como antes (fail-closed).
 */
function resumedPaneRuntime(
  scope: ProjectExecutionScope,
  ref: string,
): { adapterId: string; model?: string } | null {
  const live = findPane(ref);
  if (live?.adapterId) {
    return {
      adapterId: live.adapterId,
      ...(live.model ? { model: live.model } : {}),
    };
  }
  const paneId = ref.startsWith('pane-')
    ? ref
    : (live?.paneId ?? resumePaneRefOf(ref, scope));
  if (!paneId) return null;
  if (!ref.startsWith('pane-')) {
    const byPaneId = findPane(paneId);
    if (byPaneId?.adapterId) {
      return {
        adapterId: byPaneId.adapterId,
        ...(byPaneId.model ? { model: byPaneId.model } : {}),
      };
    }
  }
  try {
    const spec = getProjectDomainStores(scope).missionPanes.findByPaneId(paneId);
    if (spec?.adapterId) {
      return {
        adapterId: spec.adapterId,
        ...(spec.model ? { model: spec.model } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
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

/**
 * F-218 (regra do operador 29/09, repetida hoje — "Sol 6.1 saiu; nunca use o
 * Sol normal"): um modelo que chega EXPLÍCITO (args.model, template de squad,
 * requestedModel do roster que vence o selo) sobe para o mais novo da mesma
 * linha entre os elegíveis do adapter — o mesmo conjunto que
 * `assertOperatorExplicitRuntime` considera rodável (lista viva + modelos
 * descobertos pela CLI), menos os bloqueados pelo catálogo e os recusados pelo
 * provider (quarentena). Selos de roster, reservas de rota, resume e o
 * "+ Pane" do renderer não passam por aqui: contrato ou clique literal.
 */
function newestExplicitModelInLine(
  adapterId: string,
  model: string | undefined,
): {
  readonly model: string | undefined;
  readonly upgrade?: { readonly requested: string; readonly used: string };
} {
  if (!model) return { model };
  const adapter = cliAdapterFor(adapterId);
  const catalog = loadModelCatalog();
  const eligible = [
    ...new Set([
      ...(discoverCliModels().get(adapterId) ?? []),
      ...(adapter?.models.list ?? []),
    ]),
  ].filter(
    (candidate) =>
      !isModelBlockedForAutoRouting(
        modelCatalogInfo(catalog, adapterId, candidate),
      ) && !modelAccessQuarantine(adapterId, candidate),
  );
  const used = newestInModelLine(model, eligible);
  return used === model
    ? { model }
    : { model: used, upgrade: { requested: model, used } };
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
  '[Ao terminar, chame nexus_handoff_submit uma vez com status, summary, fullText (relatório completo), artifacts e evidenceIds.]';

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

/**
 * F-1259: a vaga de maxWorkers retida por falta de linha durável não pode
 * segurar o teto para sempre (budget_exhausted até reiniciar o Main). Na
 * prova física de saída do filho — o tap de saída do PTY — a vaga é
 * liberada, com ou sem composição durável (que pode chegar tarde). Sem saída,
 * a vaga fica: bloquear uma vaga é melhor que passar do teto. One-shot:
 * desarma no primeiro match.
 */
function armWorkerReservationExitRelease(input: {
  readonly paneIds: readonly (string | undefined)[];
  readonly release: () => void;
}): void {
  const watched = new Set(
    input.paneIds.filter((paneId): paneId is string => typeof paneId === 'string'),
  );
  if (watched.size === 0) return;
  const untap = tapSessionExit((exitedSessionId, agent) => {
    const snapshotPaneId = listPaneSnapshots()
      .find((pane) => pane.sessionId === exitedSessionId)?.paneId;
    const paneId = agent?.paneId
      ?? getPaneRuntimeAuthorityBySession(exitedSessionId)?.paneId
      ?? snapshotPaneId;
    if (paneId === undefined || !watched.has(paneId)) return;
    untap();
    // Revisão de ponta: a prova física de saída libera SEMPRE — com linha
    // durável tardia a vaga ficava presa até reiniciar o Main (o release é
    // idempotente e o filho já saiu de qualquer forma).
    input.release();
  });
  // A saída pode ter acontecido antes do braço (continuação adiada): a prova
  // já está nos snapshots.
  const alreadyExited = [...watched].some((paneId) =>
    listPaneSnapshots().find((pane) => pane.paneId === paneId)?.state === 'exited',
  );
  if (alreadyExited) {
    untap();
    input.release();
  }
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

/**
 * F-1318: isolatedWriter explícito vence readOnly. O spawn que pede worktree
 * própria entra no caminho de alocação mesmo rotulado como leitor — no
 * Autopilot o rótulo readOnly é consultivo (sem readOnlyEnforced fora do
 * Hardened) e o "leitor" que escreve não pode dividir o checkout. Leitor sem
 * isolatedWriter segue no checkout, como antes.
 */
export function shouldEnterIsolatedWriterPath(input: {
  readonly hasAllocation: boolean;
  readonly spawnReadOnly: boolean;
  readonly isolatedWriterRequested: boolean;
}): boolean {
  if (input.hasAllocation) return false;
  return !input.spawnReadOnly || input.isolatedWriterRequested;
}

/** Aviso do auto-isolamento: a worktree sai do HEAD, sem o WIP do operador. */
export const ISOLATED_WORKTREE_NOTE =
  'não contém alterações não commitadas do checkout principal';
/** F-980: writer aberto da pasta isolada de uma aba nasce do HEAD dela. */
export const ISOLATED_TAB_WORKTREE_NOTE =
  'nasce do HEAD da pasta isolada da aba e não contém as alterações não commitadas dela';

/** F-981: worktree aninhada já tem writer — a recusa diz a saída. */
function nestedWorktreeBusy(reason: string, worktreeRoot: string): string {
  return `${reason} (worktree ${worktreeRoot}); para writers em paralelo use isolatedWriter:true — ` +
    'o Nexus cria worktree/branch própria, registrada para integração';
}

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
  workspace: { branch: string; worktreePath: string; baseSha?: string; baseRootRealPath?: string },
): string {
  return '## Nexus execution authority\n' +
    `executionMode=\`isolated_worktree\`: esta tarefa roda na worktree própria ${workspace.worktreePath}, ` +
    `na branch ${workspace.branch}. ` +
    (workspace.baseRootRealPath
      ? `A worktree nasce do commit ${workspace.baseSha ?? 'HEAD'}, o HEAD da pasta isolada da aba ` +
        `(${workspace.baseRootRealPath}), e não contém as alterações não commitadas dela. `
      : `A worktree nasce do commit ${workspace.baseSha ?? 'HEAD'} do checkout de coordenação e ${ISOLATED_WORKTREE_NOTE}. `) +
    'Commit na própria branch é permitido e esperado. ' +
    'A branch não pode ser publicada: não use push, pull, stash, checkout, reset ou clean; ' +
    'não toque em outras branches nem no checkout de coordenação. ' +
    'Não há reserva exclusiva de arquivos: outros escritores podem editar o mesmo arquivo e gerar conflitos. ' +
    'Não há merge automático; o orquestrador revisa e integra as branches na ordem de dependência. ' +
    'Use nexus_git_add/commit/status/diff/log na própria worktree; nexus_terminal_run aceita somente essas operações Git estruturadas. ' +
    // F-794: a concessão vem da autoridade do Main, não do allowlist da squad.
    'Essas cinco ferramentas Git já estão liberadas para esta worktree, mesmo que o seu allowlist venha vazio: commite antes do handoff. ' +
    'Se o commit falhar mesmo assim, o Nexus guarda um snapshot das alterações não commitadas (refs/nexus-salvage/) quando você entrega o handoff e quando o pane fecha; declare isso no handoff. ' +
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
  /** Prompt used only to resolve referenced briefs for classification. */
  readonly classificationPrompt?: string;
  readonly tieBreakUseCounts?: ReadonlyMap<string, number>;
  readonly excludeAdapterIds?: readonly string[];
  /**
   * Pin do agente sem pedido do operador → PREFERÊNCIA suave: entra em
   * `preferAdapters` do roteador (boost), nunca em excludes.
   */
  readonly preferAdapterIds?: readonly string[];
  /**
   * F-802: spawn somente leitura FORA do Autopilot — o spawn recusa CLI que não
   * confina leitura, então a rota só pode escolher entre as que confinam.
   */
  readonly requireReadOnlyEnforceable?: boolean;
  /**
   * F-802: só sugerir (o hook /hook/delegate apontando a CLI melhor): sem o
   * lote do Jev (não gasta a chave do operador) e sem registrar proveniência
   * de spawn nem diário de rotas — nada foi decidido.
   */
  readonly suggestOnly?: boolean;
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
 * F-775: o failover pergunta a próxima CLI de uma tarefa pelo MESMO roteador
 * do spawn, com a autoridade ATUAL de quem pediu (Maestro ou operador) — sem
 * spawnar nem reservar nada além do que a rota já faz.
 */
setNextCliResolver(async ({ callerSessionId, task, excludeAdapterIds, preferAdapterIds }) => {
  const ctx = getContextBySession(callerSessionId);
  if (!ctx || !isCurrentGateContext(ctx) || !operatorRouteResolver) return null;
  const route = await operatorRouteResolver(task, ctx, {
    excludeAdapterIds,
    ...(preferAdapterIds?.length ? { preferAdapterIds } : {}),
  });
  const adapterId = routeString(route, 'adapterId');
  if (!adapterId) return null;
  const model = routeString(route, 'model');
  const effort = routeString(route, 'effort');
  return { adapterId, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
});

/**
 * F-802: a rota que o motor sugeriria para `task`, fora do spawn (o hook
 * /hook/delegate aponta a CLI melhor em UMA linha). Mesmo motor, sem Jev e sem
 * efeito colateral; null quando o resolver ainda não foi registrado (boot cedo).
 */
export function suggestOperatorRoute(
  task: string,
  ctx: AgentGateContext,
  constraints: Pick<OperatorRouteInternal, 'excludeAdapterIds' | 'requireReadOnlyEnforceable'> = {},
): Promise<Record<string, unknown>> | null {
  return operatorRouteResolver?.(task, ctx, { ...constraints, suggestOnly: true }) ?? null;
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
) => OperatorTabMission | null | Promise<OperatorTabMission | null>;

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
export async function adoptThroughOperatorTabMission(
  ctx: AgentGateContext,
  task: string | null,
): Promise<OperatorTabMission | null> {
  return await operatorTabMissionProvider?.(ctx, task) ?? null;
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
): { name: string; pkg: string; confidence: number; path?: string } | null {
  const raw = autoRoute?.skill ?? autoRoute?.skillSuggestion;
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.name !== 'string' || !rec.name.trim()) return null;
  if (typeof rec.confidence !== 'number' || !Number.isFinite(rec.confidence)) {
    return null;
  }
  // F-753: só o formato que o catálogo do projeto produz vira caminho no brief.
  const path =
    typeof rec.path === 'string' && PROJECT_SKILL_PATH.test(rec.path) ? rec.path : undefined;
  return {
    name: rec.name,
    pkg: typeof rec.pkg === 'string' ? rec.pkg : '',
    confidence: rec.confidence,
    ...(path ? { path } : {}),
  };
}

/** `.claude/skills/<nome>/SKILL.md` ou `.nexus/skills/<nome>/SKILL.md`, nada fora disso. */
const PROJECT_SKILL_PATH = /^\.(?:claude|nexus)\/skills\/[A-Za-z0-9._-]+\/SKILL\.md$/;

/** A linha que o brief do worker ganha para a skill escolhida pela rota. */
export function routeSkillHintLine(skill: { name: string; path?: string }): string {
  return skill.path
    ? `Skill sugerida pelo Nexus: ${skill.name} — leia \`${skill.path}\` antes de começar.`
    : `Skill sugerida pelo Nexus: ${skill.name} — leia a SKILL.md dela antes de começar.`;
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
 * F-787: o meta é o contrato de pane-spawn-lifecycle (modelo efetivo,
 * sessionId, versão da CLI, código de erro) — só ids/categorias/números.
 */
type PaneSpawnTimingMeta = PaneSpawnLifecycleMeta;
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
    'visibly. In a running mission, omit adapterId and describe `task`: the ' +
    'spawn routes itself (no nexus_route_task call first); pass ' +
    'routeReservationId only when you already called nexus_route_task. ' +
    'Prompt is delivered in the CLI argv AT BIRTH. ' +
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
      model: {
        type: 'string',
        description:
          'Model id for this spawn (e.g. "gpt-6.1-sol"). Omit it and Nexus ' +
          'picks the model by routing. An older version of a model line is ' +
          'replaced by the newest one the CLI offers (receipt: modelUpgrade ' +
          '{requested, used}); sealed roster models and pane resumes are ' +
          'kept as-is.',
      },
      effort: {
        type: 'string',
        description:
          'Reasoning effort for this spawn (low|medium|high|xhigh) — use ' +
          'the value returned by nexus_route_task',
      },
      cwd: {
        type: 'string',
        description:
          'Working directory inside the workspace. A writer whose cwd is the root of another git worktree of ' +
          'this repository nested INSIDE the workspace (e.g. <root>/.harvest/<name>) runs in that worktree and is ' +
          'serialized only against writers of that same worktree; a worktree outside the workspace is refused. ' +
          'Prefer isolatedWriter:true, which creates and registers the worktree/branch for integration.',
      },
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
        description: 'Spawn this writer in its own git worktree/branch so several writers run in parallel (with or without a mission); the orchestrator integrates the branch afterwards. The worktree and branch are kept for integration after the pane closes; a merged, clean one is garbage-collected. It starts at the checkout HEAD without uncommitted changes (the receipt carries baseSha); called from a tab with its own isolated folder, it starts at that tab\'s HEAD instead. Resuming such a pane reuses its original worktree.',
      },
      baseRef: {
        type: 'string',
        description:
          'isolatedWriter only: commit the worktree starts from (sha, branch or tag; validated with ' +
          'git rev-parse --verify <ref>^{commit}). Default: the current HEAD. Invalid ref = clear ' +
          'error, no spawn. The receipt baseSha is the resolved commit.',
      },
      allowedTools: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional tool allowlist for this pane — it can only NARROW what ' +
          'the caller and the roster already allow, never widen. Worker de ' +
          'missão só recebe MCPs do hub pedidos aqui (ex.: mcp__github__*).',
      },
      autoCloseOnHandoff: {
        type: 'boolean',
        description:
          'Close this pane automatically when it submits a SUCCESS handoff ' +
          '(declared at birth; failure keeps the pane open for diagnosis). ' +
          'Default ON for operator helpers without a mission and for mission ' +
          'workers (the piece is done — free the RAM). Orchestrator panes and ' +
          'operator-opened panes inside a mission never auto-close. Pass ' +
          'false to keep a pane alive after delivery.',
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
          'Combine with prompt (the adjustment). adapterId/model may be ' +
          'omitted: they are inherited from the resumed pane (live registry ' +
          'or its durable worker record).',
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
    assertLicenseAccess();
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
      tabMission = await operatorTabMissionProvider(ctx, operatorRouteTask(args));
    }
    const spawnTiming: PaneSpawnTiming = {
      timer: startPhaseTimer(),
      meta: {},
    };
    try {
      // F-1185: a adoção acima é efeito do próprio Main sobre este chamador.
      if (tabMission) invocation?.reanchorAfterOwnPromotion?.();
      assertMcpInvocationCurrent(invocation);
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
      spawnTiming.meta.errorCode = classifySpawnErrorCode(error);
      tabMission?.discardIfUnused();
      throw error;
    } finally {
      // F-213: um evento por tentativa — sucesso, rota que falhou antes do
      // PTY, falha de spawn ou exceção interna. Só ids/labels/números.
      // F-787: modelo efetivo, sessionId, versão da CLI, origem classificada
      // da injeção, código permanente de erro e paneCreated (rejeição antes
      // do primeiro turno ≠ pane criado). Nunca prompt/argv/ambiente/conta.
      const { totalMs, phases } = spawnTiming.timer.finish();
      trace(
        buildPaneSpawnLifecycleEvent({
          meta: spawnTiming.meta,
          caller: {
            role: ctx.role,
            missionId: ctx.missionId ?? null,
            sessionId: ctx.sessionId ?? null,
          },
          requestedAdapterId: str(args, 'adapterId') ?? null,
          requestedMissionId: str(args, 'missionId') ?? null,
          totalMs,
          phases,
        }),
      );
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
    startRecovery?: PaneStartRecovery,
  ): Promise<unknown> => {
    const agentRef = str(args, 'agentName');
    // F-1320: a base só existe para quem aloca worktree própria — nunca é
    // ignorada em silêncio. A ref é validada no Main ao alocar (rev-parse).
    const baseRef = str(args, 'baseRef');
    if (baseRef !== undefined && args.isolatedWriter !== true) {
      throw new Error('baseRef exige isolatedWriter:true: só uma worktree própria pode nascer de outra base');
    }
    // F-723: CLI que não começou a tarefa sai da rota do reenvio automático —
    // exclusão interna, autoritativa (nunca vem de argumento MCP).
    const recoveryExcluded = startRecovery?.excludeAdapterIds ?? [];
    // F-765: a reabertura pelo failover prefere (sem fixar) a CLI de antes.
    const recoveryPreferred = startRecovery?.preferAdapterIds ?? [];
    // F-1316: a rota classifica pelo brief ORIGINAL — no reenvio, o pacote de
    // continuidade (arquivos tocados, trecho do terminal) não entra na rota.
    const classificationPrompt = startRecovery
      ? startRecovery.classificationPrompt
      : str(args, 'prompt');
    // F-775: e continua na worktree isolada do pane parado, onde está o
    // trabalho não commitado. Indisponível → writer novo, como antes.
    const recoveryWorktree = (missionId: string | undefined) => {
      if (!startRecovery?.worktreeFromPaneId) return null;
      try {
        return resumeIsolatedWriterWorktree(ctx.scope, missionId, startRecovery.worktreeFromPaneId);
      } catch (error) {
        console.warn('[tools-panes] worktree do pane parado indisponível; writer novo:', error);
        return null;
      }
    };
    let routeReservationId = str(args, 'routeReservationId');
    let options: SpawnToolOptions;
    let executionMode: 'same_checkout' | 'isolated_worktree' | undefined;
    let rosterRouteAuthorized = false;
    // Reserva criada pelo auto-roteamento em missão (C, 0.76.110).
    let autoRouteReservation = false;
    let autoRoute: Record<string, unknown> | undefined;
    let routeSkill: { name: string; pkg: string; confidence: number; path?: string } | null =
      null;
    // F-218: um modelo pedido explicitamente (args.model, template de squad,
    // requestedModel do roster que vence o selo) sobe para o mais novo da sua
    // linha que a CLI oferece; o recibo diz o que foi pedido e o que rodou.
    let modelUpgrade: { readonly requested: string; readonly used: string } | undefined;
    const applyNewestModelLine = (
      adapterId: string,
      model: string | undefined,
    ): string | undefined => {
      const next = newestExplicitModelInLine(adapterId, model);
      if (next.upgrade) modelUpgrade = next.upgrade;
      return next.model;
    };
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
    const missionResume = ctx.missionId && resumeRef
      ? captureMissionPaneResume(ctx.scope, ctx.missionId, resumePaneRefOf(resumeRef, ctx.scope), {
          adapterId: str(args, 'adapterId'), model: str(args, 'model'),
          accountId: str(args, 'accountId'), effort: str(args, 'effort'), cwd: str(args, 'cwd'),
        }) : null;
    let resumeBound = false;
    try {
    if (missionResume) {
      const callerInvocation = invocation;
      invocation = { ...invocation, assertCurrentAuthority: () => {
        assertMcpInvocationCurrent(callerInvocation);
        if (!resumeBound) missionResume.assertCurrent();
      } };
    }
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
            ...(str(args, 'model')
              ? { model: applyNewestModelLine(pinnedAdapterId, str(args, 'model')!) }
              : {}),
          }
        : null;
    const operatorExplicitRequested = operatorExplicit && !pinRedistributed
      ? assertOperatorExplicitRuntime(str(args, 'adapterId')!, str(args, 'model'))
      : undefined;
    const operatorExplicitModel =
      operatorExplicitRequested !== undefined
        ? applyNewestModelLine(str(args, 'adapterId')!, operatorExplicitRequested)
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
            ...(classificationPrompt ? { classificationPrompt } : {}),
            tieBreakUseCounts,
            excludeAdapterIds:
              recoveryExcluded.length > 0
                ? [...recoveryExcluded, ...excluded]
                : excluded,
            ...routePreference(pinRedistributed, recoveryPreferred),
            ...(args.readOnly === true &&
            !isOperatorChoicePolicy(getOrchSettings().squadCliPolicy)
              ? { requireReadOnlyEnforceable: true }
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
      // vínculo com a missão continua obrigatório. F-1314: a missão de agente
      // livre (sem squad) nomeia agente do catálogo salvo, com a CLI selada.
      const found = mission?.squadId
        ? findAgentInSquad(mission.squadId, agentRef)
        : ctx.role === 'user'
          ? findAgentInAnySquad(agentRef)
          : mission
            ? requireCatalogAgent(agentRef)
            : null;
      if (!found && !mission?.squadId && ctx.role !== 'user') {
        const refusal = 'squad agent spawn requires a mission bound to a squad';
        // F-1334: nada foi gravado até aqui (missão da aba só nasce para
        // `user`). A exceção é a reserva de continuação de um `resume`: o
        // finally a desfaz, mas a compensação pode falhar — aí é efeito.
        if (missionResume?.continuation) throw new Error(refusal);
        throw new PreEffectRefusalError(refusal);
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
      // F-218: quando o roster selado VENCE é contrato — fica o modelo selado.
      // Quando o model pedido vence o roster (outra CLI ou selo sem modelo),
      // ele é um modelo explícito e sobe para o mais novo da linha. `resume`
      // mantém o runtime do pane, sem upgrade.
      const selectedModel = honored
        ? honored.rosterHonored || resumeRef
          ? honored.model
          : applyNewestModelLine(honored.adapterId, honored.model)
        : routeString(autoRoute, 'model');
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
        // F-247: `allowedTools` no arg só ESTREITA — o caller pede MCPs do
        // hub (`mcp__<server>__*`) para o worker, nunca amplia o roster.
        allowedTools: attenuateTools(
          attenuateTools(
            ctx.allowedTools,
            agent.allowedTools ??
              (role === 'orchestrator' || inheritOperatorFreedom
                ? null
                // F-797: worker sem allowlist no roster ganha as tools de
                // página do navegador do Nexus (só leitura; aba só ao chamar).
                : defaultMissionWorkerTools({
                    missionWorker: !operatorHand,
                    readOnly: args.readOnly === true || ctx.readOnly === true,
                  })),
          ),
          args.allowedTools === undefined ? null : strArray(args, 'allowedTools'),
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
      let adHocAdapterId = missionResume?.spec.adapterId ?? (forceOperatorRoute ? undefined : str(args, 'adapterId'));
      // F-919: modelo do pane retomado (herança abaixo); o explícito vence.
      let resumedModel: string | undefined;
      if (forceOperatorRoute) {
        autoRoute = await timedOperatorRoute();
        adHocAdapterId = routeString(autoRoute, 'adapterId');
      } else if (resumeRef && !missionResume) {
        // F-919: retomar mantém a CLI do pane retomado: o registro vivo vence
        // (trocar a CLI perderia a conversa retomada); sem ele, o worker
        // record durável (pane fechado, pós-reinício); sem nenhum, os args —
        // que vão falhar no `requireStr` abaixo (fail-closed). Dentro de
        // missão, `captureMissionPaneResume` já fixou a CLI acima.
        const resumedRuntime = resumedPaneRuntime(ctx.scope, resumeRef);
        adHocAdapterId = resumedRuntime?.adapterId ?? adHocAdapterId;
        resumedModel = resumedRuntime?.model;
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
              ...(classificationPrompt ? { classificationPrompt } : {}),
              ...(ctx.promotedFromUserSession === true || recoveryExcluded.length > 0
                ? {
                    excludeAdapterIds: [
                      ...(ctx.promotedFromUserSession === true
                        ? adapterIdsWithoutNexusMcp(listAdapters(), canUseNexusMcp)
                        : []),
                      ...recoveryExcluded,
                    ],
                  }
                : {}),
              ...routePreference(pinRedistributed, recoveryPreferred),
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
      // F-218: `args.model` explícito (o `operatorExplicitModel` acima já veio
      // promovido) sobe para o mais novo da linha do adapter final. A rota
      // (`autoRoute`) já devolve o modelo promovido; `resume` mantém o runtime
      // do pane — nenhum dos dois passa pelo upgrade.
      const adHocRequested =
        forceOperatorRoute || missionAutoRoute
          ? undefined
          : (operatorExplicitModel ??
            (resumeRef
              ? (str(args, 'model') ?? resumedModel)
              : applyNewestModelLine(adHocAdapterId, str(args, 'model'))));
      const adHocModel = adHocRequested ?? routeString(autoRoute, 'model');
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
      // F-218: o modelo do template de squad é um default declarado, não um
      // selo de missão — segue a regra da linha. `uniqueSealed` é contrato.
      const squadTemplateModel =
        !resumeRef && squadAgent?.model
          ? applyNewestModelLine(adHocAdapterId, squadAgent.model)
          : squadAgent?.model;
      const selectedAdHocModel = missionResume ? missionResume.spec.model : uniqueSealed?.model ?? adHocModel ?? squadTemplateModel;
      const selectedAdHocEffort = missionResume ? missionResume.spec.effort : uniqueSealed?.effort ?? adHocEffort ?? squadAgent?.effort;
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
        routeSkill.confidence >= SKILL_SUGGESTION_MIN_CONFIDENCE &&
        (adHocAllowedSkills === null ||
          adHocAllowedSkills.some(
            // Grants são por pacote OU por nome, como o skill-mirror.
            (skill) =>
              skill.toLowerCase() === routeSkill!.name.toLowerCase() ||
              (routeSkill!.pkg !== '' &&
                skill.toLowerCase() === routeSkill!.pkg.toLowerCase()),
          ))
      ) {
        adHocPrompt = `${adHocPrompt}\n\n${routeSkillHintLine(routeSkill)}`;
      }
      const gateModel =
        selectedAdHocModel ?? defaultModelForAdapter(adHocAdapterId);
      // A mão do operador escolhe o modelo: o aviso de catálogo (custo/faixa)
      // não vira parede `route_required` no pane dele. O gate de modelo
      // fantasma continua a jusante (resolveModelForSpawn).
      if (!routeReservationId && !operatorHand && !missionResume) {
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
        // F-247: o arg `allowedTools` só estreita — é o opt-in que libera um
        // MCP do hub (`mcp__<server>__*`) para o worker de missão.
        allowedTools: attenuateTools(
          attenuateTools(
            ctx.allowedTools,
            inheritOperatorFreedom
              ? null
              // F-797: o worker ad hoc de missão nascia com `[]` e nunca via o
              // navegador do Nexus; agora leva as tools de página (só leitura).
              : defaultMissionWorkerTools({
                  missionWorker: !operatorHand,
                  readOnly: args.readOnly === true || ctx.readOnly === true,
                }),
          ),
          args.allowedTools === undefined ? null : strArray(args, 'allowedTools'),
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
    if (missionResume) {
      const original = missionResume.spec;
      options = { ...options, adapterId: original.adapterId, model: original.model,
        workerContinuation: missionResume.continuation,
        operatorOpened: original.operatorOpened,
        visualTask: original.visualTask,
        accountId: original.accountId, effort: original.effort, cwd: original.cwd,
        executionScope: original.executionScope, resume: true, resumeFromPaneId: original.paneId,
        readOnly: options.readOnly === true || original.readOnly === true,
        allowedTools: attenuateTools(options.allowedTools ?? null, original.allowedTools === undefined ? [] : original.allowedTools),
        allowedSkills: attenuateSkills(options.allowedSkills ?? null, original.allowedSkills === undefined ? [] : original.allowedSkills),
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
      const resumed =
        resumeIsolatedWriterWorktree(ctx.scope, undefined, options.resumeFromPaneId) ??
        recoveryWorktree(undefined);
      if (resumed) {
        isolatedWriter = resumed;
      } else if (options.readOnly !== true) {
        // F-981: cwd na raiz de outra worktree Git deste repositório roda lá,
        // sem disputar a vez com os writers do checkout.
        const nested = args.isolatedWriter !== true
          ? await nestedWorktreeExecution(callerExecutionScope, options.cwd)
          : undefined;
        if (nested) options = { ...options, executionScope: nested.scope, cwd: nested.cwd };
        const checkoutRoot = (nested?.scope ?? callerExecutionScope).rootRealPath;
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
            : hasPendingWriterClaim(checkoutRoot, snapshots, isPaneSpawnPending)
              ? 'writer em spawn ainda ativo — espere a entrega dele ou abra este como readOnly'
              : undefined;
          if (blockedBy === undefined) writerClaim = claimSameCheckoutWriter(checkoutRoot);
        }
        if (nested && blockedBy !== undefined) throw new Error(nestedWorktreeBusy(blockedBy, checkoutRoot));
        if (args.isolatedWriter === true || blockedBy !== undefined) {
          let baseRootRealPath: string | undefined;
          try {
            // F-980: na pasta isolada da aba a worktree nasce do HEAD da aba.
            baseRootRealPath = isolatedWriterBaseRoot(ctx.scope, callerExecutionScope, ctx.sharedTabWorktree);
          } catch (error) {
            // Aba sem prova de identidade não ganha worktree: mantém a fila.
            throw blockedBy !== undefined ? new Error(blockedBy) : error;
          }
          if (blockedBy !== undefined) {
            isolatedWriterReason = `auto-isolado: ${blockedBy.replace(/ — .*$/, '')} no mesmo checkout`;
          }
          try {
            isolatedWriter = await allocateIsolatedWriterWorktree(ctx.scope, undefined, {
              assertCurrentAuthority: () => assertMcpInvocationCurrent(invocation),
              signal: invocation?.signal,
              ...(baseRootRealPath ? { baseRootRealPath } : {}),
              ...(baseRef ? { baseRef } : {}),
            });
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
    const requestedCwd = str(args, 'cwd');
    // Recibo: quem spawnou sabe qual branch/worktree integrar depois.
    const isolatedReceipt = () => isolatedWriter
      ? { isolatedWorktree: {
          branch: isolatedWriter.branch,
          worktreePath: isolatedWriter.worktreePath,
          baseSha: isolatedWriter.baseSha,
          note: isolatedWriter.baseRootRealPath ? ISOLATED_TAB_WORKTREE_NOTE : ISOLATED_WORKTREE_NOTE,
          // F-981: o writer isolado roda na raiz da worktree própria; o cwd pedido não vale.
          ...(requestedCwd && requestedCwd !== isolatedWriter.worktreePath
            ? { cwdDiscarded: { requested: requestedCwd, reason: 'o writer isolado roda na raiz da worktree própria' } }
            : {}),
          ...(isolatedWriterReason ? { reason: isolatedWriterReason } : {}),
        } }
      : {};
    let releaseWorkerSlot: (() => void) | undefined;
    let spawnedWorkerPaneId: string | undefined;
    /** F-793: gravação adiada da linha do worker que nasceu com ACK pendente. */
    let pendingMissionPane: Promise<PendingMissionPaneRecord> | undefined;
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
          const reservedRoute = missionSuite.missions.assertRouteReservation(expectedRoute);
          if (reservedRoute?.decision.specialty === 'visual') {
            options = { ...options, visualTask: createVisualTaskRequirement() };
          }
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
              options.prompt ??
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
            missionId: options.missionId,
          }, missionSuite?.missions.routeDecisions ?? null);
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
          const spawnReadOnly =
            options.readOnly === true || options.executionMode === 'read_only';
          // F-981: o guard olha a worktree Git REAL do pane — cwd na raiz de
          // outra worktree deste repositório roda lá, em escopo próprio.
          const nested = !spawnReadOnly && args.isolatedWriter !== true
            ? await nestedWorktreeExecution(callerExecutionScope, options.cwd)
            : undefined;
          const writerExecutionScope = nested?.scope ?? callerExecutionScope;
          const checkoutRoot = writerExecutionScope.rootRealPath;
          isolatedWriter =
            resumeIsolatedWriterWorktree(ctx.scope, missionId, options.resumeFromPaneId) ??
            recoveryWorktree(missionId) ??
            undefined;
          if (missionResume && !isolatedWriter &&
              missionResume.spec.executionScope.rootRealPath !== checkoutRoot) {
            throw new Error('resume_worktree_unavailable: worktree original indisponível; retomada preservada para recuperação');
          }
          if (shouldEnterIsolatedWriterPath({
            hasAllocation: isolatedWriter !== undefined,
            spawnReadOnly,
            isolatedWriterRequested: args.isolatedWriter === true,
          })) {
            let blockedBy: string | undefined;
            if (args.isolatedWriter !== true) {
              const snapshots = listPaneSnapshots();
              const decision = decideSameCheckoutSpawn({
                spawnReadOnly,
                activeWorker:
                  activeSameCheckoutWorker(snapshots, checkoutRoot) ??
                  (hasPendingWriterClaim(checkoutRoot, snapshots, isPaneSpawnPending)
                    ? { paneId: 'em spawn', state: 'spawning' }
                    : null),
              });
              blockedBy = decision.allowed ? undefined : decision.reason;
              if (blockedBy === undefined) writerClaim = claimSameCheckoutWriter(checkoutRoot);
            }
            if (nested && blockedBy !== undefined) throw new Error(nestedWorktreeBusy(blockedBy, checkoutRoot));
            // Paridade com a mão do operador: o segundo writer comum é
            // auto-isolado numa worktree própria em vez de recusado.
            if (args.isolatedWriter === true || blockedBy !== undefined) {
              let baseRootRealPath: string | undefined;
              try {
                // F-980: na pasta isolada da aba a worktree nasce do HEAD da aba.
                baseRootRealPath = isolatedWriterBaseRoot(ctx.scope, callerExecutionScope, ctx.sharedTabWorktree);
              } catch (error) {
                throw blockedBy !== undefined ? new Error(blockedBy) : error;
              }
              if (blockedBy !== undefined) {
                isolatedWriterReason = `auto-isolado: ${blockedBy} no mesmo checkout`;
              }
              try {
                isolatedWriter = await allocateIsolatedWriterWorktree(ctx.scope, missionId, {
                  assertCurrentAuthority: () => assertMcpInvocationCurrent(invocation),
                  signal: invocation?.signal,
                  ...(baseRootRealPath ? { baseRootRealPath } : {}),
                  ...(baseRef ? { baseRef } : {}),
                });
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
              // F-981: nunca descarta o cwd em silêncio — honra ou recusa.
              cwd: nested?.cwd ?? requestedCwdInside(checkoutRoot, options.cwd) ?? checkoutRoot,
              executionScope: writerExecutionScope,
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
        ...(autoRoute?.specialty === 'visual' ? { visualTask: createVisualTaskRequirement() } : {}),
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
              // Recibo do Jev, só leitura: confiança por dimensão e o que a
              // regra teria escolhido (ids e números, saneados).
              ...routeJevReceipt(autoRoute),
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
      // Motor (06/10): worker de missão TAMBÉM fecha — a peça terminou, o
      // pane não pode ficar comendo RAM à toa. Orquestrador e a mão do
      // operador dentro da missão (F-231, operatorOpened) continuam vivos.
      // Falha preserva o pane: o braço só dispara em success.
      const autoClose = shouldArmAutoCloseOnHandoff({
        explicit: args.autoCloseOnHandoff === true ? true : args.autoCloseOnHandoff === false ? false : undefined,
        operatorHand,
        missionId: options.missionId,
        role: options.role,
        operatorOpened: options.operatorOpened === true ? true : undefined,
      });
      if (spawnTiming) {
        spawnTiming.meta.adapterId = options.adapterId;
        spawnTiming.meta.missionId = options.missionId;
        spawnTiming.meta.role = options.role ?? ctx.role;
        // F-787: modelo EFETIVO (rota AUTO inclusa) e a versão da CLI.
        // ponytail: versão real só onde já há sonda memorizada no processo
        // (Codex — cache quente da decoração do spawn, F-687/F-689); as
        // demais CLIs ficam null até ganharem sonda própria — nunca probar
        // --version aqui (subprocesso por spawn e CLIs que renovam auth).
        // Só leitura de cache (`peek`): cache frio = null; a sonda assíncrona
        // fica por conta do spawn do Codex (settleCodexCliVersionForSpawn).
        spawnTiming.meta.model = options.model;
        spawnTiming.meta.cliVersion =
          options.adapterId === 'codex' ? peekCodexCliVersion() : null;
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
            const reusedContext = getContextBySession(reuseChoice.candidate.sessionId);
            const previousVisualTask = reusedContext?.visualTask;
            const assignedVisualTask = options.visualTask ?? visualTaskRequirement(options.memoryQuery ?? options.prompt);
            if (assignedVisualTask && (!reusedContext || reusedContext.missionId !== options.missionId ||
              reusedContext.scope.projectId !== ctx.scope.projectId || reusedContext.scope.checkoutId !== ctx.scope.checkoutId ||
              reusedContext.scope.rootRealPath !== ctx.scope.rootRealPath)) {
              throw new Error('visual worker authority changed before idle reuse');
            }
            const assignmentStore = reusedContext?.missionId ? getProjectDomainStores(ctx.scope).missionPanes : undefined;
            if (assignmentStore && !assignmentStore.assignVisualTask(reuseChoice.candidate.paneId,
              reusedContext!.missionId!, reusedContext!.workerIncarnationId, previousVisualTask, assignedVisualTask)) {
              throw new Error('worker assignment changed before idle reuse');
            }
            if (reusedContext) reusedContext.visualTask = assignedVisualTask;
            try {
              await injectPrompt(
                reuseChoice.candidate.sessionId,
                withWorkerHandoffFooter(
                  reuseChoice.candidate.sessionId,
                  options.prompt!,
                ),
                invocation,
              );
            } catch (error) {
              if (reusedContext && reusedContext.visualTask === assignedVisualTask) {
                assignmentStore?.assignVisualTask(reuseChoice.candidate.paneId, reusedContext.missionId!,
                  reusedContext.workerIncarnationId, assignedVisualTask, previousVisualTask);
                reusedContext.visualTask = previousVisualTask;
              }
              throw error;
            }
            // Apply the new assignment's policy only after delivery succeeds.
            // Re-read physical authority: the helper may have been promoted,
            // replaced or moved while the prompt transport was awaiting.
            const reusedAuthority = getPaneRuntimeAuthorityBySession(reuseChoice.candidate.sessionId);
            if (reusedAuthority?.paneId === reuseChoice.candidate.paneId &&
              reusedAuthority.sessionId === reuseChoice.candidate.sessionId &&
              reusedAuthority.scope?.projectId === ctx.scope.projectId &&
              reusedAuthority.scope.checkoutId === ctx.scope.checkoutId &&
              reusedAuthority.scope.rootRealPath === ctx.scope.rootRealPath &&
              reusedAuthority.missionId === options.missionId &&
              (reuseMissionId !== undefined || reusedAuthority.operatorParentSessionId === ctx.sessionId) &&
              reusedAuthority.role !== 'orchestrator' && reusedAuthority.operatorOpened !== true) {
              if (autoClose) armAutoCloseOnHandoff(reuseChoice.candidate.sessionId, reuseChoice.candidate.paneId);
              else disarmAutoCloseOnHandoff(reuseChoice.candidate.sessionId, reuseChoice.candidate.paneId);
            }
            if (spawnTiming) {
              // F-787: reuso não é rejeição nem spawn novo — fica marcado.
              spawnTiming.meta.ok = true;
              spawnTiming.meta.reused = true;
              spawnTiming.meta.paneId = reuseChoice.candidate.paneId;
              spawnTiming.meta.sessionId = reuseChoice.candidate.sessionId;
            }
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
      // F-723: worker de missão ou helper do operador que nasce com briefing e
      // ACK pendente ganha a ficha do watchdog de início. Ela leva as closures
      // de "corrigir ali" (a entrega comprovada do spawn) e de "mandar para
      // outro" (este mesmo handler, autoridade atual de quem pediu, a CLI que
      // falhou fora da rota). Orquestrador nunca é vigiado.
      const startWatchRole =
        options.role === 'worker' ? 'worker' : options.role === undefined ? 'helper' : null;
      const startCallerSessionId = ctx.sessionId;
      // CLI pedida pelo operador ou conversa retomada: troca nunca é sozinha.
      const pinnedRuntime =
        Boolean(resumeRef) ||
        operatorChoiceProved ||
        (operatorExplicit && pinRedistributed === null);
      const rerouteGeneration = startRecovery?.generation ?? 0;
      // "Mandar para outro" deste pedido: este mesmo handler, autoridade atual
      // de quem pediu. Agente de roster selado numa missão com squad: o
      // sucessor é o próximo do roster (spawn-fail-reroute), não uma CLI avulsa.
      const taskRerouteFor = (
        failedAdapterId: string,
        callerSessionId: string,
        lineageId: string,
      ) => {
        const rosterSquadId =
          agentRef && !forceOperatorRoute && missionRow?.squadId
            ? missionRow.squadId
            : undefined;
        const rosterSuccessor = (): string | undefined =>
          rosterSquadId
            ? rosterSuccessorAgentName(rosterSquadId, agentRef!, failedAdapterId)
            : undefined;
        const needsNexusMcp =
          !options.missionId ||
          ctx.promotedFromUserSession === true ||
          (missionRow ? isOperatorTabMission(missionRow) : false);
        return {
          reroute: (request: PaneTaskRerouteRequest) =>
            rerouteNotStartedSpawn({
              callerSessionId,
              args,
              ...request,
              classificationPrompt,
              lineageId,
              generation: rerouteGeneration + 1,
              ...(rosterSquadId ? { rosterSuccessor: rosterSuccessor() ?? null } : {}),
            }),
          hasAlternative: (excludeAdapterIds: readonly string[]) =>
            rosterSquadId
              ? rosterSuccessor() !== undefined
              : hasRerouteAlternative(excludeAdapterIds, needsNexusMcp),
        };
      };
      // F-765/F-775: o pedido fica com o pane enquanto ele vive — o failover
      // reabre a tarefa por aqui quando não dá para religar no lugar.
      const registerTaskReroute = (paneId: string, adapterId: string): void => {
        if (!startWatchRole || !startCallerSessionId) return;
        registerPaneTaskReroute({
          paneId,
          adapterId,
          ...(options.missionId ? { missionId: options.missionId } : {}),
          role: startWatchRole,
          callerSessionId: startCallerSessionId,
          routeTask: operatorRouteTask(args),
          lineageId: startRecovery?.lineageId ?? paneId,
          operatorOpened: options.operatorOpened === true,
          pinnedRuntime,
          generation: rerouteGeneration,
          ...taskRerouteFor(adapterId, startCallerSessionId, startRecovery?.lineageId ?? paneId),
        });
      };
      let trackedStartPaneId: string | undefined;
      const onPendingSpawn =
        startWatchRole && startCallerSessionId
          ? (attempt: PendingSpawnAttemptInfo) => {
              const taskReroute = taskRerouteFor(
                attempt.adapterId,
                startCallerSessionId,
                startRecovery?.lineageId ?? attempt.paneId,
              );
              trackPaneStart({
                paneId: attempt.paneId,
                requestId: attempt.requestId,
                adapterId: attempt.adapterId,
                scope: ctx.scope,
                ...(options.missionId ? { missionId: options.missionId } : {}),
                role: startWatchRole,
                callerSessionId: startCallerSessionId,
                operatorOpened: options.operatorOpened === true,
                turnProof: attempt.turnProof,
                pinnedRuntime,
                rerouted: startRecovery !== undefined,
                createdAt: Date.now(),
                redeliver: attempt.redeliver,
                reroute: (excludeAdapterIds) => taskReroute.reroute({ excludeAdapterIds }),
                hasAlternative: () => taskReroute.hasAlternative([attempt.adapterId]),
              });
              trackedStartPaneId = attempt.paneId;
              registerTaskReroute(attempt.paneId, attempt.adapterId);
            }
          : undefined;
      let spawned: { paneId: string; sessionId: string };
      try {
        if (missionResume && (options.executionScope ?? options.scope).rootRealPath !== missionResume.spec.executionScope.rootRealPath) {
          throw new Error('resume_scope_changed: a retomada deve usar a pasta original');
        }
        spawned = await spawnPaneAndMaybePrompt(options, {
          // Capture the PTY identity before missionPanes.record(). If that
          // durable write fails, the finally block must retain the reservation
          // instead of treating the spawn as if it never happened.
          onPaneCreated: (paneId) => {
            resumeBound = true;
            spawnedWorkerPaneId = paneId;
          },
          invocation,
          // F-213/R6: subdivide 'pty-spawn' nos awaits internos — em 28/09 a
          // espera de ~50 s veio antes da alocação do pane, sem saber em qual
          // etapa (rota, isolamento ou dentro desta chamada).
          timer: spawnTiming?.timer,
          ...(onPendingSpawn ? { onPendingSpawn } : {}),
          onPendingMissionPane: (recorded) => {
            pendingMissionPane = recorded;
          },
        });
        spawnTiming?.timer.mark('pty-spawn');
      } catch (error) {
        spawnTiming?.timer.mark('pty-spawn');
        // The legacy helper still requires a session id. When the renderer has
        // already acknowledged the main-minted pane as pending, translate that
        // compatibility throw back into the successful effect result.
        const pending = takePendingPaneSpawnResult(invocation?.signal);
        if (!pending) {
          // Sem ACK pendente o chamador recebe o erro: nada a vigiar.
          if (trackedStartPaneId) {
            untrackPaneStart(trackedStartPaneId);
            forgetPaneTaskReroute(trackedStartPaneId);
          }
          throw error;
        }
        // Accepted pending attempt owns deferred birth even before child allocation.
        resumeBound = true;
        // ACK pendente: ainda não há sessão para armar; o braço vai no pane e
        // o handoff da sessão que nascer nele o encontra.
        if (autoClose && pending.paneId) armAutoCloseOnHandoffForPane(pending.paneId);
        isolatedWriterPending = Boolean(isolatedWriter);
        spawnedPaneId = pending.paneId ?? undefined;
        if (isolatedWriter && pending.paneId) isolatedWriter.link(pending.paneId, pending.sessionId ?? undefined);
        if (spawnTiming) {
          spawnTiming.meta.ok = true;
          spawnTiming.meta.paneId = pending.paneId ?? undefined;
          if (pending.sessionId) spawnTiming.meta.sessionId = pending.sessionId;
        }
        const pendingDiversity = harness.source === 'explicit'
          ? sameAdapterDiversityHint(options.adapterId, options.missionId, listPaneSnapshots(), pending.paneId ?? undefined)
          : null;
        return {
          ...pending,
          ...(executionMode ? { executionMode } : {}),
          ...isolatedReceipt(),
          ...(tabMissionId ? { tabMission: { missionId: tabMissionId } } : {}),
          ...(modelUpgrade ? { modelUpgrade } : {}),
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
      // Spawn que nasceu sem ACK pendente (ex.: main-owned, sem renderer).
      if (trackedStartPaneId !== spawned.paneId) {
        registerTaskReroute(spawned.paneId, options.adapterId);
      }
      if (spawnTiming) {
        spawnTiming.meta.ok = true;
        spawnTiming.meta.paneId = spawned.paneId;
        spawnTiming.meta.sessionId = spawned.sessionId;
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
        ...(modelUpgrade ? { modelUpgrade } : {}),
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
        if (!spawnedWorkerPaneId && pendingMissionPane) {
          // F-793: ACK pendente — a linha durável só nasce quando a sessão se
          // vincula; até lá é a reserva que conta este worker no maxWorkers.
          // Mesmo invariante do caminho síncrono: sem linha, a vaga fica.
          const release = releaseWorkerSlot;
          void pendingMissionPane.then((outcome) => {
            if (outcome !== 'unrecorded') {
              release();
              return;
            }
            console.warn(
              '[tools-panes] worker com ACK pendente não gravado; mantendo a ' +
                `reserva de maxWorkers (mission=${missionId})`,
            );
            // F-1259: sem linha para sempre não pode segurar o teto para
            // sempre — a prova física de saída libera a vaga.
            if (missionId) {
              armWorkerReservationExitRelease({
                paneIds: [spawnedWorkerPaneId, spawnedPaneId],
                release,
              });
            }
          });
        } else if (
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
          // F-1259: idem — a vaga cai na prova física de saída do filho.
          if (missionId) {
            armWorkerReservationExitRelease({
              paneIds: [spawnedWorkerPaneId, spawnedPaneId],
              release: releaseWorkerSlot,
            });
          }
        }
      }
    }
    } finally {
      if (missionResume?.continuation && !resumeBound) {
        try { rollbackWorkerContinuationBeforeBirth(ctx.scope, missionResume.continuation); }
        catch { /* Changed/stale owner is retained; compensation never clears it. */ }
      }
    }
  },
};

/** F-723: reenvio automático de um spawn que não começou (nunca vem do MCP). */
interface PaneStartRecovery {
  readonly excludeAdapterIds: readonly string[];
  /** F-765: preferência suave da rota (a mesma CLI com outro modelo). */
  readonly preferAdapterIds?: readonly string[];
  /** F-765/F-775: quantas reaberturas automáticas este pedido já teve. */
  readonly generation: number;
  /** F-775: continuar na worktree isolada do pane parado (sem resume do provider). */
  readonly worktreeFromPaneId?: string;
  /** F-775: pane do pedido original — as reaberturas são a mesma tarefa. */
  readonly lineageId?: string;
  /** F-1316: prompt do pedido original, só para classificar a rota. */
  readonly classificationPrompt?: string;
}

/**
 * Preferência suave da rota: o pin do agente sem pedido do operador e a CLI
 * que a reabertura pelo failover quer manter (F-765). Nunca vira exclusão.
 */
function routePreference(
  pinRedistributed: { readonly adapterId: string } | null,
  recoveryPreferred: readonly string[],
): { preferAdapterIds?: readonly string[] } {
  const ids = [
    ...new Set([
      ...(pinRedistributed ? [pinRedistributed.adapterId] : []),
      ...recoveryPreferred,
    ]),
  ];
  return ids.length > 0 ? { preferAdapterIds: ids } : {};
}

/**
 * Há outra CLI que poderia receber a tarefa? Aproximação barata da rota (o
 * reenvio real ainda passa por ela): CLI instalada, fora do disjuntor e, onde
 * a regra exige (helper sem missão, missão da aba — F-157/F-662), com MCP do
 * Nexus para entregar o handoff.
 */
function hasRerouteAlternative(
  excludeAdapterIds: readonly string[],
  needsNexusMcp: boolean,
): boolean {
  return listAdapters().some(
    (adapter) =>
      adapter.kind === 'cli-pty' &&
      !excludeAdapterIds.includes(adapter.id) &&
      adapter.id !== 'shell' &&
      isAdapterInstalled(adapter.id) &&
      !adapterCircuitBreakers.isOpen(adapter.id) &&
      (!needsNexusMcp || canUseNexusMcp(adapter)),
  );
}

/** Próximo agente do roster selado em outra CLI, mesma categoria (spawn-fail-reroute). */
function rosterSuccessorAgentName(
  squadId: string,
  agentRef: string,
  failedAdapterId: string,
): string | undefined {
  const squad = getSquad(squadId);
  const dead = findAgentInSquad(squadId, agentRef)?.agent;
  if (!squad || !dead) return undefined;
  return (
    selectSpawnFailSuccessor({
      deadAdapterId: failedAdapterId,
      preferredCategory: dead.category,
      roster: squad.agents.map((agent) => ({
        id: agent.id,
        agentName: agent.agentName,
        category: agent.category,
        cli: agent.cli,
        model: agent.model,
        effort: agent.effort,
      })),
    })?.agentName ?? undefined
  );
}

/**
 * F-723 "mandar para outro": reabre o MESMO pedido pelo handler inteiro do
 * nexus_pane_spawn — rota, reserva nova, vagas, F-662, F-235 e diversidade
 * valem de novo — com a autoridade ATUAL de quem pediu (bearer vivo, nunca
 * uma cópia guardada) e a CLI que não começou fora da rota. O pin de CLI e
 * modelo, a reserva já consumida pelo spawn que falhou e o `resume` não
 * viajam; agente de roster vira o sucessor do roster.
 */
async function rerouteNotStartedSpawn(input: {
  readonly callerSessionId: string;
  readonly args: Record<string, unknown>;
  readonly excludeAdapterIds: readonly string[];
  /** F-765: preferência suave da rota (a mesma CLI com outro modelo). */
  readonly preferAdapterIds?: readonly string[];
  /** F-775: texto do Nexus anexado ao brief (pacote de continuidade). */
  readonly appendPrompt?: string;
  /** F-1316: prompt do pedido original; a rota do reenvio classifica por ele. */
  readonly classificationPrompt?: string;
  /** F-775: continuar na worktree isolada deste pane (o parado). */
  readonly worktreeFromPaneId?: string;
  /** F-775: pane do pedido original (a tarefa é a mesma). */
  readonly lineageId?: string;
  /** Reabertura automática nº N deste pedido (teto no failover). */
  readonly generation: number;
  /** Agente de roster: o sucessor; null = o roster não tem outra CLI. */
  readonly rosterSuccessor?: string | null;
}): Promise<PaneStartRerouteResult> {
  if (input.rosterSuccessor === null) {
    throw new Error('o roster não tem agente em outra CLI');
  }
  assertLicenseAccess();
  const ctx = getContextBySession(input.callerSessionId);
  if (!ctx || !isCurrentGateContext(ctx)) {
    throw new Error('quem pediu o pane não tem mais sessão viva');
  }
  assertCallerMaySpawnPane(ctx.role);
  const gateSignal = gateContextAbortSignal(ctx);
  const invocation: McpToolInvocation = {
    // Sinal próprio: o ACK pendente é indexado por ele.
    signal: gateSignal ? AbortSignal.any([gateSignal]) : new AbortController().signal,
    assertCurrentAuthority: () => {
      if (!isCurrentGateContext(ctx)) throw new Error('session_authority_revoked');
    },
  };
  const {
    adapterId: _adapterId,
    model: _model,
    effort: _effort,
    operatorChoice: _operatorChoice,
    routeReservationId: _routeReservationId,
    resume: _resume,
    agentName: _agentName,
    fresh: _fresh,
    ...rest
  } = input.args;
  const brief = str(rest, 'prompt') ?? str(rest, 'task');
  const args: Record<string, unknown> = {
    ...rest,
    // F-775: o pacote vai DEPOIS do brief; a rota segue a tarefa original.
    ...(input.appendPrompt
      ? {
          ...(brief ? { task: str(rest, 'task') ?? brief } : {}),
          prompt: brief ? `${brief}\n\n${input.appendPrompt}` : input.appendPrompt,
        }
      : {}),
    ...(input.rosterSuccessor ? { agentName: input.rosterSuccessor } : {}),
    fresh: true,
  };
  // F-787: a tentativa de recuperação e o resultado dela também vão ao trace
  // (origem 'sistema') — antes, o reenvio automático era invisível.
  let receipt: { paneId?: unknown; harness?: { adapterId?: unknown } };
  try {
    receipt = (await paneSpawnAfterTabMission.handler(
      args,
      ctx,
      invocation,
      null,
      parseExpectArg(args.expect),
      undefined,
      {
        excludeAdapterIds: input.excludeAdapterIds,
        ...(input.preferAdapterIds?.length ? { preferAdapterIds: input.preferAdapterIds } : {}),
        ...(input.worktreeFromPaneId ? { worktreeFromPaneId: input.worktreeFromPaneId } : {}),
        ...(input.lineageId ? { lineageId: input.lineageId } : {}),
        ...(input.classificationPrompt ? { classificationPrompt: input.classificationPrompt } : {}),
        generation: input.generation,
      },
    )) as { paneId?: unknown; harness?: { adapterId?: unknown } };
  } catch (error) {
    trace(
      buildPaneSpawnRecoveryEvent({
        callerSessionId: input.callerSessionId,
        excludeAdapterIds: input.excludeAdapterIds,
        ok: false,
        errorCode: classifySpawnErrorCode(error),
      }),
    );
    throw error;
  }
  const paneId = typeof receipt.paneId === 'string' ? receipt.paneId : null;
  const adapterId =
    typeof receipt.harness?.adapterId === 'string' ? receipt.harness.adapterId : null;
  if (!paneId || !adapterId) throw new Error('o reenvio não devolveu um pane');
  trace(
    buildPaneSpawnRecoveryEvent({
      callerSessionId: input.callerSessionId,
      excludeAdapterIds: input.excludeAdapterIds,
      paneId,
      adapterId,
      ok: true,
    }),
  );
  return { paneId, adapterId };
}

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
    'Describe the calling pane: role, mission, agent/provider identity and ' +
    'project scope. Access is open to every tool and skill (F-1157); ' +
    '`readOnlyEnforced` is true only when the operator\'s Hardened mode confines ' +
    'this lane to reading, and the tool/skill lists are seal records, not limits. Never returns ' +
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
    readOnlyEnforced: ctx.readOnlyEnforced === true,
    access: ctx.readOnlyEnforced === true ? 'hardened-read-only' : 'all-tools-and-skills',
    scope: {
      installationId: ctx.scope.installationId,
      projectId: ctx.scope.projectId,
      checkoutId: ctx.scope.checkoutId,
      rootRealPath: ctx.scope.rootRealPath,
    },
    executionRoot: ctx.executionScope?.rootRealPath ?? ctx.scope.rootRealPath,
    // F-1157: recorded in the seal; they do not restrict.
    recordedTools: ctx.allowedTools,
    recordedSkills: ctx.allowedSkills,
    account: ctx.sessionId
      ? (getAccountChoiceReceipt(ctx.sessionId) ?? null)
      : null,
    // F-1166: dicas consultivas da PRÓPRIA missão (nunca de outra); ausente sem dica.
    ...(ctx.missionId ? missionHintsField(ctx.missionId) : {}),
  }),
};

function missionHintsField(missionId: string): { decisionHints?: MissionDecisionHints } {
  try {
    const hints = getMissionDecisionHints(missionId);
    return hints ? { decisionHints: hints } : {};
  } catch {
    return {};
  }
}

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

async function paneDigestResult(
  tail: string,
  maxChars: number = DIGEST_MAX_CHARS,
  missionId?: string,
): Promise<Record<string, unknown>> {
  // F-987: redesenho de TUI colapsado e teto de caracteres por pane.
  const digest = digestPaneTail(tail, { maxChars });
  // F-1164: quem lê (o Maestro) paga a classificação no orçamento da missão dele.
  const classified = await classifyPaneTailForDigest(digest.text, { missionId });
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
    ...(digest.truncated ? { truncated: true } : {}),
    hint: paneReadHint,
  };
}

const paneRead: McpToolDef = {
  name: 'nexus_pane_read',
  description:
    "Read a pane's terminal (ANSI stripped). mode:'digest' (default for the " +
    'orchestrator) returns a compact object: signal lines (errors, test ' +
    'results, prompts, handoffs) from the older part of the window plus the ' +
    'last 30 non-blank lines, with TUI redraw/spinner/status frames ' +
    'collapsed and a per-pane character cap (truncated:true marks a cut), ' +
    'Jev state when the classifier ' +
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
    let tail = readSessionOutput(sessionId, num(args, 'lines') ?? 200);
    if (tail.trim().length === 0 && isOneShotSessionRunning(sessionId)) {
      tail = 'one-shot em execução, sem saída no PTY até terminar';
    }
    if (paneReadMode(args, ctx) !== 'digest') return tail;
    return paneDigestResult(tail, DIGEST_MAX_CHARS, ctx.missionId);
  },
};

const paneReadMany: McpToolDef = {
  name: 'nexus_pane_read_many',
  description:
    'Read the output of several panes at once. Same visibility and ' +
    "mode:'digest'|'full' semantics as nexus_pane_read (orchestrator " +
    'defaults to digest); errors come back per item. Up to ' +
    `${PANE_READ_MANY_MAX_PANES} distinct panes per call (repeated ids and ` +
    `aliases of the same pane are read once; at most ${PANE_READ_MANY_MAX_REFS} ` +
    'references). In digest mode the whole ' +
    'response shares one character cap (items mark truncated). ' +
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
    // F-987: seis panes × redesenho de TUI estouravam o limite da ferramenta.
    // Ids repetidos (e apelidos do mesmo pane) são lidos uma vez, a lista tem
    // teto e o digest divide um teto total que é conferido antes de devolver.
    // Segunda revisão: o teto vale para panes distintos RESOLVIDOS — 8 panes
    // em 4 grafias (id, sessão, "3", "pane 3") são 8, não 32. As grafias têm
    // um teto próprio, mais largo, que limita a resolução.
    const paneIds = [...new Set(strArray(args, 'paneIds'))];
    if (paneIds.length > PANE_READ_MANY_MAX_REFS) {
      throw new Error(
        `nexus_pane_read_many: no máximo ${PANE_READ_MANY_MAX_REFS} referências ` +
          `por chamada (recebeu ${paneIds.length}); divida em lotes`,
      );
    }
    type Resolved =
      | { readonly paneId: string; readonly sessionId: string }
      | { readonly paneId: string; readonly error: string };
    const resolved = paneIds.map((paneId): Resolved => {
      try {
        return { paneId, sessionId: authorizedSessionIdOf(ctx, paneId, 'read') };
      } catch (err) {
        return { paneId, error: err instanceof Error ? err.message : String(err) };
      }
    });
    const firstBySession = new Map<string, string>();
    for (const item of resolved) {
      if ('sessionId' in item && !firstBySession.has(item.sessionId)) {
        firstBySession.set(item.sessionId, item.paneId);
      }
    }
    if (firstBySession.size > PANE_READ_MANY_MAX_PANES) {
      throw new Error(
        `nexus_pane_read_many: no máximo ${PANE_READ_MANY_MAX_PANES} panes ` +
          `distintos por chamada (recebeu ${firstBySession.size}); divida em lotes`,
      );
    }
    const budget = digestBudgetPerPane(firstBySession.size);
    const results: Array<Record<string, unknown>> = await Promise.all(
      resolved.map(async (item) => {
        if (!('sessionId' in item)) return { paneId: item.paneId, error: item.error };
        const first = firstBySession.get(item.sessionId);
        if (first !== item.paneId) return { paneId: item.paneId, sameAs: first };
        try {
          let tail = readSessionOutput(item.sessionId, lines);
          if (tail.trim().length === 0 && isOneShotSessionRunning(item.sessionId)) {
            tail = 'one-shot em execução, sem saída no PTY até terminar';
          }
          if (mode !== 'digest') return { paneId: item.paneId, output: tail };
          return { paneId: item.paneId, ...(await paneDigestResult(tail, budget, ctx.missionId)) };
        } catch (err) {
          return {
            paneId: item.paneId,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    return mode === 'digest' ? capDigestEntries(results) : results;
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
      orchWriteSession(sessionId, text, { inputWriter: ctx.role === 'orchestrator' ? 'maestro' : 'nexus' });
    } else {
      await injectPrompt(sessionId, text, invocation, ctx.role === 'orchestrator' ? 'maestro' : 'nexus');
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
      await injectPrompt(sessionId, question, invocation, ctx.role === 'orchestrator' ? 'maestro' : 'nexus');
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
          orchWriteSession(sessionId, text, { inputWriter: ctx.role === 'orchestrator' ? 'maestro' : 'nexus' });
        } else {
          await injectPrompt(sessionId, text, invocation, ctx.role === 'orchestrator' ? 'maestro' : 'nexus');
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
      if (
        !(await requestPaneClose(info.paneId, undefined, {
          callerSessionId: ctx.sessionId,
          role: ctx.role,
        }))
      ) {
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
        operatorOpened: pane.operatorOpened === true || undefined,
        scopeRoot: pane.scope?.rootRealPath,
      })),
      isMissionRunning: (missionId) =>
        suite.missions.get(missionId)?.status === 'running',
    });
    const closed: string[] = [];
    for (const paneId of selection.close) {
      try {
        if (
          await requestPaneClose(paneId, undefined, {
            callerSessionId: ctx.sessionId,
            role: ctx.role,
          })
        ) {
          closed.push(paneId);
        }
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
    'Inspect the active physical lease of your own session or of a pane you ' +
    'may read (same boundary as nexus_pane_read). Returns the lease metadata ' +
    '(hasStartKey, never the key) if active, or null if unleased or terminated.',
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
  handler: async (args, ctx) => {
    const ref = requireStr(args, 'sessionId');
    // F-1336: o startKey é a prova que autoriza o kill da sessão — nunca sai
    // pelo MCP. Fora a própria sessão, só panes que o chamador já pode ler.
    const sessionId = ref === ctx.sessionId ? ref : authorizePaneRef(ctx, ref, 'read').sessionId;
    const lease = sessionId ? inspectSessionLease(sessionId) : null;
    if (!lease) return { ok: true, lease: null };
    const { startKey, ...metadata } = lease;
    return { ok: true, lease: { ...metadata, hasStartKey: Boolean(startKey) } };
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
