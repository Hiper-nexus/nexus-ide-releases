import { afterEach, describe, expect, it } from 'vitest';
import {
  clearCredentialRouteFailures,
  closedWorkerFailure,
  missionCliFailureNote,
  missionCliFailures,
  noteMissionCliFailure,
  resetMissionCliFailures,
  routeFailureOutcomeRows,
  type ClosedPaneFacts,
} from './mission-cli-failures';

afterEach(() => resetMissionCliFailures());

// F-1427 (13/10): o Maestro fechou o pane do MiMo (travado >1 h) e o do
// MiniMax (erro do provedor) com nexus_pane_close, sem handoff — e a rota
// seguiu tratando as duas CLIs como saudáveis nesta missão.
const MIMO_CLOSED: ClosedPaneFacts = {
  paneId: 'pane-mimo',
  sessionId: 'session-mimo',
  adapterId: 'mimo-code',
  missionId: 'mission-1',
  role: 'worker',
  sessionState: 'idle',
  hasTaskRequest: true,
  handoffAuthors: ['nexus-delegation-supervisor', 'nexus-handoff-enforcement'],
  model: 'mimo-v2.5',
};

describe('F-1427: pane de worker fechado pelo Maestro sem entrega', () => {
  it('worker que recebeu a tarefa e só tem handoff sintético: falha da CLI nesta missão', () => {
    expect(closedWorkerFailure(MIMO_CLOSED)).toEqual({
      missionId: 'mission-1',
      adapterId: 'mimo-code',
      model: 'mimo-v2.5',
      cause: 'closed-without-delivery',
      attemptKey: 'session-mimo',
    });
  });

  it.each<[string, Partial<ClosedPaneFacts>]>([
    ['entregou um handoff real', { handoffAuthors: ['MiMo Writer'] }],
    ['pane do operador (F-231)', { operatorOpened: true }],
    ['orquestrador', { role: 'orchestrator' }],
    ['sem pedido de tarefa', { hasTaskRequest: false }],
    ['ainda nascendo (veredito do watchdog de início)', { sessionState: 'spawning' }],
    ['sessão já encerrada', { sessionState: null }],
    ['fora de missão', { missionId: null }],
  ])('não conta: %s', (_label, patch) => {
    expect(closedWorkerFailure({ ...MIMO_CLOSED, ...patch })).toBeNull();
  });
});

describe('F-1427: registro por (missão, CLI)', () => {
  it('a mesma tentativa conta uma vez; outra missão não enxerga', () => {
    noteMissionCliFailure({ missionId: 'mission-1', adapterId: 'minimax-code', cause: 'provider-error', attemptKey: 's1' });
    noteMissionCliFailure({ missionId: 'mission-1', adapterId: 'minimax-code', cause: 'closed-without-delivery', attemptKey: 's1' });
    noteMissionCliFailure({ missionId: 'mission-1', adapterId: 'minimax-code', cause: 'closed-without-delivery', attemptKey: 's2' });
    expect(missionCliFailures('mission-1', 'minimax-code')).toHaveLength(2);
    expect(missionCliFailures('mission-2', 'minimax-code')).toHaveLength(0);
    expect(missionCliFailureNote('mission-1', 'minimax-code')).toBe(
      'minimax-code (erro do provedor, fechado sem entrega)',
    );
  });

  it('vira amostra failed por (CLI, modelo) dentro da janela do sucesso 14d', () => {
    noteMissionCliFailure({ missionId: 'm', adapterId: 'mimo-code', model: 'mimo-v2.5', cause: 'no-execution-proof', attemptKey: 'a', at: 1_000 });
    noteMissionCliFailure({ missionId: 'm', adapterId: 'mimo-code', model: 'mimo-v2.5', cause: 'closed-without-delivery', attemptKey: 'b', at: 2_000 });
    noteMissionCliFailure({ missionId: 'm', adapterId: 'mimo-code', model: 'mimo-v2.5', cause: 'provider-error', attemptKey: 'c', at: 10 });
    expect(routeFailureOutcomeRows(500)).toEqual([
      { adapterId: 'mimo-code', model: 'mimo-v2.5', successes: 0, total: 2 },
    ]);
  });

  it('ocioso sem entrega entra como falha no sucesso da rota', () => {
    noteMissionCliFailure({ missionId: 'm', adapterId: 'qwen', cause: 'idle-without-delivery', attemptKey: 'idle-1', at: 1_000 });
    expect(missionCliFailureNote('m', 'qwen')).toBe('qwen (ocioso sem entrega)');
    expect(routeFailureOutcomeRows(500)).toEqual([
      { adapterId: 'qwen', successes: 0, total: 1 },
    ]);
  });

  it('probe da credencial passando apaga só as recusas de assento daquela CLI', () => {
    // Campo 19/10: Muse logado seguia 0,00 (5) e "evitou rota falha".
    for (const key of ['r1', 'r2', 'r3']) {
      noteMissionCliFailure({ missionId: 'm', adapterId: 'muse', model: 'muse-wonder-full-1.0', cause: 'credential-remap', attemptKey: key, at: 1_000 });
    }
    noteMissionCliFailure({ missionId: 'm', adapterId: 'muse', model: 'muse-wonder-full-1.0', cause: 'closed-without-delivery', attemptKey: 'real', at: 1_000 });
    noteMissionCliFailure({ missionId: 'm', adapterId: 'kimi', cause: 'credential-remap', attemptKey: 'k', at: 1_000 });
    expect(clearCredentialRouteFailures('muse')).toBe(3);
    expect(routeFailureOutcomeRows(500)).toEqual([
      { adapterId: 'muse', model: 'muse-wonder-full-1.0', successes: 0, total: 1 },
      { adapterId: 'kimi', successes: 0, total: 1 },
    ]);
  });
});
