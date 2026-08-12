import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import type { Mission, Squad, SquadAgent } from '../../shared/orch-types';
import { isUiMissionText } from '../../shared/mission-work-kind';
import { buildOrchestratorDoctrine } from './orchestrator-doctrine';
import { getSessionState } from '../pty/pty-manager';
import { listPaneSnapshots, requestPaneSpawn } from './pane-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import { getSquad } from './squad-store';
import { missionEngineForScope } from './mission-engine-registry';

/**
 * Via Rápida de missão (2026-08-12) — motor limpo, padrão Overclock.
 *
 * O modelo é simples: spawna o ORQUESTRADOR com o briefing completo da missão
 * (objetivo + roster de workers + instruções de coordenação). O orquestrador
 * coordena tudo via MCP tools (nexus_pane_spawn, nexus_handoff_list,
 * nexus_mission_set_status). O motor só observa: se a missão foi concluída ou
 * bloqueada, encerra. Se o orquestrador morreu, verifica handoffs e decide.
 *
 * Zero tickRun. Zero wasBusy. Zero markerObserver. Zero nudge. Zero respawn.
 * Zero parsing de PRONTO/BLOQUEADO do terminal. O contrato de handoff já é
 * entregue no prompt (withHandoffContract), e os workers chamam
 * nexus_handoff_submit quando terminam.
 */

/** Intervalo de observação da missão. */
const WATCHER_INTERVAL_MS = 15_000;
/** Tempo máximo de missão sem atividade no orquestrador. */
const ORCHESTRATOR_SILENCE_TIMEOUT_MS = 30 * 60_000;

interface WatcherState {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly orchSessionId: string;
  readonly startedAt: number;
  lastOrchActivityAt: number;
  timer: ReturnType<typeof setInterval> | null;
  stopped: boolean;
}

const watchers = new Map<string, WatcherState>();

function watcherKey(scope: ProjectExecutionScope, missionId: string): string {
  return `${scope.rootRealPath}::${missionId}`;
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
    designContext,
    `Você é ${agent.agentName} (${agent.category === 'orchestrator' ? 'orquestrador' : 'worker'})`,
    agent.category === 'orchestrator'
      ? [
          'Sua função é COORDENAR a equipe. Você NÃO executa tarefas diretamente — ' +
            'você analisa o objetivo, divide em tarefas, e delega cada uma a um worker ' +
            'via nexus_pane_spawn. Depois coleta os resultados via nexus_handoff_list, ' +
            'valida, e reporta o resultado final.',
          'Workers disponíveis (spawne via nexus_pane_spawn com agentName):',
          ...teamNames
            .filter((n) => n !== agent.agentName)
            .map((n) => `  - ${n}`),
          'Fluxo de trabalho:',
          '1. Analise o objetivo e divida em tarefas claras',
          '2. Para CADA tarefa: chame nexus_pane_spawn({agentName, prompt, model, effort})',
          '3. Aguarde os resultados via nexus_handoff_list({scope: "caller_mission"})',
          '4. Valide cada entrega — se algo estiver errado, re-spawne o worker com correções',
          '5. Quando TODOS os workers entregarem, chame nexus_mission_set_status({status: "completed"})',
          'Se um worker falhar ou bloquear, tente outro worker ou relate o bloqueio.',
          doctrine,
        ].join('\n')
      : 'Você é um worker. Execute a tarefa designada e entregue o resultado.',
    'REGRA DE ENCERRAMENTO (obrigatória): a ÚLTIMA coisa que você escreve é ' +
      'uma linha começando exatamente com "PRONTO: " seguida de um resumo curto ' +
      'do que você fez.',
    'Sem essa linha o Nexus não tem como saber que você terminou e a missão ' +
      'fica aberta esperando por você — mesmo com o trabalho pronto.',
    'Se algo impedir totalmente o trabalho, escreva no lugar dela uma linha ' +
      'começando com "BLOQUEADO: " e o motivo.',
    'Escreva a linha no próprio terminal (é a sua saída), não em arquivo.',
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
  if (mission.status === 'done' || mission.status === 'blocked') {
    stopWatcher(state.scope, state.missionId);
    return;
  }

  // Se a missão não está mais running, algo externo a mudou.
  if (mission.status !== 'running') {
    stopWatcher(state.scope, state.missionId);
    return;
  }

  // Verifica se o orquestrador ainda está vivo.
  const orchState = getSessionState(state.orchSessionId);
  const now = Date.now();
  const silenceDuration = now - state.lastOrchActivityAt;

  if (orchState === 'busy') {
    state.lastOrchActivityAt = now;
  }

  // Orquestrador morto há muito tempo → verifica handoffs e decide.
  if (
    orchState !== 'busy' &&
    orchState !== 'idle' &&
    orchState !== 'spawning' &&
    silenceDuration > ORCHESTRATOR_SILENCE_TIMEOUT_MS
  ) {
    try {
      // Tenta completar por inatividade do orquestrador.
      const engine = missionEngineForScope(state.scope);
      engine.completeVerified(state.scope, {
        missionId: state.missionId,
        expectedStatus: mission.status,
        expectedIntentState: mission.intentState ?? 'executing',
        expectedUpdatedAt: mission.updatedAt,
        expectedIntentVersion: mission.intentVersion ?? 0,
        learnings: mission.learnings ?? '',
        result: {
          outcome: 'success',
          summary:
            'Missão concluída por inatividade do orquestrador. ' +
            'Verifique os terminais para os resultados.',
          evidenceIds: [],
          artifactRefs: [],
        },
      });
    } catch (error) {
      console.warn(
        '[fast-lane] conclusão por inatividade falhou:',
        error instanceof Error ? error.message : error,
      );
    }
    stopWatcher(state.scope, state.missionId);
    return;
  }

  // Orquestrador sumiu sem deixar rastro → bloqueia.
  if (
    orchState !== 'busy' &&
    orchState !== 'idle' &&
    orchState !== 'spawning'
  ) {
    // Sessão não existe mais. Se a missão tem handoffs, tenta completar.
    // Senão, bloqueia.
    try {
      const engine = missionEngineForScope(state.scope);
      const current = stores.missions.get(state.missionId);
      if (current && current.status === 'running' && current.intentState) {
        engine.blockTechnical(state.scope, {
          missionId: state.missionId,
          expectedStatus: current.status,
          expectedIntentState: current.intentState,
          expectedUpdatedAt: current.updatedAt,
          expectedIntentVersion: current.intentVersion ?? 0,
          description:
            'O orquestrador encerrou inesperadamente. Verifique os terminais ' +
            'e use Retomar para religar a equipe.',
        });
      }
    } catch (error) {
      console.warn(
        '[fast-lane] bloqueio por orquestrador morto falhou:',
        error instanceof Error ? error.message : error,
      );
    }
    stopWatcher(state.scope, state.missionId);
    return;
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
  };

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

// ── Bootstrap ────────────────────────────────────────────────────────────

/**
 * Bootstrap da Via Rápida: transiciona a missão para running, abre um pane
 * para o ORQUESTRADOR com o briefing completo da missão e liga o observador.
 *
 * O orquestrador recebe o roster de workers e as instruções para coordenar
 * via MCP tools (nexus_pane_spawn, nexus_handoff_list). Os workers são
 * spawnados SOB DEMANDA pelo orquestrador — modelo PULL do Overclock.
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
    // Já está rodando — só religa o watcher.
    const orchPane = listPaneSnapshots().find(
      (p) =>
        p.missionId === missionId &&
        (p.role === 'orchestrator' || p.agentName?.toLowerCase().includes('orquestrador')),
    );
    if (orchPane?.sessionId) {
      startWatcher(scope, missionId, orchPane.sessionId);
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

  // Se já está running, só garante que o watcher está ligado.
  if (mission.status === 'running') {
    const orchPane = listPaneSnapshots().find(
      (p) =>
        p.missionId === missionId &&
        (p.role === 'orchestrator' ||
          p.agentName?.toLowerCase().includes('orquestrador')),
    );
    if (orchPane?.sessionId) {
      startWatcher(scope, missionId, orchPane.sessionId);
    }
    return;
  }

  // Se bloqueada, tenta re-assumir.
  if (mission.status === 'blocked' && mission.intentState) {
    try {
      missionEngineForScope(scope).resumeTechnical(scope, {
        missionId,
        expectedStatus: mission.status,
        expectedIntentState: mission.intentState ?? 'executing',
        expectedUpdatedAt: mission.updatedAt,
        expectedIntentVersion: mission.intentVersion ?? 0,
        description: mission.description ?? '',
      });
    } catch (error) {
      console.warn(
        '[fast-lane] retomar missão bloqueada falhou:',
        error instanceof Error ? error.message : error,
      );
    }
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
