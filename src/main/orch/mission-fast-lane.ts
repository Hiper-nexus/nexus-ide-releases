import { createHash } from 'node:crypto';
import type { ProjectExecutionScope } from '../../shared/types';
import type { Mission, SquadAgent } from '../../shared/orch-types';
import { getSessionState } from '../pty/pty-manager';
import { deliverAgentPrompt } from './tool-util';
import {
  listPaneSnapshots,
  spawnMainOwnedMissionPaneAsync,
} from './pane-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import { getSquad } from './squad-store';
import { missionEngineForScope } from './mission-engine-registry';

/**
 * Via Rápida de missão (2026-08-10) — o motor de execução padrão.
 *
 * Modelo Overclock/BridgeMind: `Iniciar missão` abre UM TERMINAL INTERATIVO
 * POR AGENTE, direto no workspace (`same_checkout`), com um prompt curto de
 * objetivo. Os agentes trabalham contínuo no próprio PTY — sem plano selado,
 * sem claim, sem kickoff ping-pong, sem receipt, sem merge queue. A conclusão
 * é OBSERVADA: todo agente trabalhou (esteve `busy`) e depois assentou
 * (`idle`/saiu) ⇒ missão `done`. Pane que morre antes de trabalhar é
 * respawnado uma vez; silêncio prolongado vira bloqueio VISÍVEL com retomada.
 *
 * O motor cerimonial completo continua atrás de NEXUS_CEREMONIAL_MISSIONS=1
 * até a remoção definitiva.
 */

const TICK_MS = 5_000;
/** Confirmações consecutivas de assentamento antes de concluir (2 × tick). */
const IDLE_CONFIRMATIONS_TO_COMPLETE = 2;
/** Pane que nunca ficou busy depois do prompt ganha UMA recarga de prompt. */
const BOOT_NUDGE_AFTER_MS = 90_000;
/** Sem nenhum agente busy por este intervalo ⇒ bloqueio técnico visível. */
const STALL_BLOCK_AFTER_MS = 10 * 60_000;
/** Idade mínima da missão antes de o watchdog de silêncio poder agir. */
const STALL_MIN_MISSION_AGE_MS = 15 * 60_000;

export function missionFastLaneEnabled(): boolean {
  return process.env.NEXUS_CEREMONIAL_MISSIONS !== '1';
}

interface FastLaneAgentRun {
  readonly agentId: string;
  readonly agentName: string;
  readonly role: 'orchestrator' | 'worker';
  readonly adapterId: string;
  readonly model?: string;
  readonly effort?: string;
  readonly accountId?: string;
  paneId: string;
  sessionId: string;
  wasBusy: boolean;
  respawned: boolean;
  nudged: boolean;
  promptDeliveredAt: number;
}

interface FastLaneRun {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly agents: FastLaneAgentRun[];
  readonly startedAt: number;
  lastBusyAt: number;
  idleConfirmations: number;
  timer: ReturnType<typeof setInterval> | null;
}

const runs = new Map<string, FastLaneRun>();

function runKey(scope: ProjectExecutionScope, missionId: string): string {
  return `${scope.rootRealPath}\0${missionId}`;
}

export function agentPrompt(
  agent: SquadAgent,
  mission: Mission,
  teamNames: readonly string[],
  resume: boolean,
): string {
  const objective = mission.description?.trim() || mission.title;
  const others = teamNames.filter((name) => name !== agent.agentName);
  const header =
    agent.category === 'orchestrator'
      ? `Você é "${agent.agentName}", a coordenação da missão "${mission.title}".`
      : `Você é "${agent.agentName}" na missão "${mission.title}".`;
  const teamLine =
    others.length > 0
      ? `Equipe em terminais paralelos neste mesmo diretório: ${others.join(', ')}.`
      : '';
  const roleLine =
    agent.category === 'orchestrator'
      ? 'Verifique se o objetivo foi cumprido de verdade (arquivos, build, teste — o que fizer sentido) e corrija você mesmo o que faltar.'
      : agent.category === 'reviewer'
        ? 'Verifique o trabalho feito no diretório e corrija problemas pequenos você mesmo.'
        : 'Execute a sua parte do objetivo agora, direto neste diretório.';
  const resumeLine = resume
    ? 'A missão está sendo RETOMADA: confira o que já existe antes de refazer qualquer coisa.'
    : '';
  const instructions = agent.instructions?.trim()
    ? `Orientações específicas deste papel: ${agent.instructions.trim()}`
    : '';
  return [
    header,
    `Objetivo da missão: ${objective}`,
    teamLine,
    resumeLine,
    roleLine,
    instructions,
    'Quando terminar, escreva uma linha final "PRONTO: <resumo curto>".',
    'Se algo impedir totalmente o trabalho, escreva "BLOQUEADO: <motivo>" em uma linha.',
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

async function spawnAgentPane(
  scope: ProjectExecutionScope,
  mission: Mission,
  agent: SquadAgent,
  runtimeHint: {
    readonly adapterId?: string;
    readonly model?: string;
    readonly accountId?: string;
    readonly effort?: string;
  } | null,
): Promise<FastLaneAgentRun | { readonly error: string }> {
  const role: 'orchestrator' | 'worker' =
    agent.category === 'orchestrator' ? 'orchestrator' : 'worker';
  const adapterId = (role === 'orchestrator' && runtimeHint?.adapterId) || agent.cli;
  const model =
    (role === 'orchestrator' && runtimeHint?.model) || agent.model || undefined;
  const effort =
    (role === 'orchestrator' && runtimeHint?.effort) || agent.effort || undefined;
  const accountId =
    role === 'orchestrator' ? runtimeHint?.accountId || undefined : undefined;
  // Selo NUNCA é passado daqui: o canonicalizador do spawn carimba o selo
  // "atual" sozinho, e um selo calculado à parte diverge ("stale mission pane
  // authority") e derruba spawns legítimos. A visibilidade do grid vem do
  // bypass de adoção para pane main-owned da Via Rápida.
  const spawn = await spawnMainOwnedMissionPaneAsync({
    adapterId,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(accountId ? { accountId } : {}),
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
  });
  if (!spawn.ok || !spawn.paneId || !spawn.sessionId) {
    return {
      error: `${agent.agentName} (${adapterId}): ${spawn.error ?? 'spawn falhou sem detalhe'}`,
    };
  }
  const stores = getProjectDomainStores(scope);
  stores.missionPanes.record({
    missionId: mission.id,
    paneId: spawn.paneId,
    adapterId,
    ...(model ? { model } : {}),
    ...(accountId ? { accountId } : {}),
    ...(effort ? { effort } : {}),
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
    adapterId,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(accountId ? { accountId } : {}),
    paneId: spawn.paneId,
    sessionId: spawn.sessionId,
    wasBusy: false,
    respawned: false,
    nudged: false,
    promptDeliveredAt: 0,
  };
}

/** TUI recém-spawnada precisa terminar o boot antes de aceitar colagem. */
const DELIVERY_BOOT_WAIT_MS = 60_000;

async function waitPastSpawning(sessionId: string): Promise<void> {
  const deadline = Date.now() + DELIVERY_BOOT_WAIT_MS;
  while (Date.now() < deadline) {
    const state = getSessionState(sessionId);
    if (state !== 'spawning') return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * Entrega NUNCA é fatal: `deliverAgentPrompt` lança quando a TUI não aceita
 * dentro da janela, e uma exceção aqui já derrubou o loop de spawn inteiro
 * (coordenador vivo, workers nunca nascidos, observador nunca armado). A
 * falha vira retry do observador (nudge) — o agente segue vivo no terminal.
 */
async function deliverPrompt(
  run: FastLaneAgentRun,
  prompt: string,
): Promise<boolean> {
  run.promptDeliveredAt = Date.now();
  try {
    await waitPastSpawning(run.sessionId);
    run.promptDeliveredAt = Date.now();
    const accepted = await deliverAgentPrompt(run.sessionId, prompt, undefined, {
      adapterId: run.adapterId,
    });
    if (accepted) return true;
  } catch (error) {
    console.warn(
      `[fast-lane] entrega de prompt falhou para ${run.agentName} (${run.adapterId}):`,
      error instanceof Error ? error.message : error,
    );
  }
  console.warn(
    `[fast-lane] prompt não aceito por ${run.agentName} (${run.adapterId}) — o observador vai re-tentar (nudge)`,
  );
  return false;
}

/** Advisory: a projeção de admissão do snapshot lê este recibo. */
function recordFastLaneKickoffAcceptance(
  scope: ProjectExecutionScope,
  mission: Mission,
  orchestratorSessionId: string,
  prompt: string,
): void {
  try {
    getProjectDomainStores(scope).missions.recordKickoffAcceptance({
      missionId: mission.id,
      intentVersion: mission.intentVersion ?? 0,
      orchestratorSessionId,
      promptHash: createHash('sha256').update(prompt, 'utf8').digest('hex'),
    });
  } catch (error) {
    console.warn(
      '[fast-lane] recibo de kickoff não registrado (segue sem ele):',
      error instanceof Error ? error.message : error,
    );
  }
}

function stopFastLaneRun(scope: ProjectExecutionScope, missionId: string): void {
  const key = runKey(scope, missionId);
  const run = runs.get(key);
  if (run?.timer) clearInterval(run.timer);
  runs.delete(key);
}

function completeRun(run: FastLaneRun): void {
  const stores = getProjectDomainStores(run.scope);
  const mission = stores.missions.get(run.missionId);
  if (!mission || mission.status !== 'running' || !mission.intentState) {
    stopFastLaneRun(run.scope, run.missionId);
    return;
  }
  const summary =
    'Equipe concluiu e assentou: ' +
    run.agents.map((agent) => agent.agentName).join(', ') +
    '. Resultado nos terminais e no workspace.';
  try {
    missionEngineForScope(run.scope).completeVerified(run.scope, {
      missionId: run.missionId,
      expectedStatus: mission.status,
      expectedIntentState: mission.intentState,
      expectedUpdatedAt: mission.updatedAt,
      expectedIntentVersion: mission.intentVersion ?? 0,
      learnings: mission.learnings ?? '',
      result: {
        outcome: 'success',
        summary,
        evidenceIds: [],
        artifactRefs: [],
      },
    });
    stopFastLaneRun(run.scope, run.missionId);
  } catch (error) {
    // CAS perdeu (alguém mexeu na missão) — o próximo tick re-lê e decide.
    console.warn(
      '[fast-lane] conclusão adiada (CAS):',
      error instanceof Error ? error.message : error,
    );
  }
}

function blockRunVisible(run: FastLaneRun, reason: string): void {
  const stores = getProjectDomainStores(run.scope);
  const mission = stores.missions.get(run.missionId);
  if (!mission || mission.status !== 'running' || !mission.intentState) {
    stopFastLaneRun(run.scope, run.missionId);
    return;
  }
  try {
    missionEngineForScope(run.scope).blockTechnical(run.scope, {
      missionId: run.missionId,
      expectedStatus: mission.status,
      expectedIntentState: mission.intentState,
      expectedUpdatedAt: mission.updatedAt,
      expectedIntentVersion: mission.intentVersion ?? 0,
      description:
        `${mission.description ?? ''}\n\n[NEXUS_FAST_LANE]\n${reason}`.trim(),
    });
  } catch (error) {
    console.warn(
      '[fast-lane] bloqueio visível falhou (CAS):',
      error instanceof Error ? error.message : error,
    );
  } finally {
    stopFastLaneRun(run.scope, run.missionId);
  }
}

async function tickRun(run: FastLaneRun): Promise<void> {
  const stores = getProjectDomainStores(run.scope);
  const mission = stores.missions.get(run.missionId);
  if (!mission) {
    stopFastLaneRun(run.scope, run.missionId);
    return;
  }
  if (mission.status === 'blocked' && mission.intentState) {
    // Algum vigia legado gravou blocked por cima de uma equipe viva (já
    // aconteceu com o exit do Maestro pós-trabalho). A Via Rápida é a dona da
    // missão: re-assume pelo engine e segue observando.
    try {
      missionEngineForScope(run.scope).resumeTechnical(run.scope, {
        missionId: run.missionId,
        expectedStatus: mission.status,
        expectedIntentState: mission.intentState,
        expectedUpdatedAt: mission.updatedAt,
        expectedIntentVersion: mission.intentVersion ?? 0,
        description: mission.description ?? '',
      });
    } catch (error) {
      console.warn(
        '[fast-lane] re-assumir missão bloqueada falhou (tenta no próximo tick):',
        error instanceof Error ? error.message : error,
      );
    }
    return;
  }
  if (mission.status !== 'running') {
    stopFastLaneRun(run.scope, run.missionId);
    return;
  }
  const now = Date.now();
  let allSettled = true;
  for (const agent of run.agents) {
    const state = getSessionState(agent.sessionId);
    if (state === 'busy' || state === 'spawning') {
      if (state === 'busy') {
        agent.wasBusy = true;
        run.lastBusyAt = now;
      }
      allSettled = false;
      continue;
    }
    if (state === 'idle') {
      if (agent.wasBusy) continue; // assentou depois de trabalhar
      // Vivo mas nunca trabalhou: prompt pode ter se perdido no boot da TUI.
      // O nudge re-tenta em janelas de 90s (a entrega re-carimba o relógio),
      // então uma TUI lenta ganha quantas recargas precisar.
      allSettled = false;
      if (
        agent.promptDeliveredAt === 0 ||
        now - agent.promptDeliveredAt > BOOT_NUDGE_AFTER_MS
      ) {
        agent.nudged = true;
        const squad = mission.squadId ? getSquad(mission.squadId) : null;
        const spec = squad?.agents.find((item) => item.id === agent.agentId);
        if (spec) {
          void deliverPrompt(
            agent,
            agentPrompt(
              spec,
              mission,
              run.agents.map((item) => item.agentName),
              false,
            ),
          );
        }
      }
      continue;
    }
    // Sessão morta/inexistente.
    if (agent.wasBusy) continue; // trabalhou e saiu (CLI one-shot) = assentado
    if (!agent.respawned) {
      agent.respawned = true;
      allSettled = false;
      const squad = mission.squadId ? getSquad(mission.squadId) : null;
      const spec = squad?.agents.find((item) => item.id === agent.agentId);
      if (!spec) continue;
      void (async () => {
        const respawned = await spawnAgentPane(run.scope, mission, spec, null);
        if ('error' in respawned) {
          console.warn(`[fast-lane] respawn falhou: ${respawned.error}`);
          return;
        }
        agent.paneId = respawned.paneId;
        agent.sessionId = respawned.sessionId;
        await deliverPrompt(
          agent,
          agentPrompt(
            spec,
            mission,
            run.agents.map((item) => item.agentName),
            true,
          ),
        );
      })();
      continue;
    }
    // Respawn já gasto e morreu de novo sem trabalhar: conta como assentado
    // para não prender a missão — o resumo final nomeia os terminais.
  }

  const everyoneWorked = run.agents.some((agent) => agent.wasBusy);
  if (allSettled && everyoneWorked) {
    run.idleConfirmations += 1;
    if (run.idleConfirmations >= IDLE_CONFIRMATIONS_TO_COMPLETE) {
      completeRun(run);
    }
    return;
  }
  run.idleConfirmations = 0;

  const missionAge = now - run.startedAt;
  const silentFor = now - run.lastBusyAt;
  if (
    missionAge > STALL_MIN_MISSION_AGE_MS &&
    silentFor > STALL_BLOCK_AFTER_MS &&
    !everyoneWorked
  ) {
    blockRunVisible(
      run,
      'Nenhum agente chegou a trabalhar (terminais calados). Use Retomar para religar a equipe.',
    );
  }
}

function startWatcher(run: FastLaneRun): void {
  runs.set(runKey(run.scope, run.missionId), run);
  run.timer = setInterval(() => {
    void tickRun(run).catch((error) => {
      console.warn(
        '[fast-lane] tick falhou:',
        error instanceof Error ? error.message : error,
      );
    });
  }, TICK_MS);
}

/**
 * Bootstrap da Via Rápida: transiciona a missão para running, abre um pane
 * interativo por agente do squad no próprio workspace e liga o observador de
 * conclusão. Substitui o bootstrap cerimonial como caminho padrão.
 */
export async function fastLaneBootstrap(
  scope: ProjectExecutionScope,
  missionId: string,
): Promise<void> {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission) throw new Error('missão não encontrada para a Via Rápida');
  if (runs.has(runKey(scope, missionId))) return; // idempotente
  if (mission.status === 'running') {
    await resumeFastLaneMission(scope, missionId);
    return;
  }
  if (mission.status !== 'pending' || mission.intentState !== 'ready_to_start') {
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

  const run: FastLaneRun = {
    scope,
    missionId,
    agents: [],
    startedAt: Date.now(),
    lastBusyAt: Date.now(),
    idleConfirmations: 0,
    timer: null,
  };
  const teamNames = roster.map((agent) => agent.agentName);
  const failures: string[] = [];
  const runtimeHint = live.intentContract?.orchestratorRuntime ?? null;
  // Fase 1 — spawns (rápidos, sequenciais para não brigar por recursos de
  // boot). Um agente NUNCA derruba os outros: falha vira nota e segue.
  const spawnedPairs: Array<{ spec: SquadAgent; agent: FastLaneAgentRun }> = [];
  for (const agent of roster) {
    try {
      const spawned = await spawnAgentPane(scope, live, agent, runtimeHint);
      if ('error' in spawned) {
        failures.push(spawned.error);
        continue;
      }
      run.agents.push(spawned);
      spawnedPairs.push({ spec: agent, agent: spawned });
    } catch (error) {
      failures.push(
        `${agent.agentName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // Fase 2 — prompts em PARALELO: cada TUI espera o próprio boot; oito
  // agentes em fila serializada custariam minutos de largada.
  await Promise.all(
    spawnedPairs.map(async ({ spec, agent }) => {
      const accepted = await deliverPrompt(
        agent,
        agentPrompt(spec, live, teamNames, false),
      );
      if (accepted && agent.role === 'orchestrator') {
        recordFastLaneKickoffAcceptance(
          scope,
          live,
          agent.sessionId,
          agentPrompt(spec, live, teamNames, false),
        );
      }
    }),
  );
  if (run.agents.length === 0) {
    const detail = failures.join(' · ') || 'nenhum terminal abriu';
    const current = stores.missions.get(missionId);
    if (current && current.status === 'running' && current.intentState) {
      missionEngineForScope(scope).blockTechnical(scope, {
        missionId,
        expectedStatus: current.status,
        expectedIntentState: current.intentState,
        expectedUpdatedAt: current.updatedAt,
        expectedIntentVersion: current.intentVersion ?? 0,
        description: `${current.description ?? ''}\n\n[NEXUS_FAST_LANE]\nNenhum terminal da equipe abriu: ${detail}`.trim(),
      });
    }
    throw new Error(`nenhum terminal da equipe abriu: ${detail}`);
  }
  if (failures.length > 0) {
    console.warn(
      `[fast-lane] ${failures.length} terminal(is) não abriram: ${failures.join(' · ')}`,
    );
  }
  startWatcher(run);
}

/**
 * Retomada: religa terminais mortos da equipe, volta a missão para
 * running/executing quando estava bloqueada e re-arma o observador.
 */
export async function resumeFastLaneMission(
  scope: ProjectExecutionScope,
  missionId: string,
): Promise<void> {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission) throw new Error('missão não encontrada para retomar');
  const squad = mission.squadId ? getSquad(mission.squadId) : null;
  const roster = orderedRoster(squad?.agents ?? []);
  if (roster.length === 0) {
    throw new Error('a missão não tem equipe salva para retomar');
  }

  let live = mission;
  if (mission.status === 'blocked' && mission.intentState) {
    try {
      missionEngineForScope(scope).resumeTechnical(scope, {
        missionId,
        expectedStatus: mission.status,
        expectedIntentState: mission.intentState,
        expectedUpdatedAt: mission.updatedAt,
        expectedIntentVersion: mission.intentVersion ?? 0,
        description: mission.description ?? '',
      });
      live = stores.missions.get(missionId) ?? mission;
    } catch (error) {
      console.warn(
        '[fast-lane] transição blocked→running falhou na retomada:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  stopFastLaneRun(scope, missionId);
  const run: FastLaneRun = {
    scope,
    missionId,
    agents: [],
    startedAt: Date.now(),
    lastBusyAt: Date.now(),
    idleConfirmations: 0,
    timer: null,
  };
  const teamNames = roster.map((agent) => agent.agentName);

  // Panes vivos são ADOTADOS, nunca duplicados — spawnar um segundo
  // coordenador da mesma família de auth é fisicamente recusado (sessão
  // exclusiva), e reabrir CLI viva joga contexto fora.
  const liveByPaneId = new Map(
    listPaneSnapshots()
      .filter(
        (pane) =>
          pane.sessionId &&
          ['spawning', 'busy', 'idle'].includes(pane.state ?? ''),
      )
      .map((pane) => [pane.paneId, pane] as const),
  );
  const paneRows = stores.missionPanes.list(missionId);
  for (const agent of roster) {
    const row = [...paneRows]
      .reverse()
      .find(
        (pane) =>
          pane.agentName === agent.agentName &&
          pane.paneId &&
          liveByPaneId.has(pane.paneId),
      );
    const alive = row?.paneId ? liveByPaneId.get(row.paneId) : undefined;
    if (alive?.sessionId && row?.paneId) {
      const adopted: FastLaneAgentRun = {
        agentId: agent.id,
        agentName: agent.agentName,
        role: agent.category === 'orchestrator' ? 'orchestrator' : 'worker',
        adapterId: agent.cli,
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
        paneId: row.paneId,
        sessionId: alive.sessionId,
        wasBusy: alive.state === 'busy',
        respawned: false,
        nudged: false,
        promptDeliveredAt: Date.now(),
      };
      run.agents.push(adopted);
      if (alive.state === 'idle') {
        await deliverPrompt(adopted, agentPrompt(agent, live, teamNames, true));
      }
      continue;
    }
    const spawned = await spawnAgentPane(scope, live, agent, null);
    if ('error' in spawned) {
      console.warn(`[fast-lane] retomada não abriu ${agent.agentName}: ${spawned.error}`);
      continue;
    }
    run.agents.push(spawned);
    await deliverPrompt(spawned, agentPrompt(agent, live, teamNames, true));
  }
  if (run.agents.length === 0) {
    throw new Error('a retomada não conseguiu abrir nenhum terminal');
  }
  startWatcher(run);
}

/**
 * Adaptador para o boundary do renderer (Retomar/Tentar novamente): entrega o
 * resultado no formato do bootstrap antigo com o pane do coordenador vivo.
 */
export function fastLaneOrchestratorPaneSummary(
  scope: ProjectExecutionScope,
  missionId: string,
):
  | {
      readonly paneId: string;
      readonly sessionId: string;
      readonly adapterId: string;
      readonly model?: string;
      readonly accountId?: string;
      readonly effort?: string;
      readonly cwd: string;
      readonly title: string;
      readonly agentName: string;
      readonly role: 'orchestrator';
    }
  | null {
  const run = runs.get(runKey(scope, missionId));
  const orchestrator =
    run?.agents.find((agent) => agent.role === 'orchestrator') ??
    run?.agents[0];
  if (!orchestrator) return null;
  return {
    paneId: orchestrator.paneId,
    sessionId: orchestrator.sessionId,
    adapterId: orchestrator.adapterId,
    ...(orchestrator.model ? { model: orchestrator.model } : {}),
    ...(orchestrator.accountId ? { accountId: orchestrator.accountId } : {}),
    ...(orchestrator.effort ? { effort: orchestrator.effort } : {}),
    cwd: scope.rootRealPath,
    title: orchestrator.agentName,
    agentName: orchestrator.agentName,
    role: 'orchestrator',
  };
}
