import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileIntentContract } from '../../shared/mission-intent';
import type { Squad } from '../../shared/orch-types';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  advanceFastLaneStoryTaskFromHandoff,
  advanceFastLaneStoryTaskFromWorkerDone,
  advanceSealedTasksFromFilesOnDisk,
  boardProgressFromSealedTasks,
  compileListedStoriesToPlanRows,
  distinctiveFileTokens,
  distinctiveTitleTokens,
  matchOpenSealedTasksForFiles,
  titleTokenAlignsFile,
  matchSealedTaskForHandoff,
  normalizeWorkerIdentity,
  sealFastLaneListedStoryPlan,
  workerIdentitiesMatch,
  writerOrdinalFromLabel,
  shouldRejectRoleCollapsedPlan,
} from './mission-story-plan';
import { projectMissionSnapshot } from './mission-snapshot';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

const squad: Squad = {
  id: 'delivery-squad',
  name: 'Delivery squad',
  createdAt: '2026-07-23T00:00:00.000Z',
  builtin: false,
  orchestratorInstructions: 'Coordinate.',
  agents: [
    {
      id: 'orchestrator',
      agentName: 'Maestro',
      category: 'orchestrator',
      cli: 'claude',
      model: 'claude-opus-4-1',
    },
    {
      id: 'api-worker',
      agentName: 'API Worker',
      category: 'executor',
      cli: 'codex',
      model: 'gpt-5.3-codex',
    },
  ],
};

function twentyStoryObjective(): string {
  return [
    'Monte um SaaS de waitlist com estas stories:',
    ...Array.from(
      { length: 20 },
      (_, index) => `${index + 1}. Story ${index + 1} da waitlist`,
    ),
  ].join('\n');
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-story-plan-'));
});

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('compileListedStoriesToPlanRows', () => {
  it('20 stories listadas viram 20 rows — não 5 papéis', () => {
    const rows = compileListedStoriesToPlanRows(
      twentyStoryObjective(),
      squad.agents,
    );
    expect(rows).toHaveLength(20);
    expect(rows.every((row) => row.agentRef === 'api-worker')).toBe(true);
    expect(rows[0]?.plannerId).toBe('story-1');
    expect(rows[19]?.title).toBe('Story 20 da waitlist');
  });

  it('prosa "20 user stories" vira 20 rows — não 5 papéis', () => {
    const rows = compileListedStoriesToPlanRows(
      'Monte um SaaS com exatamente 20 user stories. Não colapse em papéis.',
      squad.agents,
    );
    expect(rows).toHaveLength(20);
    expect(rows[0]?.title).toBe('Story 01');
    expect(rows[19]?.title).toBe('Story 20');
  });

  it('one-liner fica um plano pequeno', () => {
    const rows = compileListedStoriesToPlanRows(
      'Crie um botão de login.',
      squad.agents,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Crie um botão de login.');
  });

  it('sem escritor no roster não finge plano', () => {
    expect(
      compileListedStoriesToPlanRows('1. A\n2. B', [
        squad.agents[0]!,
      ]),
    ).toEqual([]);
  });
});


function memorySeal(objective: string, title = 'Waitlist') {
  const mission = {
    id: 'mission-story-plan',
    title,
    description: objective,
    status: 'running' as const,
    intentVersion: 1,
    intentState: 'executing' as const,
    squadId: squad.id,
    intentContract: compileIntentContract({ goal: objective, intentVersion: 1 }),
  };
  const taskRows: Array<{
    id: string;
    title: string;
    status: 'pending' | 'running' | 'done' | 'failed' | 'blocked';
    plannerId: string;
  }> = [];
  const stores = {
    missions: { get: () => mission },
    tasks: {
      hasPlan: () => taskRows.length > 0,
      list: () => taskRows,
      listPlannedTasks: () =>
        taskRows.map((task) => ({
          taskId: task.id,
          plannerId: task.plannerId,
          agentRef: 'api-worker',
          agent: {
            id: 'api-worker',
            agentName: 'API Worker',
            category: 'executor' as const,
          },
          agentCategory: 'executor' as const,
          task,
        })),
      createPlanAtomically: (input: { rows: readonly { plannerId: string; title: string }[] }) => {
        taskRows.length = 0;
        for (const row of input.rows) {
          taskRows.push({
            id: `t-${row.plannerId}`,
            title: row.title,
            status: 'pending',
            plannerId: row.plannerId,
          });
        }
        return [...taskRows];
      },
      advanceSealedTaskStatus: (id: string, status: 'pending' | 'running' | 'done' | 'failed' | 'blocked') => {
        const row = taskRows.find((task) => task.id === id);
        if (row) row.status = status;
        return row ?? null;
      },
    },
  };
  return {
    mission,
    stores: stores as unknown as Parameters<typeof sealFastLaneListedStoryPlan>[0],
    tasks: { list: (_missionId?: string) => taskRows },
  };
}

describe('selo Via Rápida → board N/M', () => {
  it('20-line story list → 20 tasks no board (0/20, depois 3/20 no handoff)', () => {
    const { mission, stores, tasks } = memorySeal(twentyStoryObjective());

    const sealed = sealFastLaneListedStoryPlan(
      stores,
      mission as never,
      squad,
    );
    expect(sealed).toHaveLength(20);
    expect(tasks.list(mission.id)).toHaveLength(20);
    expect(boardProgressFromSealedTasks(tasks.list(mission.id))).toEqual({
      completed: 0,
      total: 20,
    });

    const replay = sealFastLaneListedStoryPlan(
      stores,
      mission as never,
      squad,
    );
    expect(replay.map((task) => task.id)).toEqual(sealed.map((task) => task.id));

    for (let i = 0; i < 3; i += 1) {
      const advanced = advanceFastLaneStoryTaskFromHandoff(stores, {
        missionId: mission.id,
        fromAgent: 'API Worker',
        summary: `Entregue a ${sealed[i]!.title} com arquivos e testes.`,
        handoffStatus: 'success',
      });
      expect(advanced).toBe(sealed[i]!.id);
    }

    const progress = boardProgressFromSealedTasks(tasks.list(mission.id));
    expect(progress).toEqual({ completed: 3, total: 20 });

    const snapshot = projectMissionSnapshot({
      mission: {
        id: mission.id,
        title: 'Waitlist',
        objective: twentyStoryObjective(),
        workspaceLabel: 'ws',
        status: 'running',
        version: 1,
        updatedAt: 200,
      },
      hasDispatchAuthority: false,
      hasCurrentKickoffReceipt: true,
      orchestratorLive: true,
      tasks: tasks.list(mission.id).map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        dependsOn: [],
        evidence: [],
      })),
      handoffs: [],
      panes: [],
      roster: squad.agents,
    });
    expect(snapshot.progress).toEqual({ completed: 3, total: 20 });
    expect(snapshot.units).toHaveLength(20);
  });

  it('20 listed stories → 20 sealed (prosa + item-01)', () => {
    const goal = 'Quero exatamente 20 user stories neste SaaS.';
    const { mission, stores, tasks } = memorySeal(goal, 'SaaS 20');

    const sealed = sealFastLaneListedStoryPlan(
      stores,
      mission as never,
      squad,
    );
    expect(sealed).toHaveLength(20);
    expect(tasks.list(mission.id)).toHaveLength(20);
    expect(boardProgressFromSealedTasks(tasks.list(mission.id))).toEqual({
      completed: 0,
      total: 20,
    });
  });

  it('one-liner sela plano pequeno (1/1 no board, não 0/7 papéis)', () => {
    const { mission, stores, tasks } = memorySeal('Crie um botão de login.', 'Login');

    expect(
      sealFastLaneListedStoryPlan(stores, mission as never, squad),
    ).toHaveLength(1);
    expect(boardProgressFromSealedTasks(tasks.list(mission.id))).toEqual({
      completed: 0,
      total: 1,
    });
  });

  it('worker done com files-modified avança o board; 0 arquivos não avança', () => {
    const { mission, stores, tasks } = memorySeal(twentyStoryObjective());
    sealFastLaneListedStoryPlan(stores, mission as never, squad);

    expect(
      advanceFastLaneStoryTaskFromWorkerDone(stores, {
        missionId: mission.id,
        fromAgent: 'Writer 1',
        filesModified: [],
      }),
    ).toBeNull();
    expect(boardProgressFromSealedTasks(tasks.list(mission.id))).toEqual({
      completed: 0,
      total: 20,
    });

    expect(
      advanceFastLaneStoryTaskFromWorkerDone(stores, {
        missionId: mission.id,
        fromAgent: 'Writer 1',
        adapterId: 'codex',
        filesModified: ['src/waitlist.ts'],
      }),
    ).not.toBeNull();
    expect(boardProgressFromSealedTasks(tasks.list(mission.id))).toEqual({
      completed: 1,
      total: 20,
    });
  });

  it('arquivos no disco fecham match único e a próxima aberta, sem inventar', () => {
    const objective = [
      '1. HTTP server listen',
      '2. Public landing',
      '3. Smoke check',
    ].join('\n');
    const { mission, stores, tasks } = memorySeal(objective, 'Stress-12');
    sealFastLaneListedStoryPlan(stores, mission as never, squad);

    const advanced = advanceSealedTasksFromFilesOnDisk(stores, {
      missionId: mission.id,
      filesModified: ['server.js', 'public/index.html', 'notes.txt'],
    });
    expect(advanced.length).toBeGreaterThanOrEqual(2);
    expect(boardProgressFromSealedTasks(tasks.list(mission.id)).completed).toBe(
      advanced.length,
    );
    expect(boardProgressFromSealedTasks(tasks.list(mission.id)).total).toBe(3);
  });
});

describe('shouldRejectRoleCollapsedPlan', () => {
  it('recusa 5 papéis quando o objetivo pede 20 stories', () => {
    expect(
      shouldRejectRoleCollapsedPlan({
        objective: 'Monte um SaaS com exatamente 20 user stories.',
        planTitles: [
          'Frontend',
          'Backend',
          'Generalist',
          'UX Designer',
          'QA',
        ],
      }),
    ).toBe(true);
    expect(
      shouldRejectRoleCollapsedPlan({
        objective: 'Crie um botão de login.',
        planTitles: ['Login'],
      }),
    ).toBe(false);
  });
});

describe('matchSealedTaskForHandoff', () => {
  const tasks = [
    {
      id: 't1',
      title: 'Landing',
      status: 'pending',
      agentName: 'API Worker',
      agentCli: 'codex',
      plannerId: 'story-1',
    },
    {
      id: 't2',
      title: 'Auth',
      status: 'pending',
      agentName: 'API Worker',
      agentCli: 'codex',
      plannerId: 'story-2',
    },
  ];

  it('casa pelo título no summary, senão a mais antiga pendente', () => {
    expect(
      matchSealedTaskForHandoff({
        tasks,
        summary: 'Auth magic link pronto com evidência.',
      }),
    ).toBe('t2');
    expect(matchSealedTaskForHandoff({ tasks })).toBe('t1');
  });

  it('normaliza nexus-* / CLI / Writer N para a task aberta', () => {
    expect(normalizeWorkerIdentity('nexus-codex')).toBe('codex');
    expect(workerIdentitiesMatch('nexus-codex', 'codex')).toBe(true);
    expect(writerOrdinalFromLabel('Writer 2')).toBe(2);
    expect(
      matchSealedTaskForHandoff({
        tasks,
        fromAgent: 'nexus-codex',
        adapterId: 'codex',
      }),
    ).toBe('t1');
    expect(
      matchSealedTaskForHandoff({
        tasks,
        fromAgent: 'Writer 2',
      }),
    ).toBe('t2');
    expect(
      matchSealedTaskForHandoff({
        tasks,
        filesModified: ['src/auth/magic-link.ts'],
      }),
    ).toBe('t2');
  });

  it('casa arquivo a task só quando o token do título é único', () => {
    expect(distinctiveTitleTokens('Story 1 da waitlist')).toEqual(['waitlist']);
    const twelve = Array.from({ length: 12 }, (_, index) => ({
      id: `t${index + 1}`,
      title: `Story ${index + 1} da waitlist`,
      status: 'pending',
    }));
    expect(
      matchOpenSealedTasksForFiles({
        tasks: twelve,
        filesModified: ['server.js', 'public/index.html'],
      }).uniqueTaskIds,
    ).toEqual([]);
    expect(
      matchOpenSealedTasksForFiles({
        tasks: [
          { id: 's', title: 'HTTP server listen', status: 'pending' },
          { id: 'l', title: 'Public landing', status: 'pending' },
        ],
        filesModified: ['server.js', 'public/index.html'],
      }).uniqueTaskIds,
    ).toEqual(['s', 'l']);
  });

  it('067 pending-with-file: story-01-landing.html fecha Landing; 05-admin fecha Admin lista emails', () => {
    const leftover = [
      {
        id: 'land',
        title: 'Landing',
        status: 'pending',
        plannerId: 'story-1',
      },
      {
        id: 'admin',
        title: 'Admin lista emails',
        status: 'pending',
        plannerId: 'story-5',
      },
      {
        id: 'cnt',
        title: 'Contador da fila',
        status: 'pending',
        plannerId: 'story-9',
      },
      {
        id: 'fav',
        title: 'Favicon e OG',
        status: 'pending',
        plannerId: 'story-20',
      },
    ];
    const matched = matchOpenSealedTasksForFiles({
      tasks: leftover,
      filesModified: [
        'story-01-landing.html',
        'subscribe.js',
        '03-server-4367.js',
        '04-thank-you.html',
        '05-admin-lista-emails.js',
        'rate-limit.js',
        'unsubscribe.js',
      ],
    });
    expect(matched.uniqueTaskIds).toEqual(expect.arrayContaining(['land', 'admin']));
    expect(matched.uniqueTaskIds).not.toContain('cnt');
    expect(matched.uniqueTaskIds).not.toContain('fav');
  });

  it('16/20 leftover Landing + story-01-landing.html avança para done', () => {
    const objective = [
      '1. Landing',
      ...Array.from({ length: 15 }, (_, index) => `${index + 2}. Story ${index + 2} da waitlist`),
      '17. Admin lista emails',
      '18. Contador da fila',
      '19. Extra leftover',
      '20. Favicon e OG',
    ].join('\n');
    const { mission, stores, tasks } = memorySeal(objective, 'SaaS 067');
    sealFastLaneListedStoryPlan(stores, mission as never, squad);
    const leftover = new Set([
      'Landing',
      'Admin lista emails',
      'Contador da fila',
      'Favicon e OG',
    ]);
    const rows = tasks.list(mission.id);
    expect(rows).toHaveLength(20);
    for (const row of rows) {
      if (!leftover.has(row.title)) {
        stores.tasks.advanceSealedTaskStatus(row.id, 'done');
      }
    }
    expect(boardProgressFromSealedTasks(tasks.list(mission.id))).toEqual({
      completed: 16,
      total: 20,
    });

    const advanced = advanceSealedTasksFromFilesOnDisk(stores, {
      missionId: mission.id,
      filesModified: ['story-01-landing.html'],
      uniqueMatchesOnly: true,
    });
    expect(advanced.length).toBe(1);
    const landing = tasks.list(mission.id).find((row) => row.title === 'Landing');
    expect(landing?.status).toBe('done');
    expect(boardProgressFromSealedTasks(tasks.list(mission.id))).toEqual({
      completed: 17,
      total: 20,
    });
  });

  it('064 pending-with-file: count.js fecha Contador da fila; subscribe.js fecha POST /subscribe', () => {
    expect(distinctiveTitleTokens('Contador da fila')).toEqual(['contador', 'fila']);
    expect(distinctiveFileTokens('lib/count.js')).toEqual(['count']);
    expect(
      titleTokenAlignsFile(
        'contador',
        'lib/count.js',
        distinctiveFileTokens('lib/count.js'),
      ),
    ).toBe(true);

    const open = [
      {
        id: 'sub',
        title: 'POST /subscribe grava email',
        status: 'pending',
        plannerId: 'story-2',
      },
      {
        id: 'cnt',
        title: 'Contador da fila',
        status: 'pending',
        plannerId: 'story-9',
      },
      {
        id: 'w1',
        title: 'Story 1 da waitlist',
        status: 'pending',
        plannerId: 'story-1',
      },
    ];
    const matched = matchOpenSealedTasksForFiles({
      tasks: open,
      filesModified: [
        'lib/subscribe.js',
        'stories/02-post-subscribe-save.md',
        'lib/count.js',
        'stories/09-queue-counter.md',
        'server.js',
      ],
    });
    expect(matched.uniqueTaskIds).toEqual(['sub', 'cnt']);
    expect(matched.unmatchedFiles).toContain('server.js');
  });

  it('12 stories iguais + leftover server.js não inventa casa', () => {
    const twelve = Array.from({ length: 12 }, (_, index) => ({
      id: `t${index + 1}`,
      title: `Story ${index + 1} da waitlist`,
      status: 'pending',
      plannerId: `story-${index + 1}`,
    }));
    expect(
      matchOpenSealedTasksForFiles({
        tasks: twelve,
        filesModified: ['server.js', 'README.md'],
      }).uniqueTaskIds,
    ).toEqual([]);
  });
});
