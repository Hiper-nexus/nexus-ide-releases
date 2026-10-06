import { describe, expect, it } from 'vitest';
import {
  MOMENTUM_REPEAT_MS,
  MOMENTUM_SOLO_MS,
  decideMomentumNudge,
  momentumNudgeSummary,
  momentumReadyBacklog,
} from './mission-momentum-watchdog';

const now = 10_000_000;
const base = {
  missionStatus: 'running',
  lane: null,
  maxWorkers: null,
  workerPanes: 0,
  orchestratorAlive: true,
  soloSinceMs: now - MOMENTUM_SOLO_MS,
  lastNudgeAtMs: null,
  now,
};

describe('vigia de esteira (F-714)', () => {
  it('Maestro vivo e sozinho há 20 min numa missão que delega: lembra de abrir workers', () => {
    expect(decideMomentumNudge(base)).toEqual({
      action: 'nudge',
      soloForMs: MOMENTUM_SOLO_MS,
    });
  });

  it('com worker vivo, há menos de 20 min, ou com lembrete na última hora: nada', () => {
    expect(decideMomentumNudge({ ...base, workerPanes: 1 })).toEqual({
      action: 'none',
    });
    expect(
      decideMomentumNudge({ ...base, soloSinceMs: now - MOMENTUM_SOLO_MS + 1 }),
    ).toEqual({ action: 'none' });
    expect(
      decideMomentumNudge({
        ...base,
        lastNudgeAtMs: now - MOMENTUM_REPEAT_MS + 1,
      }),
    ).toEqual({ action: 'none' });
    expect(
      decideMomentumNudge({ ...base, lastNudgeAtMs: now - MOMENTUM_REPEAT_MS })
        .action,
    ).toBe('nudge');
  });

  it('missão parada, de execução direta, consulta/plano ou Maestro fora do ar: nada', () => {
    for (const over of [
      { missionStatus: 'blocked' },
      { missionStatus: 'done' },
      { maxWorkers: 0 },
      { lane: 'plan' },
      { lane: 'consult' },
      { orchestratorAlive: false },
      { soloSinceMs: null },
    ]) {
      expect(
        decideMomentumNudge({ ...base, ...over }),
        JSON.stringify(over),
      ).toEqual({ action: 'none' });
    }
  });

  it('o lembrete diz há quanto tempo e manda adiantar as próximas unidades sem paralelizar o gate', () => {
    const text = momentumNudgeSummary('mission-1', 95 * 60_000);
    expect(text).toContain('[momentum:mission-1]');
    expect(text).toContain('95 min');
    expect(text).toContain('próximas unidades');
    expect(text).toContain('um por vez');
  });
});

it('ready registered backlog fills a vacant slot despite an idle helper, without waiting twenty minutes', () => {
  expect(
    decideMomentumNudge({
      ...base,
      workerPanes: 1,
      maxWorkers: 3,
      soloSinceMs: null,
      readyTaskIds: ['task-ready'],
      availableSlots: 2,
      usefulWorkingWorkers: 0,
      readySinceMs: now - 30_000,
      dispatchAuthorized: true,
      readOnly: false,
      backlogKey: 'ready-key',
      lastBacklogKey: null,
    }),
  ).toMatchObject({
    action: 'nudge',
    readyTaskIds: ['task-ready'],
    availableSlots: 2,
    usefulWorkingWorkers: 0,
  });
});

it('confirmed empty or dependency-blocked backlog, full slots and unproved authority stay quiet', () => {
  const ready = {
    ...base,
    workerPanes: 1,
    maxWorkers: 3,
    readyTaskIds: ['task-ready'],
    availableSlots: 2,
    readySinceMs: now - 30_000,
    dispatchAuthorized: true,
    readOnly: false,
    backlogKey: 'key',
  };
  for (const patch of [
    { readyTaskIds: [] },
    { availableSlots: 0 },
    { dispatchAuthorized: false },
    { readOnly: true },
    { readySinceMs: now - 29_999 },
  ]) {
    expect(decideMomentumNudge({ ...ready, ...patch })).toEqual({
      action: 'none',
    });
  }
});

it('same ready backlog repeats hourly; genuinely changed backlog may refresh only after a minute', () => {
  const ready = {
    ...base,
    maxWorkers: 3,
    readyTaskIds: ['task-ready'],
    availableSlots: 1,
    readySinceMs: now - 30_000,
    dispatchAuthorized: true,
    backlogKey: 'next',
    lastBacklogKey: 'previous',
    lastNudgeAtMs: now - 60_000,
  };
  expect(decideMomentumNudge(ready).action).toBe('nudge');
  expect(
    decideMomentumNudge({ ...ready, lastNudgeAtMs: now - 59_999 }).action,
  ).toBe('none');
  expect(decideMomentumNudge({ ...ready, lastBacklogKey: 'next' }).action).toBe(
    'none',
  );
  expect(
    decideMomentumNudge({
      ...ready,
      lastBacklogKey: 'next',
      lastNudgeAtMs: now - MOMENTUM_REPEAT_MS,
    }).action,
  ).toBe('nudge');
});

it('registered pending roots are ready while unmet/missing dependencies and in-flight dispatches are not', () => {
  const tasks = [
    { id: 'done', status: 'done', detail: '' },
    { id: 'root', status: 'pending', detail: '' },
    {
      id: 'next',
      status: 'pending',
      detail: '[plan-meta]{"dependsOn":["done"]}',
    },
    {
      id: 'wait',
      status: 'pending',
      detail: '[plan-meta]{"dependsOn":["root"]}',
    },
    {
      id: 'missing',
      status: 'pending',
      detail: '[plan-meta]{"dependsOn":["absent"]}',
    },
    { id: 'bad', status: 'pending', detail: '[plan-meta]{"dependsOn":"done"}' },
    { id: 'claimed', status: 'pending', detail: '' },
  ];
  expect(
    momentumReadyBacklog({
      tasks,
      dispatches: [{ taskId: 'claimed', state: 'claimed' }],
    }).readyTaskIds,
  ).toEqual(['next', 'root']);
});

it('sealed readiness respects the current receipt identities and translates planner dependencies', () => {
  const tasks = [
    { id: 'old-generation', status: 'pending', detail: '' },
    { id: 'task-impl', status: 'done', detail: '' },
    {
      id: 'task-review',
      status: 'pending',
      detail: 'mutable row cannot erase the dependency',
    },
  ];
  const sealedTasks = [
    { taskId: 'task-impl', plannerId: 'implementation', detail: '' },
    {
      taskId: 'task-review',
      plannerId: 'review',
      detail: '[plan-meta]{"dependsOn":["implementation"]}',
    },
  ];
  expect(
    momentumReadyBacklog({ tasks, sealedTasks, dispatches: [] }).readyTaskIds,
  ).toEqual(['task-review']);
  expect(
    momentumReadyBacklog({
      tasks: tasks.map((row) =>
        row.id === 'task-impl' ? { ...row, status: 'running' } : row,
      ),
      sealedTasks,
      dispatches: [],
    }).readyTaskIds,
  ).toEqual([]);
});

it('queue receipt key ignores content and worker heartbeats, but changes on a ready task retry', () => {
  const tasks = [{ id: 'ready', status: 'pending', detail: 'private prompt' }];
  const first = momentumReadyBacklog({ tasks, dispatches: [] });
  expect(
    momentumReadyBacklog({
      tasks: [{ ...tasks[0], detail: 'different private prompt' }],
      dispatches: [{ taskId: 'other', state: 'running', revision: 25 }],
    }).backlogKey,
  ).toBe(first.backlogKey);
  expect(
    momentumReadyBacklog({
      tasks,
      dispatches: [
        { taskId: 'ready', state: 'failed', attempt: 1, revision: 2 },
      ],
    }).backlogKey,
  ).not.toBe(first.backlogKey);
});

it('ready work directive distinguishes the sealed Main dispatcher from free one-call spawn', () => {
  const text = momentumNudgeSummary('mission-1', 30_000, {
    action: 'nudge',
    soloForMs: 30_000,
    readyTaskIds: ['existing-task'],
    availableSlots: 1,
    usefulWorkingWorkers: 0,
    backlogKey: 'a'.repeat(64),
  });
  expect(text).toContain('dispatcher Main');
  expect(text).toContain('sem spawn manual');
  expect(text).toContain('UMA chamada nexus_pane_spawn');
  expect(text).toContain('Não invente tarefas');
});
