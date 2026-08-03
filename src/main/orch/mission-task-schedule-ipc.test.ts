import { describe, expect, it } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { encodeTaskScheduleDetail } from './mission-scheduler-meta';
import { missionTaskScheduleForRenderer } from './mission-task-schedule-ipc';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';

const SECRET = 'conteúdo selado do prompt';

function mission(): Mission {
  return {
    id: 'mission-1',
    title: 'Missão',
    description: '',
    status: 'running',
    milestones: [],
    learnings: '',
    intentVersion: 2,
    createdAt: 1,
    updatedAt: 1,
  };
}

function suite(input: {
  readonly rows?: Array<{ id: string; title: string; status: string }>;
  readonly dispatches?: Array<{
    taskId: string;
    intentVersion: number;
    state: string;
  }>;
  readonly receipt?: unknown;
  readonly receiptThrows?: boolean;
}): ProjectDomainStoreSuite {
  return {
    tasks: {
      list: () => input.rows ?? [],
      getPlanReceipt: () => {
        if (input.receiptThrows) throw new Error('orphan sealed plan');
        return input.receipt ?? null;
      },
    },
    taskDispatches: {
      list: () => input.dispatches ?? [],
    },
  } as unknown as ProjectDomainStoreSuite;
}

function sealedMeta(dependsOn: readonly string[]): string {
  return encodeTaskScheduleDetail(SECRET, {
    dependsOn: [...dependsOn],
    ownership: { files: [], symbols: [], domains: [] },
    merged: false,
  });
}

describe('missionTaskScheduleForRenderer', () => {
  it('builds waves from the sealed receipt with agents, stages and dependencies', () => {
    const stores = suite({
      rows: [
        { id: 'task-impl', title: 'Implementar', status: 'running' },
        { id: 'task-review', title: 'Revisar', status: 'pending' },
      ],
      dispatches: [{ taskId: 'task-impl', intentVersion: 2, state: 'running' }],
      receipt: {
        agents: [
          { id: 'agent-exec', agentName: 'Implementador' },
          { id: 'agent-rev', agentName: 'Revisor' },
        ],
        tasks: [
          {
            taskId: 'task-impl',
            title: 'Implementar',
            detail: sealedMeta([]),
            agentRef: 'agent-exec',
            agentCategory: 'executor',
          },
          {
            taskId: 'task-review',
            title: 'Revisar',
            detail: sealedMeta(['task-impl']),
            agentRef: 'agent-rev',
            agentCategory: 'reviewer',
          },
        ],
      },
    });

    const tasks = missionTaskScheduleForRenderer(stores, mission());

    expect(tasks).toHaveLength(2);
    const impl = tasks.find((task) => task.taskId === 'task-impl');
    const review = tasks.find((task) => task.taskId === 'task-review');
    expect(impl).toMatchObject({
      title: 'Implementar',
      agentName: 'Implementador',
      stage: 'implementação',
      status: 'running',
      waveHint: 1,
    });
    expect(review).toMatchObject({
      agentName: 'Revisor',
      stage: 'revisão',
      status: 'pending',
      dependsOn: ['task-impl'],
      waveHint: 2,
    });
    // The sealed prompt body never crosses the IPC boundary.
    expect(JSON.stringify(tasks)).not.toContain(SECRET);
  });

  it('ignores dispatches from another intent version', () => {
    const stores = suite({
      rows: [{ id: 'task-a', title: 'A', status: 'pending' }],
      dispatches: [{ taskId: 'task-a', intentVersion: 1, state: 'running' }],
    });

    const [task] = missionTaskScheduleForRenderer(stores, mission());
    expect(task?.status).toBe('pending');
  });

  it('falls back to plain task rows when the receipt is orphan or absent', () => {
    const stores = suite({
      rows: [{ id: 'task-a', title: 'A', status: 'done' }],
      receiptThrows: true,
    });

    const [task] = missionTaskScheduleForRenderer(stores, mission());
    expect(task).toMatchObject({
      taskId: 'task-a',
      title: 'A',
      status: 'done',
      dependsOn: [],
      waveHint: 1,
    });
  });

  it('returns empty for a mission without tasks', () => {
    expect(missionTaskScheduleForRenderer(suite({}), mission())).toEqual([]);
  });
});
