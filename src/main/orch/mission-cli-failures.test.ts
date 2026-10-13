import { afterEach, describe, expect, it } from 'vitest';
import {
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
});
