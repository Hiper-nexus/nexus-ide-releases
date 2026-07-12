import { describe, expect, it } from 'vitest';
import {
  AgentAttentionTracker,
  AgentTransitionTracker,
  MissionTransitionTracker,
} from './pet-events';

const at = 1_000;

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
    ).toEqual([{ kind: 'mission-done', title: 'Deploy', at: at + 1 }]);
  });

  it('dispara mission-blocked quando a missão passa a esperar um humano', () => {
    const t = new MissionTransitionTracker();
    t.ingest('a', [{ id: '1', title: 'Deploy', status: 'running' }], at);
    expect(
      t.ingest('a', [{ id: '1', title: 'Deploy', status: 'blocked' }], at),
    ).toEqual([{ kind: 'mission-blocked', title: 'Deploy', at }]);
  });

  it('dispara mission-failed e ignora transições irrelevantes', () => {
    const t = new MissionTransitionTracker();
    t.ingest('a', [{ id: '1', title: 'Build', status: 'pending' }], at);
    expect(
      t.ingest('a', [{ id: '1', title: 'Build', status: 'running' }], at),
    ).toEqual([]);
    expect(
      t.ingest('a', [{ id: '1', title: 'Build', status: 'failed' }], at),
    ).toEqual([{ kind: 'mission-failed', title: 'Build', at }]);
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
    ).toEqual([{ kind: 'mission-done', title: 'Boot', at }]);
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
    ).toEqual([{ kind: 'mission-done', title: 'A', at }]);
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
