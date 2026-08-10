import { describe, expect, it } from 'vitest';

import {
  projectMissionSnapshot,
  resolveMissionAgentLiveState,
  type ProjectMissionSnapshotView,
} from './mission-snapshot';

function runningView(): ProjectMissionSnapshotView {
  return {
    mission: {
      id: 'mission-1',
      title: 'Ship the mission engine',
      objective: 'Make mission execution safe and observable.',
      workspaceLabel: 'nexus-ide',
      status: 'running',
      version: 7,
      updatedAt: 1_777_000_000_000,
    },
    hasDispatchAuthority: true,
    hasCurrentKickoffReceipt: true,
    orchestratorLive: true,
    tasks: [
      {
        id: 'task-1',
        title: 'Implement projector',
        status: 'running',
        agentId: 'agent-1',
        dependsOn: [],
        evidence: [{ id: 'evidence-1', path: 'reports/projector.json' }],
      },
    ],
    handoffs: [],
    panes: [
      {
        paneId: 'pane-1',
        agentId: 'agent-1',
        state: 'working',
        currentUnitId: 'task-1',
      },
    ],
    roster: [
      {
        id: 'agent-1',
        agentName: 'Implementer',
        category: 'executor',
        cli: 'codex',
        ownsPlanDocs: true,
        allowedSkills: ['secret-skill'],
        allowedTools: ['secret-tool'],
        persona: 'secret-persona',
      },
    ],
  };
}

describe('projectMissionSnapshot', () => {
  it('Via Rápida: running sem recibo cerimonial continua running', () => {
    // O tripé autoridade+recibo+liveness era do motor antigo e projetava
    // "Precisa de reparo" sobre equipes vivas. Sob a Via Rápida (padrão),
    // running é running; a vida real está nos panes e no observador.
    const view = runningView();
    view.hasCurrentKickoffReceipt = false;

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('running');
  });

  it('projects done with residual plan work as blocked technical', () => {
    const view = runningView();
    view.mission.status = 'done';
    view.tasks[0]!.status = 'pending';
    view.panes[0]!.state = 'done';

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('blocked_technical');
    expect(snapshot.stateReason?.code).toBe('residual-work');
    expect(snapshot.allowedActions).toEqual(['resume', 'stop']);
  });

  it('gives an open clarification precedence over technical contradictions', () => {
    const view = runningView();
    view.hasCurrentKickoffReceipt = false;
    view.openQuestion = {
      id: 'question-1',
      prompt: 'Which release channel should we use?',
      options: [{ id: 'stable', label: 'Stable' }],
      allowFreeText: false,
    };

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('blocked_user');
    expect(snapshot.stateReason?.code).toBe('open-question');
    expect(snapshot.question).toEqual(view.openQuestion);
    expect(snapshot.allowedActions).toEqual(['answer-question', 'stop']);
  });

  it('projects a verified terminal plan as completed', () => {
    const view = runningView();
    view.mission.status = 'done';
    view.mission.result = {
      outcome: 'success',
      summary: 'Mission engine shipped and verified.',
      evidenceIds: ['evidence-1'],
      artifactRefs: ['commit-1'],
    };
    view.tasks[0]!.status = 'done';
    view.panes[0]!.state = 'done';
    view.handoffs = [
      {
        id: 'handoff-1',
        sourceAgentId: 'agent-1',
        targetAgentId: 'agent-2',
        kind: 'handoff',
        settled: true,
      },
    ];

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('completed');
    expect(snapshot.stateReason).toBeUndefined();
    expect(snapshot.progress).toEqual({ completed: 1, total: 1 });
    expect(snapshot.result).toEqual(view.mission.result);
    expect(snapshot.allowedActions).toEqual([]);
  });

  it('marks every roster member done after verified completion closes their panes', () => {
    const view = runningView();
    view.mission.status = 'done';
    view.mission.result = {
      outcome: 'success',
      summary: 'Mission engine shipped and verified.',
      evidenceIds: ['evidence-1'],
      artifactRefs: ['commit-1'],
    };
    view.tasks[0]!.status = 'done';
    view.panes = [];
    view.roster = [
      {
        id: 'coordinator',
        agentName: 'Coordinator',
        category: 'orchestrator',
        cli: 'codex',
      },
      ...view.roster,
    ];

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('completed');
    expect(snapshot.agents.map((agent) => agent.state)).toEqual([
      'done',
      'done',
    ]);
  });

  it('keeps a canonical result completed despite stale residual projections', () => {
    const view = runningView();
    view.mission.status = 'done';
    view.mission.result = {
      outcome: 'success',
      summary: 'Canonical result already committed by MissionEngine.',
      evidenceIds: ['evidence-1'],
      artifactRefs: ['commit-1'],
    };
    view.tasks[0]!.status = 'pending';
    view.panes[0]!.state = 'working';
    view.handoffs = [
      {
        id: 'handoff-stale',
        sourceAgentId: 'agent-1',
        targetAgentId: 'agent-1',
        kind: 'handoff',
        settled: false,
      },
    ];

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('completed');
    expect(snapshot.stateReason).toBeUndefined();
    expect(snapshot.allowedActions).toEqual([]);
    expect(snapshot.result).toEqual(view.mission.result);
    expect(snapshot.agents.map((agent) => agent.state)).toEqual(['done']);
  });

  it('emits only evidence ids and non-authority roster fields', () => {
    const snapshot = projectMissionSnapshot(runningView());

    expect(snapshot.units[0]?.evidenceIds).toEqual(['evidence-1']);
    expect(snapshot.agents[0]).toEqual({
      id: 'agent-1',
      agentName: 'Implementer',
      category: 'executor',
      cli: 'codex',
      state: 'working',
      currentUnitId: 'task-1',
      paneId: 'pane-1',
    });
    expect(JSON.stringify(snapshot)).not.toContain('reports/projector.json');
    expect(JSON.stringify(snapshot)).not.toContain('secret-');
  });

  it.each([
    '/Users/operator/private.txt',
    'C:\\private.txt',
    '../private.txt',
    'safe\u0000private.txt',
  ])(
    'rejects non-root-relative evidence path %s',
    (path) => {
      const view = runningView();
      view.tasks[0]!.evidence = [{ id: 'evidence-1', path }];

      expect(() => projectMissionSnapshot(view)).toThrow();
    },
  );
});

describe('resolveMissionAgentLiveState', () => {
  it('projects busy and spawning sessions as working', () => {
    expect(
      resolveMissionAgentLiveState({ sessionState: 'busy', taskState: 'queued' }),
    ).toBe('working');
    expect(
      resolveMissionAgentLiveState({
        sessionState: 'spawning',
        taskState: 'queued',
      }),
    ).toBe('working');
  });

  it('projects awaiting-input as waiting without inventing it from idle', () => {
    expect(
      resolveMissionAgentLiveState({
        semantic: 'awaiting-input',
        sessionState: 'idle',
        taskState: 'queued',
      }),
    ).toBe('waiting');
    expect(
      resolveMissionAgentLiveState({
        semantic: 'idle',
        sessionState: 'idle',
        taskState: 'queued',
      }),
    ).toBe('queued');
  });

  it('keeps sealed running tasks visible over quiet transport', () => {
    expect(
      resolveMissionAgentLiveState({
        semantic: 'idle',
        sessionState: 'idle',
        taskState: 'working',
      }),
    ).toBe('working');
    expect(
      resolveMissionAgentLiveState({
        semantic: 'completed',
        sessionState: 'idle',
        taskState: 'working',
      }),
    ).toBe('working');
  });

  it('marks a listed pane without a live session as stopped', () => {
    expect(
      resolveMissionAgentLiveState({
        sessionState: null,
        taskState: 'queued',
      }),
    ).toBe('stopped');
  });

  it('projects hook error as failed and completed idle as done', () => {
    expect(
      resolveMissionAgentLiveState({
        semantic: 'error',
        sessionState: 'idle',
        taskState: 'queued',
      }),
    ).toBe('failed');
    expect(
      resolveMissionAgentLiveState({
        semantic: 'completed',
        sessionState: 'idle',
        taskState: 'done',
      }),
    ).toBe('done');
  });
});

describe('projectMissionSnapshot live pane preference', () => {
  it('prefers live pane waiting over task fallback queued', () => {
    const view = runningView();
    view.tasks[0]!.status = 'pending';
    view.panes[0] = {
      paneId: 'pane-1',
      agentId: 'agent-1',
      state: 'waiting',
      currentUnitId: 'task-1',
    };

    const snapshot = projectMissionSnapshot(view);
    expect(snapshot.agents[0]).toMatchObject({
      id: 'agent-1',
      state: 'waiting',
      paneId: 'pane-1',
      currentUnitId: 'task-1',
    });
  });
});
