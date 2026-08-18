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
import { emitMissionEvent } from './mission-event-emit';
import { buildOrchestratorDoctrine } from './orchestrator-doctrine';
import {
  getSessionState,
  orchTerminateSession,
  registeredOrchestratorSessionsForMission,
} from '../pty/pty-manager';
import { listPaneSnapshots, requestPaneSpawn } from './pane-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import { getSquad } from './squad-store';
import { missionEngineForScope } from './mission-engine-registry';
import { redeliverPendingHandoffs } from './idle-delivery';
import {
  recordAdapterProofOfLife,
  recordWorkerDeathWithoutDelivery,
} from './worker-mortality';
import { trace } from '../observability/main-trace';
import { classifySessionLiveness } from '../pty/session-liveness';

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
const ORCHESTRATOR_RESPAWN_BUDGET = 3;

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
}

const watchers = new Map<string, WatcherState>();

/**
 * Orçamento de respawn do orquestrador POR EPISÓDIO de missão (sobrevive ao
 * watcher que o respawn recria). Recarregado quando um pane vivo reaparece —
 * atividade real significa episódio novo.
 */
const respawnBudgets = new Map<string, number>();

function watcherKey(scope: ProjectExecutionScope, missionId: string): string {
  return `${scope.rootRealPath}::${missionId}`;
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
 * Prompt completo de um agente do squad, com doutrina de coordenação para o
 * orquestrador e contrato de handoff para todos.
 */
export function agentPrompt(
  agent: SquadAgent,
  mission: Mission,
  teamNames: readonly string[],
  resume: boolean,
  designContext = '',
  squad: Squad | null = null,
): string {
  const objective = mission.description ?? '';
  const doctrine = agent.category === 'orchestrator' && squad
    ? buildOrchestratorDoctrine(squad, mission)
    : '';

  const uiNote = isUiMissionText(objective)
    ? 'Este pedido envolve UI. Use o DESIGN.md do projeto e o catálogo de ' +
      'design como autoridade de estilo — nunca gere Tailwind/shadcn genérico.'
    : '';

  return [
    `## Missão: ${mission.title ?? objective.slice(0, 80)}`,
    `Objetivo: ${objective}`,
    mission.learnings ? `Aprendizados anteriores: ${mission.learnings}` : '',
    uiNote,
    uiNote ? designContext : '',
    `Você é ${agent.agentName} (${agent.category === 'orchestrator' ? 'orquestrador' : 'worker'})`,
    agent.category === 'orchestrator'
      ? [
          '## ORQUESTRAÇÃO (modelo PULL)',
          '',
          'Você é o ORQUESTRADOR. Você NÃO executa tarefas — você COORDENA.',
          'Mesmo pedidos triviais (uma pergunta, uma contagem) viram dispatch de worker:',
          'se está no objetivo da missão, um worker responde — nunca você.',
          '',
          '### Workflow',
          '1. Analise o objetivo e divida em tarefas independentes',
          '2. Para CADA tarefa: chame nexus_pane_spawn({agentName, prompt})',
          '   - O prompt vai no argv de NASCENÇA — o worker já acorda executando',
          '   - O model/effort selados no início da missão VENCEM route_task e o default da CLI',
          '   - Uma chamada só. NUNCA spawn + pane_write separados.',
          '3. PARALELIZE com inteligência (a fila de CLIs é sua vantagem):',
          '   - Trabalho de LEITURA (code review, auditoria, viabilidade) NUNCA',
          '     é serial: fatie o escopo grande em pedaços (por área/domínio/',
          '     diretório) e spawne os revisores NO MESMO TURNO, em paralelo.',
          '   - ESCRITORES ficam 1 por vez no mesmo checkout; leitores podem',
          '     acompanhar um escritor ativo. Use o plano (nexus_task plan) para',
          '     declarar dependsOn e o que é leitura vs escrita.',
          '4. Depois de spawnar, ENCERRE SEU TURNO. NÃO faça polling.',
          '   - Resultados chegam via nexus_handoff_submit e ACORDAM você',
          '   - re-chamar pane_read/pane_list/handoff_list em loop não ensina nada',
          '5. Quando acordar com resultados, valide via nexus_handoff_list({full:true})',
          '   - Use o campo `evidence` para CONFIRMAR — comandos, exit codes, arquivos',
          '   - NÃO confie cegamente no summary',
          '6. Se algo errado: re-spawne o worker com correções pontuais',
          '7. Quando TODOS entregarem: chame nexus_mission_set_status({status:"done"})',
          '',
          '### Workers disponíveis (use com agentName)',
          ...teamNames
            .filter((n) => n !== agent.agentName)
            .map((n) => `  - ${n}`),
          '',
          '### Regras',
          '- pane_wait_idle é SÓ confirmação de boot (15s). NUNCA espere resultado nele.',
          '- Worker parado sem handoff? Pergunte via pane_write. NÃO leia o terminal dele.',
          '- BLOQUEADO de um worker não trava a missão. Re-spawne com outro ou ajuste.',
          '',
          doctrine,
        ].join('\n')
      : [
          '## WORKER (modelo PULL)',
          '',
          'Você é um worker. Execute a tarefa e entregue o resultado.',
          'Sua resposta SERÁ ENTREGUE AUTOMATICAMENTE ao orquestrador — as regras ',
          'de entrega (quando responder direto e quando chamar nexus_handoff_submit) ',
          'estão no contrato de handoff no fim deste prompt. Siga ELAS.',
        ].join('\n'),
    resume ? '(Você foi religado após uma tentativa anterior.)' : '',
  ]
    .filter(Boolean)
    .join('\n');
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

async function spawnAgentPane(
  scope: ProjectExecutionScope,
  mission: Mission,
  agent: SquadAgent,
  initialPrompt?: string,
): Promise<SpawnedAgent | { error: string }> {
  const role: 'orchestrator' | 'worker' =
    agent.category === 'orchestrator' ? 'orchestrator' : 'worker';

  const spawn = await requestPaneSpawn({
    adapterId: agent.cli,
    model: agent.model || undefined,
    effort: agent.effort || undefined,
    cwd: scope.rootRealPath,
    title: agent.agentName,
    missionId: mission.id,
    agentName: agent.agentName,
    allowedTools: agent.allowedTools ? [...agent.allowedTools] : null,
    allowedSkills: agent.allowedSkills ? [...agent.allowedSkills] : [],
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
  stores.missionPanes.record({
    missionId: mission.id,
    paneId: spawn.paneId,
    adapterId: agent.cli,
    cwd: scope.rootRealPath,
    title: agent.agentName,
    agentName: agent.agentName,
    role,
    allowedTools: agent.allowedTools ? [...agent.allowedTools] : null,
    allowedSkills: agent.allowedSkills ? [...agent.allowedSkills] : [],
    readOnly: false,
    executionScope: scope,
  });

  if (role === 'orchestrator') {
    stores.missions.setOrchestratorSession(mission.id, spawn.sessionId);
    // Recibo de kickoff (0.32.23): prova durável do orquestrador desta
    // encarnação — exigido por missionDirectAuthority e pelo retry do
    // orientar-missão. Vale para bootstrap E respawn (continuidade).
    const live = stores.missions.get(mission.id) ?? mission;
    try {
      stores.missions.recordKickoffAcceptance({
        missionId: live.id,
        intentVersion: live.intentVersion ?? 0,
        orchestratorSessionId: spawn.sessionId,
        promptHash: createHash('sha256')
          .update(initialPrompt ?? '')
          .digest('hex'),
      });
    } catch (error) {
      console.warn(
        '[fast-lane] recibo de kickoff não gravou:',
        error instanceof Error ? error.message : error,
      );
    }
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
  const livePanes = missionPanes.filter(
    (p) => p.state === 'busy' || p.state === 'idle' || p.state === 'spawning',
  );
  const budgetKey = watcherKey(state.scope, state.missionId);
  if (livePanes.length > 0) {
    // Atividade real recarrega o orçamento do episódio.
    respawnBudgets.set(budgetKey, ORCHESTRATOR_RESPAWN_BUDGET);
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

/**
 * Mortalidade de worker no tick do watcher (campanha 0.50, A1): pane morto
 * que NUNCA entregou handoff = morte sem entrega (conta pro circuit breaker
 * do adapter); pane com entrega é prova de vida (zera) — exit pós-entrega é
 * o TTL normal da doutrina, não mortalidade. Cada morte vira evento no
 * journal: o pós-mortem deixa de ser cego.
 */
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
  }[],
): void {
  const workers = missionPanes.filter((p) => p.role === 'worker');
  if (workers.length === 0) return;
  const deliveredSessions = new Set<string>();
  try {
    for (const handoff of getProjectDomainStores(scope).handoffs.list({
      missionId,
      includeDelivered: true,
    })) {
      if (handoff.sessionId) deliveredSessions.add(handoff.sessionId);
    }
  } catch {
    // Handoffs ilegíveis: segue sem prova de vida — a morte sem entrega é o
    // default honesto (o breaker precisa de 3 para agir).
  }
  for (const pane of workers) {
    const adapterId = pane.adapterId?.trim() || '';
    if (!adapterId) continue;
    if (pane.sessionId && deliveredSessions.has(pane.sessionId)) {
      recordAdapterProofOfLife(missionId, adapterId);
      continue;
    }
    if (pane.state !== 'exited' && pane.state !== 'hibernated') continue;
    if (mortalityCountedPanes.has(pane.paneId)) continue;
    mortalityCountedPanes.add(pane.paneId);
    const deaths = recordWorkerDeathWithoutDelivery(missionId, adapterId);
    trace({
      kind: 'worker-died-without-delivery',
      missionId,
      paneId: pane.paneId,
      adapterId,
      deaths,
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

  // Cura split-brain persistido: write status-only reativação normaliza
  // intent blocked_* → executing (guard do mission-store.update).
  let live = mission;
  if (
    mission.status === 'running' &&
    (mission.intentState === 'blocked_technical' ||
      mission.intentState === 'blocked_user')
  ) {
    live =
      stores.missions.update(mission.id, { status: 'running' }) ?? mission;
  }

  const squad = mission.squadId ? getSquad(mission.squadId) : null;
  const roster = orderedRoster(squad?.agents ?? []);
  const orchestrator = roster.find((agent) => agent.category === 'orchestrator');
  if (!orchestrator) {
    throw new Error('o squad não tem um orquestrador definido');
  }

  const prompt = [
    agentPrompt(
      orchestrator,
      live,
      roster.map((agent) => agent.agentName),
      true,
      missionDesignContext(scope.rootRealPath),
      squad,
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
 * Ressurreição de boot: missões running de um escopo recém-aberto voltam a
 * voar (restart do app não pode virar zumbi — print 2026-08-16). Missões
 * fechadas pelo operador explícitamente NÃO são ressuscitadas.
 */
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
  for (const mission of running) {
    if (wasMissionRuntimeClosedByOperator(mission)) continue;
    try {
      await resumeFastLaneMission(scope, mission.id);
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
): Promise<void> {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission) throw new Error('missão não encontrada para a Via Rápida');

  const key = watcherKey(scope, missionId);
  if (watchers.has(key)) return; // idempotente

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

  // Spawna APENAS o orquestrador. Workers são spawnados sob demanda por ele.
  const orchestrator = roster.find((a) => a.category === 'orchestrator');
  if (!orchestrator) {
    throw new Error('o squad não tem um orquestrador definido');
  }

  const prompt = agentPrompt(
    orchestrator,
    live,
    teamNames,
    false,
    designContext,
    squad,
  );

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
}

// ── Resume ───────────────────────────────────────────────────────────────

export async function resumeFastLaneMission(
  scope: ProjectExecutionScope,
  missionId: string,
): Promise<void> {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission) throw new Error('missão não encontrada para retomar');

  const action = decideFastLaneResumeAction({
    status: mission.status,
    liveOrchestratorSession: liveOrchestratorSessionId(missionId) !== null,
  });
  if (action === 'watch') {
    const sessionId = liveOrchestratorSessionId(missionId);
    if (sessionId) startWatcher(scope, missionId, sessionId);
    return;
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
  if (mission.status === 'blocked' && mission.intentState) {
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
            MISSION_RUNTIME_CLOSED_MARKER,
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
