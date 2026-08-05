import { describe, expect, it } from 'vitest';
import type {
  MissionControlSnapshot,
  MissionControlPaneEntry,
  MissionControlQueueEntry,
} from './mission-control-plane';
import { missionControlPulse } from './mission-control-pulse';

function pane(
  patch: Partial<MissionControlPaneEntry>,
): MissionControlPaneEntry {
  return {
    paneId: 'pane-1',
    sessionId: 'sess-1',
    title: 'Worker',
    state: 'idle',
    activity: 'idle',
    ...patch,
  };
}

function item(
  patch: Partial<MissionControlQueueEntry>,
): MissionControlQueueEntry {
  return {
    taskId: 'task-1',
    title: 'Tarefa',
    status: 'pending',
    waveHint: 1,
    dependsOn: [],
    agentName: null,
    stage: null,
    ...patch,
  };
}

function snapshot(
  patch: Partial<MissionControlSnapshot>,
): MissionControlSnapshot {
  return {
    missionId: 'mission-1',
    generatedAt: 1_000,
    panes: [],
    queue: [],
    ownership: [],
    blocks: [],
    ...patch,
  };
}

describe('missionControlPulse', () => {
  it('answers "is anything running?" with the working count', () => {
    const pulse = missionControlPulse(
      snapshot({
        panes: [
          pane({ paneId: 'p1', activity: 'working', currentTaskId: 'impl' }),
          pane({ paneId: 'p2', activity: 'idle' }),
        ],
        queue: [
          item({ taskId: 'impl', status: 'running', dispatchState: 'running' }),
          item({ taskId: 'rev', dependsOn: ['impl'], waveHint: 2 }),
        ],
      }),
    );

    expect(pulse.running).toBe(1);
    expect(pulse.workingPanes).toBe(1);
    expect(pulse.idlePanes).toBe(1);
    expect(pulse.headline).toBe('1 unidade trabalhando agora');
  });

  it('explains an idle-looking mission as a sequential phase', () => {
    const pulse = missionControlPulse(
      snapshot({
        queue: [
          item({ taskId: 'impl', status: 'running', dispatchState: 'running' }),
          item({ taskId: 'rev', dependsOn: ['impl'], waveHint: 2 }),
          item({ taskId: 'doc', dependsOn: ['rev'], waveHint: 3 }),
        ],
      }),
    );

    expect(pulse.eligible).toBe(0);
    expect(pulse.waitingOnDeps).toBe(2);
    expect(pulse.explanation).toBe(
      'Fase sequencial: nenhuma outra unidade elegível — 2 aguardam dependências.',
    );
  });

  it('counts a pending task with satisfied dependencies as eligible', () => {
    const pulse = missionControlPulse(
      snapshot({
        queue: [
          item({ taskId: 'impl', status: 'done' }),
          item({ taskId: 'rev', dependsOn: ['impl'], waveHint: 2 }),
          item({ taskId: 'doc', dependsOn: ['rev'], waveHint: 3 }),
        ],
      }),
    );

    expect(pulse.eligible).toBe(1);
    expect(pulse.waitingOnDeps).toBe(1);
    expect(pulse.done).toBe(1);
    expect(pulse.headline).toBe(
      'Nada rodando — 1 unidade elegível aguardando despacho',
    );
    expect(pulse.explanation).toBe(
      'Fase sequencial: só 1 unidade elegível — 1 aguarda dependências.',
    );
  });

  it('names blocks instead of pretending the mission is merely idle', () => {
    const pulse = missionControlPulse(
      snapshot({
        queue: [item({ taskId: 'impl', status: 'blocked' })],
        blocks: [
          { scope: 'task', taskId: 'impl', text: 'worktree ocupado' },
        ],
      }),
    );

    expect(pulse.blocked).toBe(1);
    expect(pulse.headline).toBe('Nada rodando — 1 bloqueio');
    expect(pulse.explanation).toBe('worktree ocupado');
  });

  it('reports a dead pane so a reaped worker is never invisible', () => {
    const pulse = missionControlPulse(
      snapshot({
        panes: [
          pane({ paneId: 'p1', activity: 'dead', state: 'exited' }),
          pane({ paneId: 'p2', activity: 'working' }),
        ],
        queue: [item({ taskId: 'impl', status: 'running' })],
      }),
    );

    expect(pulse.deadPanes).toBe(1);
    expect(pulse.explanation).toBe('1 pane morto na missão.');
  });

  it('says the queue is finished rather than "nothing running"', () => {
    const pulse = missionControlPulse(
      snapshot({ queue: [item({ taskId: 'impl', status: 'done' })] }),
    );

    expect(pulse.headline).toBe('Fila concluída');
    expect(pulse.explanation).toBeNull();
  });

  it('reports an empty queue as no plan yet', () => {
    const pulse = missionControlPulse(snapshot({}));

    expect(pulse.headline).toBe('Sem fila');
    expect(pulse.running).toBe(0);
  });

  it('treats an active dispatch as running even before the status flips', () => {
    const pulse = missionControlPulse(
      snapshot({
        queue: [item({ taskId: 'impl', status: 'pending', dispatchState: 'claimed' })],
      }),
    );

    expect(pulse.running).toBe(1);
    expect(pulse.eligible).toBe(0);
  });
});
