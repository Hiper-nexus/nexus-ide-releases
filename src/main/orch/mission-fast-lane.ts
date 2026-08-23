import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import type { Mission, Squad, SquadAgent } from '../../shared/orch-types';
import { isUiMissionText } from '../../shared/mission-work-kind';
import {
  MISSION_RUNTIME_CLOSED_MARKER,
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
  getSessionCwd,
  isPtySessionConnectedAndWritable,
  orchTerminateSession,
  registeredOrchestratorSessionsForMission,
} from '../pty/pty-manager';
import { getAdapter } from '../adapters/adapter-registry';
import { deliverAgentPrompt, proveNativeArgvBriefAccepted } from './tool-util';
import { canUseNexusMcp } from './cli-mcp-inject';
import {
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
} from './project-domain-store-registry';
import { getSquad } from './squad-store';
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
import { listPaneSnapshots, requestPaneSpawn, waitForIdle, readSessionOutput } from './pane-registry';
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
  planFirstWaveSeats,
} from './via-rapida-first-wave';
import { firstWaveWorkerPrompt } from './via-rapida-walk';
import { maybeApplyCivilianPronto } from './civilian-pronto';

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
        'escolha claude/codex/opencode/kimi/grok (ou família Claude).',
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
  spawn: { paneId: string; sessionId: string; title?: string },
): void {
  const title = spawn.title?.trim() || agent.agentName;
  stores.missionPanes.record({
    missionId: mission.id,
    paneId: spawn.paneId,
    adapterId: agent.cli,
    model: agent.model || undefined,
    effort: agent.effort || undefined,
    cwd: scope.rootRealPath,
    title,
    agentName: agent.agentName,
    role,
    allowedTools: agent.allowedTools ? [...agent.allowedTools] : null,
    allowedSkills: agent.allowedSkills ? [...agent.allowedSkills] : null,
    readOnly: false,
    executionScope: scope,
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
 * Doutrina Overclock: quando todos os panes morreram e a missão segue
 * running, o watcher NUNCA bloqueia nem completa sozinho. Com orçamento,
 * respawna o orquestrador (que consome handoffs pendentes e decide o fim);
 * sem orçamento, mantém a missão viva e observando — só o operador para.
 */
export function decideFastLaneEmptyPaneAction(input: {
  readonly status: Mission['status'];
  readonly pendingHandoffs: number;
  readonly respawnBudgetLeft: number;
}): 'respawn-orchestrator' | 'keep-running-watching' {
  if (input.status !== 'running') return 'keep-running-watching';
  return input.respawnBudgetLeft > 0
    ? 'respawn-orchestrator'
    : 'keep-running-watching';
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
 * SessionId do orquestrador desta missão SE existir um processo físico vivo
 * (sessão em spawning/busy/idle). Snapshots sem sessão viva, ids persistidos
 * pré-restart e cadáveres devolvem null.
 */
function liveOrchestratorSessionId(
  missionId: string,
  fallbackSessionId?: string,
): string | null {
  const snapshot = listPaneSnapshots().find(
    (pane) =>
      pane.missionId === missionId &&
      (pane.role === 'orchestrator' ||
        pane.agentName?.toLowerCase().includes('orquestrador')),
  );
  const sessionId = snapshot?.sessionId ?? fallbackSessionId;
  if (!sessionId) return null;
  // Verdade única de liveness (session-liveness): só 'live' conta como vivo.
  return classifySessionLiveness(getSessionState(sessionId)) === 'live'
    ? sessionId
    : null;
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
): string {
  try {
    const parts: string[] = [];
    if (existsSync(join(workspaceRoot, 'DESIGN.md'))) {
      parts.push(
        'O projeto tem DESIGN.md na raiz — ele é a autoridade de estilo: leia antes de qualquer tela.',
      );
    }
    const catalogRoot = join(home, '.design-references');
    if (existsSync(catalogRoot)) {
      parts.push(
        `Catálogo de referências de design do operador: ${catalogRoot} ` +
          '(índice em README.md; um .md por marca/estilo). Consulte o que ' +
          'combinar com o pedido e siga os tokens/composição de lá.',
      );
    }
    return parts.join(' ');
  } catch {
    return '';
  }
}

// ── Construção de prompt ────────────────────────────────────────────────

/**
 * Prompt do kickoff. Maestro: briefing curto (objetivo / equipe / fim).
 * Worker: papel + objetivo. Contrato de handoff continua anexado à parte.
 */
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
  // Missão-pergunta aos panes: contrato META-DE-PANE no lugar do plano selado
  // (redundância "1 entrega" repetindo o objetivo custava contexto sem
  // informação — 22/08, missão 1+1).
  const isMetaPaneMission =
    agent.category === 'orchestrator' &&
    sealedPlanTitles.some((storyTitle) => isPaneMetaTask(storyTitle));
  // A doutrina anti-colapso existe para planos com VÁRIAS entregas (11
  // stories viravam 5 papéis). Para 1 entrega ela é ruído puro no kickoff
  // ("Não colapse em 7 papéis. São 1 entregas." — operador 20/08): 1 task =
  // uma linha só.
  const sealedPlanBlock =
    agent.category === 'orchestrator' && !isMetaPaneMission
      ? sealedPlanTitles.length > 1
        ? [
            '### Plano selado (não colapse em papéis do squad)',
            `São ${sealedPlanTitles.length} entregas — spawne UM worker por ` +
              'task pendente; NÃO reduza a lista aos papéis do squad.',
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
      ? 'META-DE-PANE: esta missão pergunta aos próprios panes — VOCÊ executa. ' +
        'EXTRAIA do objetivo apenas a PERGUNTA (ex.: "quanto é 1+1?") — quem é ' +
        'perguntado recebe SÓ a pergunta, nunca a instrução "pergunte aos ' +
        'panes" nem papel/missão (relay fiel vale para trabalho delegado, não ' +
        'para perguntas). ' +
        `Abra UM pane por integrante (${teamWorkerNames.join(', ') || 'equipe'}) ` +
        'via nexus_pane_spawn com a pergunta no prompt e readOnly: true — ' +
        'pergunta não escreve arquivo, e SEM readOnly a serialização de 1 ' +
        'escritor por checkout bloqueia o leque no 2º pane. Aguarde a resposta de ' +
        'TODOS os panes, e só então FECHO: nexus_handoff_submit success com ' +
        'summary citando a resposta de CADA pane E artifacts: [{fullText: ' +
        '"pane X → resposta; pane Y → resposta"}] — success com artifacts ' +
        'vazio NÃO conclui a missão (o gate exige prova listada), e o slot de ' +
        'handoff é ÚNICO: não chame set_status done, o motor conclui sozinho. ' +
        'Nenhum pane sem resposta = missão não fecha. ' +
        'Para perguntar a um pane JÁ aberto use nexus_pane_ask (envia, espera ' +
        'e devolve só a resposta) — qualquer pane da missão pode usar.'
      : '';
  const uiNote = isUiMissionText(objective)
    ? 'Este pedido envolve interface. Use o DESIGN.md do projeto e o catálogo de design como guia de estilo.'
    : '';
  const browserNote =
    /\b(abr[aeiou]|navegador|browser|preview|mostr(?:ar|e)|ver\s+no\s+navegador)\b/iu.test(
      objective,
    )
      ? 'Se o objetivo pede para ABRIR no navegador: após gerar os arquivos, abra o HTML no navegador do SO (macOS: `open <arquivo>`; Linux: `xdg-open <arquivo>`) ANTES do handoff e cite o arquivo/comando no summary.'
      : '';
  const designBlock = uiNote && designContext ? designContext : '';
  const executorCount = (squad?.agents ?? []).filter(
    (row) => row.category === 'executor',
  ).length;

  if (agent.category === 'orchestrator') {
    return buildMaestroKickoffBrief({
      title,
      objective: [
        objective,
        mission.learnings
          ? `Aprendizados anteriores: ${mission.learnings}`
          : '',
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
      designContext: designBlock,
      lane: mission.intentContract?.lane,
      maxWorkers: mission.intentContract?.budgets?.maxWorkers,
      executorCount: executorCount ?? 3,
      sealedPlanTitles,
      metaPane: isMetaPaneMission,
    });
  }

  return [
    `## Missão: ${title}`,
    `Objetivo: ${objective}`,
    mission.learnings ? `Aprendizados anteriores: ${mission.learnings}` : '',
    uiNote,
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
    return spawnAgentPane(scope, mission, successor, prompt, paneTitle);
  }
  const spawned = await spawnAgentPane(scope, mission, writer, prompt, paneTitle);
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
  return spawnAgentPane(scope, mission, successor, prompt, paneTitle);
}

async function spawnAgentPane(
  scope: ProjectExecutionScope,
  mission: Mission,
  agent: SquadAgent,
  initialPrompt?: string,
  paneTitle?: string,
): Promise<SpawnedAgent | { error: string }> {
  const role: 'orchestrator' | 'worker' =
    agent.category === 'orchestrator' ? 'orchestrator' : 'worker';
  const title = paneTitle?.trim() || agent.agentName;

  const spawn = await requestPaneSpawn({
    adapterId: agent.cli,
    model: agent.model || undefined,
    effort: agent.effort || undefined,
    cwd: scope.rootRealPath,
    title,
    missionId: mission.id,
    agentName: agent.agentName,
    allowedTools: agent.allowedTools ? [...agent.allowedTools] : null,
    // null = irrestrito (paridade tools / spawn-authority). `[]` nega todas
    // as skills e ainda arma requiresSpawnGate — não confundir com ausente.
    allowedSkills: agent.allowedSkills ? [...agent.allowedSkills] : null,
    role,
    scope,
    executionScope: scope,
    executionMode: 'same_checkout',
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

  // Maestro paste/oneshot: pty-manager NÃO coloca o briefing no argv (one-shot
  // mataria o pane; paste não tem canal). Sem colagem o Maestro fica mudo e
  // a Via Rápida marca kickoff aceito — missão "running" que nunca despacha.
  // Maestro positional: argv sem recibo — NÃO gravar kickoff até first-run/
  // OAuth sumirem. Se o pane já está idle com o briefing injetado, o recibo
  // pode ser aceito antes da prova de Enter (poke do operador não espera 70s).
  if (role === 'orchestrator' && initialPrompt) {
    const delivery = resolveOrchestratorBriefDelivery(agent.cli);
    if (delivery === 'paste') {
      const boot =
        getSessionState(spawn.sessionId) === 'idle'
          ? 'idle'
          : await waitForIdle(
              spawn.sessionId,
              ORCHESTRATOR_BOOT_TIMEOUT_MS,
            );
      if (boot === 'exited') {
        return {
          error: `${agent.agentName} (${agent.cli}): pane saiu antes do briefing`,
        };
      }
      try {
        const accepted = await deliverAgentPrompt(
          spawn.sessionId,
          initialPrompt,
          undefined,
          { adapterId: agent.cli },
        );
        if (!accepted) {
          return {
            error: `${agent.agentName} (${agent.cli}): briefing não foi aceito pelo pane`,
          };
        }
        tryAcceptIdleOrchestratorKickoff(
          stores,
          mission,
          spawn.sessionId,
          initialPrompt,
        );
      } catch (error) {
        return {
          error: `${agent.agentName} (${agent.cli}): falha ao colar briefing — ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
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
    const pronto = maybeApplyCivilianPronto(state.scope, state.missionId);
    if (pronto.completed) {
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
  const currentHead = await readCheckoutHead(state.scope.rootRealPath);
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
      cwd: state.scope.rootRealPath,
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
  // Se não há NENHUM pane vivo nesta missão: doutrina Overclock — a missão
  // NUNCA é bloqueada nem completada pelo watcher. Com orçamento, o
  // orquestrador é respawnado (ele consome handoffs pendentes e decide o
  // fim da missão); sem orçamento, mantém running e observando. Só o
  // operador para.
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
    console.warn(
      `[fast-lane] nenhum pane vivo em ${state.missionId} e orçamento de ` +
        'respawn esgotado; missão segue running — use Retomar no rail.',
    );
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
      scope.rootRealPath;
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
  void readCheckoutHead(scope.rootRealPath).then((head) => {
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
 * Respawna o orquestrador de uma missão running cujo runtime morreu
 * (exit do Maestro, restart do app, pane vazio). Cura split-brain de intent
 * ANTES do spawn — sem isso o reconciler de autoridade de 1s mata o
 * orquestrador recém-nascido. O novo Maestro recebe nota de continuidade e
 * decide o resto pelas tools dele (handoffs pendentes, replanejamento, done).
 */
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

  const squad = mission.squadId ? getSquad(mission.squadId) : null;
  const roster = orderedRoster(squad?.agents ?? []);
  const orchestrator = roster.find((agent) => agent.category === 'orchestrator');
  if (!orchestrator) {
    throw new Error('o squad não tem um orquestrador definido');
  }
  assertFastLaneMaestroMcp(orchestrator.cli);

  const sealedPlanTitles = sealFastLanePlanTitles(stores, live, squad);
  const prompt = [
    agentPrompt(
      orchestrator,
      live,
      roster.map((agent) => agent.agentName),
      true,
      missionDesignContext(scope.rootRealPath),
      squad,
      sealedPlanTitles,
    ),
    options.note
      ? `## CONTINUIDADE\nVocê foi religado automaticamente. ${options.note} ` +
          'Consulte nexus_handoff_list e o estado da missão antes de agir.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');

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

  const spawned = await spawnAgentPane(scope, live, orchestrator, prompt);
  if ('error' in spawned) {
    throw new Error(`orquestrador não reabriu: ${spawned.error}`);
  }

  stopWatcher(scope, mission.id);
  orchPanes.set(mission.id, {
    paneId: spawned.paneId,
    sessionId: spawned.sessionId,
    adapterId: spawned.adapterId,
    cwd: scope.rootRealPath,
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

/**
 * Ressurreição de boot: só a missão focused COM Maestro vivo neste processo
 * volta a voar. Rows leftover `running` no disco NÃO remontam PTY — persistem
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

  const squad = mission.squadId ? getSquad(mission.squadId) : null;
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
  const live = executing ?? dispatched;

  const teamNames = roster.map((agent) => agent.agentName);
  const designContext = missionDesignContext(scope.rootRealPath);
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
      cwd: scope.rootRealPath,
      title: orchestrator.agentName,
      agentName: orchestrator.agentName,
    });

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

const firstWaveInFlight = new Set<string>();

/**
 * First-wave no mesmo turno do Maestro. Só CLI AuthReadiness=present
 * ganha assento; LongCat sem chave é skip silencioso (sem toast).
 */
/**
 * Task cujo destinatário são os PRÓPRIOS panes da missão (perguntar/chamar/
 * responder aos panes). Worker não tem ferramenta de pane — despachar essa
 * classe gera papelada honesta no lugar do efeito ("workers cannot create
 * panes", nota do próprio worker em 20/08). Ela fica com o Maestro, que tem
 * as ferramentas e a doutrina EXCEÇÃO/FECHO para executar e concluir.
 */
export function isPaneMetaTask(title: string): boolean {
  const text = title.normalize('NFC');
  return (
    /\b(?:pergunt|respond|cham)\w*\b[^.\n]{0,40}\bpanes?\b/iu.test(text) ||
    /\bpanes?\b[^\n]{0,40}\b(?:pergunt|respond|cham)\w*/iu.test(text) ||
    /\bcada\s+pane\b/iu.test(text) ||
    // Ditado por voz vem com typo no verbo ("oergunta aos panes quwnto e
    // 1+1" derrotou o padrão acima em campo, 20/08). A construção de
    // destinatário ("aos panes") + carga interrogativa é evidência
    // suficiente sem o verbo; task de código fala "do pane"/"o pane X" e
    // não carrega interrogação.
    (/\baos?\s+(?:todos\s+(?:os\s+)?)?panes\b/iu.test(text) &&
      /\?|\bquanto|\bqual|\bquem\b|\bonde\b|\bquando\b|\d\s*\+\s*\d/iu.test(
        text,
      ))
  );
}

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
    // Meta-de-pane fica com o Maestro (EXCEÇÃO): worker sem ferramenta de
    // pane entregaria papelada em vez do efeito pedido.
    const titles = allTitles.filter((title) => !isPaneMetaTask(title));
    const maestroKept = allTitles.length - titles.length;
    if (maestroKept > 0) {
      console.info(
        `[fast-lane] first-wave deixou ${maestroKept} task(s) meta-de-pane ` +
          `para o Maestro executar (${missionId})`,
      );
    }
    if (titles.length === 0) return 0;
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
      const prompt = firstWaveWorkerPrompt({
        mission,
        agentName: seat.agent.agentName,
        storyTitle: seat.storyTitle,
        storyIndex: seat.seatIndex,
        storyTotal: titles.length,
      });
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
  options: { readonly remountKind?: LeftoverRemountKind } = {},
): Promise<void> {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission) throw new Error('missão não encontrada para retomar');

  const remountKind = options.remountKind ?? 'operator';
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
    if (liveMaestroSessionId) startWatcher(scope, missionId, liveMaestroSessionId);    return;
  }
  if (action === 'respawn') {
    await respawnFastLaneOrchestrator(scope, mission);
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

export function fastLaneOrchestratorPaneSummary(
  _scope: ProjectExecutionScope,
  missionId: string,
): {
  readonly paneId: string;
  readonly sessionId: string;
  readonly adapterId: string;
  readonly cwd: string;
  readonly title: string;
  readonly agentName: string;
  readonly role: 'orchestrator';
} | null {
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
