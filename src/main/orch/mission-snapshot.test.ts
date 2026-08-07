import { describe, expect, it } from 'vitest';
import {
  projectMissionSnapshot,
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
  it('projects running without a current receipt as blocked technical', () => {
    const view = runningView();
    view.hasCurrentKickoffReceipt = false;

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('blocked_technical');
    expect(snapshot.stateReason?.code).toBe('kickoff-receipt-missing');
    expect(snapshot.allowedActions).toEqual(['retry-kickoff', 'stop']);
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
    expect(snapshot.allowedActions).toEqual([]);
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
