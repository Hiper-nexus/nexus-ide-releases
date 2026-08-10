import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneSessionState } from '../../shared/surface-payload-types';
import type { Mission, SquadAgent } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';

/**
 * Prova de comportamento da Via Rápida em cima do marcador do agente.
 *
 * O bug ao vivo: `agy` nunca flipou para `busy` (pane parado em "Pronto"), o
 * motor leu "viva mas nunca trabalhou" e reentregou o prompt INTEIRO a cada
 * 90s para sempre — o agente já tinha escrito `PRONTO: ...` e refazia tudo em
 * loop. Cada teste abaixo roda o observador REAL de tick (setInterval) com
 * relógio falso, e o par baseline/corrigido é a prova: mesmas condições, só a
 * palavra do agente muda.
 */

const sessionStates = new Map<string, PaneSessionState | null>();
const deliverAgentPrompt = vi.fn(async () => true);
const completeVerified = vi.fn();
const blockTechnical = vi.fn();
const resumeTechnical = vi.fn();
let spawnCount = 0;

vi.mock('../pty/pty-manager', () => ({
  getSessionState: (sessionId: string) => sessionStates.get(sessionId) ?? null,
}));

vi.mock('./tool-util', () => ({
  deliverAgentPrompt: (...args: unknown[]) => deliverAgentPrompt(...(args as [])),
}));

vi.mock('./pane-registry', () => ({
  listPaneSnapshots: () => [],
  requestPaneSpawn: async () => {
    spawnCount += 1;
    const sessionId = `session-${spawnCount}`;
    sessionStates.set(sessionId, 'idle');
    return { requestId: 'r', ok: true, paneId: `pane-${spawnCount}`, sessionId };
  },
}));

const mission: Mission = {
  id: 'mission-1',
  title: 'Prova',
  description: 'Leia brief.txt e escreva a primeira frase em resumo.txt.',
  status: 'pending',
  intentState: 'ready_to_start',
  intentVersion: 1,
  createdAt: 1,
  updatedAt: 1,
  squadId: 'squad-1',
  milestones: [],
} as unknown as Mission;

let liveMission: Mission = mission;

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      get: () => liveMission,
      transitionLifecycle: (
        _id: string,
        _expected: unknown,
        next: { status: string; intentState: string },
      ) => {
        liveMission = { ...liveMission, ...next } as Mission;
        return liveMission;
      },
      setOrchestratorSession: () => {},
      recordKickoffAcceptance: () => {},
    },
    missionPanes: { record: () => {}, list: () => [] },
  }),
}));

const squadAgents: SquadAgent[] = [
  {
    id: 'coord',
    agentName: 'Coordenar e revisar',
    category: 'orchestrator',
    cli: 'agy',
  } as SquadAgent,
  {
    id: 'exec-1',
    agentName: 'Implementar motor',
    category: 'executor',
    cli: 'agy',
  } as SquadAgent,
];

vi.mock('./squad-store', () => ({
  getSquad: () => ({ id: 'squad-1', agents: squadAgents }),
}));

vi.mock('./mission-engine-registry', () => ({
  missionEngineForScope: () => ({
    completeVerified: (...args: unknown[]) => completeVerified(...args),
    blockTechnical: (...args: unknown[]) => blockTechnical(...args),
    resumeTechnical: (...args: unknown[]) => resumeTechnical(...args),
  }),
}));

type FastLaneModule = typeof import('./mission-fast-lane');
type MarkerModule = typeof import('./mission-completion-marker');

let fastLane: FastLaneModule;
let marker: MarkerModule;

const scope = testProjectScope();
/** Sessões que a fase de spawn cria, na ordem do roster. */
const SESSIONS = ['session-1', 'session-2'] as const;

/** Escreve a linha final do agente na sessão, como a TUI faria. */
function agentSays(sessionId: string, line: string): void {
  marker.missionMarkerObserver.observe(sessionId, `${line}\n`);
}

async function bootAllIdle(): Promise<void> {
  await fastLane.fastLaneBootstrap(scope, 'mission-1');
  // Nenhum agente jamais fica `busy`: é exatamente o estado da `agy` no bug.
  for (const sessionId of SESSIONS) sessionStates.set(sessionId, 'idle');
}

/** Avança o relógio em ticks de 5s do observador. */
async function ticks(count: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(5_000 * count);
}

beforeEach(async () => {
  vi.useFakeTimers();
  sessionStates.clear();
  deliverAgentPrompt.mockClear();
  completeVerified.mockClear();
  blockTechnical.mockClear();
  resumeTechnical.mockClear();
  spawnCount = 0;
  liveMission = mission;
  // A Via Rápida guarda os runs vivos em estado de módulo (e `fastLaneBootstrap`
  // é idempotente por missão): sem grafo novo, o segundo teste do arquivo cairia
  // no guard e nunca abriria terminal nenhum.
  vi.resetModules();
  fastLane = await import('./mission-fast-lane');
  marker = await import('./mission-completion-marker');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Via Rápida × marcador do agente', () => {
  it('BASELINE do bug: sem marcador, pane idle eterno é recutucado e nada conclui', async () => {
    await bootAllIdle();
    // Muito além da janela de 90s: o motor só tem o estado do PTY para ler.
    await ticks(40);

    expect(deliverAgentPrompt).toHaveBeenCalled();
    expect(completeVerified).not.toHaveBeenCalled();
  });

  it('todos escreveram PRONTO: conclui com sucesso e ninguém é cutucado, mesmo sem nunca ficar busy', async () => {
    await bootAllIdle();
    agentSays(SESSIONS[0], 'PRONTO: revisei o resultado e está correto.');
    agentSays(
      SESSIONS[1],
      'PRONTO: Primeira frase do brief.txt gravada em resumo.txt.',
    );

    await ticks(40);

    expect(deliverAgentPrompt).not.toHaveBeenCalled();
    expect(blockTechnical).not.toHaveBeenCalled();
    expect(completeVerified).toHaveBeenCalledTimes(1);
    const [, args] = completeVerified.mock.calls[0] as [
      unknown,
      { result: { outcome: string; summary: string } },
    ];
    expect(args.result.outcome).toBe('success');
    // O resultado carrega a frase do próprio agente, não só a lista de nomes.
    expect(args.result.summary).toContain('Primeira frase do brief.txt');
  });

  it('eco do prompt na tela NÃO conclui missão nenhuma (a armadilha)', async () => {
    await fastLaneBootstrap(scope, 'mission-1');
    for (const sessionId of SESSIONS) sessionStates.set(sessionId, 'idle');
    // A TUI ecoa o prompt entregue, inclusive quebrado por largura — é o texto
    // que CONTÉM "PRONTO:" e "BLOQUEADO:" porque é a instrução que os pede.
    const echo = [
      'Quando terminar, escreva uma linha final',
      '"PRONTO: <resumo curto>".',
      'Se algo impedir totalmente o trabalho, escreva',
      '"BLOQUEADO: <motivo>" em uma linha.',
    ].join('\n');
    for (const sessionId of SESSIONS) {
      missionMarkerObserver.observe(sessionId, `${echo}\n`);
    }

    await ticks(4);

    expect(completeVerified).not.toHaveBeenCalled();
    expect(blockTechnical).not.toHaveBeenCalled();
  });

  it('um PRONTO + um BLOQUEADO: não conclui como sucesso e o bloqueio cita o motivo do agente', async () => {
    await bootAllIdle();
    agentSays(SESSIONS[0], 'PRONTO: revisei o que existia.');
    agentSays(SESSIONS[1], 'BLOQUEADO: brief.txt não existe no diretório.');

    await ticks(4);

    expect(completeVerified).not.toHaveBeenCalled();
    expect(blockTechnical).toHaveBeenCalledTimes(1);
    const [, args] = blockTechnical.mock.calls[0] as [
      unknown,
      { description: string },
    ];
    expect(args.description).toContain(
      'brief.txt não existe no diretório.',
    );
    expect(args.description).toContain('Implementar motor');
    // Nada de genérico: o operador lê a frase do agente, não "terminais calados".
    expect(args.description).not.toContain('terminais calados');
  });

  it('sem marcador, mudo e morto duas vezes continua não sendo sucesso', async () => {
    await fastLaneBootstrap(scope, 'mission-1');
    // Ninguém trabalhou e as sessões morreram: o respawn é gasto e elas morrem
    // de novo. Nenhuma palavra dada, nenhum `busy` observado.
    for (const sessionId of SESSIONS) sessionStates.set(sessionId, 'exited');
    await ticks(2);
    for (const [sessionId] of sessionStates) {
      sessionStates.set(sessionId, 'exited');
    }
    await ticks(6);

    expect(completeVerified).not.toHaveBeenCalled();
  });
});
