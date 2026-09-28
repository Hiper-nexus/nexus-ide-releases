import { missionExecutionScope } from './mission-execution-scope';
import { resolveWorkspaceDesignContract } from './design-system-reader';
import { isPaneMetaTask, extractMetaPaneQuestion } from '../../shared/pane-meta-task';
import { getMissionRoutingHints } from '../../shared/mission-routing-advice';
export { isPaneMetaTask, extractMetaPaneQuestion } from '../../shared/pane-meta-task';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isDeepStrictEqual, promisify } from 'node:util';
import {
  pickDesignReference,
  type DesignReferenceCandidate,
} from './design-reference-pick';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import type { Mission, Squad, SquadAgent } from '../../shared/orch-types';
import { isUiMissionText } from '../../shared/mission-work-kind';
import {
  MISSION_RUNTIME_CLOSED_MARKER,
  missionAwaitsAdjustment,
  wasMissionRuntimeClosedByOperator,
} from '../../shared/mission-recovery-policy';
import { stripMissionVerdictParagraph } from '../../shared/mission-block-cause';
import { wasUpdatedBeforeThisProcess } from '../../shared/session-restore-liveness';
import {
  initialPromptChannel,
  type InitialPromptChannel,
} from '../../shared/cli-initial-prompt';
import {
  persistLeftoverIsolation,
  pickFocusedRunningMission,
  shouldSkipLeftoverRemount,
  wasMissionLeftoverParked,
  isFreshIniciarKickoff,
  NEXUS_LEFTOVER_PARKED_MARKER,
  type LeftoverRemountKind,
} from '../../shared/mission-leftover-isolation';
import { emitMissionEvent } from './mission-event-emit';
import { buildMaestroKickoffBrief } from './orchestrator-doctrine';
import {
  getSessionState,
  getAgentSessionInfo,
  getSessionCwd,
  isPtySessionConnectedAndWritable,
  listAgentSessions,
  orchTerminateSession,
  registeredOrchestratorSessionsForMission,
} from '../pty/pty-manager';
import { getAcpDriverSession } from '../acp/acp-harness-driver';
import { getAdapter } from '../adapters/adapter-registry';
import { deliverAgentPrompt, proveNativeArgvBriefAccepted, withProjectContextBlocks } from './tool-util';
import { canUseNexusMcp } from './cli-mcp-inject';
import {
  OPERATOR_TAB_RESUME_NOTE,
  operatorTabMissionLeader,
  operatorTabMissionResumeSpec,
  operatorTabResumeAgent,
  operatorTabResumeAwaitsAdjustment,
} from './operator-tab-mission-resume';
import {
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
} from './project-domain-store-registry';
import { getSquad, listSquads } from './squad-store';
import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import { missionEngineForScope } from './mission-engine-registry';
import { redeliverPendingHandoffs } from './idle-delivery';
import { maybeCompleteFastLaneOnDelivery } from './civilian-delivery-completion';
import {
  recordAdapterProofOfLife,
  recordWorkerDeathWithoutDelivery,
  shouldTripWorkerMortalityBreaker,
  workerMortalityCount,
  workerPaneHasDelivery,
} from './worker-mortality';
import { trace } from '../observability/main-trace';
import { classifySessionLiveness } from '../pty/session-liveness';
import {
  decideOrchestratorAdoption,
  orchestratorAdoptionRefusalMessage,
  takeOrchestratorAdoption,
  type OrchestratorAdoptionRefusal,
} from './orchestrator-adoption';
import { waitOutBootPrompts } from './boot-prompt-hold';
import { maestroKickoffBlockReason } from './maestro-boot-gate';
import { missionBlockPatch, type MissionBlockPatch } from '../../shared/mission-intent';
import { detectSubscriptionAuthReadiness } from '../adapters/subscription-auth';
import {
  decideWriterCircuitAction,
  logWriterCircuitBreak,
  recordWriterConnectFailure,
  writerCircuitBroken,
} from './writer-circuit-breaker';
import { writerCircuitBlocksSeat, writerCircuitBreakers } from './writer-circuit-break';
import {
  HANDOFF_STALL_TTL_MS,
  findStalledHandoffIds,
} from './handoff-stall-ttl';
import {
  collectFilesModified,
  maybeCompleteFastLaneOnDelivery as maybeCompleteFromFilesModified,
} from './worker-files-modified';
import {
  boardProgressFromSealedTasks,
  sealFastLaneListedStoryPlan,
  advanceFastLaneStoryTaskFromWorkerDone,
} from './mission-story-plan';
import { assertPreSpawnProbe, PreSpawnProbeError } from '../pty/pre-spawn-probe';
import { warmPool } from '../pty/warm-pool';
import {
  hasRuntimeKey,
  listProviderSettings,
  providerAuthStrategy,
} from '../persistence/provider-config-store';
import {
  PREFERRED_AUTO_SEAT_CLIS,
  remintWriterCliForAutoSeat,
  type AutoSeatProviderView,
} from '../../shared/auto-seat-auth';
import {
  clearOperatorDismissedPanes,
  listPaneSnapshots,
  requestPaneSpawn,
  waitForIdle,
  readSessionOutput,
  wasOrchestratorOperatorDismissed,
} from './pane-registry';
import {
  peekKickoffDirects,
  rememberKickoffBrief,
  tryRecordIdleKickoffAcceptance,
} from './mission-kickoff-direct-queue';
import { reconcileSealedBoardFromDisk } from './worker-delivery-board';
import { classifySeatAuth } from '../adapters/seat-auth-readiness';
import { warmSquadRuntimeSubscriptionAuth } from './squad-runtime-inventory';
import {
  countLiveFirstWaveWriters,
  FIRST_WAVE_OFFER_CLIS,
  decideMetaPaneWorkerSpawn,
  liveMissionWorkerCount,
  liveWorkerSeatKeys,
  planFirstWaveSeats,
  planMetaPaneAskSeats,
} from './via-rapida-first-wave';
import { firstWaveWorkerPrompt, metaPaneAskPrompt } from './via-rapida-walk';
import { hashMissionIntentAuthority } from './mission-pane-authority';
import {
  MissionLeadershipError,
  type MissionLeader,
  type MissionLeadershipErrorCode,
} from './mission-leadership';
import { getMissionLeadership } from './mission-leadership-runtime';

/**
 * Via Rápida de missão (2026-08-12) — motor limpo, modelo PULL.
 *
 * O modelo é simples: spawna o ORQUESTRADOR com o briefing completo da missão
 * (objetivo + roster de workers + instruções de coordenação). O orquestrador
 * coordena tudo via MCP tools (nexus_pane_spawn, nexus_handoff_list,
 * nexus_mission_set_status). O motor só observa: se a missão foi concluída ou
 * bloqueada, encerra. Se o orquestrador morreu, verifica handoffs e decide.
 *
 * Zero tickRun. Zero wasBusy. Zero markerObserver. Zero nudge. Zero respawn.
 * Zero parsing de PRONTO/BLOQUEADO do terminal. O contrato de handoff já é
 * entregue no prompt (withHandoffContract, variante C-194.1: curta → não
 * chama tool, o Main entrega verbatim via turn-end-handoff; longa/bloqueio →
 * nexus_handoff_submit com vocabulário canônico).
 */

/** Intervalo de observação da missão. */
const WATCHER_INTERVAL_MS = 15_000;
/** Tentativas de respawn do orquestrador por geração de watcher. */
const ORCHESTRATOR_RESPAWN_BUDGET = 10;
/** Boot do Maestro antes da colagem do briefing (paridade tool-util). */
const ORCHESTRATOR_BOOT_TIMEOUT_MS = 120_000;

/**
 * Canal de entrega do briefing do Maestro na Via Rápida.
 *
 * `pty-manager` só coloca `initialPrompt` no argv para orquestrador
 * **posicional**. One-shot (AGY `--print`, OpenCode `run`) mata o pane —
 * só worker. Paste não tem argv. Sem colagem pós-boot o Maestro sobe mudo,
 * o kickoff é marcado aceito e a missão fica "running" sem nunca chamar
 * `nexus_pane_spawn`.
 */
export function orchestratorBriefDelivery(
  channel: InitialPromptChannel,
): 'argv' | 'paste' {
  return channel.kind === 'positional' ? 'argv' : 'paste';
}

/**
 * Via Rápida exige Maestro com rota Nexus MCP: o briefing instrui
 * `nexus_pane_spawn` / `nexus_handoff_*` / `nexus_mission_set_status`.
 * AGY/aider (`nexusMcp: none`) podem ser workers via PTY-stream, mas como
 * Maestro ficam "running" sem poder orquestrar. Fail-closed no bootstrap.
 */
export function assertFastLaneMaestroMcp(adapterId: string): void {
  const adapter = getAdapter(adapterId);
  if (!adapter || adapter.kind !== 'cli-pty') {
    throw new Error(
      `Maestro \`${adapterId}\` não é um adapter PTY carregado — ` +
        'escolha claude/openclaude/codex/opencode/kimi/grok (ou família Claude).',
    );
  }
  if (!canUseNexusMcp(adapter)) {
    throw new Error(
      `${adapter.label ?? adapterId} não pode coordenar esta missão — ` +
        'escolha Claude ou Codex.',
    );
  }
}

function kickoffPromptHash(initialPrompt: string | undefined): string {
  return createHash('sha256')
    .update(initialPrompt ?? '')
    .digest('hex');
}

function bindSpawnedMissionPane(
  stores: ProjectDomainStoreSuite,
  scope: ProjectExecutionScope,
  mission: Mission,
  agent: SquadAgent,
  role: 'orchestrator' | 'worker',
  spawn: {
    paneId: string;
    sessionId: string;
    title?: string;
    readOnly?: boolean;
  },
): void {
  const executionScope = missionExecutionScope(scope, mission);
  const spawnedSession = getAgentSessionInfo(spawn.sessionId)
    ?? getAcpDriverSession(spawn.sessionId)?.agent;
  const physical = role === 'worker' ? spawnedSession : undefined;
  if (role === 'worker' && (!physical || physical.sessionId !== spawn.sessionId ||
    physical.paneId !== spawn.paneId || physical.missionId !== mission.id ||
    physical.role !== role || physical.agentName !== agent.agentName ||
    physical.adapterId !== agent.cli || !isDeepStrictEqual(physical.scope, executionScope) ||
    !physical.workerIncarnationId || !physical.authoritySeal ||
    physical.authoritySeal.intentVersion !== mission.intentVersion ||
    !mission.intentContract ||
    physical.authoritySeal.intentContractHash !== hashMissionIntentAuthority(mission.intentContract))) {
    throw new Error('first-wave worker physical spawn authority is missing or mismatched');
  }
  const title = spawn.title?.trim() || agent.agentName;
  stores.missionPanes.record({
    missionId: mission.id,
    paneId: spawn.paneId,
    adapterId: agent.cli,
    accountId: spawnedSession?.accountId,
    model: agent.model || undefined,
    effort: agent.effort || undefined,
    cwd: executionScope.rootRealPath,
    title,
    agentName: agent.agentName,
    workerIncarnationId: physical?.workerIncarnationId,
    authoritySeal: physical?.authoritySeal,
    role,
    allowedTools: physical ? physical.allowedTools : agent.allowedTools ? [...agent.allowedTools] : null,
    allowedSkills: physical ? physical.allowedSkills : agent.allowedSkills ? [...agent.allowedSkills] : null,
    readOnly: physical ? physical.readOnly : spawn.readOnly === true,
    executionScope,
  });
}

async function flushQueuedKickoffDirects(
  scope: ProjectExecutionScope,
  stores: ProjectDomainStoreSuite,
  missionId: string,
): Promise<void> {
  if (peekKickoffDirects(missionId).length === 0) return;
  const { flushQueuedKickoffDirectsForMission } = await import(
    './mission-engine-production'
  );
  await flushQueuedKickoffDirectsForMission(scope, stores, missionId);
}

function tryAcceptIdleOrchestratorKickoff(
  stores: ProjectDomainStoreSuite,
  mission: Mission,
  sessionId: string,
  initialPrompt: string | undefined,
): boolean {
  const live = stores.missions.get(mission.id) ?? mission;
  const promptHash = kickoffPromptHash(initialPrompt);
  rememberKickoffBrief({
    missionId: live.id,
    orchestratorSessionId: sessionId,
    intentVersion: live.intentVersion ?? 0,
    promptHash,
  });
  return tryRecordIdleKickoffAcceptance({
    missionId: live.id,
    sessionId,
    intentVersion: live.intentVersion ?? 0,
    promptHash,
    sessionIdle: getSessionState(sessionId) === 'idle',
    sessionOutput: readSessionOutput(sessionId, 80),
    hasCurrentKickoffAcceptance: stores.missions.hasCurrentKickoffAcceptance(
      live.id,
    ),
    recordKickoffAcceptance: (raw) => stores.missions.recordKickoffAcceptance(raw),
  });
}

function resolveOrchestratorBriefDelivery(adapterId: string): 'argv' | 'paste' {
  const adapter = getAdapter(adapterId);
  if (!adapter || adapter.kind !== 'cli-pty') {
    // Fail-closed: sem contrato de argv confiável, cola.
    return 'paste';
  }
  return orchestratorBriefDelivery(
    initialPromptChannel({
      declared: adapter.spawn.initialPrompt,
      oneshotArgs: adapter.spawn.initialPromptArgs,
      interactive: adapter.spawn.interactive,
    }),
  );
}

/**
 * A mission without live processes can retry within its recovery budget.
 * Exhaustion is a recoverable technical block, never a successful delivery.
 */
export function decideFastLaneEmptyPaneAction(input: {
  readonly status: Mission['status'];
  readonly pendingHandoffs: number;
  readonly respawnBudgetLeft: number;
  /** Operador fechou o Maestro (✕ do pane). Não relança a missão inteira. */
  readonly operatorDismissedOrchestrator?: boolean;
}): 'respawn-orchestrator' | 'keep-running-watching' | 'block-recovery-exhausted' {
  if (input.status !== 'running') return 'keep-running-watching';
  if (input.operatorDismissedOrchestrator) return 'keep-running-watching';
  return input.respawnBudgetLeft > 0
    ? 'respawn-orchestrator'
    : 'block-recovery-exhausted';
}

/**
 * ✕ no Maestro não é Retomar. Resume automático / retry-kickoff / supervisor
 * não podem limpar o tombstone e relançar o time. Só remountKind operator
 * (Retomar no rail, Pedir um ajuste) volta a spawnar.
 */
export function mayResumeAfterOperatorDismiss(input: {
  readonly remountKind: LeftoverRemountKind;
  readonly operatorDismissedOrchestrator: boolean;
}): boolean {
  if (!input.operatorDismissedOrchestrator) return true;
  return input.remountKind === 'operator';
}

/**
 * Sentinela de HEAD (achado #14 do Maestro, 2026-08-17): o lock do
 * same-checkout só serializa panes da PRÓPRIA missão — 27 commits de outro
 * processo entraram no diretório sem barreira nenhuma, e a missão seguia
 * achando que tinha exclusividade. Não vamos fingir exclusividade global;
 * vamos VER o mundo: quando o HEAD do checkout muda por fora no meio da
 * missão, o watcher emite evento + warn para o Maestro revalidar o chão.
 */
export function decideExternalHeadChangeAction(input: {
  readonly baseline: string | null;
  readonly current: string | null;
  /**
   * Escada de SHAs produzida pela PRÓPRIA missão: headSha/baseSha de cada
   * handoff entregue (worker do same_checkout commita e grava os dois). HEAD
   * que bate aqui é trabalho interno — avisar gasta um turno do Maestro para
   * "revalidar" o trabalho dele mesmo (A6: 8 falsos positivos numa missão).
   */
  readonly missionShaLadder?: ReadonlySet<string>;
}): { readonly action: 'ignore' } | { readonly action: 'internal'; readonly from: string; readonly to: string } | { readonly action: 'notify'; readonly from: string; readonly to: string } {
  if (!input.baseline || !input.current) return { action: 'ignore' };
  if (input.baseline === input.current) return { action: 'ignore' };
  if (input.missionShaLadder?.has(input.current)) {
    return { action: 'internal', from: input.baseline, to: input.current };
  }
  return { action: 'notify', from: input.baseline, to: input.current };
}

const execFileAsync = promisify(execFile);

/** HEAD atual do checkout (null quando não é repo ou git falhou). */
async function readCheckoutHead(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      timeout: 4_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Retry-kickoff tem que FAZER ALGO: running com orquestrador vivo religa o
 * watcher; running com runtime morto respawna (o print 2026-08-16 mostrou o
 * botão "Tentar início novamente" como no-op silencioso exatamente aqui).
 */
export function decideFastLaneResumeAction(input: {
  readonly status: Mission['status'];
  readonly liveOrchestratorSession: boolean;
}): 'watch' | 'respawn' | 'bootstrap' {
  if (input.status === 'running') {
    return input.liveOrchestratorSession ? 'watch' : 'respawn';
  }
  return 'bootstrap';
}

export { pickFocusedRunningMission, shouldSkipLeftoverRemount };

function thisProcessLiveMaestroByMissionId(
  missionIds: readonly string[],
): Map<string, string> {
  const live = new Map<string, string>();
  for (const missionId of missionIds) {
    const sessionId = liveOrchestratorSessionId(missionId);
    if (sessionId) live.set(missionId, sessionId);
  }
  return live;
}

function isThisProcessFreshKickoff(
  stores: ProjectDomainStoreSuite,
  mission: Mission,
  liveMaestroSessionId: string | null,
): boolean {
  const sealedCount = stores.tasks?.list?.(mission.id)?.length ?? 0;
  const paneCount = listPaneSnapshots().filter(
    (pane) => pane.missionId === mission.id,
  ).length;
  return isFreshIniciarKickoff({
    status: mission.status,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    sealedCount,
    paneCount,
    hasLiveMaestro: liveMaestroSessionId != null,
  });
}
interface WatcherState {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  orchSessionId: string;
  readonly startedAt: number;
  lastOrchActivityAt: number;
  timer: ReturnType<typeof setInterval> | null;
  stopped: boolean;
  /** Baseline da sentinela de HEAD (achado #14); null fora de repo. */
  baselineHeadSha: string | null;
  /** Assinatura de progresso real da missão; recarrega o orçamento de respawn. */
  lastProgressSignature: string | null;
}

const watchers = new Map<string, WatcherState>();

/**
 * Orçamento de respawn do orquestrador POR EPISÓDIO de missão (sobrevive ao
 * watcher que o respawn recria). Recarregado somente com PROGRESSO REAL
 * (handoffs consumidos ou tarefas concluídas) — nunca com a mera liveness do
 * orquestrador respawnado, senão o orçamento vira infinito e a missão entra
 * em loop de respawn (bug de campo 2026-08-18).
 */
const respawnBudgets = new Map<string, number>();

function watcherKey(scope: ProjectExecutionScope, missionId: string): string {
  return `${scope.rootRealPath}::${missionId}`;
}

/** Progresso observável que justifica recarregar o orçamento de respawn. */
function missionProgressSignature(
  stores: ProjectDomainStoreSuite,
  missionId: string,
): string {
  const consumedHandoffs = stores.handoffs
    .list({ missionId, includeDelivered: true })
    .filter((handoff) => handoff.deliveryState === 'consumed').length;
  const doneTasks = stores.tasks
    .list(missionId)
    .filter((task) => task.status === 'done').length;
  return `${consumedHandoffs}:${doneTasks}`;
}



/**
 * SessionId do orquestrador desta missão SE existir um processo físico vivo,
 * segundo o par (sessionId,paneId) provado por `resolveMissionLeader`.
 * `source:'live'` sozinho não é prova — só `proven:true` conta. Split-brain
 * nunca é engolido aqui: propaga `MissionLeadershipError('split_brain')`.
 *
 * ponytail: o snapshot físico ainda escolhe o CANDIDATO (role/nome) porque
 * esta função não recebe `scope`; quando o snapshot não carrega `.scope`
 * (fixtures antigas, panes main-owned) cai no heurístico de liveness direta
 * pré-religação. Upgrade: threadear `scope` explícito nos 3 chamadores.
 */
export function liveOrchestratorSessionId(missionId: string): string | null {
  const snapshot = listPaneSnapshots().find(
    (pane) =>
      pane.missionId === missionId &&
      (pane.role === 'orchestrator' ||
        pane.agentName?.toLowerCase().includes('orquestrador')),
  );
  const sessionId = snapshot?.sessionId;
  if (!sessionId) return null;
  if (!snapshot?.scope) {
    // Verdade única de liveness (session-liveness): só 'live' conta como vivo.
    return classifySessionLiveness(getSessionState(sessionId)) === 'live'
      ? sessionId
      : null;
  }
  const leader = getMissionLeadership().resolveMissionLeader(snapshot.scope, missionId);
  return leader?.proven ? leader.sessionId : null;
}

export { maybeCompleteFastLaneOnDelivery };

export function leftoverIsolationPersistPatch(): MissionBlockPatch {
  return missionBlockPatch('technical');
}

export function shouldPersistLeftoverIsolation(input: {
  readonly updatedAt: number;
  readonly processStartedAt?: number;
  readonly operatorClosed: boolean;
  readonly orchestratorLive: boolean;
  readonly focusedLiveMission?: boolean;
}): boolean {
  return !shouldResurrectPersistedRunningMission(input);
}

export function missionFastLaneEnabled(): boolean {
  return true;
}

/**
 * Contexto de design resolvido SEM atrito: o operador não configura nada — o
 * spawn olha o que existe (DESIGN.md do projeto e o catálogo do usuário em
 * ~/.design-references, com índice em README.md) e aponta os agentes de UI
 * para lá. Falha de filesystem nunca bloqueia; devolve vazio.
 */
export function missionDesignContext(
  workspaceRoot: string,
  home: string = homedir(),
  objective = '',
): string {
  try {
    const parts: string[] = [];
    const contract = resolveWorkspaceDesignContract(workspaceRoot);
    if (contract) {
      parts.push(
        `O projeto tem ${contract.path} — ele é a autoridade de estilo: leia antes de qualquer tela. Referências do catálogo complementam este contrato, sem substituir suas regras.`,
      );
    }
    const catalogRoot = join(home, '.design-references');
    if (existsSync(catalogRoot)) {
      // Escolher a referência é MECÂNICA: mandar "consulte o que combinar"
      // obrigava o agente a listar o catálogo e abrir arquivos para descobrir
      // o que era relevante — caro em tokens e não determinístico. Quando o
      // Nexus consegue decidir, ele NOMEIA o arquivo; ambiguidade volta a
      // apontar a pasta, nunca inventa.
      const picked = objective
        ? pickDesignReference(objective, listDesignReferences(catalogRoot))
        : null;
      parts.push(
        picked
          ? `Referência de design que combina com este pedido: ` +
              `${join(catalogRoot, picked.fileName)} — leia ESTE arquivo e ` +
              'siga os tokens/composição dele. Só abra outros do catálogo se ' +
              'ele não cobrir o pedido.'
          : `Catálogo de referências de design do operador: ${catalogRoot} ` +
              '(índice em README.md; um .md por marca/estilo). Consulte o que ' +
              'combinar com o pedido e siga os tokens/composição de lá.',
      );
    }
    return parts.join(' ');
  } catch {
    return '';
  }
}

/** Lê nome e título de cada `.md` do catálogo. Falha vira catálogo vazio. */
function listDesignReferences(catalogRoot: string): DesignReferenceCandidate[] {
  try {
    return readdirSync(catalogRoot)
      .filter((name) => /\.mdx?$/iu.test(name))
      .slice(0, 200)
      .map((fileName) => {
        let title: string | undefined;
        try {
          const head = readFileSync(join(catalogRoot, fileName), 'utf8').slice(
            0,
            400,
          );
          title = head.split(/\r?\n/u).find((line) => line.startsWith('#'));
        } catch {
          title = undefined;
        }
        return { fileName, title };
      });
  } catch {
    return [];
  }
}

/**
 * Pedido de SEGURANÇA — auditoria, vulnerabilidade, permissão, segredo.
 *
 * `classifyWorkKind` não tem um kind 'security' (sonda 23/08: "auditoria de
 * segurança no login" sai `feature`; "proteja as rotas de admin" sai
 * `unknown`), então a missão de segurança não recebia doutrina nenhuma.
 * Detectar aqui é aditivo: não mexe na precedência do classificador.
 */
export function isSecurityMissionText(text: string): boolean {
  const canonical = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase();
  // Sonda 23/08 (89 objetivos reais): o leigo não diz "segredo" nem
  // "credencial" — ele diz "as senhas que estão no código", "as chaves de
  // api", "valide os dados do formulário", "coloque https". Todas são
  // decisões de segurança e nenhuma casava.
  return /\b(seguranca|vulnerabilidad|vulneravel|auditoria\s+de\s+seguranca|pentest|owasp|xss|csrf|sql\s*injection|injecao\s+de\s+sql|autenticacao|autorizacao|permissoes?|credencial|credenciais|segredo|secrets?|senhas?|token\s+de\s+acesso|chaves?\s+de\s+api|api\s*keys?|variavel\s+de\s+ambiente|https?\b|ssl|tls|criptografi|sanitiz|escap(?:ar|e)|hardening|proteg(?:er|e)|proteja|valid(?:ar|e|a)\s+(?:os\s+)?dados)\b/u.test(
    canonical,
  );
}

/**
 * O que um agente precisa saber ANTES de mexer em segurança. Curta de
 * propósito: prompt longo é token queimado em toda missão que casar.
 */
export const SECURITY_DOCTRINE_NOTE =
  'Este pedido envolve SEGURANÇA. Regras: (1) nunca escreva segredo, chave ou ' +
  'token em código, log ou summary — use variável de ambiente e cite só o ' +
  'NOME; (2) toda entrada externa é hostil: valide no servidor, nunca só no ' +
  'cliente; (3) não afrouxe permissão, CORS ou verificação para "fazer ' +
  'funcionar" — se travar, relate o bloqueio; (4) corrija a causa, não o ' +
  'sintoma, e diga no summary qual risco cada mudança fecha.';

// ── Construção de prompt ────────────────────────────────────────────────

/**
 * Caminho que o CLI no checkout consegue abrir com Read. O snapshot.path é
 * o artefato selado FORA do workspace — o Maestro colava isso no brief e
 * nunca via a imagem no pane.
 */
export function readableMissionAttachmentPath(snapshot: {
  readonly path: string;
  readonly sourcePath?: string;
}): string {
  const source = (snapshot.sourcePath ?? '').replaceAll('\\', '/');
  const marker = '/.nexus/attachments/mission-context/';
  const indexed = source.indexOf(marker);
  const relative =
    indexed >= 0
      ? source.slice(indexed + 1)
      : source.startsWith('.nexus/attachments/mission-context/')
        ? source
        : '';
  if (
    relative.length > 0 &&
    !relative.includes('..') &&
    !relative.startsWith('/')
  ) {
    return relative;
  }
  return snapshot.path;
}

/**
 * Prompt do kickoff. Maestro: briefing curto (objetivo / equipe / fim).
 * Worker: papel + objetivo. Contrato de handoff continua anexado à parte.
 */
function missionCanDispatchWorkers(mission: Mission): boolean {
  const contract = mission.intentContract;
  return contract?.lane !== 'plan' && contract?.lane !== 'consult' && contract?.budgets?.maxWorkers !== 0;
}

function missionRoutingSkillNote(mission: Mission, agent: SquadAgent): string {
  const { suggestedSkills } = getMissionRoutingHints(mission.intentContract, agent.allowedSkills);
  return suggestedSkills.length > 0
    ? `Skills sugeridas para esta tarefa: ${suggestedSkills.join(', ')}. Consulte as instruções das skills antes de usá-las; esta sugestão não amplia suas permissões.`
    : '';
}

export function agentPrompt(
  agent: SquadAgent,
  mission: Mission,
  teamNames: readonly string[],
  resume: boolean,
  designContext = '',
  squad: Squad | null = null,
  sealedPlanTitles: readonly string[] = [],
): string {
  const objective = mission.description ?? '';
  const title = mission.title ?? objective.slice(0, 80);
  const routingHints = getMissionRoutingHints(mission.intentContract);
  const skillNote = missionRoutingSkillNote(mission, agent);
  // Missão-pergunta aos panes: contrato META-DE-PANE no lugar do plano selado
  // (redundância "1 entrega" repetindo o objetivo custava contexto sem
  // informação — 22/08, missão 1+1).
  const isMetaPaneMission =
    agent.category === 'orchestrator' &&
    missionCanDispatchWorkers(mission) &&
    (routingHints.paneQuestion !== null || isPaneMetaTask(objective) ||
      isPaneMetaTask(title) ||
      sealedPlanTitles.some((storyTitle) => isPaneMetaTask(storyTitle)));
  // A doutrina anti-colapso existe para planos com VÁRIAS entregas (11
  // stories viravam 5 papéis). Para 1 entrega ela é ruído puro no kickoff
  // ("Não colapse em 7 papéis. São 1 entregas." — operador 20/08): 1 task =
  // uma linha só.
  const sealedPlanBlock =
    agent.category === 'orchestrator' && !isMetaPaneMission
      ? sealedPlanTitles.length > 1
        ? [
            '### Plano selado (não colapse em papéis do squad)',
            `São ${sealedPlanTitles.length} entregas. Preserve cada tarefa e seus critérios; ` +
              'não reduza a lista aos papéis do squad.',
            ...sealedPlanTitles.map(
              (storyTitle, index) => `${index + 1}. ${storyTitle}`,
            ),
          ].join('\n')
        : sealedPlanTitles.length === 1
          ? `Plano selado (1 entrega): ${sealedPlanTitles[0]}`
          : ''
      : '';
  // Critério do operador (20/08): missão que pergunta aos panes só termina
  // quando TODOS os panes endereçados responderam — um pane por integrante,
  // e o FECHO cita a resposta de cada um. Sem isto o Maestro abria 1 pane
  // genérico e fechava com papelada.
  const teamWorkerNames = (squad?.agents ?? [])
    .filter((member) => member.category !== 'orchestrator')
    .map((member) => member.agentName);
  const metaPaneBlock = isMetaPaneMission
      ? 'META-DE-PANE: esta missão pergunta aos próprios panes — VOCÊ fecha ' +
        'com a evidência, a first-wave pergunta. ' +
        `O Nexus está inicializando UM pane por integrante (${teamWorkerNames.join(', ') || 'equipe'}) ` +
        'com a pergunta limpa e readOnly: true. NÃO spawne de novo o mesmo ' +
        'integrante. NÃO spawne ad-hoc (sem agentName). NÃO liste panes. ' +
        'Use nexus_pane_ask em cada integrante quando seu pane estiver disponível. ' +
        'A ausência durante a inicialização não autoriza outro spawn. Só substitua um ' +
        'integrante após falha confirmada, com o mesmo agentName e readOnly: true. ' +
        'EXTRAIA do objetivo apenas a PERGUNTA (ex.: ' +
        '"quanto é 1+1?") — quem é perguntado recebe SÓ a pergunta. ' +
        'Aguarde a resposta de TODOS os panes, e só então FECHO: ' +
        'nexus_handoff_submit success com summary citando a resposta de CADA ' +
        'pane E artifacts: [{fullText: "pane X → resposta; pane Y → resposta"}] ' +
        '— success com artifacts vazio NÃO conclui a missão (o gate exige prova ' +
        'listada), e o slot de handoff é ÚNICO: não chame set_status done, o ' +
        'motor conclui sozinho. Nenhum pane sem resposta = missão não fecha.'
      : '';
  const uiNote = isUiMissionText(objective)
    ? 'Este pedido envolve interface. Antes de editar, leia o contrato de design do projeto (DESIGN.md ou .context/docs/design-system.md) e siga seus tokens e componentes. Use o catálogo apenas como complemento.'
    : '';
  // Missão de segurança não tinha doutrina nenhuma: `WORK_KINDS` não tem um
  // kind 'security' (ela sai como feature/unknown) e `resources/doctrines/`
  // ainda não existe. Em vez de mexer na precedência do classificador no meio
  // de uma release, o pedido de segurança ganha a mesma coisa que o de UI
  // ganha — uma nota de doutrina anexada ao prompt.
  const securityNote = isSecurityMissionText(objective)
    ? SECURITY_DOCTRINE_NOTE
    : '';
  const browserNote =
    /\b(abr[aeiou]|navegador|browser|preview|mostr(?:ar|e)|ver\s+no\s+navegador)\b/iu.test(
      objective,
    )
      // O Nexus abre a entrega sozinho no done (mission-deliverable-open).
      // Este prompt também pedia `open` e o resultado no voo real foram DUAS
      // abas no Chrome. O agente registra o arquivo; quem abre é o main.
      ? 'O objetivo pede para abrir no navegador: o próprio Nexus abre a entrega quando a missão concluir — NÃO rode `open`/`xdg-open`. Garanta apenas que o HTML final esteja salvo no projeto e citado no summary do handoff.'
      : '';
  const designBlock = uiNote && designContext ? designContext : '';
  const attachmentBlock =
    mission.intentContract?.attachmentSnapshots?.length
      ? [
          '### Anexos da missão',
          'PRIMEIRO ATO: abra cada arquivo abaixo com a ferramenta Read ANTES de planejar ou delegar. São os anexos autorizados pelo operador; use os caminhos indicados:',
          ...mission.intentContract.attachmentSnapshots.map((snapshot, index) => {
            return `${index + 1}. ${mission.intentContract?.workspaceBinding?.spaceId ? snapshot.path : readableMissionAttachmentPath(snapshot)}`;
          }),
        ].join('\n')
      : '';
  const executorCount = (squad?.agents ?? []).filter(
    (row) => row.category === 'executor',
  ).length;

  if (agent.category === 'orchestrator') {
    return buildMaestroKickoffBrief({
      title,
      objective: [
        objective,
        routingHints.paneQuestion ? `Pergunta à equipe: ${routingHints.paneQuestion}` : '',
        routingHints.triage
          ? `Triagem Jev: complexidade ${routingHints.triage.complexityLevel} ` +
            `(${routingHints.triage.complexity.toFixed(1)}), risco sensível ` +
            `${routingHints.triage.riskSensitive.toFixed(2)}, ambiguidade ` +
            `${routingHints.triage.ambiguous.toFixed(2)}` +
            (routingHints.triage.designReference
              ? `, referência visual ${routingHints.triage.designReference.name} ` +
                `${routingHints.triage.designReference.probability.toFixed(2)}`
              : '') +
            '. Regras: ambiguidade ≥ 0.75 → use nexus_clarify com o usuário ' +
            'ANTES de dividir trabalho; risco ≥ 0.7 → exija revisão de ' +
            'segurança (bridgesecurity) e evidência de testes no handoff; ' +
            'complexidade trivial/small → um worker direto, sem cerimônia de plano.'
          : '',
        skillNote,
        mission.learnings
          ? `Aprendizados anteriores: ${mission.learnings}`
          : '',
        attachmentBlock,
        sealedPlanBlock,
        metaPaneBlock,
        browserNote,
      ]
        .filter(Boolean)
        .join('\n'),
      orchestratorName: agent.agentName,
      teamNames,
      playbook: squad?.orchestratorInstructions,
      resume,
      uiNote,
      // O coordenador delega — precisa da doutrina de segurança ANTES de
      // escrever o prompt do worker, não só depois dele.
      securityNote,
      designContext: designBlock,
      lane: mission.intentContract?.lane,
      maxWorkers: mission.intentContract?.budgets?.maxWorkers,
      executorCount: executorCount ?? 3,
      sealedPlanTitles,
      firstWaveDispatched: true,
      metaPane: isMetaPaneMission,
    });
  }

  return [
    `## Missão: ${title}`,
    `Objetivo: ${objective}`,
    skillNote,
    mission.learnings ? `Aprendizados anteriores: ${mission.learnings}` : '',
    attachmentBlock,
    uiNote,
    securityNote,
    browserNote,
    designBlock,
    `Você é ${agent.agentName} (trabalhador).`,
    'Execute a tarefa e entregue o resultado ao coordenador.',
    'Nunca pergunte ao operador cor, fonte ou preferência de design — se faltar, leia DESIGN.md, escolha e entregue arquivos.',
    'As regras de entrega estão no contrato no fim deste prompt — siga-as.',
    resume ? '(Você foi religado após uma tentativa anterior.)' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function sealFastLanePlanTitles(
  stores: ProjectDomainStoreSuite,
  mission: Mission,
  squad: Squad | null,
): readonly string[] {
  if (!squad) return [];
  try {
    return sealFastLaneListedStoryPlan(stores, mission, squad).map(
      (task) => task.title,
    );
  } catch (error) {
    console.warn(
      '[fast-lane] selo do plano de stories falhou:',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

function orderedRoster(agents: readonly SquadAgent[]): SquadAgent[] {
  return [...agents].sort(
    (left, right) =>
      Number(right.category === 'orchestrator') -
      Number(left.category === 'orchestrator'),
  );
}

// ── Spawn de pane ───────────────────────────────────────────────────────

interface SpawnedAgent {
  agentId: string;
  agentName: string;
  role: 'orchestrator' | 'worker';
  adapterId: string;
  paneId: string;
  sessionId: string;
}

function liveAutoSeatProviderViews(
  adapterIds: readonly string[],
): AutoSeatProviderView[] {
  const seen = new Set<string>();
  const views: AutoSeatProviderView[] = [];
  for (const adapterId of adapterIds) {
    const id = adapterId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    views.push({
      adapterId: id,
      authStrategy: String(providerAuthStrategy(id) ?? ''),
      hasKey: hasRuntimeKey(id),
      readiness: detectSubscriptionAuthReadiness(id),
      enabled: true,
    });
  }
  return views;
}

function writerIsConnectedAndWritable(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return isPtySessionConnectedAndWritable(sessionId);
}

function writerCliIsCircuitDead(missionId: string, adapterId: string): boolean {
  const key = { missionId, adapterId, role: 'worker' as const };
  return (
    writerCircuitBroken(key) ||
    writerCircuitBlocksSeat(key) ||
    shouldTripWorkerMortalityBreaker(workerMortalityCount(missionId, adapterId))
  );
}

async function spawnWriterWithCircuit(
  scope: ProjectExecutionScope,
  mission: Mission,
  writer: SquadAgent,
  prompt: string,
  paneTitle?: string,
  spawnOpts?: { readonly readOnly?: boolean },
): Promise<SpawnedAgent | { error: string }> {
  const key = {
    missionId: mission.id,
    role: 'worker',
    adapterId: writer.cli,
  };
  if (writerCliIsCircuitDead(mission.id, writer.cli)) {
    const attempts = Math.max(
      3,
      workerMortalityCount(mission.id, writer.cli),
    );
    logWriterCircuitBreak({
      adapterId: writer.cli,
      attempts,
      role: 'worker',
      missionId: mission.id,
    });
    const providers = liveAutoSeatProviderViews(
      [writer.cli, ...PREFERRED_AUTO_SEAT_CLIS],
    );
    const reminted = remintWriterCliForAutoSeat(
      { id: writer.id, cli: writer.cli, model: writer.model },
      providers.filter((item) => item.adapterId !== writer.cli),
    );
    if (!reminted || reminted.cli === writer.cli) {
      return {
        error: `writer_circuit_break ${writer.cli} after ${attempts} attempts`,
      };
    }
    const successor: SquadAgent = {
      ...writer,
      cli: reminted.cli,
      model: reminted.model ?? '',
    };
    console.warn(
      `[fast-lane] writer_circuit_break remint ${writer.cli} → ${successor.cli} (${attempts} attempts)`,
    );
    return spawnAgentPane(scope, mission, successor, prompt, paneTitle, spawnOpts);
  }
  const spawned = await spawnAgentPane(
    scope,
    mission,
    writer,
    prompt,
    paneTitle,
    spawnOpts,
  );
  const connected =
    !('error' in spawned) &&
    writerIsConnectedAndWritable(spawned.sessionId);
  if (connected) return spawned;
  const attempts = recordWriterConnectFailure(key);
  writerCircuitBreakers.recordConnectFailure(key);
  if (!writerCircuitBroken(key)) {
    return 'error' in spawned
      ? spawned
      : { error: `${writer.agentName} (${writer.cli}): PTY not connected+writable` };
  }
  logWriterCircuitBreak({
    adapterId: writer.cli,
    attempts,
    role: writer.id,
    missionId: mission.id,
  });
  const providers = liveAutoSeatProviderViews(
    [writer.cli, ...PREFERRED_AUTO_SEAT_CLIS],
  );
  const reminted = remintWriterCliForAutoSeat(
    { id: writer.id, cli: writer.cli, model: writer.model },
    providers.filter((item) => item.adapterId !== writer.cli),
  );
  const action = decideWriterCircuitAction({
    attempts,
    successorAuthed: reminted !== null && reminted.cli !== writer.cli,
  });
  if (action === 'skip-silent' || !reminted || reminted.cli === writer.cli) {
    return {
      error: `writer_circuit_break ${writer.cli} after ${attempts} attempts`,
    };
  }
  const successor: SquadAgent = {
    ...writer,
    cli: reminted.cli,
    model: reminted.model ?? '',
  };
  console.warn(
    `[fast-lane] writer_circuit_break remint ${writer.cli} → ${successor.cli} (${attempts} attempts)`,
  );
  return spawnAgentPane(scope, mission, successor, prompt, paneTitle, spawnOpts);
}

/**
 * Colagem do briefing depois do boot (canal paste), igual para Maestro e
 * worker. Se falhar, o pane recém-nascido é encerrado: nunca fica vivo, mudo
 * e já vinculado à missão (o guardian não fecha pane de missão).
 */
async function pasteBriefAfterBoot(
  sessionId: string,
  prompt: string,
  adapterId: string,
): Promise<string | null> {
  let failure: string | null;
  try {
    const boot =
      getSessionState(sessionId) === 'idle'
        ? 'idle'
        : await waitForIdle(sessionId, ORCHESTRATOR_BOOT_TIMEOUT_MS);
    if (boot === 'exited') return 'pane saiu antes do briefing';
    failure = (await deliverAgentPrompt(sessionId, prompt, undefined, { adapterId }))
      ? null
      : 'briefing não foi aceito pelo pane';
  } catch (error) {
    failure = `falha ao colar briefing — ${error instanceof Error ? error.message : String(error)}`;
  }
  if (failure) {
    await orchTerminateSession(sessionId).catch((error: unknown) => {
      console.warn('[fast-lane] pane sem briefing não terminou:', error instanceof Error ? error.message : error);
    });
  }
  return failure;
}

async function spawnAgentPane(
  scope: ProjectExecutionScope,
  mission: Mission,
  agent: SquadAgent,
  briefPrompt?: string,
  paneTitle?: string,
  spawnOpts?: {
    readonly readOnly?: boolean;
    /**
     * F-661: retoma a conversa gravada deste pane no pane novo (`--resume`).
     * O prompt vai cru — os blocos de contexto são do 1º prompt da conversa.
     */
    readonly resumeFromPaneId?: string;
    readonly accountId?: string;
  },
): Promise<SpawnedAgent | { error: string }> {
  const executionScope = missionExecutionScope(scope, mission);
  const role: 'orchestrator' | 'worker' =
    agent.category === 'orchestrator' ? 'orchestrator' : 'worker';
  const title = paneTitle?.trim() || agent.agentName;
  const readOnly = spawnOpts?.readOnly === true;
  // Mesmos blocos de contexto do wrapper de spawn (<business-model>,
  // <workspace-memory>), compostos ANTES da escolha do transporte: argv e as
  // colagens abaixo entregam este texto. O canal do "+ Pane" exclui missão.
  const resumeFromPaneId = spawnOpts?.resumeFromPaneId;
  const initialPrompt = resumeFromPaneId ? briefPrompt : withProjectContextBlocks({
    prompt: briefPrompt,
    scope,
    executionScope,
    missionId: mission.id,
    role,
    readOnly,
    agentCategory: agent.category,
  });
  if (role === 'worker') {
    const isMeta =
      getMissionRoutingHints(mission.intentContract).paneQuestion !== null ||
      isPaneMetaTask(mission.description ?? '') ||
      isPaneMetaTask(mission.title ?? '');
    if (isMeta) {
      const squad = mission.squadId ? getSquad(mission.squadId) : null;
      const snapshots = listPaneSnapshots();
      const liveKeys = liveWorkerSeatKeys(snapshots, mission.id);
      const liveCount = liveMissionWorkerCount(snapshots, mission.id);
      const decision = decideMetaPaneWorkerSpawn({
        isMetaPaneMission: true,
        requestedAgentName: agent.agentName,
        rosterWorkerNames: (squad?.agents ?? [])
          .filter((member) => member.category !== 'orchestrator')
          .map((member) => member.agentName),
        liveWorkerKeys: liveKeys,
        liveWorkerCount: liveCount,
      });
      if (!decision.allowed) return { error: decision.reason };
    }
    warmPool.take(agent.cli);
  }

  const spawn = await requestPaneSpawn({
    adapterId: agent.cli,
    model: agent.model || undefined,
    effort: agent.effort || undefined,
    cwd: executionScope.rootRealPath,
    title,
    missionId: mission.id,
    agentName: agent.agentName,
    allowedTools: agent.allowedTools ? [...agent.allowedTools] : null,
    // null = irrestrito (paridade tools / spawn-authority). `[]` nega todas
    // as skills e ainda arma requiresSpawnGate — não confundir com ausente.
    allowedSkills: agent.allowedSkills ? [...agent.allowedSkills] : null,
    role,
    scope,
    executionScope,
    executionMode: readOnly ? 'read_only' : 'same_checkout',
    ...(readOnly ? { readOnly: true, nativeReadOnly: true } : {}),
    resume: Boolean(resumeFromPaneId),
    ...(resumeFromPaneId ? { resumeFromPaneId } : {}),
    ...(spawnOpts?.accountId ? { accountId: spawnOpts.accountId } : {}),
    ...(initialPrompt ? { initialPrompt } : {}),
  });

  if (!spawn.ok || !spawn.paneId || !spawn.sessionId) {
    return {
      error: `${agent.agentName} (${agent.cli}): ${spawn.error ?? 'spawn falhou sem detalhe'}`,
    };
  }

  const stores = getProjectDomainStores(scope);
  bindSpawnedMissionPane(stores, scope, mission, agent, role, {
    paneId: spawn.paneId,
    sessionId: spawn.sessionId,
    title,
    readOnly,
  });
  if (role === 'orchestrator') {
    stores.missions.setOrchestratorSession(mission.id, spawn.sessionId);
    rememberKickoffBrief({
      missionId: mission.id,
      orchestratorSessionId: spawn.sessionId,
      intentVersion: (stores.missions.get(mission.id) ?? mission).intentVersion ?? 0,
      promptHash: kickoffPromptHash(initialPrompt),
    });
  }

  // Worker paste: mesma lacuna do Maestro, mas para writers. pty-manager só
  // injeta initialPrompt no argv quando o canal do binário é positional/flag;
  // um CLI sem prompt posicional (ex.: Kimi Code 2.1.1 — `kimi --help` não
  // tem `[prompt]`) sempre resolve 'paste' e dependia de alguém colar depois
  // do boot. Só o Maestro tinha esse fallback — o worker abria mudo e o
  // operador digitava o briefing à mão (achado 2026-09-27).
  if (role === 'worker' && initialPrompt) {
    const delivery = resolveOrchestratorBriefDelivery(agent.cli);
    if (delivery === 'paste') {
      const failure = await pasteBriefAfterBoot(spawn.sessionId, initialPrompt, agent.cli);
      if (failure) return { error: `${agent.agentName} (${agent.cli}): ${failure}` };
    }
  }

  // Maestro paste/oneshot: pty-manager NÃO coloca o briefing no argv (one-shot
  // mataria o pane; paste não tem canal). Sem colagem o Maestro fica mudo e
  // a Via Rápida marca kickoff aceito — missão "running" que nunca despacha.
  // Maestro positional: argv sem recibo — NÃO gravar kickoff até first-run/
  // OAuth sumirem. Se o pane já está idle com o briefing injetado, o recibo
  // pode ser aceito antes da prova de Enter (poke do operador não espera 70s).
  if (role === 'orchestrator' && initialPrompt) {
    const delivery = resolveOrchestratorBriefDelivery(agent.cli);
    if (delivery === 'paste') {
      const failure = await pasteBriefAfterBoot(spawn.sessionId, initialPrompt, agent.cli);
      if (failure) return { error: `${agent.agentName} (${agent.cli}): ${failure}` };
      tryAcceptIdleOrchestratorKickoff(
        stores,
        mission,
        spawn.sessionId,
        initialPrompt,
      );
    } else {
      // positional argv: Claude often only preloads the composer. Force
      // Enter (then paste) so the first turn starts without a human keystroke.
      const boot =
        getSessionState(spawn.sessionId) === 'idle'
          ? 'idle'
          : await waitForIdle(
              spawn.sessionId,
              ORCHESTRATOR_BOOT_TIMEOUT_MS,
            );
      if (boot === 'exited') {
        return {
          error: `${agent.agentName} (${agent.cli}): pane saiu antes de consumir o briefing`,
        };
      }
      try {
        // Theme picker / trust / bypass — autoresponder; não injectar no modal.
        await waitOutBootPrompts(spawn.sessionId, 20_000);
      } catch (error) {
        return {
          error: `${agent.agentName} (${agent.cli}): falha ao limpar boot menus — ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      const tail = readSessionOutput(spawn.sessionId, 80);
      const blocked = maestroKickoffBlockReason(tail);
      if (blocked?.kind === 'auth') {
        return {
          error: `${agent.agentName} (${agent.cli}): ${blocked.reason}`,
        };
      }
      if (blocked?.kind === 'onboarding') {
        // Uma segunda passagem: o autoresponder pode ainda estar a meio.
        await waitOutBootPrompts(spawn.sessionId, 10_000);
        const tail2 = readSessionOutput(spawn.sessionId, 80);
        const still = maestroKickoffBlockReason(tail2);
        if (still) {
          return {
            error: `${agent.agentName} (${agent.cli}): ${still.reason}`,
          };
        }
      }
      // Recibo quando idle + briefing no argv + sem auth. Não espera a prova
      // de Enter — o poke do operador e o primeiro turno deixam de ficar
      // atrás de 60s+ de waitForIdle/prove.
      tryAcceptIdleOrchestratorKickoff(
        stores,
        mission,
        spawn.sessionId,
        initialPrompt,
      );
      try {
        await proveNativeArgvBriefAccepted(
          spawn.sessionId,
          initialPrompt,
          agent.cli,
        );
      } catch (error) {
        const after = maestroKickoffBlockReason(
          readSessionOutput(spawn.sessionId, 80),
        );
        return {
          error: `${agent.agentName} (${agent.cli}): ${
            after?.reason ??
            (error instanceof Error
              ? error.message
              : 'briefing argv não abriu um turno')
          }`,
        };
      }
      // Recusa kickoff se, após a prova, o TUI voltou a auth/onboarding.
      const finalBlock = maestroKickoffBlockReason(
        readSessionOutput(spawn.sessionId, 80),
      );
      if (finalBlock) {
        return {
          error: `${agent.agentName} (${agent.cli}): ${finalBlock.reason}`,
        };
      }
    }
  }

  if (role === 'orchestrator') {
    // Recibo de kickoff (0.32.23): prova durável do orquestrador desta
    // encarnação — exigido por missionDirectAuthority e pelo retry do
    // orientar-missão. Vale para bootstrap E respawn (continuidade).
    // Idle + briefing já injetado (e sem auth) pode ter gravado antes da prova.
    const live = stores.missions.get(mission.id) ?? mission;
    if (!stores.missions.hasCurrentKickoffAcceptance(live.id)) {
      try {
        stores.missions.recordKickoffAcceptance({
          missionId: live.id,
          intentVersion: live.intentVersion ?? 0,
          orchestratorSessionId: spawn.sessionId,
          promptHash: kickoffPromptHash(initialPrompt),
        });
      } catch (error) {
        console.warn(
          '[fast-lane] recibo de kickoff não gravou:',
          error instanceof Error ? error.message : error,
        );
      }
    }
    void flushQueuedKickoffDirects(scope, stores, live.id);
  }

  return {
    agentId: agent.id,
    agentName: agent.agentName,
    role,
    adapterId: agent.cli,
    paneId: spawn.paneId,
    sessionId: spawn.sessionId,
  };
}

// ── Orquestrador registry (para consulta externa) ──────────────────────

interface OrchPaneEntry {
  paneId: string;
  sessionId: string;
  adapterId: string;
  cwd: string;
  title: string;
  agentName: string;
}

const orchPanes = new Map<string, OrchPaneEntry>();

// ── Watcher ──────────────────────────────────────────────────────────────

function stopWatcher(scope: ProjectExecutionScope, missionId: string): void {
  const key = watcherKey(scope, missionId);
  const watcher = watchers.get(key);
  if (watcher?.timer) clearInterval(watcher.timer);
  watchers.delete(key);
}

/**
 * Watcher tick — verifica o estado da missão e do orquestrador.
 *
 * O orquestrador NÃO faz polling de worker. Ele chama
 * nexus_pane_spawn, os workers chamam nexus_handoff_submit quando terminam,
 * e o orquestrador chama nexus_mission_set_status({status:"done"}) quando
 * todos entregaram. O watcher só observa o status da missão e a saúde do
 * orquestrador.
 */
async function tickWatcher(state: WatcherState): Promise<void> {
  if (state.stopped) {
    stopWatcher(state.scope, state.missionId);
    return;
  }

  const stores = getProjectDomainStores(state.scope);
  const mission = stores.missions.get(state.missionId);

  if (!mission) {
    stopWatcher(state.scope, state.missionId);
    return;
  }

  // Missão já concluída ou bloqueada → encerra observador.
  if (mission.status === 'done' || mission.status === 'failed') {
    stopWatcher(state.scope, state.missionId);
    return;
  }

  // Bloqueada por alguém (orquestrador ou vigia externo) → encerra.
  if (mission.status === 'blocked') {
    stopWatcher(state.scope, state.missionId);
    return;
  }

  // Se a missão não está mais running, algo externo a mudou.
  if (mission.status !== 'running') {
    stopWatcher(state.scope, state.missionId);
    return;
  }

  // Orientação enfileirada (kickoff/autoridade incompleta) tenta de novo a
  // cada tick — o flush pós-spawn pode rodar antes da autoridade fechar e a
  // fila ficava órfã (19/08: "authority is incomplete" cru pro operador).
  void flushQueuedKickoffDirects(state.scope, stores, state.missionId);

  // TTL de stalled (paridade OC): entrega em voo sem veredito há 30min+
  // ganha status `stalled` — visível para cobrança/doctor em vez de
  // pendente anônima para sempre (evidência A4/B4: 16h paradas sem dono).
  try {
    const inFlight = stores.handoffs.list({
      missionId: state.missionId,
      includeDelivered: false,
    });
    const stalledIds = findStalledHandoffIds(inFlight, Date.now());
    if (stalledIds.length > 0) {
      stores.handoffs.markStalled(stalledIds);
      console.warn(
        `[fast-lane] ${stalledIds.length} handoff(s) stalled ` +
          `(TTL ${Math.round(HANDOFF_STALL_TTL_MS / 60_000)}min) ` +
          `mission=${state.missionId}: ${stalledIds.join(',')}`,
      );
    }
  } catch {
    // Diagnóstico best-effort; nunca bloqueia o tick por isso.
  }

  // P0 civil: Pronto só com board selado N/N. pending-with-file fecha
  // match único na pasta; never-started após first-wave curto reroteia.
  try {
    const civilian = await maybeCompleteFastLaneOnDelivery(
      state.scope,
      state.missionId,
      {
        getStores: () => stores,
        rerouteUnassigned: async () =>
          dispatchFastLaneFirstWave(state.scope, state.missionId),
      },
    );
    if (civilian.completed) {
      stopWatcher(state.scope, state.missionId);
      return;
    }
  } catch (error) {
    console.warn(
      '[fast-lane] avaliação de Pronto civil falhou:',
      error instanceof Error ? error.message : error,
    );
  }

  // Atualiza timestamp de atividade se o orquestrador está busy.
  const orchState = getSessionState(state.orchSessionId);
  if (orchState === 'busy') {
    state.lastOrchActivityAt = Date.now();
  }

  // Sentinela de HEAD (achado #14): o mundo pode commitar por fora enquanto
  // a missão acha que tem exclusividade no checkout. Avisa uma vez por mudança
  // — MENOS quando o HEAD novo bate na escada de SHAs das entregas da própria
  // missão (worker do same_checkout commitou): isso é trabalho interno, não
  // exclusividade violada (A6).
  const currentHead = await readCheckoutHead(missionExecutionScope(state.scope, mission).rootRealPath);
  const missionShaLadder = new Set<string>();
  try {
    for (const handoff of stores.handoffs.list({
      missionId: state.missionId,
      includeDelivered: true,
    })) {
      // Os SHAs do trabalho vivem no binding de evidência (worker que
      // commitou entrega evidência confiável com base/head do diff).
      const binding = handoff.evidenceBinding;
      if (binding?.headSha) missionShaLadder.add(binding.headSha);
      if (binding?.baseSha) missionShaLadder.add(binding.baseSha);
    }
  } catch {
    // Escada ilegível: segue sem atribuição — o aviso é o default honesto.
  }
  const headDecision = decideExternalHeadChangeAction({
    baseline: state.baselineHeadSha,
    current: currentHead,
    missionShaLadder,
  });
  if (headDecision.action === 'internal') {
    // Trabalho da própria missão: rebaseline silencioso, zero turno gasto.
    state.baselineHeadSha = headDecision.to;
    trace({
      kind: 'head-change-internal',
      missionId: state.missionId,
      to: headDecision.to.slice(0, 12),
    });
  }
  if (headDecision.action === 'notify') {
    state.baselineHeadSha = headDecision.to;
    trace({
      kind: 'head-change-external',
      missionId: state.missionId,
      from: headDecision.from.slice(0, 12),
      to: headDecision.to.slice(0, 12),
    });
    console.warn(
      `[fast-lane] HEAD do checkout mudou por FORA durante ${state.missionId}: ` +
        `${headDecision.from.slice(0, 10)} → ${headDecision.to.slice(0, 10)}; ` +
        'o orquestrador deve revalidar o estado do repo antes de despachar',
    );
    try {
      emitMissionEvent(state.scope, {
        missionId: state.missionId,
        runId: `watcher:${state.missionId}`,
        type: 'custom',
        origin: 'system',
        payload: {
          kind: 'external-head-change',
          from: headDecision.from,
          to: headDecision.to,
          note:
            'O HEAD do checkout mudou por um processo fora da missão. ' +
            'Revalide git status/HEAD antes de despachar ou considerar ' +
            'entregas atuais.',
        },
        idempotencyKey: `head-change:${state.missionId}:${headDecision.to.slice(0, 12)}`,
        occurredAt: Date.now(),
      });
    } catch {
      // Evento é best-effort; o warn no log já registrou.
    }
  }

  // Verifica se há panes vivos nesta missão.
  const missionPanes = listPaneSnapshots().filter(
    (p) => p.missionId === state.missionId,
  );
  recordWorkerMortalityTick(state.scope, state.missionId, missionPanes);
  try {
    const disk = reconcileSealedBoardFromDisk({
      stores,
      missionId: state.missionId,
      cwd: missionExecutionScope(state.scope, mission).rootRealPath,
    });
    if (disk.advancedTaskIds.length > 0) {
      console.info(
        `[fast-lane] board selado +${disk.advancedTaskIds.length} ` +
          `via files-modified (${disk.filesModified.length} arquivos) ` +
          `em ${state.missionId}`,
      );
    }
  } catch (error) {
    console.warn(
      '[fast-lane] reconcile files-modified falhou:',
      error instanceof Error ? error.message : error,
    );
  }
  const livePanes = missionPanes.filter(
    (p) => p.state === 'busy' || p.state === 'idle' || p.state === 'spawning',
  );
  const budgetKey = watcherKey(state.scope, state.missionId);
  // Recarrega o orçamento do episódio somente quando houve progresso REAL
  // (handoff consumido ou tarefa concluída) desde o último tick. A mera
  // liveness de um orquestrador respawnado não recarrega — senão o orçamento
  // nunca esgota e a missão entra em loop de respawn (bug de campo 2026-08-18).
  if (livePanes.length > 0) {
    try {
      const signature = missionProgressSignature(stores, state.missionId);
      if (
        state.lastProgressSignature !== null &&
        state.lastProgressSignature !== signature
      ) {
        respawnBudgets.set(budgetKey, ORCHESTRATOR_RESPAWN_BUDGET);
      }
      state.lastProgressSignature = signature;
    } catch {
      // Assinatura ilegível não recarrega orçamento — fail-closed.
    }
  }
  // No live processes: retry while budget remains, then expose the failure
  // so the operator can fix its cause and explicitly resume the mission.
  if (livePanes.length === 0) {
    let pendingHandoffs = 0;
    try {
      pendingHandoffs = stores.handoffs
        .list({ missionId: state.missionId, includeDelivered: false })
        .filter((h) => h.status === 'success' || h.status === 'blocked').length;
    } catch {
      // Sem handoffs legíveis não muda a decisão: o orquestrador respawnado
      // consulta o mundo pelas tools dele.
    }
    const action = decideFastLaneEmptyPaneAction({
      status: mission.status,
      pendingHandoffs,
      respawnBudgetLeft: respawnBudgets.get(budgetKey) ?? ORCHESTRATOR_RESPAWN_BUDGET,
      operatorDismissedOrchestrator: wasOrchestratorOperatorDismissed(
        state.missionId,
      ),
    });
    if (action === 'respawn-orchestrator') {
      respawnBudgets.set(
        budgetKey,
        (respawnBudgets.get(budgetKey) ?? ORCHESTRATOR_RESPAWN_BUDGET) - 1,
      );
      try {
        await respawnFastLaneOrchestrator(state.scope, mission, {
          note:
            pendingHandoffs > 0
              ? `${pendingHandoffs} entrega(s) de worker aguardando consumo.`
              : 'Nenhum pane vivo; retome de onde a missão parou.',
        });
        return; // respawnFastLaneOrchestrator re-armou watcher/orchPanes.
      } catch (error) {
        console.warn(
          '[fast-lane] respawn do orquestrador falhou; missão segue running:',
          error instanceof Error ? error.message : error,
        );
        return; // watcher continua; próxima tick tenta com o orçamento restante.
      }
    }
    if (action === 'block-recovery-exhausted') {
      const current = stores.missions.get(state.missionId);
      if (!current || current.status !== 'running') return;
      missionEngineForScope(state.scope).blockTechnical(state.scope, {
        missionId: current.id,
        expectedStatus: current.status,
        expectedIntentState: current.intentState ?? 'executing',
        expectedUpdatedAt: current.updatedAt,
        expectedIntentVersion: current.intentVersion ?? 0,
        description: `${current.description ?? current.title}\n\n[NEXUS_FAILURE:terminal] A recuperação automática se esgotou após ${ORCHESTRATOR_RESPAWN_BUDGET} tentativas, sem nenhum painel vivo. O histórico e as entregas foram preservados. Confira o login e a saída das ferramentas de IA, depois clique em Retomar.`,
      });
      stopWatcher(state.scope, state.missionId);
    }
    return;
  }

  // Orquestrador morreu mas ainda há panes vivos e o timeout não passou →
  // deixa o delegation-supervisor tentar recovery. Não bloqueia — workers
  // ainda podem estar trabalhando.
}

/** Panes mortos cuja mortalidade já foi contada (conta 1× por pane). */
const mortalityCountedPanes = new Set<string>();
/** Idle/exited writers already settled from files-modified (1× per pane). */
const filesModifiedSettledPanes = new Set<string>();

/**
 * Mortalidade de worker no tick do watcher (campanha 0.50, A1): pane morto
 * que NUNCA entregou handoff = morte sem entrega (conta pro circuit breaker
 * do adapter); pane com entrega é prova de vida (zera) — exit pós-entrega é
 * o TTL normal da doutrina, não mortalidade. Cada morte vira evento no
 * journal: o pós-mortem deixa de ser cego.
 */
function settleFastLaneWriterDone(input: {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly fromAgent?: string | null;
  readonly preferredTaskId?: string | null;
  readonly filesModified: readonly string[];
  readonly mcpHandoffClosedTask: boolean;
}): void {
  let stores: ProjectDomainStoreSuite;
  try {
    stores = getProjectDomainStores(input.scope);
  } catch {
    return;
  }
  const mission = stores.missions.get(input.missionId);
  const sealed = mission
    ? stores.tasks.list(input.missionId)
    : [];
  const progress = boardProgressFromSealedTasks(sealed);
  const decision = maybeCompleteFromFilesModified({
    filesModified: input.filesModified,
    mcpHandoffClosedTask: input.mcpHandoffClosedTask,
    sealedCompleted: progress.completed,
    sealedTotal: progress.total,
  });
  if (!decision.countsAsDelivery) {
    console.warn(
      `[fast-lane] worker_done ignored — 0 files-modified and no MCP handoff ` +
        `(mission=${input.missionId})`,
    );
    return;
  }
  if (!input.mcpHandoffClosedTask && input.filesModified.length > 0) {
    try {
      advanceFastLaneStoryTaskFromWorkerDone(stores, {
        missionId: input.missionId,
        fromAgent: input.fromAgent,
        preferredTaskId: input.preferredTaskId,
        summary: `files-modified: ${input.filesModified.slice(0, 20).join(', ')}`,
        filesModified: input.filesModified,
      });
    } catch (error) {
      console.warn(
        '[fast-lane] files-modified board advance failed:',
        error instanceof Error ? error.message : error,
      );
    }
  }
  if (decision.pronto) {
    console.info(
      `[fast-lane] Pronto justified by files-modified/handoff ` +
        `(${progress.completed}/${progress.total}) mission=${input.missionId}`,
    );
  }
}

function recordWorkerMortalityTick(
  scope: ProjectExecutionScope,
  missionId: string,
  missionPanes: readonly {
    paneId: string;
    sessionId?: string | null;
    adapterId?: string | null;
    role?: 'orchestrator' | 'worker';
    state?: string;
    agentName?: string;
    title?: string;
  }[],
): void {
  const mission = getProjectDomainStores(scope).missions.get(missionId);
  if (!mission) return;
  const workers = missionPanes.filter((p) => p.role === 'worker');
  if (workers.length === 0) return;
  let deliveredHandoffs: readonly {
    sessionId?: string | null;
    fromAgent?: string | null;
  }[] = [];
  try {
    deliveredHandoffs = getProjectDomainStores(scope).handoffs.list({
      missionId,
      includeDelivered: true,
    });
  } catch {
    // Handoffs ilegíveis: segue sem prova de vida — a morte sem entrega é o
    // default honesto (o breaker precisa de 3 para agir).
  }
  for (const pane of workers) {
    const adapterId = pane.adapterId?.trim() || '';
    if (!adapterId) continue;
    if (workerPaneHasDelivery(pane, deliveredHandoffs)) {
      recordAdapterProofOfLife(missionId, adapterId);
      continue;
    }
    const cwd =
      (pane.sessionId ? getSessionCwd(pane.sessionId) : null) ??
      missionExecutionScope(scope, mission).rootRealPath;
    const filesModified = collectFilesModified(cwd);
    const idleOrDead =
      pane.state === 'idle' ||
      pane.state === 'exited' ||
      pane.state === 'hibernated';
    // worker_done --files-modified: a live idle writer that actually wrote
    // files must advance the sealed board. Death-only settlement left
    // 20stories-e at 0/20 with files on disk.
    if (
      idleOrDead &&
      filesModified.length > 0 &&
      !filesModifiedSettledPanes.has(pane.paneId)
    ) {
      filesModifiedSettledPanes.add(pane.paneId);
      settleFastLaneWriterDone({
        scope,
        missionId,
        fromAgent: pane.agentName ?? pane.title ?? adapterId,
        filesModified,
        mcpHandoffClosedTask: false,
      });
    }
    if (pane.state !== 'exited' && pane.state !== 'hibernated') continue;
    if (mortalityCountedPanes.has(pane.paneId)) continue;
    mortalityCountedPanes.add(pane.paneId);
    const deaths = recordWorkerDeathWithoutDelivery(missionId, adapterId);
    if (!filesModifiedSettledPanes.has(pane.paneId)) {
      filesModifiedSettledPanes.add(pane.paneId);
      settleFastLaneWriterDone({
        scope,
        missionId,
        fromAgent: pane.agentName ?? pane.title ?? adapterId,
        filesModified,
        mcpHandoffClosedTask: false,
      });
    }
    trace({
      kind: 'worker-died-without-delivery',
      missionId,
      paneId: pane.paneId,
      adapterId,
      deaths,
      filesModified,
    });
    console.warn(
      `[fast-lane] worker ${pane.paneId} (${adapterId}) morreu sem entregar ` +
        `— mortalidade ${deaths} em ${missionId}`,
    );
    try {
      emitMissionEvent(scope, {
        missionId,
        runId: `watcher:${missionId}`,
        type: 'custom',
        origin: 'system',
        payload: {
          kind: 'worker-died-without-delivery',
          paneId: pane.paneId,
          adapterId,
          agentName: pane.agentName ?? '',
          deaths,
        },
        idempotencyKey: `worker-died:${pane.paneId}`,
        occurredAt: Date.now(),
      });
    } catch {
      // Evento é best-effort; o warn já registrou.
    }
  }
}

function startWatcher(
  scope: ProjectExecutionScope,
  missionId: string,
  orchSessionId: string,
): void {
  const key = watcherKey(scope, missionId);
  // Idempotente: já tem watcher rodando.
  if (watchers.has(key)) return;
  const mission = getProjectDomainStores(scope).missions.get(missionId);
  if (!mission) return;

  const state: WatcherState = {
    scope,
    missionId,
    orchSessionId,
    startedAt: Date.now(),
    lastOrchActivityAt: Date.now(),
    timer: null,
    stopped: false,
    baselineHeadSha: null,
    lastProgressSignature: null,
  };
  void readCheckoutHead(missionExecutionScope(scope, mission).rootRealPath).then((head) => {
    if (!watchers.has(key)) return;
    state.baselineHeadSha = head;
  });

  state.timer = setInterval(() => {
    void tickWatcher(state).catch((error) => {
      console.warn(
        '[fast-lane] tick do watcher falhou:',
        error instanceof Error ? error.message : error,
      );
    });
  }, WATCHER_INTERVAL_MS);

  watchers.set(key, state);
}

// ── Respawn do orquestrador ────────────────────────────────────────────────

/**
 * "Pedir um ajuste": o Maestro religa para OUVIR o operador, não para
 * re-executar. O kickoff completo abaixo manda delegar e concluir — sem este
 * bloco de espera NA FRENTE, ele obedece as ordens permanentes e sai rodando
 * sozinho antes de saber qual é o ajuste.
 */
export const ADJUSTMENT_WAIT_FIRST =
  '## AGUARDE O OPERADOR (esta ordem vence as instruções de delegação abaixo)\n' +
  'Você foi religado porque o operador clicou "Pedir um ajuste". NÃO spawne workers, NÃO re-execute o objetivo, NÃO conclua a missão. ' +
  'Leia nexus_handoff_list({full:true}) para contexto e ESPERE a orientação dele no chat. Só aja depois que ele disser qual é o ajuste. ' +
  'A espera termina quando o operador descreve o ajuste: se ele já o descreveu depois da reabertura, execute esse pedido e delegue partes independentes conforme suas permissões. ' +
  'Não peça o mesmo ajuste novamente. Perguntar status não autoriza re-executar o objetivo antigo.';

/** Monta o prompt do Maestro religado — puro para teste. */
export function buildRespawnPrompt(input: {
  readonly basePrompt: string;
  readonly awaitingAdjustment: boolean;
  readonly note?: string;
}): string {
  return [
    input.awaitingAdjustment ? ADJUSTMENT_WAIT_FIRST : '',
    input.basePrompt,
    input.note
      ? `## CONTINUIDADE\nVocê foi religado automaticamente. ${input.note} ` +
        'Consulte nexus_handoff_list e o estado da missão antes de agir.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Respawna o orquestrador de uma missão running cujo runtime morreu
 * (exit do Maestro, restart do app, pane vazio). Cura split-brain de intent
 * ANTES do spawn — sem isso o reconciler de autoridade de 1s mata o
 * orquestrador recém-nascido. O novo Maestro recebe nota de continuidade e
 * decide o resto pelas tools dele (handoffs pendentes, replanejamento, done).
 */
function resolveFastLaneSquad(squadId?: string): import('../../shared/orch-types').Squad | null {
  return (
    (squadId ? getSquad(squadId) : null) ??
    getSquad('nexus-fullstack') ??
    listSquads().find((candidate) => candidate.id !== PET_STUDIO_SQUAD_ID) ??
    null
  );
}

async function respawnFastLaneOrchestrator(
  scope: ProjectExecutionScope,
  mission: Mission,
  options: { readonly note?: string } = {},
): Promise<void> {
  const stores = getProjectDomainStores(scope);

  // Re-valida o estado durável antes de spawnar: um Stop do operador (ou
  // qualquer demotion) pode ter vencido a corrida contra o watcher. Respawnar
  // por cima de uma missão blocked/failed re-armaria um runtime que o operador
  // acabou de encerrar (bug de campo 2026-08-18).
  const current = stores.missions.get(mission.id);
  if (!current || current.status !== 'running') {
    throw new Error('missão não está mais running; respawn ignorado');
  }

  // Cura split-brain persistido: write status-only reativação normaliza
  // intent blocked_* → executing (guard do mission-store.update).
  let live = current;
  if (
    current.intentState === 'blocked_technical' ||
    current.intentState === 'blocked_user'
  ) {
    live = stores.missions.update(mission.id, { status: 'running' }) ?? current;
  }

  // F-661: a missão da aba retoma a CONVERSA do pane do operador que a
  // lidera, com a CLI/modelo/conta dele — nunca o Maestro de um squad com o
  // título da missão como brief.
  const composition = stores.missionPanes.list(mission.id);
  const operatorResume = operatorTabMissionResumeSpec(live, composition);
  let orchestrator: SquadAgent;
  let prompt: string;
  if (operatorResume) {
    orchestrator = operatorTabResumeAgent(
      operatorResume,
      operatorTabMissionLeader(composition),
    );
    assertFastLaneMaestroMcp(orchestrator.cli);
    prompt = buildRespawnPrompt({
      basePrompt: OPERATOR_TAB_RESUME_NOTE,
      awaitingAdjustment: operatorTabResumeAwaitsAdjustment(live),
      note: options.note,
    });
  } else {
    const squad = resolveFastLaneSquad(mission.squadId);
    const roster = orderedRoster(squad?.agents ?? []);
    const squadOrchestrator = roster.find((agent) => agent.category === 'orchestrator');
    if (!squadOrchestrator) {
      throw new Error('o squad não tem um orquestrador definido');
    }
    orchestrator = squadOrchestrator;
    assertFastLaneMaestroMcp(orchestrator.cli);

    const sealedPlanTitles = sealFastLanePlanTitles(stores, live, squad);
    prompt = buildRespawnPrompt({
      basePrompt: agentPrompt(
        orchestrator,
        live,
        roster.map((agent) => agent.agentName),
        true,
        missionDesignContext(missionExecutionScope(scope, live).rootRealPath),
        squad,
        sealedPlanTitles,
      ),
      awaitingAdjustment: missionAwaitsAdjustment(live),
      note: options.note,
    });
  }

  // P0-1 (2026-08-17): NUNCA spawnar por cima de um orquestrador registrado.
  // A cerca do pty-manager conta QUALQUER sessão registrada (exited/
  // hibernated incluso); liveOrchestratorSessionId conta só busy/idle/
  // spawning com pane. Quando discordavam, o respawn era recusado para
  // sempre. A saída sancionada é terminar com prova física antes do spawn —
  // e abortar (sem split-brain) se o processo teimoso não provar a morte.
  const staleOrchestrators = registeredOrchestratorSessionsForMission(
    mission.id,
  );
  for (const stale of staleOrchestrators) {
    const proven = await orchTerminateSession(stale.sessionId, {
      termTimeoutMs: 5_000,
      killTimeoutMs: 10_000,
    });
    if (!proven) {
      throw new Error(
        `orquestrador anterior (${stale.sessionId}, estado ${stale.state}, ` +
          `${stale.adapterId}) não terminou fisicamente; respawn abortado ` +
          'para não criar dois Maestros na mesma missão. Feche o pane antigo ' +
          'ou reinicie o app e use Retomar.',
      );
    }
  }

  const spawned = operatorResume
    ? await spawnAgentPane(scope, live, orchestrator, prompt, operatorResume.title, {
        resumeFromPaneId: operatorResume.paneId,
        ...(operatorResume.accountId ? { accountId: operatorResume.accountId } : {}),
      })
    : await spawnAgentPane(scope, live, orchestrator, prompt);
  if ('error' in spawned) {
    throw new Error(`orquestrador não reabriu: ${spawned.error}`);
  }
  // F-664: a conversa agora mora no pane novo. Se o record() deduplicou o
  // pane novo na linha retomada (mesma identidade), a linha passa a apontar
  // para ele — a próxima retomada continua DESTA conversa, não da anterior.
  if (operatorResume && !stores.missionPanes.findByPaneId(spawned.paneId)) {
    try {
      stores.missionPanes.moveOrchestratorPane(mission.id, operatorResume.id, spawned.paneId);
    } catch (error) {
      // O runtime já nasceu e tem autoridade própria. Uma falha no vínculo
      // histórico não pode deixá-lo sem watcher nem re-entrega de handoffs.
      console.warn('[fast-lane] vínculo do pane retomado não foi atualizado:', error);
    }
  }

  stopWatcher(scope, mission.id);
  orchPanes.set(mission.id, {
    paneId: spawned.paneId,
    sessionId: spawned.sessionId,
    adapterId: spawned.adapterId,
    cwd: missionExecutionScope(scope, live).rootRealPath,
    title: orchestrator.agentName,
    agentName: orchestrator.agentName,
  });
  console.info(
    `[fast-lane] orquestrador respawnado para ${mission.id} ` +
      `(session=${spawned.sessionId})`,
  );
  startWatcher(scope, mission.id, spawned.sessionId);
  void maybeRedispatchFastLaneFirstWave(scope, live, {
    focusedLiveMission: true,
  }).catch((error) => {
    console.warn(
      '[fast-lane] first-wave after orchestrator respawn falhou:',
      error instanceof Error ? error.message : error,
    );
  });
  // Onda 1 (A3, campanha 0.50): a sessão anterior pode ter morrido com
  // entregas aceitas-não-consumidas (quit na janela do ack). O Maestro novo
  // precisa RECEBER os handoffs pendentes pela lane de entrega — a sugestão
  // "consulte nexus_handoff_list" do kickoff é prompt, não mecanismo.
  const redelivered = redeliverPendingHandoffs(scope, mission.id);
  trace({
    kind: 'orchestrator-respawned',
    missionId: mission.id,
    sessionId: spawned.sessionId,
    redeliveredHandoffs: redelivered,
  });
  if (redelivered > 0) {
    console.info(
      `[fast-lane] ${redelivered} handoff(s) pendente(s) re-entregue(s) ao ` +
        `orquestrador respawnado (mission=${mission.id})`,
    );
  }
}

// Each mission owns its dispatch budget. Selecting or starting another mission
// must never revoke it or close its PTYs.
const firstWaveInFlight = new Set<string>();

function listMissionLiveSessionIds(missionId: string): readonly string[] {
  const sessionIds = new Set<string>();
  for (const snapshot of listPaneSnapshots()) {
    if (snapshot.missionId === missionId && snapshot.sessionId) {
      sessionIds.add(snapshot.sessionId);
    }
  }
  const orch = orchPanes.get(missionId);
  if (orch?.sessionId) sessionIds.add(orch.sessionId);
  try {
    for (const session of listAgentSessions()) {
      if (session.missionId === missionId) sessionIds.add(session.sessionId);
    }
  } catch {
    // Testes sem inventário PTY completo.
  }
  return [...sessionIds];
}

async function releaseMissionLiveRuntime(
  scope: ProjectExecutionScope,
  missionId: string,
): Promise<void> {
  stopWatcher(scope, missionId);
  firstWaveInFlight.delete(missionId);
  const sessionIds = listMissionLiveSessionIds(missionId);
  orchPanes.delete(missionId);
  for (const sessionId of sessionIds) {
    try {
      await orchTerminateSession(sessionId);
    } catch (error) {
      console.warn(
        `[fast-lane] unfocus não terminou ${sessionId} (${missionId}):`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/**
 * Ressurreição de boot: preserva todas as missões com Maestro vivo neste
 * processo. Rows leftover `running` no disco NÃO remontam PTY — persistem
 * isolamento e ficam card na rail (restart restaura o card, não a equipe). */
export function shouldResurrectPersistedRunningMission(input: {
  readonly updatedAt: number;
  readonly processStartedAt?: number;
  readonly operatorClosed: boolean;
  readonly orchestratorLive: boolean;
  /** Rail-selected / civilian-focused mission — resume even if leftover. */
  readonly focusedLiveMission?: boolean;
}): boolean {
  if (input.operatorClosed) return false;
  if (input.orchestratorLive) return true;
  if (input.focusedLiveMission === true) return true;
  return !wasUpdatedBeforeThisProcess(
    input.updatedAt,
    input.processStartedAt,
  );
}

export async function resurrectRunningMissionsForScope(
  scope: ProjectExecutionScope,
): Promise<void> {
  const stores = getProjectDomainStores(scope);
  let running: readonly Mission[];
  try {
    running = stores.missions.list('running');
  } catch {
    return;
  }
  const liveById = thisProcessLiveMaestroByMissionId(
    running.map((mission) => mission.id),
  );
  const focused = pickFocusedRunningMission(running, liveById);
  for (const mission of running) {
    if (wasMissionRuntimeClosedByOperator(mission)) continue;
    const liveMaestroSessionId = liveById.get(mission.id) ?? null;
    const freshKickoff = isThisProcessFreshKickoff(
      stores,
      mission,
      liveMaestroSessionId,
    );
    const ageMs = Date.now() - (mission.createdAt ?? mission.updatedAt ?? 0);
    const sealedCount = stores.tasks.list(mission.id).length;
    const paneCount = listPaneSnapshots().filter(
      (pane) => pane.missionId === mission.id,
    ).length;
    const isNewIniciar =
      ageMs < 1000 ||
      freshKickoff ||
      (sealedCount >= 20 &&
        paneCount === 0 &&
        !wasUpdatedBeforeThisProcess(mission.updatedAt));
    if (
      shouldSkipLeftoverRemount({
        mission,
        liveMaestroSessionId,
        remountKind: 'automatic',
        isFreshKickoff: freshKickoff || isNewIniciar,
        isLeftover:
          !isNewIniciar && (!focused || mission.id !== focused.id),
      })
    ) {
      persistLeftoverIsolation(
        stores.missions,
        mission.id,
        focused && mission.id !== focused.id ? 'unfocus' : 'leftover',
      );
      await releaseMissionLiveRuntime(scope, mission.id);
      continue;
    }
    try {
      await resumeFastLaneMission(scope, mission.id, {
        remountKind: 'automatic',
      });
    } catch (error) {
      console.warn(
        `[fast-lane] ressurreição de ${mission.id} falhou (missão permanece running):`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────

/**
 * Bootstrap da Via Rápida: transiciona a missão para running, abre um pane
 * para o ORQUESTRADOR com o briefing completo da missão e liga o observador.
 *
 * O orquestrador recebe o roster de workers e as instruções para coordenar
 * via MCP tools (nexus_pane_spawn, nexus_handoff_list). Os workers são
 * spawnados SOB DEMANDA pelo orquestrador.
 */
/**
 * Resultado da tentativa de adoção. `adopted` é o caminho feliz; qualquer outra
 * coisa devolve o motivo e a Via Rápida segue para o spawn normal — a missão
 * SEMPRE arranca, com o painel do operador ou com um Maestro próprio.
 */
type OrchestratorAdoptionOutcome =
  | {
      readonly adopted: true;
      readonly sessionId: string;
      readonly paneId: string;
      /**
       * A adoção VALEU (autoridade concedida, store apontando para a sessão)
       * mas o briefing não chegou. Isto NUNCA vira spawn: depois da concessão o
       * pane já é o orquestrador registrado e subir outro deixaria DOIS
       * Maestros vivos na mesma missão — o pane adotado tem sessão viva, então
       * a aposentadoria de cadáveres não o remove. O desfecho correto é o mesmo
       * do caminho spawnado quando o briefing falha: bloqueio técnico com a
       * causa escrita, com o pane preservado para o operador cutucar.
       */
      readonly briefingError?: string;
    }
  | { readonly adopted: false; readonly refusal: OrchestratorAdoptionRefusal };

/**
 * Faz o painel VIVO do operador virar o Maestro desta missão.
 *
 * A ordem importa e é toda a razão desta função existir:
 *  1. a missão já transicionou para running/executing (só aí ela tem autoridade
 *     de despacho — sem isso a concessão é recusada);
 *  2. concede-se autoridade de missão à sessão viva (quem faz isso é quem tem o
 *     WebContents dono do pane; aqui só perguntamos);
 *  3. confirma-se no store que a missão passou a apontar para ESSA sessão;
 *  4. o briefing é COLADO no pane que já está rodando — não existe argv para um
 *     processo que já subiu;
 *  5. recibo de kickoff e watcher, iguais aos do caminho spawnado.
 *
 * Nada disso mata o pane. É exatamente o oposto do respawn, que termina
 * fisicamente o orquestrador registrado antes de subir o seu.
 */
async function adoptOrchestratorPane(
  scope: ProjectExecutionScope,
  mission: Mission,
  briefPrompt: string,
): Promise<OrchestratorAdoptionOutcome> {
  const reservation = takeOrchestratorAdoption(mission.id);
  const adapter = reservation ? getAdapter(reservation.adapterId) : null;
  const decision = decideOrchestratorAdoption({
    reservation,
    now: Date.now(),
    sessionIsLive: reservation
      ? classifySessionLiveness(getSessionState(reservation.sessionId)) === 'live'
      : false,
    adapterCanOrchestrate: Boolean(
      adapter && adapter.kind === 'cli-pty' && canUseNexusMcp(adapter),
    ),
  });
  if (decision.kind === 'spawn') {
    return { adopted: false, refusal: decision.refusal };
  }

  const adopted = decision.reservation;
  let granted = false;
  try {
    granted = await adopted.grantAuthority();
  } catch (error) {
    console.warn(
      '[fast-lane] concessão de autoridade na adoção falhou:',
      error instanceof Error ? error.message : error,
    );
    granted = false;
  }
  const stores = getProjectDomainStores(scope);
  // Prova, não promessa: o store tem que apontar para a sessão adotada. Se a
  // concessão disse ok mas o vínculo não mudou, isto NÃO é uma adoção.
  const bound =
    stores.missions.get(mission.id)?.orchestratorSessionId ?? null;
  if (!granted || bound !== adopted.sessionId) {
    return { adopted: false, refusal: 'authority-refused' };
  }

  const live = stores.missions.get(mission.id) ?? mission;
  // Adotado vira pane de missão: o canal do "+ Pane" deixa de valer para ele.
  const initialPrompt = withProjectContextBlocks({
    prompt: briefPrompt,
    scope,
    executionScope: missionExecutionScope(scope, live),
    missionId: live.id,
    role: 'orchestrator',
  })!;
  rememberKickoffBrief({
    missionId: live.id,
    orchestratorSessionId: adopted.sessionId,
    intentVersion: live.intentVersion ?? 0,
    promptHash: kickoffPromptHash(initialPrompt),
  });

  // DAQUI PARA BAIXO a adoção é irreversível: a autoridade já foi concedida e o
  // store já aponta para esta sessão. Toda falha vira `briefingError`, nunca
  // recusa — voltar para o spawn agora criaria o segundo Maestro.
  const settled: OrchestratorAdoptionOutcome = {
    adopted: true,
    sessionId: adopted.sessionId,
    paneId: adopted.paneId,
  };
  try {
    // Pane já rodando: o canal é sempre colagem. Esperar idle evita colar por
    // cima de um turno em andamento do próprio operador.
    const boot =
      getSessionState(adopted.sessionId) === 'idle'
        ? 'idle'
        : await waitForIdle(adopted.sessionId, ORCHESTRATOR_BOOT_TIMEOUT_MS);
    if (boot === 'exited') {
      return { ...settled, briefingError: 'o painel saiu antes do briefing' };
    }
    const accepted = await deliverAgentPrompt(
      adopted.sessionId,
      initialPrompt,
      undefined,
      { adapterId: adopted.adapterId },
    );
    if (!accepted) {
      return {
        ...settled,
        briefingError: 'o painel não aceitou o briefing',
      };
    }
  } catch (error) {
    return {
      ...settled,
      briefingError:
        error instanceof Error ? error.message : String(error),
    };
  }
  tryAcceptIdleOrchestratorKickoff(stores, live, adopted.sessionId, initialPrompt);
  if (!stores.missions.hasCurrentKickoffAcceptance(live.id)) {
    try {
      stores.missions.recordKickoffAcceptance({
        missionId: live.id,
        intentVersion: live.intentVersion ?? 0,
        orchestratorSessionId: adopted.sessionId,
        promptHash: kickoffPromptHash(initialPrompt),
      });
    } catch (error) {
      console.warn(
        '[fast-lane] recibo de kickoff da adoção não gravou:',
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { adopted: true, sessionId: adopted.sessionId, paneId: adopted.paneId };
}

export async function fastLaneBootstrap(
  scope: ProjectExecutionScope,
  missionId: string,
  options?: { readonly waitForFirstPane?: boolean },
): Promise<void> {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission) throw new Error('missão não encontrada para a Via Rápida');

  const key = watcherKey(scope, missionId);
  if (watchers.has(key)) {
    // Watcher already up (Maestro remounted). Iniciar / religado must still
    // self-walk if writers are gone — otherwise the civilian sees 1 pane.
    void maybeRedispatchFastLaneFirstWave(scope, mission, {
      focusedLiveMission: true,
    }).catch((error) => {
      console.warn(
        '[fast-lane] first-wave on remount/Iniciar falhou:',
        error instanceof Error ? error.message : error,
      );
    });
    return;
  }

  if (mission.status === 'running') {
    // Já está rodando: orquestrador vivo → watcher; morto → respawn. O
    // retorno silencioso antigo deixava missões zumbis pós-restart.
    const action = decideFastLaneResumeAction({
      status: mission.status,
      liveOrchestratorSession: liveOrchestratorSessionId(missionId) !== null,
    });
    if (action === 'watch') {
      const sessionId = liveOrchestratorSessionId(missionId);
      if (sessionId) startWatcher(scope, missionId, sessionId);
      void maybeRedispatchFastLaneFirstWave(scope, mission, {
        focusedLiveMission: true,
      }).catch((error) => {
        console.warn(
          '[fast-lane] first-wave on resume/watch falhou:',
          error instanceof Error ? error.message : error,
        );
      });
      return;
    }
    if (action === 'respawn') {
      await respawnFastLaneOrchestrator(scope, mission);
      return;
    }
    return;
  }

  if (
    mission.status !== 'pending' ||
    mission.intentState !== 'ready_to_start'
  ) {
    throw new Error(
      `Via Rápida exige missão pending/ready_to_start (atual: ${mission.status}/${mission.intentState ?? '—'})`,
    );
  }

  const squad = resolveFastLaneSquad(mission.squadId);
  const roster = orderedRoster(squad?.agents ?? []);
  if (roster.length === 0) {
    throw new Error('a missão não tem equipe salva para abrir terminais');
  }

  // Spawna APENAS o orquestrador. Workers são spawnados sob demanda por ele.
  const orchestrator = roster.find((a) => a.category === 'orchestrator');
  if (!orchestrator) {
    throw new Error('o squad não tem um orquestrador definido');
  }
  // Fail-closed ANTES de marcar running — senão AGY/aider viram "running"
  // eterno sem MCP.
  assertFastLaneMaestroMcp(orchestrator.cli);

  // Auth pre-gate: CLI sem credencial não sobe como fake-run.
  try {
    await assertPreSpawnProbe(orchestrator.cli, {
      model: orchestrator.model || undefined,
      failClosed: true,
    });
  } catch (error) {
    const hint =
      error instanceof PreSpawnProbeError
        ? error.hint
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(
      `Maestro \`${orchestrator.cli}\` não está autenticado para missões: ${hint}`,
    );
  }

  let live = mission;
  {
    const dispatched = stores.missions.transitionLifecycle(
      missionId,
      { updatedAt: mission.updatedAt, intentVersion: mission.intentVersion ?? 0 },
      { status: 'running', intentState: 'dispatched' },
    );
    if (!dispatched) {
      throw new Error('a missão mudou durante o início — tente de novo');
    }

    const executing = stores.missions.transitionLifecycle(
      missionId,
      {
        updatedAt: dispatched.updatedAt,
        intentVersion: dispatched.intentVersion ?? 0,
      },
      { status: 'running', intentState: 'executing' },
    );
    live = executing ?? dispatched;
  }

  const teamNames = roster.map((agent) => agent.agentName);
  const designContext = missionDesignContext(
    missionExecutionScope(scope, live).rootRealPath,
    undefined,
    mission.description ?? '',
  );
  const sealedPlanTitles = sealFastLanePlanTitles(stores, live, squad);

  const prompt = agentPrompt(
    orchestrator,
    live,
    teamNames,
    false,
    designContext,
    squad,
    sealedPlanTitles,
  );

  const finishFirstPane = async (): Promise<void> => {
    const wave = dispatchFastLaneFirstWave(scope, missionId);
    // Adoção primeiro: se o operador indicou um painel para liderar, ele vira o
    // Maestro e nenhum pane novo nasce. Recusa não derruba a missão — ela cai
    // no arranque normal com o aviso registrado.
    const adoption = await adoptOrchestratorPane(scope, live, prompt);
    if (adoption.adopted) {
      orchPanes.set(missionId, {
        paneId: adoption.paneId,
        sessionId: adoption.sessionId,
        adapterId:
          getAgentSessionInfo(adoption.sessionId)?.adapterId ?? orchestrator.cli,
        cwd: missionExecutionScope(scope, live).rootRealPath,
        title: orchestrator.agentName,
        agentName: orchestrator.agentName,
      });
      // Briefing não entregue num pane JÁ adotado: mesmo desfecho do caminho
      // spawnado — bloqueio técnico com a causa, pane preservado. O que não
      // pode acontecer é a missão ficar running sem ninguém e sem explicação.
      if (adoption.briefingError) {
        const current = stores.missions.get(missionId);
        if (current && current.status === 'running' && current.intentState) {
          missionEngineForScope(scope).blockTechnical(scope, {
            missionId,
            expectedStatus: current.status,
            expectedIntentState: current.intentState,
            expectedUpdatedAt: current.updatedAt,
            expectedIntentVersion: current.intentVersion ?? 0,
            description: `Briefing não chegou ao painel adotado: ${adoption.briefingError}`,
          });
        }
        throw new Error(
          `briefing não chegou ao painel adotado: ${adoption.briefingError}`,
        );
      }
      if (stores.missions.get(missionId)?.status !== 'running') {
        await releaseMissionLiveRuntime(scope, missionId);
        return;
      }
      startWatcher(scope, missionId, adoption.sessionId);
      void wave.catch((error) => {
        console.warn(
          '[fast-lane] first-wave após adoção falhou:',
          error instanceof Error ? error.message : error,
        );
      });
      return;
    }
    if (adoption.refusal !== 'no-reservation') {
      console.warn(
        `[fast-lane] adoção recusada (${adoption.refusal}) para ${missionId}: ` +
          orchestratorAdoptionRefusalMessage(adoption.refusal),
      );
      emitMissionEvent(scope, {
        missionId,
        runId: `bootstrap:${missionId}`,
        type: 'custom',
        origin: 'system',
        payload: {
          kind: 'orchestrator-adoption-refused',
          refusal: adoption.refusal,
          detail: orchestratorAdoptionRefusalMessage(adoption.refusal),
        },
        idempotencyKey: `adoption-refused:${missionId}`,
        occurredAt: Date.now(),
      });
    }
    const spawned = await spawnAgentPane(scope, live, orchestrator, prompt);
    if ('error' in spawned) {
      const current = stores.missions.get(missionId);
      if (current && current.status === 'running' && current.intentState) {
        missionEngineForScope(scope).blockTechnical(scope, {
          missionId,
          expectedStatus: current.status,
          expectedIntentState: current.intentState,
          expectedUpdatedAt: current.updatedAt,
          expectedIntentVersion: current.intentVersion ?? 0,
          description: `Orquestrador não abriu: ${spawned.error}`,
        });
      }
      throw new Error(`orquestrador não abriu: ${spawned.error}`);
    }

    orchPanes.set(missionId, {
      paneId: spawned.paneId,
      sessionId: spawned.sessionId,
      adapterId: spawned.adapterId,
      cwd: missionExecutionScope(scope, live).rootRealPath,
      title: orchestrator.agentName,
      agentName: orchestrator.agentName,
    });

    if (stores.missions.get(missionId)?.status !== 'running') {
      await releaseMissionLiveRuntime(scope, missionId);
      return;
    }

    startWatcher(scope, missionId, spawned.sessionId);
    void wave.then((n) => {
      if (n > 0) {
        console.info(
          `[fast-lane] first-wave auto-dispatch ${n} writers for ${sealedPlanTitles.length} sealed stories`,
        );
      }
    }).catch((error) => {
      console.warn(
        '[fast-lane] first-wave auto-dispatch falhou:',
        error instanceof Error ? error.message : error,
      );
    });
  };

  // Via Rápida start IPC must return once the mission is running (rail
  // item exists). Waiting for Maestro boot/idle can hang 60s+ and leaves
  // the civilian on "Iniciando…" with the dialog stuck open.
  if (options?.waitForFirstPane === false) {
    void finishFirstPane().catch((error) => {
      console.warn(
        '[fast-lane] first pane after start (mission already running):',
        error instanceof Error ? error.message : error,
      );
    });
    return;
  }

  await finishFirstPane();
}


export async function maybeRedispatchFastLaneFirstWave(
  scope: ProjectExecutionScope,
  mission: Mission,
  _opts?: { readonly focusedLiveMission?: boolean },
): Promise<number> {
  return dispatchFastLaneFirstWave(scope, mission.id);
}

/**
 * First-wave no mesmo turno do Maestro. Só CLI AuthReadiness=present
 * ganha assento; LongCat sem chave é skip silencioso (sem toast).
 */
export async function dispatchFastLaneFirstWave(
  scope: ProjectExecutionScope,
  missionId: string,
): Promise<number> {
  if (firstWaveInFlight.has(missionId)) return 0;
  firstWaveInFlight.add(missionId);
  try {
    const stores = getProjectDomainStores(scope);
    const mission = stores.missions.get(missionId);
    if (!mission || mission.status !== 'running') return 0;
    if (!missionCanDispatchWorkers(mission)) return 0;
    // "Pedir um ajuste": a missão reabriu para o operador DESCREVER o ajuste.
    // Disparar a first-wave aqui seria mandar prompt e sair rodando sozinho
    // antes de saber o quê — o Maestro religa digitável e espera no chat.
    if (missionAwaitsAdjustment(mission)) return 0;
    const squad = mission.squadId ? getSquad(mission.squadId) : null;
    if (!squad) return 0;
    const sealedTasks = stores.tasks.list(missionId);
    const pendingTitles = sealedTasks
      .filter(
        (task) => task.status === 'pending' || task.status === 'running',
      )
      .map((task) => task.title);
    const allTitles =
      pendingTitles.length > 0
        ? pendingTitles
        : sealFastLanePlanTitles(stores, mission, squad);
    const liveWorkers = countLiveFirstWaveWriters(
      listPaneSnapshots(),
      missionId,
      writerIsConnectedAndWritable,
    );
    const blockedAdapterIds = [
      ...new Set(
        squad.agents
          .map((agent) => agent.cli)
          .filter((cli) => writerCliIsCircuitDead(missionId, cli)),
      ),
    ];
    const orchestratorCli =
      squad.agents.find((agent) => agent.category === 'orchestrator')?.cli ??
      '';
    const extraPresentClis = [
      ...new Set([
        ...FIRST_WAVE_OFFER_CLIS,
        ...listProviderSettings().map((provider) => provider.adapterId),
      ]),
    ].filter((cli) => cli !== 'shell');
    await warmSquadRuntimeSubscriptionAuth([
      ...squad.agents.map((agent) => agent.cli),
      ...extraPresentClis,
    ]);
    const classifySeat = (agent: SquadAgent) => {
      const readiness = detectSubscriptionAuthReadiness(agent.cli);
      return classifySeatAuth({
        adapterId: agent.cli,
        authStrategy: String(providerAuthStrategy(agent.cli) ?? ''),
        hasKey: hasRuntimeKey(agent.cli),
        kimiListReadiness: agent.cli === 'kimi' ? readiness : undefined,
        hasCredentiallessModel: readiness === 'present',
      });
    };
    const routingHints = getMissionRoutingHints(mission.intentContract);
    const missionIsMeta =
      routingHints.paneQuestion !== null || isPaneMetaTask(mission.description ?? '') ||
      isPaneMetaTask(mission.title ?? '') ||
      allTitles.some((storyTitle) => isPaneMetaTask(storyTitle));
    if (missionIsMeta) {
      const seatedKeys = listPaneSnapshots()
        .filter((pane) => pane.missionId === missionId && pane.role === 'worker')
        .flatMap((pane) =>
          [pane.agentName, pane.title].filter(
            (key): key is string => typeof key === 'string' && key.length > 0,
          ),
        );
      const question = routingHints.paneQuestion ?? extractMetaPaneQuestion(
        mission.description || mission.title || allTitles[0] || '',
      );
      const wave = planMetaPaneAskSeats({
        agents: squad.agents,
        classifySeat,
        blockedAdapterIds,
        seatedKeys,
      });
      if (blockedAdapterIds.length > 0) {
        console.warn(
          `[fast-lane] writer_circuit_break first-wave pulou CLI: ${blockedAdapterIds.join(', ')}`,
        );
      }
      if (wave.skippedNoCredential.length > 0) {
        console.info(
          `[fast-lane] first-wave pulou CLI sem auth present: ${wave.skippedNoCredential.join(', ')}`,
        );
      }
      for (const seat of wave.seats) {
        const current = stores.missions.get(missionId);
        if (!current || current.status !== 'running') {
          break;
        }
        const result = await spawnWriterWithCircuit(
          scope,
          mission,
          seat.agent,
          metaPaneAskPrompt({
            agentName: seat.agent.agentName,
            question,
          }),
          seat.title,
          { readOnly: true },
        );
        if ('error' in result) {
          console.warn(
            `[fast-lane] first-wave ${seat.title} não abriu:`,
            result.error,
          );
        }
      }
      const spawned = countLiveFirstWaveWriters(
        listPaneSnapshots(),
        missionId,
        writerIsConnectedAndWritable,
      );
      if (spawned > 0) {
        trace({
          kind: 'fast-lane-first-wave',
          missionId,
          spawned,
          target: wave.targetSeats,
        });
        console.info(
          `[fast-lane] first-wave pergunta abriu ${spawned} pane(s) ` +
            `read-only no mesmo turno do Maestro (${missionId})`,
        );
      }
      return spawned;
    }
    const titles = allTitles.filter((title) => !isPaneMetaTask(title));
    if (titles.length === 0) return 0;
    const wave = planFirstWaveSeats({
      storyCount: titles.length,
      storyTitles: titles,
      agents: squad.agents,
      liveWritableWorkers: liveWorkers,
      blockedAdapterIds,
      extraPresentClis,
      orchestratorCli,
      classifySeat,
    });
    if (blockedAdapterIds.length > 0) {
      console.warn(
        `[fast-lane] writer_circuit_break first-wave pulou CLI: ${blockedAdapterIds.join(', ')}`,
      );
    }
    if (wave.skippedNoCredential.length > 0) {
      console.info(
        `[fast-lane] first-wave pulou CLI sem auth present: ${wave.skippedNoCredential.join(', ')}`,
      );
    }
    for (const seat of wave.seats) {
      const current = stores.missions.get(missionId);
      if (!current || current.status !== 'running') {
        break;
      }
      const prompt = [firstWaveWorkerPrompt({
        mission,
        agentName: seat.agent.agentName,
        storyTitle: seat.storyTitle,
        storyIndex: seat.seatIndex,
        storyTotal: titles.length,
      }), missionRoutingSkillNote(mission, seat.agent)].filter(Boolean).join('\n');
      const result = await spawnWriterWithCircuit(
        scope,
        mission,
        seat.agent,
        prompt,
        seat.title,
      );
      if ('error' in result) {
        console.warn(
          `[fast-lane] first-wave ${seat.title} não abriu:`,
          result.error,
        );
      }
    }
    const spawned = countLiveFirstWaveWriters(
      listPaneSnapshots(),
      missionId,
      writerIsConnectedAndWritable,
    );
    if (spawned > 0) {
      trace({
        kind: 'fast-lane-first-wave',
        missionId,
        spawned,
        target: wave.targetSeats,
      });
      console.info(
        `[fast-lane] first-wave despachou ${spawned} writer(s) no mesmo turno do Maestro (${missionId})`,
      );
    }
    return spawned;
  } catch (error) {
    console.warn(
      '[fast-lane] first-wave falhou; Maestro segue:',
      error instanceof Error ? error.message : error,
    );
    return 0;
  } finally {
    firstWaveInFlight.delete(missionId);
  }
}

// ── Resume ───────────────────────────────────────────────────────────────

export async function resumeFastLaneMission(
  scope: ProjectExecutionScope,
  missionId: string,
  options: {
    readonly remountKind?: LeftoverRemountKind;
    readonly note?: string;
  } = {},
): Promise<void> {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission) throw new Error('missão não encontrada para retomar');

  const remountKind = options.remountKind ?? 'operator';
  if (
    !mayResumeAfterOperatorDismiss({
      remountKind,
      operatorDismissedOrchestrator:
        wasOrchestratorOperatorDismissed(missionId),
    })
  ) {
    return;
  }
  if (remountKind === 'operator') {
    clearOperatorDismissedPanes(missionId);
    respawnBudgets.delete(watcherKey(scope, missionId));
  }
  const liveMaestroSessionId = liveOrchestratorSessionId(missionId);
  const freshKickoff = isThisProcessFreshKickoff(
    stores,
    mission,
    liveMaestroSessionId,
  );
  if (
    shouldSkipLeftoverRemount({
      mission,
      liveMaestroSessionId,
      remountKind,
      isFreshKickoff: freshKickoff,
    })
  ) {
    persistLeftoverIsolation(stores.missions, mission.id, 'leftover');
    return;
  }

  const action = decideFastLaneResumeAction({
    status: mission.status,
    liveOrchestratorSession: liveMaestroSessionId !== null,
  });
  if (action === 'watch') {
    if (liveMaestroSessionId) startWatcher(scope, missionId, liveMaestroSessionId);
    return;
  }
  if (action === 'respawn') {
    await respawnFastLaneOrchestrator(scope, mission, {
      note: options.note,
    });
    return;
  }

  // Se bloqueada, tenta re-assumir E spawna novo orquestrador.
  // resumeTechnical só muda o status — não abre panes. O selo de encerramento
  // pelo operador sai JUNTO: ele é prova de "Encerrada pelo operador" em
  // qualquer missão blocked, então sobreviver a uma reabertura mentiria no
  // próximo bloqueio (mission-recovery-policy Bug I).
  //
  // Bloqueio de USUÁRIO com pergunta pendente NUNCA é re-armado aqui: a única
  // saída autorizada é answer-question. Retomar/retry-kickoff que chegasse
  // nesse estado limparia a pergunta sem resposta (bug de campo 2026-08-18).
  // Leftover parked é isolamento de rail, não pergunta — Retomar religa.
  if (mission.status === 'blocked' && mission.intentState) {
    const runtimeClosedByOperator = wasMissionRuntimeClosedByOperator(mission);
    const leftoverParked = wasMissionLeftoverParked(mission);
    if (
      mission.intentState === 'blocked_user' &&
      !runtimeClosedByOperator &&
      !leftoverParked
    ) {
      throw new Error(
        'missão bloqueada por pergunta do operador exige resposta ' +
          '(answer-question) antes de retomar',
      );
    }
    const sealedMarker = leftoverParked
      ? NEXUS_LEFTOVER_PARKED_MARKER
      : MISSION_RUNTIME_CLOSED_MARKER;
    try {
      missionEngineForScope(scope).resumeTechnical(scope, {
        missionId,
        expectedStatus: mission.status,
        expectedIntentState: mission.intentState ?? 'executing',
        expectedUpdatedAt: mission.updatedAt,
        expectedIntentVersion: mission.intentVersion ?? 0,
        description:
          stripMissionVerdictParagraph(
            mission.description ?? '',
            sealedMarker,
          ) || 'Missão reaberta pelo operador.',
      });
    } catch (error) {
      console.warn(
        '[fast-lane] resumeTechnical falhou:',
        error instanceof Error ? error.message : error,
      );
      // Falhou o resumeTechnical, mas o bootstrap ainda pode funcionar
      // se a missão já estiver em running.
    }
    await fastLaneBootstrap(scope, missionId);
    return;
  }

  // Outros estados: re-spawna do zero.
  await fastLaneBootstrap(scope, missionId);
}

// ── UI helpers ───────────────────────────────────────────────────────────

export interface FastLaneOrchestratorPaneSummary {
  readonly paneId: string;
  readonly sessionId: string;
  readonly adapterId: string;
  readonly cwd: string;
  readonly title: string;
  readonly agentName: string;
  readonly role: 'orchestrator';
}

function paneSummaryFromLocalState(missionId: string): FastLaneOrchestratorPaneSummary | null {
  const entry = orchPanes.get(missionId);
  if (!entry) {
    // Fallback: procura nos snapshots vivos.
    const snapshot = listPaneSnapshots().find(
      (p) => p.missionId === missionId && p.role === 'orchestrator',
    );
    if (!snapshot?.paneId || !snapshot?.sessionId) return null;
    return {
      paneId: snapshot.paneId,
      sessionId: snapshot.sessionId,
      adapterId: snapshot.adapterId ?? 'claude',
      cwd: '',
      title: snapshot.title ?? 'Orquestrador',
      agentName: snapshot.agentName ?? 'Orquestrador',
      role: 'orchestrator',
    };
  }
  return {
    paneId: entry.paneId,
    sessionId: entry.sessionId,
    adapterId: entry.adapterId,
    cwd: entry.cwd,
    title: entry.title,
    agentName: entry.agentName,
    role: 'orchestrator',
  };
}

/**
 * Acessor CRU de B (claim do adaptador de liderança). NUNCA chama o
 * resolver: `mission-leadership-runtime.ts` consome esta função como parte
 * da própria observação de `resolveMissionLeader` — religar aqui causaria
 * recursão infinita entre o motor e o adaptador. Leitores novos devem
 * preferir `resolveFastLaneOrchestratorPaneSummary`.
 */
export function fastLaneOrchestratorPaneSummary(
  _scope: ProjectExecutionScope,
  missionId: string,
): FastLaneOrchestratorPaneSummary | null {
  return paneSummaryFromLocalState(missionId);
}

/**
 * Leitor público do orquestrador da missão: resolve o par (sessionId,paneId)
 * provado por `resolveMissionLeader` antes de projetar metadados de UI.
 * `source:'live'` sozinho não é prova — só `proven:true` conta. Split-brain
 * nunca é engolido: o código do erro volta em `errorCode`, nunca vira `null`
 * silencioso nem escolhe um pane por ordem de array.
 */
export function resolveFastLaneOrchestratorPaneSummary(
  scope: ProjectExecutionScope,
  missionId: string,
): FastLaneOrchestratorPaneSummary | { readonly errorCode: MissionLeadershipErrorCode } | null {
  let leader: MissionLeader | null;
  try {
    leader = getMissionLeadership().resolveMissionLeader(scope, missionId);
  } catch (error) {
    if (error instanceof MissionLeadershipError) return { errorCode: error.code };
    throw error;
  }
  if (!leader?.proven || !leader.paneId) return null;
  const local = paneSummaryFromLocalState(missionId);
  if (local && local.sessionId === leader.sessionId && local.paneId === leader.paneId) {
    return local;
  }
  const snapshot = listPaneSnapshots().find(
    (p) => p.sessionId === leader.sessionId && p.paneId === leader.paneId,
  );
  if (!snapshot) return null;
  return {
    paneId: leader.paneId,
    sessionId: leader.sessionId,
    adapterId: snapshot.adapterId ?? 'claude',
    cwd: '',
    title: snapshot.title ?? 'Orquestrador',
    agentName: snapshot.agentName ?? 'Orquestrador',
    role: 'orchestrator',
  };
}
