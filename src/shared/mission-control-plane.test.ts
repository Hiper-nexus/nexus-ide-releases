import { describe, expect, it } from 'vitest';
import {
  buildMissionControlSnapshot,
  type MissionControlSnapshotInput,
} from './mission-control-plane';

function baseInput(): MissionControlSnapshotInput {
  return {
    missionId: 'm-1',
    generatedAt: 1_000,
    mission: { status: 'running', description: null },
    panes: [
      {
        paneId: 'pane-a',
        sessionId: 'sess-a',
        title: 'executor',
        state: 'busy',
        adapterId: 'claude',
        model: 'sonnet',
        agentName: 'dev-backend',
        role: 'worker',
      },
      {
        paneId: 'pane-b',
        sessionId: 'sess-b',
        title: 'maestro',
        state: 'idle',
        role: 'orchestrator',
      },
    ],
    schedule: [
      {
        taskId: 't-1',
        title: 'implementar API',
        status: 'running',
        agentName: 'dev-backend',
        stage: 'implementação',
        dependsOn: [],
        waveHint: 1,
      },
      {
        taskId: 't-2',
        title: 'revisar API',
        status: 'pending',
        agentName: 'reviewer',
        stage: 'revisão',
        dependsOn: ['t-1'],
        waveHint: 2,
      },
    ],
    dispatches: [
      {
        taskId: 't-1',
        state: 'running',
        attempt: 0,
        workerId: 'w-1',
        leaseOwner: 'driver',
        leaseExpiresAt: 5_000,
        paneId: 'pane-a',
        sessionId: 'sess-a',
        lastHeartbeatAt: 900,
        ownership: {
          files: ['src/api/**'],
          symbols: [],
          domains: ['api'],
        },
      },
    ],
  };
}

describe('buildMissionControlSnapshot', () => {
  it('funde pane + dispatch ativo em um único snapshot com item corrente', () => {
    const snapshot = buildMissionControlSnapshot(baseInput());

    expect(snapshot.missionId).toBe('m-1');
    expect(snapshot.generatedAt).toBe(1_000);
    expect(snapshot.missionStatus).toBe('running');

    const paneA = snapshot.panes.find((p) => p.paneId === 'pane-a');
    expect(paneA).toBeDefined();
    expect(paneA?.activity).toBe('working');
    expect(paneA?.currentTaskId).toBe('t-1');
    expect(paneA?.currentTaskTitle).toBe('implementar API');
    expect(paneA?.dispatchState).toBe('running');
    expect(paneA?.lastHeartbeatAt).toBe(900);

    const paneB = snapshot.panes.find((p) => p.paneId === 'pane-b');
    expect(paneB?.activity).toBe('idle');
    expect(paneB?.currentTaskId).toBeUndefined();
  });

  it('projeta fila ordenada por wave com estado de dispatch fundido', () => {
    const snapshot = buildMissionControlSnapshot(baseInput());

    expect(snapshot.queue.map((q) => q.taskId)).toEqual(['t-1', 't-2']);
    const running = snapshot.queue[0];
    expect(running.dispatchState).toBe('running');
    expect(running.attempt).toBe(0);
    expect(running.paneId).toBe('pane-a');
    expect(running.waveHint).toBe(1);
    const pending = snapshot.queue[1];
    expect(pending.dispatchState).toBeUndefined();
    expect(pending.dependsOn).toEqual(['t-1']);
  });

  it('expõe o mapa de ownership por task', () => {
    const snapshot = buildMissionControlSnapshot(baseInput());

    expect(snapshot.ownership).toHaveLength(1);
    expect(snapshot.ownership[0]).toMatchObject({
      taskId: 't-1',
      workerId: 'w-1',
      paneId: 'pane-a',
      files: ['src/api/**'],
      domains: ['api'],
    });
  });

  it('não expõe ownership de dispatch superseded ou completed', () => {
    const input = baseInput();
    const snapshot = buildMissionControlSnapshot({
      ...input,
      dispatches: [
        { ...input.dispatches[0], state: 'superseded' },
        { ...input.dispatches[0], taskId: 't-2', state: 'completed' },
      ],
    });
    expect(snapshot.ownership).toHaveLength(0);
  });

  it('classifica pane exited como dead e sem task corrente', () => {
    const input = baseInput();
    const snapshot = buildMissionControlSnapshot({
      ...input,
      panes: [{ ...input.panes[0], state: 'exited' }],
    });
    expect(snapshot.panes[0].activity).toBe('dead');
  });

  it('surfaça bloqueio de task com lastError saneado (sem caminho absoluto)', () => {
    const input = baseInput();
    const snapshot = buildMissionControlSnapshot({
      ...input,
      dispatches: [
        {
          ...input.dispatches[0],
          state: 'blocked',
          lastError:
            'checkout sujo em /Users/cleofasrocha/dev/nexus-ide/worktree-x',
        },
      ],
    });

    const taskBlocks = snapshot.blocks.filter((b) => b.scope === 'task');
    expect(taskBlocks).toHaveLength(1);
    expect(taskBlocks[0].taskId).toBe('t-1');
    expect(taskBlocks[0].text).not.toContain('/Users/cleofasrocha');
    expect(taskBlocks[0].text.length).toBeGreaterThan(0);
    // Dispatch bloqueado também derruba o item corrente do pane.
    const queueEntry = snapshot.queue.find((q) => q.taskId === 't-1');
    expect(queueEntry?.dispatchState).toBe('blocked');
    expect(snapshot.panes[0].currentTaskId).toBeUndefined();
  });

  it('surfaça bloqueio de missão via mission-block-cause quando nomeado', () => {
    const input = baseInput();
    const snapshot = buildMissionControlSnapshot({
      ...input,
      mission: {
        status: 'blocked',
        description:
          '[NEXUS_WORKER_RUNTIME_LOST] O worker não entregou um handoff.',
      },
    });

    const missionBlocks = snapshot.blocks.filter((b) => b.scope === 'mission');
    expect(missionBlocks).toHaveLength(1);
    expect(missionBlocks[0].code).toBeDefined();
    expect(missionBlocks[0].text.length).toBeGreaterThan(0);
  });

  it('não emite bloqueio de missão quando a missão corre saudável', () => {
    const snapshot = buildMissionControlSnapshot(baseInput());
    expect(snapshot.blocks.filter((b) => b.scope === 'mission')).toHaveLength(
      0,
    );
  });
});
