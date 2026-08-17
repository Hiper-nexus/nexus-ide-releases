import { describe, expect, it } from 'vitest';
import {
  AgentAttentionTracker,
  AgentTransitionTracker,
  MissionTransitionTracker,
} from './pet-events';
import type { MissionIntentContract } from '../../shared/mission-intent';
import { TERMINAL_OPERATIONAL_FAILURE_MARKER } from '../../shared/mission-recovery-policy';

const at = 1_000;
const automaticRecoveryAuthority = {
  intentVersion: 1,
  intentContract: {
    goal: 'Recuperar missão',
    intentVersion: 1,
    approvedAt: 1,
  } as MissionIntentContract,
};

describe('MissionTransitionTracker', () => {
  it('não dispara nada na primeira leva (seed), mesmo com done presente', () => {
    const t = new MissionTransitionTracker();
    expect(
      t.ingest('a', [{ id: '1', title: 'Deploy', status: 'done' }], at),
    ).toEqual([]);
  });

  it('dispara mission-done na transição running → done', () => {
    const t = new MissionTransitionTracker();
    t.ingest('a', [{ id: '1', title: 'Deploy', status: 'running' }], at);
    expect(
      t.ingest('a', [{ id: '1', title: 'Deploy', status: 'done' }], at + 1),
    ).toEqual([{ kind: 'mission-done', title: 'Deploy', at: at + 1, missionId: '1' }]);
  });

  it('dispara mission-blocked quando a missão passa a esperar um humano', () => {
    const t = new MissionTransitionTracker();
    t.ingest('a', [{ id: '1', title: 'Deploy', status: 'running' }], at);
    expect(
      t.ingest('a', [{ id: '1', title: 'Deploy', status: 'blocked' }], at),
    ).toEqual([
      {
        kind: 'mission-blocked',
        title: 'Deploy',
        at,
        missionId: '1',
        // Sem nota durável, o evento admite que não sabe — nunca inventa.
        cause: {
          code: 'unknown',
          headline: 'Motivo não registrado.',
          action: 'Abra o diagnóstico da missão para ver o que aconteceu.',
        },
      },
    ]);
  });

  it('não pede intervenção durante retry técnico, mas avisa se virar espera humana', () => {
    const t = new MissionTransitionTracker();
    t.ingest(
      'a',
      [{ id: '1', title: 'Deploy', status: 'running', intentState: 'executing' }],
      at,
    );
    expect(
      t.ingest(
        'a',
        [
          {
            id: '1',
            title: 'Deploy',
            status: 'blocked',
            intentState: 'blocked_technical',
            ...automaticRecoveryAuthority,
          },
        ],
        at + 1,
      ),
    ).toEqual([]);
    expect(
      t.ingest(
        'a',
        [
          {
            id: '1',
            title: 'Deploy',
            status: 'blocked',
            intentState: 'blocked_user',
          },
        ],
        at + 2,
      ),
    ).toEqual([
      {
        kind: 'mission-blocked',
        title: 'Deploy',
        at: at + 2,
        missionId: '1',
        // Bloqueio sem nota durável: honesto, nunca "aguardando decisão".
        cause: {
          code: 'unknown',
          headline: 'Motivo não registrado.',
          action: 'Abra o diagnóstico da missão para ver o que aconteceu.',
        },
      },
    ]);
  });

  it('reporta falha técnica quando blocked_technical esgotou o retry', () => {
    const t = new MissionTransitionTracker();
    t.ingest('a', [{ id: '1', title: 'Deploy', status: 'running' }], at);

    expect(
      t.ingest(
        'a',
        [
          {
            id: '1',
            title: 'Deploy',
            status: 'blocked',
            intentState: 'blocked_technical',
          },
        ],
        at + 1,
      ),
    ).toEqual([
      {
        kind: 'mission-technical-failure',
        title: 'Deploy',
        at: at + 1,
        missionId: '1',
        cause: {
          code: 'unknown',
          headline: 'Motivo não registrado.',
          action: 'Abra o diagnóstico da missão para ver o que aconteceu.',
        },
      },
    ]);
  });

  it('muda de recuperação silenciosa para falha técnica ao esgotar retries', () => {
    const t = new MissionTransitionTracker();
    t.ingest(
      'a',
      [{ id: '1', title: 'Deploy', status: 'running', intentState: 'executing' }],
      at,
    );
    expect(
      t.ingest(
        'a',
        [
          {
            id: '1',
            title: 'Deploy',
            description: '',
            status: 'blocked',
            intentState: 'blocked_technical',
            ...automaticRecoveryAuthority,
          },
        ],
        at + 1,
      ),
    ).toEqual([]);

    expect(
      t.ingest(
        'a',
        [
          {
            id: '1',
            title: 'Deploy',
            description: TERMINAL_OPERATIONAL_FAILURE_MARKER,
            status: 'blocked',
            intentState: 'blocked_technical',
            ...automaticRecoveryAuthority,
          },
        ],
        at + 2,
      ),
    ).toEqual([
      {
        kind: 'mission-technical-failure',
        title: 'Deploy',
        at: at + 2,
        missionId: '1',
        cause: {
          code: 'terminal-failure',
          headline: 'A recuperação automática se esgotou nesta falha.',
          action:
            'Abra o diagnóstico da missão, corrija a causa e retome a missão.',
        },
      },
    ]);
  });

  it('não repete alerta ao normalizar bloqueio legado para blocked_user', () => {
    const t = new MissionTransitionTracker();
    t.ingest('a', [{ id: '1', title: 'Deploy', status: 'running' }], at);

    expect(
      t.ingest(
        'a',
        [
          {
            id: '1',
            title: 'Deploy',
            status: 'blocked',
            intentState: 'dispatched',
          },
        ],
        at + 1,
      ),
    ).toEqual([
      {
        kind: 'mission-blocked',
        title: 'Deploy',
        at: at + 1,
        missionId: '1',
        cause: {
          code: 'unknown',
          headline: 'Motivo não registrado.',
          action: 'Abra o diagnóstico da missão para ver o que aconteceu.',
        },
      },
    ]);

    expect(
      t.ingest(
        'a',
        [
          {
            id: '1',
            title: 'Deploy',
            status: 'blocked',
            intentState: 'blocked_user',
          },
        ],
        at + 2,
      ),
    ).toEqual([]);
  });

  it('expõe “Handoff não entregue” no alerta quando esse foi o bloqueio', () => {
    const t = new MissionTransitionTracker();
    t.ingest(
      'a',
      [{ id: '1', title: 'Deploy', description: '', status: 'running' }],
      at,
    );
    expect(
      t.ingest(
        'a',
        [
          {
            id: '1',
            title: 'Deploy',
            description:
              '<!-- nexus:handoff-delivery-failed:h1 -->\nHandoff não entregue. Clique em Reabrir.',
            status: 'blocked',
          },
        ],
        at + 1,
      ),
    ).toEqual([
      {
        kind: 'mission-blocked',
        title: 'Handoff não entregue — Deploy',
        at: at + 1,
        missionId: '1',
        cause: {
          code: 'handoff-not-delivered',
          headline: 'O worker terminou, mas a entrega não chegou ao orquestrador.',
          action: 'Abra o diagnóstico da missão e reenvie a entrega pendente.',
        },
      },
    ]);
  });

  it('dispara mission-failed e ignora transições irrelevantes', () => {
    const t = new MissionTransitionTracker();
    t.ingest('a', [{ id: '1', title: 'Build', status: 'pending' }], at);
    expect(
      t.ingest('a', [{ id: '1', title: 'Build', status: 'running' }], at),
    ).toEqual([]);
    expect(
      t.ingest('a', [{ id: '1', title: 'Build', status: 'failed' }], at),
    ).toEqual([{ kind: 'mission-failed', title: 'Build', at, missionId: '1' }]);
  });

  it('missão nova aparecendo já como done (após o seed) não comemora', () => {
    const t = new MissionTransitionTracker();
    t.ingest('a', [{ id: '1', title: 'A', status: 'running' }], at);
    expect(
      t.ingest(
        'a',
        [
          { id: '1', title: 'A', status: 'running' },
          { id: '2', title: 'B', status: 'done' },
        ],
        at,
      ),
    ).toEqual([]);
  });

  it('seed() hidrata o escopo: a PRIMEIRA transição real já dispara', () => {
    const t = new MissionTransitionTracker();
    t.seed('a', [{ id: '1', title: 'Boot', status: 'running' }]);
    expect(
      t.ingest('a', [{ id: '1', title: 'Boot', status: 'done' }], at),
    ).toEqual([{ kind: 'mission-done', title: 'Boot', at, missionId: '1' }]);
  });

  it('poda missões que saíram da lista do escopo', () => {
    const t = new MissionTransitionTracker();
    t.ingest('a', [
      { id: '1', title: 'A', status: 'running' },
      { id: '2', title: 'B', status: 'running' },
    ], at);
    // "2" removida da lista; se voltar depois, é seed de novo (não transição)
    t.ingest('a', [{ id: '1', title: 'A', status: 'running' }], at);
    expect(
      t.ingest(
        'a',
        [
          { id: '1', title: 'A', status: 'running' },
          { id: '2', title: 'B', status: 'done' },
        ],
        at,
      ),
    ).toEqual([]);
  });

  it('escopos são independentes (seed por escopo)', () => {
    const t = new MissionTransitionTracker();
    t.ingest('a', [{ id: '1', title: 'A', status: 'running' }], at);
    // primeiro contato do escopo b: seed, sem evento
    expect(
      t.ingest('b', [{ id: '1', title: 'Outra', status: 'done' }], at),
    ).toEqual([]);
    // transição real no escopo a continua funcionando
    expect(
      t.ingest('a', [{ id: '1', title: 'A', status: 'done' }], at),
    ).toEqual([{ kind: 'mission-done', title: 'A', at, missionId: '1' }]);
  });

  it('status repetido não repete evento', () => {
    const t = new MissionTransitionTracker();
    t.ingest('a', [{ id: '1', title: 'A', status: 'running' }], at);
    t.ingest('a', [{ id: '1', title: 'A', status: 'done' }], at);
    expect(
      t.ingest('a', [{ id: '1', title: 'A', status: 'done' }], at),
    ).toEqual([]);
  });
});

describe('AgentTransitionTracker', () => {
  it('busy → idle vira agent-idle (celebração leve)', () => {
    const t = new AgentTransitionTracker();
    t.ingest('s1', 'busy', at);
    expect(t.ingest('s1', 'idle', at)).toEqual({
      kind: 'agent-idle',
      title: 's1',
      at,
    });
  });

  it('spawning → idle não celebra (não veio de trabalho)', () => {
    const t = new AgentTransitionTracker();
    t.ingest('s1', 'spawning', at);
    expect(t.ingest('s1', 'idle', at)).toBeNull();
  });

  it('qualquer estado conhecido → exited avisa', () => {
    const t = new AgentTransitionTracker();
    t.ingest('s1', 'busy', at);
    expect(t.ingest('s1', 'exited', at)).toEqual({
      kind: 'agent-exited',
      title: 's1',
      at,
    });
  });

  it('primeira observação já exited não avisa (seed)', () => {
    const t = new AgentTransitionTracker();
    expect(t.ingest('s1', 'exited', at)).toBeNull();
  });

  it('estado repetido é silencioso e forget() reseta o seed', () => {
    const t = new AgentTransitionTracker();
    t.ingest('s1', 'busy', at);
    expect(t.ingest('s1', 'busy', at)).toBeNull();
    t.forget('s1');
    expect(t.ingest('s1', 'exited', at)).toBeNull();
  });
});

describe('AgentAttentionTracker', () => {
  it('entrar em waiting dispara, mesmo na primeira observação', () => {
    const t = new AgentAttentionTracker();
    expect(t.ingest('s1', 'waiting', at)).toEqual({
      kind: 'agent-waiting',
      title: 's1',
      at,
    });
  });

  it('working → blocked dispara; repetição do mesmo estado não', () => {
    const t = new AgentAttentionTracker();
    expect(t.ingest('s1', 'working', at)).toBeNull();
    expect(t.ingest('s1', 'blocked', at)?.kind).toBe('agent-waiting');
    expect(t.ingest('s1', 'blocked', at)).toBeNull();
  });

  it('waiting → working → waiting avisa de novo (novo pedido real)', () => {
    const t = new AgentAttentionTracker();
    t.ingest('s1', 'waiting', at);
    expect(t.ingest('s1', 'working', at)).toBeNull();
    expect(t.ingest('s1', 'waiting', at)?.kind).toBe('agent-waiting');
  });

  it('done/working nunca disparam e forget reseta', () => {
    const t = new AgentAttentionTracker();
    expect(t.ingest('s1', 'done', at)).toBeNull();
    t.ingest('s1', 'waiting', at);
    t.forget('s1');
    expect(t.ingest('s1', 'waiting', at)?.kind).toBe('agent-waiting');
  });
});

describe('MissionTransitionTracker — shutdown não é alerta (bug I)', () => {
  it('missão blocked_technical PELO ENCERRAMENTO do app não gera balão de falha técnica', () => {
    const t = new MissionTransitionTracker();
    t.ingest(
      'a',
      [
        {
          id: '1',
          title: 'HiperGO review',
          status: 'running',
        },
      ],
      at,
    );
    // Shutdown marca a missão com o marcador de runtime fechado pelo
    // operador — mesmo que o intent termine como blocked_technical numa
    // corrida de teardown, fechar o app não é falha técnica.
    const events = t.ingest(
      'a',
      [
        {
          id: '1',
          title: 'HiperGO review',
          status: 'blocked',
          intentState: 'blocked_technical',
          description:
            'Missão em curso.\n<!-- nexus:runtime-closed -->',
        },
      ],
      at + 1,
    );
    expect(events).toEqual([]);
  });
});
