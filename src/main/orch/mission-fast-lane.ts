import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import type { Mission, Squad, SquadAgent } from '../../shared/orch-types';
import { isUiMissionText } from '../../shared/mission-work-kind';
import { buildOrchestratorDoctrine } from './orchestrator-doctrine';
import { getSessionState } from '../pty/pty-manager';
import { deliverAgentPrompt } from './tool-util';
import { listPaneSnapshots, requestPaneSpawn } from './pane-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import { getSquad } from './squad-store';
import { missionEngineForScope } from './mission-engine-registry';
import {
  missionMarkerObserver,
  type MissionMarkerSighting,
} from './mission-completion-marker';

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
 * O motor cerimonial foi removido fisicamente (varredura 2026-08-10): a Via
 * Rápida é o caminho único de execução de missão.
 */

const TICK_MS = 5_000;
/** Confirmações consecutivas de assentamento antes de concluir (2 × tick). */
const IDLE_CONFIRMATIONS_TO_COMPLETE = 2;
/** Pane que nunca ficou busy depois do prompt ganha UMA recarga de prompt. */
const BOOT_NUDGE_AFTER_MS = 90_000;
/**
 * Teto de recargas por agente. Sem ele o tick reentregava o prompt INTEIRO a
 * cada 90s para sempre quando o parsing de estado da CLI não flipava para busy
 * — e CLI que já tinha entregue a parte dela refazia tudo em loop (agy: "sua
 * conversa já está aberta em outra instância"). Trabalho refeito é pior que
 * silêncio: duplica escrita no workspace. Depois do teto o agente para de ser
 * cutucado e o watchdog de silêncio converte em bloqueio VISÍVEL com Retomar.
 */
const MAX_BOOT_NUDGES = 2;
/** Sem nenhum agente busy por este intervalo ⇒ bloqueio técnico visível. */
const STALL_BLOCK_AFTER_MS = 10 * 60_000;
/** Idade mínima da missão antes de o watchdog de silêncio poder agir. */
const STALL_MIN_MISSION_AGE_MS = 15 * 60_000;

export function missionFastLaneEnabled(): boolean {
  // Caminho único: o motor cerimonial e o env NEXUS_CEREMONIAL_MISSIONS
  // morreram na varredura de 2026-08-10.
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
  /** Quantas recargas de prompt este agente já recebeu (teto MAX_BOOT_NUDGES). */
  nudges: number;
  promptDeliveredAt: number;
  /**
   * A palavra do próprio agente (`PRONTO:`/`BLOQUEADO:`), travada no primeiro
   * tick que a enxerga. Autoridade acima do estado do PTY: CLI que nunca flipa
   * para `busy` (agy) entregava e era cutucada em loop para refazer tudo.
   */
  marker: MissionMarkerSighting | null;
}

/**
 * Vereditos possíveis de uma equipe. `pending` = ainda há agente sem entrega
 * provada; conclusão só pode ser `success` quando NINGUÉM está pendente e
 * ninguém se declarou bloqueado.
 */
export type FastLaneVerdict =
  | { readonly kind: 'pending' }
  | { readonly kind: 'success' }
  | { readonly kind: 'blocked'; readonly reason: string };

export interface FastLaneAgentDelivery {
  readonly agentName: string;
  readonly wasBusy: boolean;
  readonly marker: MissionMarkerSighting | null;
}

/** Este agente entregou alguma coisa? Trabalho observado OU palavra dada. */
export function agentDelivered(agent: FastLaneAgentDelivery): boolean {
  return agent.wasBusy || agent.marker !== null;
}

/**
 * Veredito da equipe, puro. Um `BLOQUEADO:` de qualquer agente proíbe `success`
 * e carrega a FRASE DELE para o bloqueio — o operador tem que ler o motivo do
 * agente, não um genérico "os terminais ficaram calados".
 */
export function fastLaneVerdict(
  agents: readonly FastLaneAgentDelivery[],
): FastLaneVerdict {
  if (agents.length === 0) return { kind: 'pending' };
  if (!agents.every(agentDelivered)) return { kind: 'pending' };
  const blocked = agents.filter((agent) => agent.marker?.kind === 'blocked');
  if (blocked.length === 0) return { kind: 'success' };
  const detail = blocked
    .map((agent) => `${agent.agentName}: ${agent.marker?.text ?? ''}`.trim())
    .join(' · ');
  return {
    kind: 'blocked',
    reason:
      `A equipe reportou BLOQUEADO — ${detail}. ` +
      'Resolva o impedimento e use Retomar.',
  };
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
  designContext = '',
  squad: Squad | null = null,
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
  // Missão de interface: o agente deve honrar o design system do projeto e as
  // skills de design da própria CLI — sem isso cada pane inventa um estilo.
  const uiLine = isUiMissionText(objective)
    ? [
        'Trabalho de interface: siga o design system do projeto e use as skills de design disponíveis na sua CLI antes de criar estilo novo.',
        designContext,
      ]
        .filter(Boolean)
        .join(' ')
    : '';
  // A doutrina de orquestração (espera dirigida por handoff, delegação fiel,
  // política de workspace, nota de voz) + o playbook do squad entram SÓ no
  // prompt da coordenação. Workers têm o worker-handoff-contract; não duplicar.
  const doctrine =
    agent.category === 'orchestrator'
      ? buildOrchestratorDoctrine(squad, mission)
      : '';
  return [
    header,
    `Objetivo da missão: ${objective}`,
    teamLine,
    resumeLine,
    roleLine,
    uiLine,
    instructions,
    'Quando terminar, escreva uma linha final "PRONTO: <resumo curto>".',
    'Se algo impedir totalmente o trabalho, escreva "BLOQUEADO: <motivo>" em uma linha.',
    doctrine,
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

/**
 * CLIs que consomem o prompt como ARGUMENTO de largada (canal nativo do
 * pty-manager). Para elas a colagem inicial é pulada — o agente já nasce com
 * a missão; a colagem fica como nudge de reforço para quem não trabalhou.
 */
const NATIVE_INITIAL_PROMPT_ADAPTERS: ReadonlySet<string> = new Set([
  'agy',
  'codex',
  'claude',
  'glm',
  'longcat',
  'kimi',
  'opencode',
]);

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
  initialPrompt?: string,
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
  // requestPaneSpawn é o caminho VISÍVEL: cria o tile no grid do renderer
  // (xterm real, clicável — a autonomia do operador) e mantém o fluxo de
  // estado do PTY vivo. O spawner headless deixava a equipe trabalhando
  // invisível ("nenhum pane foi aberto" com 8 CLIs vivas). Selo NUNCA é
  // passado daqui: o canonicalizador do spawn carimba o atual sozinho.
  const spawn = await requestPaneSpawn({
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
    ...(initialPrompt ? { initialPrompt } : {}),
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
  // Largada nativa: o prompt vai como ARGUMENTO e a TUI o ecoa na tela. Armar o
  // observador aqui, antes de qualquer byte, é o que impede o eco da própria
  // instrução (que contém as palavras PRONTO:/BLOQUEADO:) de virar veredito.
  if (initialPrompt) {
    missionMarkerObserver.registerPrompt(spawn.sessionId, initialPrompt);
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
    nudges: 0,
    promptDeliveredAt: 0,
    marker: null,
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
 * Carimba a entrega no relógio do nudge E arma a trava de eco do observador com
 * o texto EXATO entregue. Todo caminho de entrega (largada nativa, colagem,
 * recarga, retomada) passa por aqui: prompt entregue sem registrar é prompt
 * cujo eco o motor pode confundir com a resposta do agente.
 */
function markPromptDelivered(run: FastLaneAgentRun, prompt: string): void {
  run.promptDeliveredAt = Date.now();
  missionMarkerObserver.registerPrompt(run.sessionId, prompt);
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
  markPromptDelivered(run, prompt);
  try {
    await waitPastSpawning(run.sessionId);
    markPromptDelivered(run, prompt);
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
  // Quando o agente disse com todas as letras o que entregou, é a FRASE DELE
  // que vai para o resultado — o operador lê o trabalho, não a lista de nomes.
  const reported = run.agents
    .filter((agent) => agent.marker?.kind === 'done')
    .map((agent) => `${agent.agentName}: ${agent.marker?.text ?? ''}`.trim());
  const summary =
    'Equipe concluiu e assentou: ' +
    run.agents.map((agent) => agent.agentName).join(', ') +
    '. Resultado nos terminais e no workspace.' +
    (reported.length > 0 ? `\n\n${reported.join('\n')}` : '');
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
    // A palavra do agente vem ANTES da máquina de estados do PTY. Quem escreveu
    // `PRONTO:`/`BLOQUEADO:` já se pronunciou: está assentado, não recebe mais
    // recarga de prompt e não é respawnado. Era exatamente aqui que a `agy` —
    // pane parado em "Pronto", `busy` que nunca chegou — refazia a tarefa a
    // cada 90s tendo entregue na primeira vez.
    agent.marker ??= missionMarkerObserver.markerOf(agent.sessionId);
    if (agent.marker) continue;
    const state = getSessionState(agent.sessionId);
    if (state === 'busy') {
      agent.wasBusy = true;
      run.lastBusyAt = now;
      allSettled = false;
      continue;
    }
    if (state === 'spawning' || state === 'idle') {
      if (state === 'idle' && agent.wasBusy) continue; // assentou após trabalhar
      // Vivo mas nunca trabalhou (idle) OU preso em spawning: prompt pode ter
      // se perdido no boot da TUI. O nudge re-tenta em janelas de 90s (a
      // entrega re-carimba o relógio) — uma TUI lenta ganha quantas recargas
      // precisar. `spawning` preso também recebe nudge: já houve retomada em
      // que o parsing nunca flipou e a frota inteira ficou muda.
      allSettled = false;
      if (
        agent.nudges < MAX_BOOT_NUDGES &&
        (agent.promptDeliveredAt === 0 ||
          now - agent.promptDeliveredAt > BOOT_NUDGE_AFTER_MS)
      ) {
        agent.nudges += 1;
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
              missionDesignContext(run.scope.rootRealPath),
              squad,
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
        const prompt = agentPrompt(
          spec,
          mission,
          run.agents.map((item) => item.agentName),
          true,
          missionDesignContext(run.scope.rootRealPath),
          squad,
        );
        const respawned = await spawnAgentPane(
          run.scope,
          mission,
          spec,
          null,
          prompt,
        );
        if ('error' in respawned) {
          console.warn(`[fast-lane] respawn falhou: ${respawned.error}`);
          return;
        }
        agent.paneId = respawned.paneId;
        agent.sessionId = respawned.sessionId;
        if (NATIVE_INITIAL_PROMPT_ADAPTERS.has(agent.adapterId)) {
          markPromptDelivered(agent, prompt);
          return;
        }
        await deliverPrompt(agent, prompt);
      })();
      continue;
    }
    // Respawn já gasto e morreu de novo sem trabalhar: NÃO conta como
    // assentado — done falso é pior que bloqueio visível. O watchdog de
    // silêncio converte em bloqueio com Retomar.
    allSettled = false;
  }

  // TODOS entregaram — `some()` produziu missão done com 2 de 3 agentes mortos
  // sem executar e o artefato do objetivo inexistente (smoke 0.30.0). Entrega =
  // trabalho observado no PTY OU a palavra do próprio agente; sem nenhum dos
  // dois (mudo e morto duas vezes) continua não sendo sucesso.
  const verdict = fastLaneVerdict(run.agents);
  if (allSettled && verdict.kind !== 'pending') {
    run.idleConfirmations += 1;
    if (run.idleConfirmations >= IDLE_CONFIRMATIONS_TO_COMPLETE) {
      // Quem disse BLOQUEADO proíbe o sucesso e empresta o próprio motivo.
      if (verdict.kind === 'blocked') blockRunVisible(run, verdict.reason);
      else completeRun(run);
    }
    return;
  }
  run.idleConfirmations = 0;

  const missionAge = now - run.startedAt;
  const silentFor = now - run.lastBusyAt;
  if (
    missionAge > STALL_MIN_MISSION_AGE_MS &&
    silentFor > STALL_BLOCK_AFTER_MS &&
    verdict.kind === 'pending'
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
  const designContext = missionDesignContext(scope.rootRealPath);
  const spawnedPairs: Array<{ spec: SquadAgent; agent: FastLaneAgentRun }> = [];
  for (const agent of roster) {
    try {
      // O prompt vai como ARGUMENTO de largada (canal nativo) — a colagem
      // pós-boot falhava contra TUIs reais (missão 10/08: 8/8 panes mudos).
      const prompt = agentPrompt(agent, live, teamNames, false, designContext);
      const spawned = await spawnAgentPane(
        scope,
        live,
        agent,
        runtimeHint,
        prompt,
      );
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
  // Fase 2 — colagem SÓ para CLIs sem canal nativo de largada; para as
  // nativas o agente já nasceu com a missão (colar de novo duplicaria).
  await Promise.all(
    spawnedPairs.map(async ({ spec, agent }) => {
      const prompt = agentPrompt(
        spec,
        live,
        teamNames,
        false,
        designContext,
        squad,
      );
      if (NATIVE_INITIAL_PROMPT_ADAPTERS.has(agent.adapterId)) {
        markPromptDelivered(agent, prompt);
        if (agent.role === 'orchestrator') {
          recordFastLaneKickoffAcceptance(scope, live, agent.sessionId, prompt);
        }
        return;
      }
      const accepted = await deliverPrompt(agent, prompt);
      if (accepted && agent.role === 'orchestrator') {
        recordFastLaneKickoffAcceptance(scope, live, agent.sessionId, prompt);
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
        // Pane adotado numa retomada já recebeu prompt em vida anterior: entra
        // com o teto parcialmente gasto para a retomada não virar re-execução
        // em série do mesmo trabalho.
        nudges: 1,
        promptDeliveredAt: Date.now(),
        // Pane vivo adotado: o veredito que ele já tenha dado nesta vida
        // continua valendo — retomada não apaga trabalho declarado.
        marker: missionMarkerObserver.markerOf(alive.sessionId),
      };
      run.agents.push(adopted);
      if (alive.state === 'idle') {
        await deliverPrompt(
          adopted,
          agentPrompt(
            agent,
            live,
            teamNames,
            true,
            missionDesignContext(scope.rootRealPath),
            squad,
          ),
        );
      }
      continue;
    }
    const resumePrompt = agentPrompt(
      agent,
      live,
      teamNames,
      true,
      missionDesignContext(scope.rootRealPath),
      squad,
    );
    const spawned = await spawnAgentPane(scope, live, agent, null, resumePrompt);
    if ('error' in spawned) {
      console.warn(`[fast-lane] retomada não abriu ${agent.agentName}: ${spawned.error}`);
      continue;
    }
    run.agents.push(spawned);
    if (NATIVE_INITIAL_PROMPT_ADAPTERS.has(spawned.adapterId)) {
      markPromptDelivered(spawned, resumePrompt);
      continue;
    }
    await deliverPrompt(spawned, resumePrompt);
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
